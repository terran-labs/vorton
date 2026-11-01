import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Store } from "../server/store.ts";
import { WorkspaceHttpHost, releaseWorkspaceResponse } from "../server/workspace-http-host.ts";
import { PortableWorkspaceExecutor } from "../server/workspace-http-runtime.ts";

async function fixture(t, limits = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vorton-http-worker-")));
  const target = { id: "portable", kind: "portable", root, profiles: ["Synthetic"] };
  const host = new WorkspaceHttpHost({ targets: [target], ...limits });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { root, target, host, store: new Store(root, target.profiles) };
}
const decode = result => JSON.parse(new TextDecoder().decode(result.bytes));
async function request(host, operation, options) {
  const result = await host.execute("portable", operation, options);
  try { return decode(result); } finally { result.release(); }
}

test("real portable worker returns the existing projections and encoded bytes", async t => {
  const { host, target } = await fixture(t), local = new PortableWorkspaceExecutor({ targets: [target], effects: false });
  for (const operation of [
    { kind: "state", profile: "Synthetic" }, { kind: "state", profile: "Synthetic", view: "replica" },
    { kind: "export", profile: "Synthetic" }, { kind: "review", profile: "Synthetic", session: true },
    { kind: "changes", profile: "Synthetic", after: 0 },
  ]) {
    const result = await host.execute("portable", operation);
    try {
      const expected = await local.execute("portable", operation);
      const actualValue = decode(result), expectedValue = decode(expected);
      if (operation.kind === "review" && operation.session) {
        assert.match(actualValue.sessionId, /^[a-f0-9-]{36}$/);
        assert.match(expectedValue.sessionId, /^[a-f0-9-]{36}$/);
        actualValue.sessionId = expectedValue.sessionId; // Packet preparation assigns a fresh identity.
      }
      assert.deepEqual(actualValue, expectedValue); assert.deepEqual(result.headers, expected.headers);
      assert.ok(result.bytes instanceof Uint8Array); assert.equal(result.status, 200);
    } finally { result.release(); }
  }
});

test("portable commands and sync retain receipts, original identities and history fences", async t => {
  const { host, store } = await fixture(t), initial = await request(host, { kind: "state", profile: "Synthetic" });
  const command = { requestId: randomUUID(), expectedRevision: initial.revision, expectedGeneration: initial.syncGeneration,
    action: "idea.create", payload: { fields: { title: "Synthetic retained idea" } } };
  const first = await request(host, { kind: "command", profile: "Synthetic", command });
  assert.deepEqual(await request(host, { kind: "command", profile: "Synthetic", command }), first);
  const operation = { operationId: randomUUID(), kind: "task", id: randomUUID(), action: "create", expectedRevision: 0, value: { title: "Synthetic task" } };
  const input = { protocol: "vorton.sync.v1", generation: initial.syncGeneration, operation };
  const receipt = await request(host, { kind: "sync", profile: "Synthetic", request: input });
  assert.deepEqual(await request(host, { kind: "sync", profile: "Synthetic", request: input }), receipt);
  const before = await store.read("Synthetic");
  assert.equal(before.events.length, 2); assert.equal(before.tasks.length, 1); assert.equal(before.ideas.length, 1);
  await store.adoptHistory("Synthetic", { requestId: randomUUID(), expectedRevision: before.revision, expectedGeneration: initial.syncGeneration });
  await assert.rejects(request(host, { kind: "sync", profile: "Synthetic", request: input }), error => error.code === "history-changed");
});

test("unknown targets, profiles, operations and missing browser history fail closed", async t => {
  const { host, store } = await fixture(t);
  await assert.rejects(host.execute("other", { kind: "state", profile: "Synthetic" }), /Unknown.*target/);
  await assert.rejects(request(host, { kind: "state", profile: "Other" }), /Unknown installation/);
  await assert.rejects(request(host, { kind: "arbitrary", profile: "Synthetic" }), /Unknown.*operation/);
  await assert.rejects(request(host, { kind: "command", profile: "Synthetic", command: { requestId: randomUUID(), expectedRevision: 0, action: "idea.create", payload: { fields: { title: "Rejected" } } } }), error => error.code === "history-required");
  assert.equal((await store.read("Synthetic")).revision, 0);
});

test("exposed local policy changes reject enqueue and queued dispatch without running callbacks", async t => {
  const { host, store } = await fixture(t); host.bindPolicy("portable", store);
  const held = await host.execute("portable", { kind: "state", profile: "Synthetic" });
  const queued = host.execute("portable", { kind: "state", profile: "Synthetic" });
  let calls = 0; store.beforeCommand = () => { calls++; };
  held.release();
  await assert.rejects(queued, error => error.code === "http-policy-changed");
  await assert.rejects(request(host, { kind: "state", profile: "Synthetic" }), error => error.code === "http-policy-changed");
  assert.equal(calls, 0);
});
test("an initial portable callback is rejected before readiness or publication", async t => {
  const { host, store } = await fixture(t); let calls = 0;
  store.beforeCommand = () => { calls++; throw Error("Deny every command"); };
  assert.throws(() => host.bindPolicy("portable", store), error => error.code === "http-policy-unsupported");
  assert.equal(host.worker, undefined); assert.equal(calls, 0);
  assert.equal((await store.read("Synthetic")).ideas.length, 0);
  assert.throws(() => host.bindPolicy("portable", store, { kind: "installed-aubos-planning", directory: "aubos" }), error => error.code === "http-policy-unsupported");
});
test("pre-ready clean worker exit settles readiness and concurrent close", { timeout: 3000 }, async t => {
  const { host } = await fixture(t);
  // Hold initialization to make an actual clean pre-ready exit deterministic.
  const original = host.send.bind(host);
  host.send = message => { if (message.kind !== "initialize") original(message); };
  const ready = host.ready(), rejected = assert.rejects(ready, error => error.code === "http-worker-unavailable");
  const exit = host.worker.terminate(), closing = host.close();
  assert.equal(await exit, 0); await rejected; await closing;
});
test("worker readiness rejects a mismatched protocol and still closes", async t => {
  const { host } = await fixture(t), original = host.send.bind(host);
  host.send = message => original(message.kind === "initialize" ? { ...message, protocol: 999 } : message);
  await assert.rejects(host.ready(), error => error.code === "http-worker-protocol"); await host.close();
});

test("response permit prevents the next mutation from executing until delivery releases", async t => {
  const { host, store } = await fixture(t);
  const held = await host.execute("portable", { kind: "state", profile: "Synthetic" }), state = decode(held);
  const queued = request(host, { kind: "command", profile: "Synthetic", command: {
    requestId: randomUUID(), expectedRevision: 0, expectedGeneration: state.syncGeneration, action: "idea.create", payload: { fields: { title: "Queued" } },
  } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await store.read("Synthetic")).revision, 0);
  held.release(); held.release();
  assert.equal((await queued).revision, 1);
});

test("queue overload and queued abort do not dispatch; closing rejects queued work", async t => {
  const { host } = await fixture(t, { maximumQueuedJobs: 1 });
  const held = await host.execute("portable", { kind: "state", profile: "Synthetic" });
  const controller = new AbortController(), operation = { kind: "state", profile: "Synthetic" };
  const queued = host.execute("portable", operation, { signal: controller.signal });
  await assert.rejects(host.execute("portable", operation), error => error.code === "http-worker-busy");
  controller.abort(); await assert.rejects(queued, error => error.status === 499);
  const rejected = host.execute("portable", operation);
  const closing = host.close(); await assert.rejects(rejected, /closing before dispatch/);
  held.release(); await closing; await host.close();
});

test("worker close drains an owned result and works before start or after ready without listen", async t => {
  const { host } = await fixture(t); await host.ready(); await host.close(); await host.close();
  await assert.rejects(host.execute("portable", { kind: "state", profile: "Synthetic" }), /unavailable/);
  const neverStarted = new WorkspaceHttpHost({ targets: [{ id: "unused", kind: "portable", root: "/not-opened", profiles: ["Synthetic"] }] });
  await neverStarted.close();
});

test("response delivery releases once on finish, close, error or an already closed socket", () => {
  for (const event of ["finish", "close", "error"]) {
    let count = 0; const response = new EventEmitter();
    releaseWorkspaceResponse(response, { release: () => count++ });
    response.emit(event); response.emit("close"); assert.equal(count, 1);
    assert.equal(response.listenerCount("finish"), 0);
  }
  let count = 0; const response = Object.assign(new EventEmitter(), { destroyed: true });
  releaseWorkspaceResponse(response, { release: () => count++ }); assert.equal(count, 1);
});
