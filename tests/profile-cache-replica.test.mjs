import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { LocalReplica } from "../web/application/replica-sql.ts";
import { ReplicaService } from "../web/application/replica-service.ts";
import { RetryGate } from "../web/application/retry-gate.ts";
import { workspaceAccess } from "../web/application/offline-access.ts";

// Match profile-cache.test.mjs: erase types and resolve its actual dependencies,
// without replacing the cache, service, SQL replica or their publication logic.
const source = await readFile(new URL("../web/application/profile-cache.ts", import.meta.url), "utf8");
let javascript = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022,
} }).outputText;
for (const dependency of ["offline-access", "offline-store", "replica-service", "retry-gate"])
  javascript = javascript.replaceAll(JSON.stringify(`./${dependency}.ts`),
    JSON.stringify(new URL(`../web/application/${dependency}.ts`, import.meta.url).href));
const { ProfileCache } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("a confirmed Council decision survives an older synchronization and queued canonical ingestion", { timeout: 5000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "vorton-cache-replica-"));
  const database = new DatabaseSync(path.join(directory, "device.sqlite3"));
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const sql = new LocalReplica({
    run: (statement, parameters = []) => database.prepare(statement).run(...parameters),
    all: (statement, parameters = []) => database.prepare(statement).all(...parameters),
  });
  sql.initialize();
  const profile = "LastResort", generation = "33333333-3333-4333-8333-333333333333";
  const identity = { installationId: "11111111-1111-4111-8111-111111111111", variant: "portable" };
  const scope = { ...identity, readEpoch: 0, draftEpoch: 0 };
  workspaceAccess.manage("portable");
  workspaceAccess.admitOnline({ ...identity, schema: 1, profiles: [profile], verifiedAt: 1 }, scope);
  workspaceAccess.setProfile(profile);
  workspaceAccess.confirmLive(workspaceAccess.getSnapshot());

  const existingTask = freeze({ id: "existing-task", title: "Retain the synthetic baseline", version: 1 });
  const acceptedTask = freeze({ id: "accepted-task", title: "Run the synthetic rehearsal", version: 1, origin: "recommendation" });
  const revision4 = freeze({ schema: 1, profile, revision: 4, syncGeneration: generation, syncCursor: 13,
    tasks: [existingTask], goals: [], ideas: [], events: [],
    recommendations: [{ id: "recommendation", status: "pending", proposal: { title: acceptedTask.title } }],
  });
  const revision5 = freeze({ ...revision4, revision: 5, syncCursor: 14, tasks: [existingTask, acceptedTask],
    recommendations: [{ ...revision4.recommendations[0], status: "accepted", resultId: acceptedTask.id }],
  });
  const initialFeed = { protocol: "vorton.sync.v1", generation, cursor: 13, head: 13, more: false,
    changes: [{ cursor: 13, kind: "task", id: existingTask.id, revision: 1, deleted: false, value: existingTask }] };
  const oldPullReached = deferred(), releaseOldPull = deferred();
  const canonicalPullReached = deferred(), releaseCanonicalPull = deferred();
  const trace = [], requests = [], publications = [], ingestions = [];
  let phase = "initial", service;
  const cache = new ProfileCache(async url => { throw Error(`Unexpected workspace refresh or polling: ${url}`); });
  const client = { async request(key, action, payload = {}) {
    sql.authorize(key, payload.deviceEpoch);
    if (action === "workspace") return sql.read(key);
    if (action === "configure") {
      trace.push(`configure:${payload.state.revision}`);
      return sql.configure(key, payload.profile, payload.state);
    }
    if (action === "pull") {
      trace.push(`pull:${payload.after}->${payload.feed.head}`);
      return sql.pull(key, payload.after, payload.feed);
    }
    if (action === "next") return sql.next(key);
    throw Error(`Unexpected SQLite operation: ${action}`);
  } };
  service = new ReplicaService({ client, retries: new RetryGate(() => 0, () => 0),
    session: async () => ({ ...identity, token: "synthetic-session", profiles: [profile] }),
    publish: (publishedProfile, state) => {
      trace.push(`replica-publish:${state.revision}:${state.recommendations[0].status}`);
      cache.writeReplica(publishedProfile, state);
    },
    fetcher: async input => {
      const url = new URL(String(input), "http://synthetic");
      requests.push(url.pathname + url.search);
      if (url.pathname.endsWith("/state")) {
        assert.equal(phase, "old-sync", "only the admitted earlier synchronization reads metadata");
        trace.push("old-metadata-response:4");
        return Response.json(revision4);
      }
      assert.ok(url.pathname.endsWith("/changes"), `Unexpected URL: ${url}`);
      if (phase === "initial") return Response.json(initialFeed);
      if (url.searchParams.get("head") === "13") {
        assert.equal(url.searchParams.get("after"), "13");
        trace.push("old-pull-held"); oldPullReached.resolve();
        await releaseOldPull.promise;
        trace.push("old-pull-released");
        return Response.json({ ...initialFeed, changes: [] });
      }
      assert.equal(url.searchParams.get("head"), "14");
      assert.equal(url.searchParams.get("after"), "13");
      trace.push("canonical-pull-held"); canonicalPullReached.resolve();
      await releaseCanonicalPull.promise;
      trace.push("canonical-pull-released");
      return Response.json({ ...initialFeed, cursor: 14, head: 14,
        changes: [{ cursor: 14, kind: "task", id: acceptedTask.id, revision: 1, deleted: false, value: acceptedTask }] });
    },
  });
  cache.attachReplica(service);
  // Observe, rather than replace, the real ingestion promise that write() starts
  // without returning. This lets the final assertion wait for that exact work.
  const ingest = service.ingest.bind(service);
  service.ingest = (...args) => { const pending = ingest(...args); ingestions.push(pending); return pending; };
  cache.subscribe(profile, () => {
    const state = cache.read(profile).state;
    if (state) publications.push({ revision: state.revision, status: state.recommendations[0].status });
  });
  await service.ingest(profile, revision4);
  cache.writeReplica(profile, service.getSnapshot(profile).state);
  assert.equal(cache.read(profile).state.recommendations[0].status, "pending");
  const initialRows = sql.read(service.getSnapshot(profile).scope);
  assert.equal(initialRows.metadata.cursor, 13);

  phase = "old-sync";
  const oldSync = service.synchronize(profile);
  await oldPullReached.promise;
  const heldRows = sql.read(service.getSnapshot(profile).scope);
  assert.equal(JSON.parse(heldRows.stagedMetadata.body).revision, 4);
  trace.push("confirmed-cache-write:5");
  cache.write(profile, revision5, false);
  assert.equal(ingestions.length, 2, "cache.write starts exactly one real canonical ingestion");
  const canonicalIngest = ingestions[1];
  assert.equal(cache.read(profile).state.recommendations[0].status, "accepted", "the confirmation publishes before the old sync is released");
  assert.equal(JSON.parse(sql.read(service.getSnapshot(profile).scope).stagedMetadata.body).revision, 4,
    "canonical ingestion is still waiting for the earlier synchronization");

  releaseOldPull.resolve();
  await oldSync;
  await canonicalPullReached.promise;
  assert.ok(trace.includes("replica-publish:4:pending"), "the real old synchronization publishes its metadata");
  assert.equal(JSON.parse(sql.read(service.getSnapshot(profile).scope).stagedMetadata.body).revision, 5);
  releaseCanonicalPull.resolve();
  await canonicalIngest;

  const local = service.getSnapshot(profile), finalRows = sql.read(local.scope), displayed = cache.read(profile).state;
  t.diagnostic(JSON.stringify({ trace, publications, requests,
    finalReplica: { revision: local.state.revision, status: local.state.recommendations[0].status, cursor: finalRows.metadata.cursor },
    finalCache: { revision: displayed.revision, status: displayed.recommendations[0].status },
  }));
  assert.equal(local.state.recommendations[0].status, "accepted", "the actual ingestion has finished with accepted metadata");
  assert.equal(finalRows.metadata.cursor, 14);
  assert.equal(finalRows.metadata.generation, generation);
  assert.equal(local.state.syncGeneration, generation);
  assert.equal(displayed.syncGeneration, generation);
  assert.deepEqual(local.state.tasks, [existingTask, acceptedTask]);
  assert.deepEqual(displayed.tasks.find(task => task.id === existingTask.id), existingTask);
  assert.deepEqual(finalRows.outbox, [], "no optimistic edits or retry effects are fabricated by this fixture");
  assert.equal(requests.filter(url => url.includes("/state")).length, 1, "no later poll repairs the assertion");
  assert.equal(displayed.recommendations[0].status, "accepted",
    "the confirmed decision must remain visible after every admitted sync and ingestion promise settles, before polling");
  assert.deepEqual(displayed.tasks, [existingTask, acceptedTask]);
});
