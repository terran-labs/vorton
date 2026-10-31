import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { RetryGate, RetryFailure, RetryDeferred, responseValue, retryReason, retryGate } from "../web/application/retry-gate.ts";
import { ReplicaService } from "../web/application/replica-service.ts";
import { ProfileCache, loadSession, readJsonWithDeadline } from "../web/application/profile-cache.ts";
import { workspaceAccess } from "../web/application/offline-access.ts";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const network = () => new RetryFailure("Acknowledgement lost", "transient");

test("actual Connection Status forwards automatic recovery as false and its explicit click as true", async t => {
  const source = await readFile(new URL("../web/application/connection-status.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const state = [], effects = [], forwarded = []; let cursor = 0, calls = 0;
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === "function" ? value(state[i]) : value; }]; },
    useRef(initial) { const [value] = hooks.useState({ current: initial }); return value; },
    useSyncExternalStore(_subscribe, read) { return read(); },
    useEffect(run, deps) { const i = cursor++, old = effects[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) effects[i] = { deps, run, pending: true, cleanup: old?.cleanup }; },
  };
  const jsx = (type, props) => ({ type, props }), exports = {};
  vm.runInNewContext(compiled, { exports, window, document, navigator: { onLine: true }, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, require(name) {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name.endsWith("connection-check")) return { checkConnection: async () => { calls++; return { reachable: calls > 1, admitted: calls > 1, browserOnline: true }; } };
    if (name.endsWith("pwa-client")) return { checkPwaUpdate: async () => {}, pwaStatus: { subscribe() {}, getSnapshot: () => ({}) } };
    if (name.endsWith("offline-context")) return { useWorkspaceAccess: () => ({ profile: null }) };
    if (name.endsWith("use-replica")) return { useReplica: () => ({ pending: 1 }) };
    if (name.endsWith("update-safety")) return { observeUpdateSafety: () => () => {} };
    return {};
  } });
  const render = () => { cursor = 0; const tree = exports.ConnectionStatus({ href: "/synthetic", onReconnect: explicit => forwarded.push(explicit) }); for (const e of effects) if (e?.pending) { e.pending = false; e.cleanup?.(); e.cleanup = e.run(); } return tree; };
  const nodes = tree => !tree || typeof tree !== "object" ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
  t.after(() => { for (const e of effects) e?.cleanup?.(); });
  render(); await flush(); window.dispatchEvent(new Event("online")); await flush();
  assert.deepEqual(forwarded, [false]);
  nodes(render()).find(node => node.props?.className?.startsWith("connection-status-button")).props.onClick(); await flush();
  nodes(render()).find(node => node.type === "button" && node.props.children === "Test connection and retry").props.onClick(); await flush();
  assert.deepEqual(forwarded, [false, true]);
});

test("equal jitter doubles to a 60-second ceiling, isolates scopes and resets only current successful work", () => {
  for (const random of [0, 0.5, 1]) {
    let now = 0;
    const gate = new RetryGate(() => now, () => random);
    for (const ceiling of [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]) {
      const old = gate.begin("a");
      gate.fail("a", network());
      gate.finish(old, true);
      const delay = ceiling / 2 + random * ceiling / 2;
      assert.equal(gate.inspect("a").remaining, delay);
      assert.throws(() => gate.begin("a"), RetryDeferred);
      assert.doesNotThrow(() => gate.begin("other-installation/profile"));
      now += delay;
    }
    gate.finish(gate.begin("a"), true);
    assert.deepEqual(gate.inspect("a"), { failures: 0, remaining: 0, paused: undefined });
  }
});

test("explicit bypass is one owned lease; duplicate errors and retired finishes cannot alter another attempt", () => {
  const gate = new RetryGate(() => 0, () => 0), old = gate.begin("a"), error = network();
  gate.fail("a", error); gate.fail("a", error);
  assert.equal(gate.inspect("a").failures, 1);
  const explicit = gate.begin("a", true);
  gate.finish(old, false);
  assert.throws(() => gate.begin("a", true), RetryDeferred);
  gate.fail("a", network()); gate.finish(explicit, false);
  assert.equal(gate.inspect("a").remaining, 2000);
  for (const reason of ["auth", "history", "storage", "validation"]) {
    const paused = new RetryGate(); paused.fail("a", new RetryFailure(reason, reason));
    assert.throws(() => paused.begin("a", true), RetryDeferred);
    paused.recover("a", "transient");
    assert.equal(paused.inspect("a").paused, reason);
  }
  gate.fail("a", new RetryFailure("retired", "cancelled"));
  assert.equal(gate.inspect("a").failures, 2);
});

test("HTTP classification retains non-JSON auth and storage/history codes before generic status handling", async () => {
  for (const status of [401, 403]) await assert.rejects(responseValue(new Response("<html>Denied</html>", { status })), error => error.reason === "auth" && error.status === status);
  for (const [code, reason] of [["history-changed", "history"], ["storage-corrupt", "storage"], ["migration-required", "storage"]])
    await assert.rejects(responseValue(Response.json({ code, error: code }, { status: 503 })), error => error.code === code && error.reason === reason);
  for (const [code, reason] of [["http-worker-busy", "transient"], ["http-worker-unavailable", "transient"], ["http-policy-changed", "validation"], ["http-policy-unsupported", "validation"]])
    await assert.rejects(responseValue(Response.json({ code }, { status: 503 })), error => error.code === code && error.reason === reason);
  await assert.rejects(responseValue(new Response("bad gateway", { status: 502 })), { reason: "transient" });
  await assert.rejects(responseValue(Response.json({ error: "Correct the input" }, { status: 422 })), { reason: "validation" });
  await assert.rejects(responseValue(new Response("not json")), { reason: "validation" });
  await assert.rejects(responseValue({ ok: true, json: async () => { throw TypeError("Body interrupted"); } }), { reason: "transient" });
});

function fixture(t) {
  const identity = { installationId: randomUUID(), variant: "private" }, profile = "AubOS", history = randomUUID();
  const scope = { ...identity, readEpoch: 0, draftEpoch: 0 };
  const admission = { ...identity, schema: 1, profiles: [profile], verifiedAt: 1 };
  const admit = () => { workspaceAccess.admitOnline(admission, scope); workspaceAccess.setProfile(profile); workspaceAccess.confirmLive(workspaceAccess.getSnapshot()); };
  workspaceAccess.manage("private"); admit();
  const state = { profile, revision: 0, syncGeneration: history, syncCursor: 0, tasks: [], goals: [], ideas: [], recommendations: [], events: [] };
  const rows = { metadata: { profile, body: JSON.stringify(state), generation: history, cursor: 0, download_head: 0, verified_at: 1 }, records: [], acceptedRecords: [], outbox: [] };
  let now = 0, sessions = 0, mode, sessionWait, bodyWait, readWait, recoveryWait, localFailure = false, sessionVersion = 0;
  const remoteState = structuredClone(state);
  const retries = new RetryGate(() => now, () => 0), bodies = [], fetches = [], signals = [], recovered = [], actions = [];
  const client = { async request(_scope, action, payload) {
    actions.push(action);
    if (localFailure) throw Error("Local storage unavailable");
    assert.equal(payload.deviceEpoch.readEpoch, scope.readEpoch, "retired device epochs cannot mutate the new device");
    if (action === "workspace") return structuredClone(rows);
    if (action === "recover-attempt") { recovered.push(payload.operationId); if (recoveryWait) await recoveryWait.promise; return { original: { ...rows.outbox.find(row => row.operation_id === payload.operationId), scope: _scope } }; }
    if (action === "configure" || action === "pull") return;
    if (action === "enqueue") { rows.outbox.push({ operation_id: payload.operationId, operation: JSON.stringify(payload.operation), generation: history, status: "pending", error: null, dependencies: "[]" }); return; }
    if (action === "next") return rows.outbox.find(row => row.status === "pending") ?? null;
    if (action === "mark") { Object.assign(rows.outbox.find(row => row.operation_id === payload.operationId), { status: payload.status, error: payload.error }); return; }
    if (action === "reconcile") { if (mode === "local-confirmation") throw Error("Local confirmation unavailable"); rows.outbox[0].status = "accepted"; return; }
    throw Error(`Unexpected ${action}`);
  } };
  const service = new ReplicaService({ client, retries, sessionVersion: () => sessionVersion, publish() {}, session: async signal => {
    sessions++; signals.push(signal);
    if (sessionWait) await sessionWait.promise;
    return { ...identity, profiles: [profile], token: "memory-only" };
  }, fetcher: async (url, options) => {
    fetches.push(url);
    if (url.includes("/sync")) {
      bodies.push(options.body);
      if (mode === "timeout") return new Promise(() => {});
      if (mode === "body") return { ok: true, json: () => bodyWait.promise };
      if (mode === "transient") throw Error("Reply lost");
      if (mode === "auth") return new Response("Denied", { status: 401 });
      if (mode === "storage") return Response.json({ code: "storage-corrupt" }, { status: 503 });
      if (mode === "history") return Response.json({ code: "history-changed" }, { status: 409 });
      if (mode === "validation") return Response.json({ error: "Correct this operation" }, { status: 422 });
      if (mode?.startsWith("http-")) return Response.json({ code: mode }, { status: 503 });
      return Response.json({ confirmed: true });
    }
    if (url.includes("/state") && readWait) await readWait.promise;
    return Response.json(url.includes("/changes") ? { generation: history, head: 0, cursor: 0, more: false } : remoteState);
  } });
  const original = { window: globalThis.window, document: globalThis.document };
  globalThis.window = new EventTarget(); globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const stops = [];
  t.after(() => { for (const stop of stops) stop(); if (original.window === undefined) delete globalThis.window; else globalThis.window = original.window; if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document; });
  const enqueue = async () => { workspaceAccess.fail("Offline"); await service.hydrate(profile); const operation = { operationId: randomUUID(), id: randomUUID(), kind: "task", action: "create", expectedRevision: 0, value: { title: "Synthetic draft" } }; await service.enqueue(profile, operation, "Synthetic draft", { ...operation.value, id: operation.id, version: 1 }); admit(); return operation; };
  return { service, retries, bodies, fetches, rows, signals, scope, state, identity, admit, enqueue, recovered, actions, sessions: () => sessions,
    mode(value) { mode = value; }, holdSession() { sessionWait = deferred(); return sessionWait; }, localFailure(value) { localFailure = value; },
    holdBody() { mode = "body"; bodyWait = deferred(); return bodyWait; },
    holdRead() { readWait = deferred(); return readWait; }, holdRecovery() { recoveryWait = deferred(); return recoveryWait; },
    bumpSession() { sessionVersion++; }, remoteGeneration(value) { remoteState.syncGeneration = value; },
    start() { const stop = service.start(); stops.push(stop); return stop; },
    advance(ms) { now += ms; t.mock.timers.tick(ms); } };
}

test("events, enqueue and renewed admission cannot bypass a scoped deadline; explicit retry preserves the body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t), operation = await f.enqueue();
  f.mode("transient"); await f.service.synchronize("AubOS");
  assert.equal(f.bodies.length, 1);
  const stop = f.start(); t.after(stop);
  for (let n = 0; n < 20; n++) { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("pageshow")); document.dispatchEvent(new Event("visibilitychange")); f.admit(); }
  await f.service.synchronize("AubOS"); await flush();
  assert.equal(f.bodies.length, 1); assert.equal(f.sessions(), 1);
  f.advance(999); await flush(); assert.equal(f.bodies.length, 1);
  f.mode(undefined);
  await Promise.all([f.service.retry("AubOS", operation.operationId), f.service.retry("AubOS", operation.operationId)]);
  assert.equal(f.bodies.length, 2); assert.equal(f.bodies[1], f.bodies[0]);
  assert.equal(f.rows.outbox[0].status, "accepted");
  assert.equal(f.retries.inspect(f.service.getSnapshot("AubOS").scope).failures, 0);
});

test("the retry timer fires at its deadline and stop/start retains timing without a catch-up burst", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t); await f.enqueue(); f.mode("transient"); await f.service.synchronize("AubOS");
  let stop = f.start();
  f.advance(999); await flush(); assert.equal(f.bodies.length, 1);
  stop(); f.advance(100); await flush(); assert.equal(f.bodies.length, 1);
  stop = f.start(); t.after(stop);
  window.dispatchEvent(new Event("pageshow")); await flush(); assert.equal(f.bodies.length, 2);
  assert.equal(f.retries.inspect(f.service.getSnapshot("AubOS").scope).remaining, 2000);
  f.advance(1999); await flush(); assert.equal(f.bodies.length, 2);
  f.advance(1); await flush(); assert.equal(f.bodies.length, 3);
});

test("an uncertain transport timeout replays the original body and generation after one explicit bypass", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t), operation = await f.enqueue(); f.mode("timeout");
  const sending = f.service.synchronize("AubOS"); await flush(); assert.equal(f.bodies.length, 1);
  f.advance(8000); await sending;
  assert.equal(f.retries.inspect(f.service.getSnapshot("AubOS").scope).remaining, 1000);
  assert.equal(f.rows.outbox[0].status, "pending");
  f.mode(undefined); await f.service.retry("AubOS", operation.operationId);
  assert.equal(f.bodies.length, 2); assert.equal(f.bodies[0], f.bodies[1]);
  assert.equal(JSON.parse(f.bodies[1]).generation, f.state.syncGeneration);
});

for (const code of ["http-worker-busy", "http-worker-unavailable"]) test(`${code} retries only the immutable uncertain operation`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t), operation = await f.enqueue(); f.mode(code); await f.service.synchronize("AubOS");
  assert.equal(f.rows.outbox[0].status, "pending"); await f.service.synchronize("AubOS"); assert.equal(f.bodies.length, 1);
  f.mode(undefined); await f.service.retry("AubOS", operation.operationId);
  assert.equal(f.bodies.length, 2); assert.equal(f.bodies[0], f.bodies[1]);
});

test("explicit device recovery verifies the original attempt before delivery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t), operation = await f.enqueue(); f.mode("local-confirmation"); await f.service.synchronize("AubOS");
  assert.equal(f.service.getSnapshot("AubOS").storageRecovery, true);
  f.mode(undefined); await f.service.hydrate("AubOS", true);
  assert.deepEqual(f.recovered, [operation.operationId]); assert.equal(f.bodies.length, 1, "local verification does not itself dispatch");
  await f.service.synchronize("AubOS", true);
  assert.equal(f.bodies.length, 2); assert.equal(f.bodies[0], f.bodies[1]);
});

for (const reason of ["transient", "auth", "history"]) test(`local uncertainty recovers despite a later unrelated ${reason} failure`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t); await f.enqueue();
  f.mode("local-confirmation"); await f.service.synchronize("AubOS");
  const key = f.service.getSnapshot("AubOS").scope, original = f.rows.outbox[0].operation;
  f.retries.fail(key, new RetryFailure("Unrelated failure", reason));
  await f.service.hydrate("AubOS", true);
  assert.equal(f.retries.reasonToken(key, "storage", "local"), undefined);
  assert.equal(f.service.getSnapshot("AubOS").storageRecovery, false);
  assert.equal(f.bodies.length, 1); assert.equal(f.rows.outbox[0].operation, original);
  if (reason === "transient") assert.equal(f.retries.inspect(key).remaining, 1000);
  else assert.equal(f.retries.has(key, reason), true);
});

test("a newer local-origin failure survives late recovery of its predecessor", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t); await f.enqueue(); f.mode("local-confirmation"); await f.service.synchronize("AubOS");
  const key = f.service.getSnapshot("AubOS").scope, original = f.rows.outbox[0].operation, generation = f.rows.outbox[0].generation;
  const wait = f.holdRecovery(), recovery = f.service.hydrate("AubOS", true); await flush();
  f.retries.fail(key, Error("New local storage failure"), "local"); const token = f.retries.reasonToken(key, "storage", "local");
  wait.resolve(); await recovery;
  assert.equal(f.retries.reasonToken(key, "storage", "local"), token); assert.equal(f.bodies.length, 1);
  f.retries.fail(key, new RetryFailure("Separate auth pause", "auth"));
  f.retries.fail(key, new RetryFailure("Separate history pause", "history"));
  f.retries.fail(key, new RetryFailure("Separate server storage pause", "storage", 503, "storage-corrupt"));
  const serverToken = f.retries.reasonToken(key, "storage", "server");
  await f.service.hydrate("AubOS", true);
  assert.equal(f.retries.reasonToken(key, "storage", "local"), undefined, "a second explicit verification captures and settles the new local failure");
  assert.equal(f.retries.reasonToken(key, "storage", "server"), serverToken);
  assert.equal(f.retries.has(key, "auth"), true); assert.equal(f.retries.has(key, "history"), true);
  assert.equal(f.rows.outbox[0].operation, original); assert.equal(f.rows.outbox[0].generation, generation); assert.equal(f.bodies.length, 1);
});

test("a shared ProfileCache local failure registers device verification without a ReplicaService failure", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t); await f.enqueue();
  const stop = f.start(), cache = new ProfileCache(async () => Response.json(f.state), f.retries);
  cache.attachReplica({ getSnapshot: profile => f.service.getSnapshot(profile), ingest: async () => { throw Error("Shared cache local integrity failure"); } });
  await assert.rejects(cache.load("AubOS", true), /Shared cache local integrity failure/);
  const key = f.service.getSnapshot("AubOS").scope, original = f.rows.outbox[0].operation;
  assert.equal(f.service.getSnapshot("AubOS").storageRecovery, true);
  f.retries.fail(key, new RetryFailure("Keep history paused", "history"));
  await f.service.hydrate("AubOS", true);
  assert.equal(f.retries.reasonToken(key, "storage", "local"), undefined);
  assert.equal(f.retries.has(key, "history"), true); assert.equal(f.service.getSnapshot("AubOS").storageRecovery, false);
  assert.equal(f.bodies.length, 0); assert.equal(f.rows.outbox[0].operation, original); stop();
});

test("local worker codes cannot be mistaken for a server-storage failure", () => {
  const gate = new RetryGate(), error = Object.assign(Error("Local SQLite integrity failure"), { code: "storage-corrupt" });
  gate.fail("scope", error);
  assert.notEqual(gate.reasonToken("scope", "storage", "local"), undefined);
  assert.equal(gate.reasonToken("scope", "storage", "server"), undefined);
});

test("admission scope inheritance preserves the newest storage-origin token", () => {
  const gate = new RetryGate(); gate.fail("known", new RetryFailure("Old server failure", "storage", 503, "storage-corrupt"));
  const old = gate.reasonToken("known", "storage", "server");
  gate.fail("bootstrap", new RetryFailure("New server failure", "storage", 503, "storage-corrupt"));
  const current = gate.reasonToken("bootstrap", "storage", "server");
  gate.inherit("bootstrap", "known");
  assert.equal(gate.reasonToken("known", "storage", "server"), current);
  assert.equal(gate.recover("known", "storage", old, "server"), false);
  assert.equal(gate.recover("known", "storage", current, "server"), true);
});

test("local and server storage failures remain independently recoverable in the same scope", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t); await f.enqueue(); f.mode("local-confirmation"); await f.service.synchronize("AubOS");
  const key = f.service.getSnapshot("AubOS").scope, original = f.rows.outbox[0].operation;
  const stop = f.start(); f.retries.fail(key, new RetryFailure("Server storage unavailable", "storage", 503, "storage-corrupt"));
  const serverToken = f.retries.reasonToken(key, "storage", "server");
  await f.service.hydrate("AubOS", true);
  assert.equal(f.retries.reasonToken(key, "storage", "local"), undefined);
  assert.equal(f.retries.reasonToken(key, "storage", "server"), serverToken);
  f.mode(undefined); await f.service.verifyServerStorage("AubOS");
  assert.equal(f.retries.has(key, "storage"), false); assert.equal(f.rows.outbox[0].operation, original);
  assert.equal(f.bodies.length, 1); stop();
});

test("repaired server storage verifies read-only, retains local uncertainty and cannot release queued writes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t); await f.enqueue(); f.mode("storage"); await f.service.synchronize("AubOS");
  const key = f.service.getSnapshot("AubOS").scope, original = f.bodies[0], token = f.retries.reasonToken(key, "storage", "server");
  assert.equal(workspaceAccess.getSnapshot().canWrite, false); assert.equal(f.service.getSnapshot("AubOS").serverStorageRecovery, true);
  f.retries.fail(key, Error("Independent uncertain local commit"), "local");
  const local = f.retries.reasonToken(key, "storage", "local"), before = workspaceAccess.getSnapshot(), actions = f.actions.length;
  f.mode(undefined); const stop = f.start(); await f.service.verifyServerStorage("AubOS");
  assert.equal(f.retries.reasonToken(key, "storage", "server"), undefined); assert.notEqual(token, undefined);
  assert.equal(f.retries.reasonToken(key, "storage", "local"), local);
  assert.equal(workspaceAccess.getSnapshot(), before); assert.equal(f.bodies.length, 1);
  assert.deepEqual(f.actions.slice(actions), [], "the probe does not configure, pull, reconcile or publish normal read proof");
  f.retries.recover(key, "storage", local, "local");
  f.advance(120000); window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("pageshow")); await flush();
  assert.equal(f.bodies.length, 1, "timers and reactive foreground cannot flush after verification");
  f.admit(); await f.service.synchronize("AubOS"); assert.equal(f.bodies.length, 1, "even a stray live proof cannot bypass the recovery latch");
  f.service.completeExplicitAdmission("AubOS"); await f.service.synchronize("AubOS", true);
  assert.equal(f.bodies.length, 2); assert.equal(f.bodies[1], original); stop();
});

for (const change of ["scope", "incarnation", "session", "generation", "server-token"]) test(`late server verification rejects ${change} changes without clearing its failure`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t); await f.enqueue(); f.mode("storage"); await f.service.synchronize("AubOS");
  f.mode(undefined); const key = f.service.getSnapshot("AubOS").scope, wait = f.holdRead(), stop = f.start();
  const probe = f.service.verifyServerStorage("AubOS"); const rejected = assert.rejects(probe); await flush();
  if (change === "scope") workspaceAccess.manage("portable");
  else if (change === "incarnation") window.dispatchEvent(new Event("pagehide"));
  else if (change === "session") f.bumpSession();
  else if (change === "generation") { f.rows.metadata.generation = "another-local-history"; f.rows.metadata.body = JSON.stringify({ ...f.state, syncGeneration: "another-local-history" }); await f.service.hydrate("AubOS"); }
  else f.retries.fail(key, new RetryFailure("New server failure", "storage", 503, "storage-corrupt"));
  const token = f.retries.reasonToken(key, "storage", "server"); wait.resolve(); await rejected;
  assert.equal(f.retries.reasonToken(key, "storage", "server"), token); assert.equal(f.bodies.length, 1); stop();
});

test("verification of another server generation enters history review without importing it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t); await f.enqueue(); f.mode("storage"); await f.service.synchronize("AubOS");
  const key = f.service.getSnapshot("AubOS").scope, original = f.rows.outbox[0].operation, generation = f.rows.outbox[0].generation;
  f.mode(undefined); f.remoteGeneration("different-server-history"); const actions = f.actions.length;
  await assert.rejects(f.service.verifyServerStorage("AubOS"), { reason: "history" });
  assert.equal(f.retries.has(key, "history"), true); assert.equal(f.retries.has(key, "storage"), true);
  assert.equal(f.service.getSnapshot("AubOS").historyChanged, true);
  assert.deepEqual(f.actions.slice(actions), []); assert.equal(f.rows.outbox[0].operation, original); assert.equal(f.rows.outbox[0].generation, generation); assert.equal(f.bodies.length, 1);
});

test("the actual server-storage recovery control performs only scoped verification", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t); await f.enqueue(); f.mode("storage"); await f.service.synchronize("AubOS"); f.mode(undefined);
  const source = await readFile(new URL("../web/application/pending-changes.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {}, jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, { exports, document, require(name) {
    if (name === "react") return { useState: initial => [initial, () => {}], useRef: () => ({ current: null }) };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name.endsWith("profile-cache")) return { profileReplica: f.service };
    if (name.endsWith("sync-contract.ts")) return { RECORD_FIELDS: {} };
    return {};
  } });
  const snapshot = { ...f.service.getSnapshot("AubOS"), queue: [] }, before = workspaceAccess.getSnapshot();
  const tree = exports.PendingChanges({ profile: "AubOS", snapshot, reconnect: () => assert.fail("verification is separately owned") });
  const nodes = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  nodes(tree).find(node => node.type === "button" && node.props.children === "Verify server storage").props.onClick(); await flush();
  assert.equal(f.service.getSnapshot("AubOS").serverStorageRecovery, false);
  assert.equal(workspaceAccess.getSnapshot(), before); assert.equal(f.bodies.length, 1);
  window.dispatchEvent(new Event("pageshow")); await flush(); assert.equal(f.bodies.length, 1);
});

test("a newer scoped failure while session renewal awaits prevents subsequent delivery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t); await f.enqueue(); const waiting = f.holdSession();
  const running = f.service.synchronize("AubOS"); await flush();
  f.retries.fail(f.service.getSnapshot("AubOS").scope, network());
  waiting.resolve(); await running;
  assert.equal(f.bodies.length, 0); assert.equal(f.retries.inspect(f.service.getSnapshot("AubOS").scope).remaining, 1000);
});

test("a fresh admitted foreground request resumes after joining a retired pipeline without waiting for healthy polling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t); await f.enqueue();
  const stop = f.start(), session = f.holdSession(), retired = f.service.synchronize("AubOS"); await flush();
  assert.equal(f.sessions(), 1); f.admit(); await retired; await flush();
  assert.equal(f.sessions(), 2, "the current foreground owner retains its request after the old epoch retires");
  session.resolve(); await flush();
  assert.equal(f.bodies.length, 1); assert.equal(f.rows.outbox[0].status, "accepted"); stop();
});

for (const reason of ["auth", "history", "storage"]) test(`device recovery cannot clear a newer ${reason} authority failure`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t); await f.enqueue(); f.mode("local-confirmation"); await f.service.synchronize("AubOS");
  const key = f.service.getSnapshot("AubOS").scope;
  f.retries.fail(key, new RetryFailure("New authority failure", reason, reason === "storage" ? 503 : undefined, reason === "storage" ? "storage-corrupt" : undefined));
  await f.service.hydrate("AubOS", true);
  assert.equal(f.retries.inspect(key).paused, reason);
  await assert.rejects(f.service.synchronize("AubOS", true)); assert.equal(f.bodies.length, 1);
});

test("body deadlines and caller cancellation remain distinct, including a late body completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const body = deferred();
  const read = readJsonWithDeadline("/api/session", async () => ({ ok: true, json: () => body.promise }));
  t.mock.timers.tick(8000);
  await assert.rejects(read, { reason: "transient" });
  body.resolve({ token: "late" }); await flush();
  const owner = new AbortController();
  const other = readJsonWithDeadline("/api/session", async () => new Promise(() => {}), 8000, owner.signal);
  owner.abort(); await assert.rejects(other, { reason: "cancelled" });
});

test("a hidden document cannot reconcile a late body or rearm until a new visible lifecycle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t); await f.enqueue(); const body = f.holdBody(), stop = f.start(); t.after(stop);
  const sending = f.service.synchronize("AubOS"); await flush(); assert.equal(f.bodies.length, 1);
  document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
  await sending; body.resolve({ confirmed: true }); await flush(); f.advance(120000); await flush();
  assert.equal(f.rows.outbox[0].status, "pending"); assert.equal(f.bodies.length, 1);
  assert.equal(f.retries.inspect(f.service.getSnapshot("AubOS").scope).failures, 0);
  f.mode(undefined); document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"));
  await f.service.synchronize("AubOS"); assert.equal(f.bodies.length, 2); assert.equal(f.bodies[0], f.bodies[1]);
});

for (const mode of ["auth", "storage", "history", "validation", "local-confirmation", "http-policy-changed", "http-policy-unsupported"]) test(`${mode} pauses automatic and explicit unchanged delivery`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t), operation = await f.enqueue(); f.mode(mode); await f.service.synchronize("AubOS");
  const stop = f.start(); t.after(stop);
  f.advance(120000); window.dispatchEvent(new Event("online")); await f.service.synchronize("AubOS"); await flush();
  assert.equal(f.bodies.length, 1);
  await assert.rejects(f.service.retry("AubOS", operation.operationId));
  await assert.rejects(f.service.synchronize("AubOS", true));
  assert.equal(f.bodies.length, 1);
  if (mode === "auth") { f.mode(undefined); f.admit(); await f.service.synchronize("AubOS"); assert.equal(f.bodies.length, 2); assert.equal(f.bodies[0], f.bodies[1]); }
});

for (const event of ["pagehide", "offline", "hidden", "scope", "device", "stop"]) test(`late session completion after ${event} cannot fetch or rearm`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t); await f.service.hydrate("AubOS"); const wait = f.holdSession(), stop = f.start(); t.after(stop);
  const running = f.service.synchronize("AubOS"); await flush(); assert.equal(f.sessions(), 1);
  if (event === "hidden") { document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange")); }
  else if (event === "scope") workspaceAccess.manage("portable");
  else if (event === "device") { f.scope.readEpoch++; workspaceAccess.storageChanged({ ...f.scope, type: "READS_CLEARED" }); }
  else if (event === "stop") stop();
  else window.dispatchEvent(new Event(event));
  assert.equal(f.signals[0].aborted, true);
  wait.resolve(); await running; f.advance(120000); await flush();
  assert.deepEqual(f.fetches, []); assert.equal(f.sessions(), 1);
});

test("session leases coalesce forced renewals and cancel only their owned share", async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; });
  workspaceAccess.manage("private");
  const identity = { installationId: randomUUID(), variant: "private" }, scope = { ...identity, readEpoch: 0, draftEpoch: 0 };
  workspaceAccess.admitOnline({ ...identity, schema: 1, profiles: ["AubOS"], verifiedAt: 1 }, scope); workspaceAccess.setProfile("AubOS");
  let calls = 0, signal;
  const wait = deferred(); globalThis.fetch = async (_url, options) => { calls++; signal = options.signal; return wait.promise; };
  const a = new AbortController(), b = new AbortController();
  const first = loadSession(true, { signal: a.signal }), second = loadSession(true, { signal: b.signal });
  a.abort(); await assert.rejects(first, error => retryReason(error) === "cancelled");
  assert.equal(signal.aborted, false); assert.equal(calls, 1);
  wait.resolve(Response.json({ ...identity, token: "synthetic", profiles: ["AubOS"] }));
  assert.equal((await second).installationId, identity.installationId);
  const next = deferred(); globalThis.fetch = async (_url, options) => { signal = options.signal; return next.promise; };
  const c = new AbortController(), retired = loadSession(true, { signal: c.signal }); c.abort();
  await assert.rejects(retired, error => retryReason(error) === "cancelled"); assert.equal(signal.aborted, true);
  next.resolve(Response.json({ ...identity, token: "retired", profiles: ["AubOS"] })); await flush();
});

test("forced profile reads share delivery backoff and cannot reset it through session renewal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t); await f.service.hydrate("AubOS");
  let calls = 0;
  const cache = new ProfileCache(async () => { calls++; throw Error("Connection refused"); }, f.retries);
  await assert.rejects(cache.load("AubOS", true));
  await assert.rejects(cache.load("AubOS", true), RetryDeferred);
  await f.service.synchronize("AubOS"); assert.equal(calls, 1); assert.equal(f.sessions(), 0);
  f.admit(); await assert.rejects(cache.load("AubOS", true), RetryDeferred);
  assert.equal(calls, 1);
  f.advance(1000); await assert.rejects(cache.load("AubOS", true)); assert.equal(calls, 2);
});

test("session renewal itself obeys auth pause and allows only explicit admission to verify a replacement token", async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; });
  const f = fixture(t); let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("Session expired", { status: 403 }); };
  await assert.rejects(loadSession(true), { reason: "auth" });
  for (let n = 0; n < 10; n++) await assert.rejects(loadSession(true), RetryDeferred);
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls++; return Response.json({ ...f.identity, profiles: ["AubOS"], token: "renewed" }); };
  await loadSession(true, { explicit: true, admission: true });
  assert.equal(calls, 2);
  await assert.rejects(loadSession(true), RetryDeferred, "a token alone does not establish admission");
});

test("a session ticket captured before a newer failure cannot start a late renewal", async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; }); let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("Unexpected transport"); };
  const key = `private/${randomUUID()}/AubOS/owner`, ticket = retryGate.begin(key);
  retryGate.fail(key, network());
  await assert.rejects(loadSession(true, { attempt: ticket }), RetryDeferred);
  assert.equal(calls, 0);
});

test("a scoped failure during a profile read ticket await prevents the later fetch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t); let calls = 0;
  const cache = new ProfileCache(async () => { calls++; return Response.json(f.state); }, f.retries);
  const loading = cache.load("AubOS", true);
  f.retries.fail(`private/${f.identity.installationId}/AubOS/owner`, network());
  await assert.rejects(loading, RetryDeferred); assert.equal(calls, 0);
});

test("an initially offline lifecycle owns no retry timer until the browser resumes online", async t => {
  const f = fixture(t), old = Object.getOwnPropertyDescriptor(navigator, "onLine"), nativeTimer = globalThis.setTimeout;
  let timers = 0;
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  globalThis.setTimeout = (...args) => { timers++; return nativeTimer(...args); };
  t.after(() => { globalThis.setTimeout = nativeTimer; if (old) Object.defineProperty(navigator, "onLine", old); else delete navigator.onLine; });
  f.start(); window.dispatchEvent(new Event("pageshow")); await flush();
  assert.equal(timers, 0); assert.equal(f.sessions(), 0);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  window.dispatchEvent(new Event("online")); await flush();
  assert.equal(f.sessions(), 1); assert.ok(timers > 0);
});
