import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { workspaceAccess } from "../web/application/offline-access.ts";
import { RetryGate, retryScope } from "../web/application/retry-gate.ts";

const source = await readFile(new URL("../web/application/profile-cache.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText.replaceAll('"./offline-access.ts"', JSON.stringify(new URL("../web/application/offline-access.ts", import.meta.url).href)).replaceAll('"./offline-store.ts"', JSON.stringify(new URL("../web/application/offline-store.ts", import.meta.url).href)).replaceAll('"./replica-service.ts"', JSON.stringify(new URL("../web/application/replica-service.ts", import.meta.url).href));
const { ProfileCache } = await import(`data:text/javascript;base64,${Buffer.from(js.replaceAll('"./retry-gate.ts"', JSON.stringify(new URL("../web/application/retry-gate.ts", import.meta.url).href))).toString("base64")}`);
const state = (profile, revision, title) => ({ profile, revision, goals: [{ title }], tasks: [], recommendations: [], events: [] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function freshReadEvidenceTest() {
  const identity = { installationId: "11111111-1111-4111-8111-111111111111", variant: "private" };
  const scope = { ...identity, readEpoch: 0, draftEpoch: 0 };
  workspaceAccess.manage("private");
  workspaceAccess.admitOnline({ ...identity, schema: 1, profiles: ["AubOS"], verifiedAt: 1 }, scope);
  workspaceAccess.setProfile("AubOS");
  const ticket = workspaceAccess.getSnapshot(), response = deferred();
  const cached = { ...state("AubOS", 1, "Local projection"), syncGeneration: "current-history" };
  let local = { ready: true, serverGeneration: "current-history", state: cached };
  const cache = new ProfileCache(() => response.promise);
  cache.attachReplica({ getSnapshot: () => local });
  cache.writeReplica("AubOS", cached);
  assert.equal(cache.canConfirmLive("AubOS", ticket), false, "a cached document is not admission evidence");
  const request = cache.load("AubOS", true);
  cache.writeReplica("AubOS", cached); // This publication wins the display race.
  response.resolve(Response.json({ ...cached, revision: 2 }));
  await request;
  assert.equal(cache.read("AubOS").saved, true);
  assert.equal(cache.read("AubOS").state.revision, 1, "read admission does not regress or replace the chosen display");
  assert.equal(cache.canConfirmLive("AubOS", ticket), true);
  local = { ...local, historyChanged: true };
  assert.equal(cache.canConfirmLive("AubOS", ticket), false);
  local = { ...local, historyChanged: false, serverGeneration: "different-history" };
  assert.equal(cache.canConfirmLive("AubOS", ticket), false);
  local = { ...local, serverGeneration: "current-history" };
  assert.equal(cache.canConfirmLive("LastResort", ticket), false);
  workspaceAccess.fail("Offline");
  assert.equal(cache.canConfirmLive("AubOS", ticket), false, "another connection cannot reuse prior admission evidence");
}

async function durableHydrationTest() {
  const identity = { installationId: "11111111-1111-4111-8111-111111111111", variant: "private" };
  const scope = { ...identity, readEpoch: 0, draftEpoch: 0 };
  workspaceAccess.manage("private");
  workspaceAccess.admitOnline({ ...identity, schema: 1, profiles: ["AubOS"], verifiedAt: 1 }, scope);
  workspaceAccess.setProfile("AubOS");
  const cache = new ProfileCache();
  cache.write("AubOS", state("AubOS", 0, "Older read"), false, false);
  const old = deferred(), current = state("AubOS", 1, "Durable record");
  let calls = 0;
  cache.attachReplica({ getSnapshot: () => ({ ready: false }), hydrate: () => ++calls === 1 ? old.promise : Promise.resolve(current) });
  const obsolete = cache.hydrate("AubOS");
  workspaceAccess.fail("Offline");
  assert.equal(await cache.hydrate("AubOS"), current);
  assert.equal(cache.read("AubOS").state.goals[0].title, "Durable record");
  old.resolve(undefined); await obsolete;
  assert.equal(cache.read("AubOS").state.goals[0].title, "Durable record");
  assert.equal(calls, 2);
}

async function managedAdmissionTest() {
  const identity = { installationId: "11111111-1111-4111-8111-111111111111", variant: "private" };
  const admission = { schema: 1, ...identity, profiles: ["AubOS"], verifiedAt: 1 };
  const requests = [];
  const cache = new ProfileCache(() => { const request = deferred(); requests.push(request); return request.promise; });
  workspaceAccess.manage("private");
  await assert.rejects(cache.load("AubOS"), /unavailable/);
  assert.equal(requests.length, 0);
  workspaceAccess.admitOnline(admission);
  workspaceAccess.setProfile("AubOS");
  const earlier = cache.load("AubOS");
  workspaceAccess.beginReconcile();
  requests[0].resolve(Response.json(state("AubOS", 1, "Earlier connection")));
  await assert.rejects(earlier, /older connection/);
  assert.equal(cache.read("AubOS").state, undefined);
  workspaceAccess.admitOnline(admission);
  const live = cache.load("AubOS");
  requests[1].resolve(Response.json(state("AubOS", 2, "Current installation")));
  await live;
  assert.equal(cache.read("AubOS").state.goals[0].title, "Current installation");
  workspaceAccess.admitOnline({ ...admission, installationId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(cache.read("AubOS").state, undefined);
  workspaceAccess.admitOnline({ ...admission, profiles: [] });
  await assert.rejects(cache.load("AubOS"), /unavailable/);
}

test("workspace projection metadata is explicit while canonical command replies stay full", async () => {
  let canonical = { source: "governed-registers", projection: "workspace-v1" };
  const cache = new ProfileCache(async () => Response.json({ ...state("AubOS", 42, "Projected"), canonical }));
  await cache.load("AubOS");
  assert.equal(cache.read("AubOS").state.canonical.source, "governed-registers");
  canonical = { source: "sqlite", projection: "workspace-v1" };
  await cache.load("AubOS", true);
  assert.equal(cache.read("AubOS").state.canonical.source, "sqlite");
  cache.write("AubOS", { ...state("AubOS", 1, "Saved"), canonical: { goals: [], tasks: [] } });
  assert.ok(Array.isArray(cache.read("AubOS").state.canonical.goals));
  canonical = { source: "governed-registers", projection: "unknown" };
  await assert.rejects(cache.load("AubOS", true), /Unsupported workspace projection/);
  assert.equal(cache.read("AubOS").state.goals[0].title, "Saved");
});

test("page changes share a request and profile caches never expose another profile", async () => {
  const requests = [];
  const cache = new ProfileCache(url => { const request = deferred(); requests.push({ url, ...request }); return request.promise; });
  const aubos = cache.load("AubOS");
  assert.equal(cache.load("AubOS"), aubos);
  const resort = cache.load("LastResort");
  assert.equal(cache.read("LastResort").state, undefined);
  requests[0].resolve(Response.json(state("AubOS", 700, "Private fixture")));
  await aubos;
  assert.equal(cache.read("LastResort").state, undefined);
  requests[1].resolve(Response.json(state("LastResort", 1, "Fictional fixture")));
  await resort;
  assert.equal(cache.read("AubOS").state.goals[0].title, "Private fixture");
  assert.equal((await cache.load("AubOS")).revision, 700);
  assert.deepEqual(requests.map(request => request.url), ["/api/aubos/state?view=workspace", "/api/lastresort/state?view=workspace"]);
});

test("AubOS external refresh and canonical mutation accept lower-valued digest revisions", async () => {
  const cache = new ProfileCache(async () => Response.json(state("AubOS", 3, "Externally refreshed")));
  cache.write("AubOS", state("AubOS", 999999, "Before refresh"));
  await cache.load("AubOS", true);
  assert.equal(cache.read("AubOS").state.goals[0].title, "Externally refreshed");
  assert.equal(cache.read("AubOS").loading, false);
  cache.write("AubOS", state("AubOS", 1, "Canonical mutation"));
  assert.equal(cache.read("AubOS").state.goals[0].title, "Canonical mutation");
});

test("older GET cannot overwrite a completed canonical command or publish its stale failure", async () => {
  const request = deferred();
  const cache = new ProfileCache(() => request.promise);
  const oldRead = cache.load("AubOS");
  cache.write("AubOS", state("AubOS", 10, "Command completed"));
  request.resolve(Response.json(state("AubOS", 9000, "Old read")));
  assert.equal((await oldRead).goals[0].title, "Command completed");
  assert.equal(cache.read("AubOS").state.goals[0].title, "Command completed");
  const failed = deferred();
  const other = new ProfileCache(() => failed.promise);
  const pending = other.load("AubOS");
  other.write("AubOS", state("AubOS", 3, "Saved"));
  failed.reject(new Error("Stale failure"));
  assert.equal((await pending).goals[0].title, "Saved");
  assert.equal(other.read("AubOS").error, undefined);
});

test("forced refreshes settle out of order without overwriting the newest request", async () => {
  const requests = [];
  const cache = new ProfileCache(() => { const request = deferred(); requests.push(request); return request.promise; });
  const old = cache.load("FreedOS");
  const fresh = cache.load("FreedOS", true);
  requests[1].resolve(Response.json(state("FreedOS", 2, "Fresh")));
  await fresh;
  requests[0].resolve(Response.json(state("FreedOS", 8000, "Old")));
  await old;
  assert.equal(cache.read("FreedOS").state.goals[0].title, "Fresh");
});

test("wrong-profile replies are rejected and failures remain retryable", async () => {
  let wrong = true;
  const cache = new ProfileCache(async () => Response.json(state(wrong ? "AubOS" : "LastResort", 1, "Fixture")));
  await assert.rejects(cache.load("LastResort"), /Installation mismatch/);
  assert.equal(cache.read("LastResort").state, undefined);
  wrong = false;
  await cache.load("LastResort");
  assert.equal(cache.read("LastResort").state.profile, "LastResort");
});

test("destination reads deduplicate within TTL and refresh retained records after TTL", async t => {
  const now = Date.now;
  let time = now();
  Date.now = () => time;
  t.after(() => { Date.now = now; });
  const requests = [];
  const cache = new ProfileCache(() => { const request = deferred(); requests.push(request); return request.promise; });
  const initial = cache.load("AubOS");
  requests[0].resolve(Response.json(state("AubOS", 9000, "Initial records")));
  await initial;
  time += 29_999;
  await cache.load("AubOS");
  await cache.load("AubOS");
  assert.equal(requests.length, 1, "Warm client destinations should reuse planning state");
  time += 2;
  const refresh = cache.load("AubOS");
  assert.equal(requests.length, 2);
  assert.equal(cache.read("AubOS").state.goals[0].title, "Initial records", "Freshness must not blank the screen");
  assert.equal(cache.load("AubOS"), refresh, "Simultaneous destinations share the background refresh");
  requests[1].resolve(Response.json(state("AubOS", 1, "Externally changed")));
  await refresh;
  assert.equal(cache.read("AubOS").state.goals[0].title, "Externally changed");
});

// Run after the legacy cache cases; managed authority deliberately stays sticky.
test("an older response is rejected before it can enter persistent replica metadata", async () => {
  const pending = deferred(), ingested = [];
  const cache = new ProfileCache(() => pending.promise);
  cache.attachReplica({ overlay: (_profile, value) => value,
    ingest: async (_profile, value) => { ingested.push(value.revision); return value; },
    getSnapshot: () => ({ serverRevision: 6 }) });
  const old = cache.load("AubOS");
  cache.write("AubOS", state("AubOS", 6, "Newer canonical save"));
  pending.resolve(Response.json(state("AubOS", 5, "Delayed response")));
  await old;
  assert.deepEqual(ingested, [], "The delayed response must never reach replica ingestion");
  assert.equal(cache.read("AubOS").state.revision, 6);
});

test("managed reads wait for admission and an earlier connection cannot publish after resume or identity replacement", managedAdmissionTest);
test("a cached read cannot prevent retrying durable hydration after a connection change", durableHydrationTest);
test("fresh server read evidence survives a racing replica display without granting cached or foreign history authority", freshReadEvidenceTest);

test("a handled hydration failure creates no orphan rejection and permits retry", async () => {
  const identity = { installationId: "11111111-1111-4111-8111-111111111111", variant: "private" };
  workspaceAccess.manage("private");
  workspaceAccess.admitOnline({ ...identity, schema: 1, profiles: ["AubOS"], verifiedAt: 1 }, { ...identity, readEpoch: 0, draftEpoch: 0 });
  workspaceAccess.setProfile("AubOS");
  const cache = new ProfileCache(), current = state("AubOS", 1, "Recovered hydration");
  let calls = 0;
  cache.attachReplica({ getSnapshot: () => ({ ready: false }), hydrate: async () => {
    if (++calls === 1) throw Error("Interrupted hydration");
    return current;
  } });
  await assert.rejects(cache.hydrate("AubOS"), /Interrupted hydration/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await cache.hydrate("AubOS"), current);
  assert.equal(calls, 2);
});

function ingestionFixture() {
  const identity = { installationId: "11111111-1111-4111-8111-111111111111", variant: "private" };
  const scope = { ...identity, readEpoch: 0, draftEpoch: 0 };
  workspaceAccess.manage("private");
  workspaceAccess.admitOnline({ ...identity, schema: 1, profiles: ["AubOS"], verifiedAt: 1 }, scope);
  workspaceAccess.setProfile("AubOS");
  const ingestions = [], reads = [];
  const retries = new RetryGate(() => 0, () => 0);
  const cache = new ProfileCache(() => { const request = deferred(); reads.push(request); return request.promise; }, retries);
  let historyChanged = false;
  cache.attachReplica({ overlay: (_profile, value) => value,
    ingest: (_profile, value) => { const request = deferred(); ingestions.push({ ...request, value }); return request.promise; },
    getSnapshot: () => ({ ready: true, historyChanged }) });
  const model = (revision, history = "same-history") => ({ ...state("AubOS", revision, `Revision ${revision}`), syncGeneration: history });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { cache, ingestions, reads, model, settle, retries, changeHistory: () => { historyChanged = true; } };
}

test("a newer canonical write owns ingestion even when the older completion settles first", async () => {
  const { cache, ingestions, model, settle } = ingestionFixture();
  cache.write("AubOS", model(5), false);
  cache.write("AubOS", model(6), false);
  ingestions[0].resolve(model(5)); await settle();
  assert.equal(cache.read("AubOS").state.revision, 6);
  cache.writeReplica("AubOS", model(4));
  ingestions[1].resolve(model(6)); await settle();
  assert.equal(cache.read("AubOS").state.revision, 6, "old completion cannot clear the newer ingestion owner");
});

for (const boundary of ["clear", "revoke", "connection", "history", "history-review"]) test(`canonical ingestion cannot publish after ${boundary}`, async () => {
  const { cache, ingestions, model, settle, changeHistory } = ingestionFixture();
  cache.write("AubOS", model(5), false);
  if (boundary === "clear") cache.clear();
  if (boundary === "revoke") workspaceAccess.admitOnline({ installationId: "11111111-1111-4111-8111-111111111111", variant: "private", schema: 1, profiles: [], verifiedAt: 2 });
  if (boundary === "connection") workspaceAccess.beginReconcile();
  if (boundary === "history") cache.writeReplica("AubOS", model(1, "restored-history"));
  if (boundary === "history-review") changeHistory();
  const before = cache.read("AubOS").state;
  ingestions[0].resolve(model(7)); await settle();
  assert.equal(cache.read("AubOS").state, before);
});

test("a new read retires ingestion, while cache hits and joined reads do not create owners", async () => {
  const { cache, ingestions, reads, model, settle } = ingestionFixture();
  cache.write("AubOS", model(5), false);
  await cache.load("AubOS");
  assert.equal(reads.length, 0, "a warm cache hit does not start a new read");
  cache.writeReplica("AubOS", model(4));
  ingestions[0].resolve(model(5)); await settle();
  assert.equal(cache.read("AubOS").state.revision, 5);
  cache.write("AubOS", model(6), false);
  const read = cache.load("AubOS", true);
  assert.equal(cache.load("AubOS", true), read);
  ingestions[1].resolve(model(6)); await settle();
  assert.equal(cache.read("AubOS").loading, true, "old ingestion cannot replace the newer read owner");
  reads[0].resolve(Response.json(model(7))); await settle();
  ingestions[2].resolve(model(7));
  await read;
  assert.equal(cache.read("AubOS").state.revision, 7);
});

test("a gate-rejected read cannot retire a confirmed ingestion", async () => {
  const { cache, ingestions, model, settle, retries, reads } = ingestionFixture();
  cache.write("AubOS", model(5), false);
  retries.fail(retryScope(workspaceAccess.getSnapshot(), "AubOS"), new TypeError("Synthetic network failure"));
  await assert.rejects(cache.load("AubOS", true));
  assert.equal(reads.length, 0);
  cache.writeReplica("AubOS", model(4));
  ingestions[0].resolve(model(5)); await settle();
  assert.equal(cache.read("AubOS").state.revision, 5);
});
