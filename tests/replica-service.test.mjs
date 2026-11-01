import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.mjs";
import { LocalReplica } from "../web/application/replica-sql.ts";
import { ReplicaService } from "../web/application/replica-service.ts";
import { localCommand, recoveredLocalCommand } from "../web/application/local-command.ts";
import { workspaceAccess } from "../web/application/offline-access.ts";
import { RetryGate } from "../web/application/retry-gate.ts";

async function fixture(t, { seedTasks = 0, pageSize = 200, appendDuringDownload = false, misreportBoundary = null,
  capturedMetadata = false, metadataDuringDownload = false, initialDownloadInterruptAfter } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "vorton-replica-service-"));
  const server = new Store(root);
  const append = async () => {
    const state = await server.read("AubOS");
    await server.command("AubOS", { requestId: randomUUID(), expectedRevision: state.revision, action: "task.create",
      payload: { fields: { title: `Server task ${state.tasks.length + 1}` } } });
  };
  for (let index = 0; index < seedTasks; index++) await append();
  const database = new DatabaseSync(":memory:");
  const replica = new LocalReplica({ run: (sql, parameters = []) => { database.prepare(sql).run(...parameters); },
    all: (sql, parameters = []) => database.prepare(sql).all(...parameters) });
  replica.initialize();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const identity = { installationId: randomUUID(), variant: "private" };
  const scope = { ...identity, readEpoch: 0, draftEpoch: 0 };
  const admission = { ...identity, schema: 1, profiles: ["AubOS"], verifiedAt: Date.now() };
  const admit = () => { workspaceAccess.manage("private"); workspaceAccess.admitOnline(admission, scope); workspaceAccess.setProfile("AubOS"); workspaceAccess.confirmLive(workspaceAccess.getSnapshot()); };
  admit();
  let lostAcknowledgement = false, rejectSession = false, storageUnavailable = false, responseGate, replyReached = () => {};
  let loseLocalConfirmation = false, failReadAfterEnqueue = false, failNextRead = false;
  let loseAdoptionConfirmation = false, successfulDownloadPages = initialDownloadInterruptAfter;
  let time = 0;
  const retries = new RetryGate(() => time, () => 0);
  const requestBodies = [], rendered = [], changeRequests = [];
  const client = { async request(key, action, payload = {}) {
    if (storageUnavailable) throw Error("Device storage is unavailable. Keep your draft open.");
    replica.authorize(key, payload.deviceEpoch ?? { readEpoch: 0, draftEpoch: 0 });
    if (action === "workspace") {
      if (failNextRead) { failNextRead = false; throw Error("Temporary local read failure"); }
      return replica.read(key);
    }
    if (action === "configure") return replica.configure(key, payload.profile, payload.state);
    if (action === "begin-history-review") return replica.beginHistoryReview(key, payload.profile, payload.state, payload.reviewId, payload.replaceReviewId);
    if (action === "pull-history-review") return replica.pullHistoryReview(key, payload.reviewId, payload.after, payload.feed);
    if (action === "compare-history") return replica.historyComparison(key, payload.reviewId);
    if (action === "adopt-history") {
      const result = replica.adoptHistoryReview(key, payload.reviewId, payload.adoptionId, payload.comparison, payload.verifiedGeneration);
      if (loseAdoptionConfirmation) { loseAdoptionConfirmation = false; throw Error("Adoption committed but confirmation was lost"); }
      return result;
    }
    if (action === "history-adoption") return replica.historyAdoption(key, payload.adoptionId);
    if (action === "recover-attempt") return replica.recoverAttempt(key, payload.operationId);
    if (action === "record-identity") return replica.resolveRecordIdentity(key, payload.kind, payload.id, payload.generation);
    if (action === "review-record-identity") return replica.reviewRecordIdentity(key, payload.kind, payload.id, payload.generation, payload.review);
    if (action === "pull") return replica.pull(key, payload.after, payload.feed);
    if (action === "enqueue") {
      const result = replica.enqueue(key, payload.operation, payload.title, payload.record, payload.baselineVersion, payload.expectedGeneration);
      if (loseLocalConfirmation) { loseLocalConfirmation = false; throw Error("Local confirmation interrupted"); }
      if (failReadAfterEnqueue) { failReadAfterEnqueue = false; failNextRead = true; }
      return result;
    }
    if (action === "next") return replica.next(key);
    if (action === "mark") return replica.mark(key, payload.operationId, payload.status, payload.error);
    if (action === "reconcile") return replica.reconcile(key, payload.receipt);
    if (action === "resolve") return replica.resolve(key, payload.operationId, payload.choice, payload.resolutionId, payload.review);
    throw Error("Unsupported fixture request");
  } };
  const session = { ...identity, token: "transport-only-secret", profiles: ["AubOS"] };
  const service = new ReplicaService({ client, retries, session: async () => session, publish: (_profile, state) => rendered.push(state),
    fetcher: async (input, options = {}) => {
      const url = new URL(String(input), "http://fixture");
      if (url.pathname.endsWith("/changes")) {
        if (successfulDownloadPages !== undefined && successfulDownloadPages-- <= 0) { successfulDownloadPages = undefined; throw Error("Interrupted restored-history download"); }
        changeRequests.push(Object.fromEntries(url.searchParams));
        const feed = await server.changes("AubOS", Number(url.searchParams.get("after") ?? 0), pageSize, {
          head: url.searchParams.has("head") ? Number(url.searchParams.get("head")) : undefined,
          generation: url.searchParams.get("generation") ?? undefined,
        });
        if (metadataDuringDownload && changeRequests.length === 1) {
          const current = await server.read("AubOS");
          await server.command("AubOS", { requestId: randomUUID(), expectedRevision: current.revision, action: "settings.update",
            payload: { defaultOwner: "Owner", purpose: "Changed during download" } });
        }
        if (appendDuringDownload) await append();
        if (changeRequests.length === 2 && misreportBoundary === "head") feed.head++;
        if (changeRequests.length === 2 && misreportBoundary === "generation") feed.generation = randomUUID();
        return Response.json(feed);
      }
      if (url.pathname.endsWith("/state")) {
        const { requests, ...state } = await server.replicaState("AubOS"); return Response.json(state);
      }
      if (url.pathname.endsWith("/sync")) {
        requestBodies.push(options.body);
        if (rejectSession) return Response.json({ error: "Session expired. Reconnect." }, { status: 403 });
        const input = JSON.parse(options.body);
        const result = await server.sync("AubOS", input.operation, { generation: input.generation });
        if (responseGate) { const gate = responseGate; responseGate = undefined; replyReached(); await gate; }
        if (lostAcknowledgement) { lostAcknowledgement = false; throw Error("Simulated lost acknowledgement"); }
        return Response.json(result);
      }
      throw Error("Unexpected fixture URL");
    } });
  await service.ingest("AubOS", await (capturedMetadata ? server.replicaState("AubOS") : server.read("AubOS")));
  return { server, replica, service, identity, scope, admission, session, rendered, requestBodies, changeRequests, retries,
    advance(milliseconds) { time += milliseconds; },
    loseNextAcknowledgement() { lostAcknowledgement = true; }, rejectSession(value) { rejectSession = value; },
    failStorage() { storageUnavailable = true; },
    holdNextReply(gate, reached = () => {}) { responseGate = gate; replyReached = reached; },
    interruptLocalReply() { loseLocalConfirmation = true; }, failReadAfterSave() { failReadAfterEnqueue = true; },
    interruptAdoptionReply() { loseAdoptionConfirmation = true; }, interruptDownloadAfter(pages) { successfulDownloadPages = pages; },
    offline() { workspaceAccess.fail("Offline"); },
    reconnect() { workspaceAccess.admitOnline(admission, scope); workspaceAccess.confirmLive(workspaceAccess.getSnapshot()); } };
}
test("initial preparation finishes a bounded download while new server records arrive between every page", async t => {
  const f = await fixture(t, { seedTasks: 3, pageSize: 1, appendDuringDownload: true });
  const snapshot = f.service.getSnapshot("AubOS");
  assert.equal(snapshot.ready, true); assert.equal(snapshot.state.tasks.length, 3);
  assert.equal(f.changeRequests.length, 3);
  assert.equal(f.changeRequests[0].head, undefined);
  for (const query of f.changeRequests.slice(1)) { assert.equal(query.head, "3"); assert.match(query.generation, /^[a-f0-9-]{36}$/); }
  assert.equal((await f.server.read("AubOS")).tasks.length, 6);
  await f.service.synchronize("AubOS");
  assert.equal(f.service.getSnapshot("AubOS").ready, true);
  assert.equal(f.service.getSnapshot("AubOS").state.tasks.length, 6);
  assert.equal(f.changeRequests.length, 6);
});

async function adoptServerHistory(f) {
  const before = await f.server.replicaState("AubOS");
  return f.server.adoptHistory("AubOS", { requestId: randomUUID(), expectedGeneration: before.syncGeneration, expectedRevision: before.revision });
}
test("read clearing keeps server recovery reviewable and editor identity proof rejects stale records", async t => {
  const f = await fixture(t, { capturedMetadata: true }), operationId = randomUUID();
  const initial = f.service.getSnapshot("AubOS"), intent = localCommand(initial, "task.create", { fields: { title: "Accepted before read clearing" } }, operationId);
  await f.service.enqueue("AubOS", intent.operation, intent.title, intent.record);
  await f.service.synchronize("AubOS");
  const next = f.replica.clearDevice(initial.scope, f.scope, false);
  Object.assign(f.scope, next); f.reconnect();
  await f.service.hydrate("AubOS");
  assert.equal(f.service.getSnapshot("AubOS").serverGeneration, initial.state.syncGeneration);
  assert.equal(f.service.getSnapshot("AubOS").ready, false);
  await adoptServerHistory(f);
  await f.service.ingest("AubOS", await f.server.replicaState("AubOS"));
  assert.equal(f.service.getSnapshot("AubOS").historyChanged, true);
  const comparison = await f.service.reviewHistory("AubOS");
  await f.service.adoptHistory("AubOS", comparison, randomUUID());
  const snapshot = f.service.getSnapshot("AubOS"), row = snapshot.rows.find(row => row.id === intent.operation.id);
  const review = { id: row.id, generation: snapshot.state.syncGeneration, localRevision: row.revision, version: JSON.parse(row.body).version };
  const identity = await f.service.recordIdentity("AubOS", "task", intent.operation.id, initial.state.syncGeneration, review);
  assert.equal(identity.id, intent.operation.id); assert.equal(identity.generation, snapshot.state.syncGeneration);
  await assert.rejects(f.service.recordIdentity("AubOS", "task", intent.operation.id, initial.state.syncGeneration, { ...review, version: review.version + 1 }), /record changed during draft review/);
});
test("foreground restored-history review preserves unsent work and confirms a lost adoption reply once", async t => {
  const f = await fixture(t, { capturedMetadata: true });
  f.offline();
  const originalId = randomUUID(), intent = localCommand(f.service.getSnapshot("AubOS"), "task.create", { fields: { title: "Pending through server recovery" } }, originalId);
  await f.service.enqueue("AubOS", intent.operation, intent.title, intent.record, undefined, intent.generation);
  await adoptServerHistory(f); f.reconnect();
  await f.service.ingest("AubOS", await f.server.replicaState("AubOS"));
  assert.equal(f.service.getSnapshot("AubOS").historyChanged, true);
  const comparison = await f.service.reviewHistory("AubOS");
  assert.equal(f.service.getSnapshot("AubOS").historyReview.cursor, comparison.review.head);
  assert.equal(f.service.canEdit("AubOS"), false);
  assert.equal(f.requestBodies.length, 0);
  assert.equal(f.service.getSnapshot("AubOS").state.tasks[0].title, intent.title);
  f.interruptAdoptionReply();
  const adoptionId = randomUUID(), result = await f.service.adoptHistory("AubOS", comparison, adoptionId);
  assert.equal(result.recoveries, 1);
  assert.equal(f.service.getSnapshot("AubOS").adoptionCounter, 1);
  assert.equal(f.service.getSnapshot("AubOS").historyChanged, false);
  assert.equal(f.service.getSnapshot("AubOS").queue.filter(row => row.status === "conflict").length, 1);
  assert.deepEqual(await f.service.adoptHistory("AubOS", comparison, adoptionId), result);
  assert.equal(f.replica.exportDevice(f.service.getSnapshot("AubOS").scope).history_adoptions.length, 1);
  await f.service.synchronize("AubOS");
  assert.equal(f.requestBodies.length, 0, "adopting history must not replay the saved original intent");
  const proposal = f.service.getSnapshot("AubOS").queue.find(row => row.status === "conflict");
  const local = f.service.getSnapshot("AubOS").rows.find(row => row.id === proposal.record_id);
  await f.service.resolve("AubOS", proposal.operation_id, "local", { serverRevision: 0, localRevision: local.revision, queueTail: proposal.operation_id });
  await f.service.synchronize("AubOS");
  const saved = await f.service.recoverAttempt("AubOS", originalId);
  assert.notEqual(saved.identity.id, originalId);
  assert.equal(saved.saved.status, "accepted");
  assert.equal((await f.server.read("AubOS")).tasks.length, 1);
  assert.equal((await f.server.read("AubOS")).tasks[0].id, saved.identity.id);
  assert.deepEqual(await f.service.recordIdentity("AubOS", "task", originalId, intent.generation), saved.identity);
  const newer = { fields: { title: "Newer typing after the lost recovery confirmation" } };
  const confirmed = recoveredLocalCommand(f.service.getSnapshot("AubOS"), "task.create", newer, originalId, saved);
  assert.equal(confirmed.recordId, saved.identity.id); assert.equal(confirmed.retainedEdits, true); assert.equal(confirmed.serverAccepted, true);
  assert.equal(confirmed.savedVersion, 1);
  const next = localCommand(f.service.getSnapshot("AubOS"), "task.update", { id: confirmed.recordId, fields: newer.fields }, randomUUID(), confirmed.savedVersion, confirmed.generation);
  await f.service.enqueue("AubOS", next.operation, next.title, next.record, next.baselineVersion, next.generation);
  await f.service.synchronize("AubOS");
  assert.equal((await f.server.read("AubOS")).tasks.length, 1);
  assert.equal((await f.server.read("AubOS")).tasks[0].title, newer.fields.title);
  assert.deepEqual(f.requestBodies.map(body => JSON.parse(body).operation.action), ["create", "update"]);
});

test("history change then offline loss recovers through private read-only admission and explicit review", async t => {
  const f = await fixture(t, { capturedMetadata: true }); f.offline();
  const intent = localCommand(f.service.getSnapshot("AubOS"), "task.create", { fields: { title: "Keep the original operation through read-only recovery" } }, randomUUID());
  await f.service.enqueue("AubOS", intent.operation, intent.title, intent.record, undefined, intent.generation);
  const original = f.service.getSnapshot("AubOS").queue[0];
  await adoptServerHistory(f); f.reconnect(); await f.service.ingest("AubOS", await f.server.replicaState("AubOS")); f.offline();
  const before = workspaceAccess.getSnapshot(); assert.equal(before.onlineAdmission, false);
  await f.service.verifyAdmission("AubOS");
  assert.equal(workspaceAccess.getSnapshot(), before); assert.equal(f.requestBodies.length, 0);
  const comparison = await f.service.reviewHistory("AubOS");
  assert.equal(f.requestBodies.length, 0); assert.equal(workspaceAccess.getSnapshot().canWrite, false);
  const retained = f.service.getSnapshot("AubOS").queue.find(row => row.operation_id === original.operation_id);
  assert.equal(retained.operation, original.operation); assert.equal(retained.generation, original.generation);
  await f.service.adoptHistory("AubOS", comparison, randomUUID());
  await f.service.synchronize("AubOS");
  assert.equal(f.requestBodies.length, 0); assert.equal(workspaceAccess.getSnapshot().onlineAdmission, false);
  assert.equal(f.service.getSnapshot("AubOS").historyChanged, false);
});

test("interrupted restored-history downloads resume a fixed candidate while the old replica remains readable", async t => {
  const f = await fixture(t, { capturedMetadata: true, seedTasks: 3, pageSize: 1 });
  const original = f.service.getSnapshot("AubOS").state;
  await adoptServerHistory(f);
  await f.service.ingest("AubOS", await f.server.replicaState("AubOS"));
  f.interruptDownloadAfter(1);
  await assert.rejects(f.service.reviewHistory("AubOS"), /Interrupted restored-history download/);
  const paused = f.service.getSnapshot("AubOS");
  assert.equal(paused.historyReview.cursor, 1); assert.equal(paused.historyChanged, true); assert.equal(paused.reviewing, false);
  assert.deepEqual(paused.state.tasks, original.tasks);
  const comparison = await f.service.reviewHistory("AubOS");
  assert.equal(comparison.review.review_id, paused.historyReview.review_id);
  assert.equal(comparison.review.cursor, 3);
  assert.deepEqual(f.service.getSnapshot("AubOS").state.tasks, original.tasks);
  assert.equal(f.requestBodies.length, 0);
});

test("a second server recovery rejects confirmation and permits an explicit fresh comparison", async t => {
  const f = await fixture(t, { capturedMetadata: true, seedTasks: 1 });
  await adoptServerHistory(f);
  await f.service.ingest("AubOS", await f.server.replicaState("AubOS"));
  const first = await f.service.reviewHistory("AubOS"), original = f.service.getSnapshot("AubOS").state;
  const secondServer = await adoptServerHistory(f);
  await assert.rejects(f.service.adoptHistory("AubOS", first, randomUUID()), /changed again/);
  assert.equal(f.service.getSnapshot("AubOS").adoptionCounter, 0);
  assert.deepEqual(f.service.getSnapshot("AubOS").state.tasks, original.tasks);
  const second = await f.service.reviewHistory("AubOS", true);
  assert.notEqual(second.review.review_id, first.review.review_id);
  assert.equal(second.review.generation, secondServer.generation);
  await f.service.adoptHistory("AubOS", second, randomUUID());
  assert.equal(f.service.getSnapshot("AubOS").adoptionCounter, 1);
  assert.equal(f.service.getSnapshot("AubOS").state.syncGeneration, secondServer.generation);
});

test("expired or foreign session admission cannot start restored-history review", async t => {
  const f = await fixture(t, { capturedMetadata: true });
  await adoptServerHistory(f);
  await f.service.ingest("AubOS", await f.server.replicaState("AubOS"));
  const key = f.service.getSnapshot("AubOS").scope, before = f.replica.exportDevice(key);
  f.session.installationId = randomUUID();
  await assert.rejects(f.service.reviewHistory("AubOS"), /no longer admits/);
  assert.deepEqual(f.replica.exportDevice(key), before);
  assert.equal(f.requestBodies.length, 0);
});

test("fresh scoped admission can review a restored model before ordinary command authority resumes", async t => {
  const f = await fixture(t, { capturedMetadata: true });
  await adoptServerHistory(f);
  workspaceAccess.setProfile(null); workspaceAccess.setProfile("AubOS");
  assert.equal(workspaceAccess.getSnapshot().onlineAdmission, true);
  assert.equal(workspaceAccess.getSnapshot().canWrite, false);
  await f.service.ingest("AubOS", await f.server.replicaState("AubOS"));
  const comparison = await f.service.reviewHistory("AubOS"), adoptionId = randomUUID();
  assert.equal(workspaceAccess.getSnapshot().canWrite, false, "downloading a candidate grants no command authority");
  await f.service.adoptHistory("AubOS", comparison, adoptionId);
  assert.equal(workspaceAccess.getSnapshot().canWrite, true, "verified matching adoption permits ordinary admission to finish");
  workspaceAccess.setProfile(null); workspaceAccess.setProfile("AubOS");
  await f.service.adoptHistory("AubOS", comparison, adoptionId);
  assert.equal(workspaceAccess.getSnapshot().canWrite, false, "a historical receipt cannot establish current command authority");
  f.offline();
  const before = f.replica.exportDevice(f.service.getSnapshot("AubOS").scope);
  await assert.rejects(f.service.reviewHistory("AubOS"), /Reconnect to this workspace/);
  assert.deepEqual(f.replica.exportDevice(f.service.getSnapshot("AubOS").scope), before);
});

test("legacy drafts retain their text and need explicit history review before local command preparation", async t => {
  const f = await fixture(t, { capturedMetadata: true });
  const payload = { fields: { title: "Legacy retained text" } }, original = structuredClone(payload);
  assert.throws(() => localCommand(f.service.getSnapshot("AubOS"), "task.create", payload, randomUUID(), undefined, null), /no reviewed server history/);
  assert.deepEqual(payload, original);
  await adoptServerHistory(f); await f.service.ingest("AubOS", await f.server.replicaState("AubOS"));
  const comparison = await f.service.reviewHistory("AubOS");
  await f.service.adoptHistory("AubOS", comparison, randomUUID());
  assert.throws(() => localCommand(f.service.getSnapshot("AubOS"), "task.create", payload, randomUUID()), /no reviewed server history/);
  const current = f.service.getSnapshot("AubOS");
  assert.equal(localCommand(current, "task.create", payload, randomUUID(), undefined, current.state.syncGeneration).alreadySaved, false);
  assert.deepEqual(payload, original);
});

test("a reviewed discarded attempt cannot be reported saved or replayed from its retained capture", async t => {
  const f = await fixture(t, { capturedMetadata: true }); f.offline();
  const operationId = randomUUID(), payload = { fields: { title: "Text retained after choosing server history" } };
  const intent = localCommand(f.service.getSnapshot("AubOS"), "task.create", payload, operationId);
  await f.service.enqueue("AubOS", intent.operation, intent.title, intent.record, undefined, intent.generation);
  await adoptServerHistory(f); f.reconnect();
  await f.service.ingest("AubOS", await f.server.replicaState("AubOS"));
  const comparison = await f.service.reviewHistory("AubOS"); await f.service.adoptHistory("AubOS", comparison, randomUUID());
  const snapshot = f.service.getSnapshot("AubOS"), proposal = snapshot.queue.find(row => row.status === "conflict");
  const local = snapshot.rows.find(row => row.id === proposal.record_id);
  await f.service.resolve("AubOS", proposal.operation_id, "server", { serverRevision: 0, localRevision: local.revision, queueTail: proposal.operation_id });
  await f.service.synchronize("AubOS");
  const recovery = await f.service.recoverAttempt("AubOS", operationId), before = structuredClone(payload);
  assert.throws(() => recoveredLocalCommand(f.service.getSnapshot("AubOS"), "task.create", payload, operationId, recovery), /already resolved using server history/);
  assert.deepEqual(payload, before);
  assert.equal(f.requestBodies.length, 0);
  assert.equal((await f.server.read("AubOS")).tasks.length, 0);
});

test("page teardown fences follow-up downloads and foreground resumes the committed operation once", async t => {
  const f = await fixture(t, { capturedMetadata: true });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = new EventTarget(); globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let release, reached, stop = () => {}, sending;
  const gate = new Promise(resolve => { release = resolve; }), accepted = new Promise(resolve => { reached = resolve; });
  try {
    stop = f.service.start();
    f.holdNextReply(gate, reached);
    const operationId = randomUUID(), intent = localCommand(f.service.getSnapshot("AubOS"), "task.create", { fields: { title: "Accepted while closing" } }, operationId);
    await f.service.enqueue("AubOS", intent.operation, intent.title, intent.record);
    sending = f.service.synchronize("AubOS");
    await accepted;
    const downloads = f.changeRequests.length;
    window.dispatchEvent(new Event("pagehide"));
    release(); await sending;
    assert.equal(f.changeRequests.length, downloads, "a late confirmation must not start another fetch in the closing document");
    assert.equal((await f.server.read("AubOS")).tasks.length, 1);
    window.dispatchEvent(new Event("pageshow"));
    await f.service.synchronize("AubOS");
    assert.ok(f.changeRequests.length > downloads);
    assert.equal(f.service.getSnapshot("AubOS").state.tasks.length, 1);
    assert.equal(f.service.getSnapshot("AubOS").queue[0].operation_id, operationId);
    assert.equal(f.service.getSnapshot("AubOS").queue[0].status, "accepted");
    assert.equal(f.requestBodies.length, 2, "aborted acknowledgement is uncertain; reopen replays the identical operation");
    assert.equal(f.requestBodies[0], f.requestBodies[1]);
  } finally {
    release(); await sending?.catch(() => {}); stop();
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
  }
});
test("captured metadata stays with its record boundary and foreground sync refreshes independent metadata changes", async t => {
  const f = await fixture(t, { seedTasks: 3, pageSize: 1, appendDuringDownload: true, capturedMetadata: true, metadataDuringDownload: true });
  const first = f.service.getSnapshot("AubOS");
  assert.equal(first.ready, true); assert.equal(first.state.tasks.length, 3); assert.equal(first.state.settings.purpose, "");
  assert.equal(first.state.syncCursor, 3);
  for (const query of f.changeRequests) assert.equal(query.head, "3");
  assert.equal((await f.server.read("AubOS")).settings.purpose, "Changed during download");
  await f.service.synchronize("AubOS");
  const current = f.service.getSnapshot("AubOS");
  assert.equal(current.ready, true); assert.equal(current.state.tasks.length, 6);
  assert.equal(current.state.settings.purpose, "Changed during download"); assert.equal(current.state.syncCursor, 6);
  assert.equal(f.requestBodies.length, 0, "No local changes were needed to refresh metadata");
});
for (const misreportBoundary of ["head", "generation"]) test(`a changed ${misreportBoundary} between pages cannot publish a ready replica or advance its cursor`, async t => {
  const f = await fixture(t, { seedTasks: 3, pageSize: 1, misreportBoundary });
  const snapshot = f.service.getSnapshot("AubOS");
  assert.equal(snapshot.ready, false); assert.equal(f.service.canEdit("AubOS"), false);
  assert.equal(f.changeRequests.length, 2);
  const metadata = f.replica.read(snapshot.scope).metadata;
  assert.equal(metadata.cursor, 1); assert.equal(metadata.download_head, 3);
  assert.equal(Boolean(snapshot.historyChanged), misreportBoundary === "generation");
  assert.match(snapshot.error, misreportBoundary === "generation" ? /history changed/ : /changed its boundary/);
});
test("foreground synchronization resumes a partial initial download without clearing saved progress", async t => {
  const f = await fixture(t, { seedTasks: 3, pageSize: 1, initialDownloadInterruptAfter: 1 });
  assert.equal(f.service.getSnapshot("AubOS").ready, false);
  await f.service.synchronize("AubOS");
  assert.equal(f.service.getSnapshot("AubOS").ready, false, "an immediate event cannot bypass the interrupted download's deadline");
  f.advance(1000);
  await f.service.synchronize("AubOS");
  const snapshot = f.service.getSnapshot("AubOS"), metadata = f.replica.read(snapshot.scope).metadata;
  assert.equal(snapshot.ready, true); assert.equal(snapshot.state.tasks.length, 3);
  assert.equal(metadata.cursor, 3); assert.equal(metadata.download_head, 3); assert.equal(f.requestBodies.length, 0);
});
test("metadata ingestion waits for an in-flight synchronization and does not deadlock", { timeout: 3000 }, async t => {
  const f = await fixture(t), input = task("Held acknowledgement task");
  await f.service.enqueue("AubOS", input.operation, input.record.title, input.record);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.holdNextReply(gate);
  const syncing = f.service.synchronize("AubOS");
  while (!f.requestBodies.length) await new Promise(resolve => setImmediate(resolve));
  let ingested = false;
  const ingesting = f.service.ingest("AubOS", await f.server.replicaState("AubOS")).then(() => { ingested = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(ingested, false);
  release(); await Promise.all([syncing, ingesting]);
  assert.equal(f.service.getSnapshot("AubOS").ready, true);
  assert.equal(f.service.getSnapshot("AubOS").pending, 0); assert.equal(f.service.getSnapshot("AubOS").state.tasks.length, 1);
});
function task(title) {
  const id = randomUUID();
  return { operation: { operationId: randomUUID(), kind: "task", id, action: "create", expectedRevision: 0, value: { title } },
    record: { id, title, version: 1 } };
}
test("old-generation save identity remains recoverable while newer edits require a history review", async t => {
  const f = await fixture(t), input = task("Original accepted task");
  await f.service.enqueue("AubOS", input.operation, input.record.title, input.record);
  await f.service.synchronize("AubOS");
  const snapshot = f.service.getSnapshot("AubOS"), oldGeneration = snapshot.state.syncGeneration;
  const changed = { ...snapshot, state: { ...snapshot.state, syncGeneration: randomUUID() } };
  const recovered = localCommand(changed, "task.create", { fields: { title: "Newer retained typing" } }, input.operation.operationId, undefined, oldGeneration);
  assert.equal(recovered.alreadySaved, true); assert.equal(recovered.retainedEdits, true); assert.equal(recovered.serverAccepted, false);
  assert.equal(recovered.operation.id, input.operation.id);
  assert.throws(() => localCommand(changed, "task.update", { id: input.operation.id, fields: { title: "Stale draft" } }, randomUUID(), 1, oldGeneration), /Server history changed/);
});
function reviewFor(service, operationId) {
  const snapshot = service.getSnapshot("AubOS"), target = snapshot.queue.find(row => row.operation_id === operationId);
  const matches = row => row.kind === target.kind && (row.id ?? row.record_id) === target.record_id;
  return { serverRevision: snapshot.serverRows.find(matches)?.revision ?? 0,
    localRevision: snapshot.rows.find(matches).revision,
    queueTail: snapshot.queue.filter(row => matches(row) && !["accepted", "superseded"].includes(row.status)).at(-1).operation_id };
}

test("twenty offline edits stay visible through a lost acknowledgement and synchronize exactly once", async t => {
  const f = await fixture(t); f.offline();
  const inputs = Array.from({ length: 20 }, (_, index) => task(`Offline task ${index + 1}`));
  for (const input of inputs) await f.service.enqueue("AubOS", input.operation, input.record.title, input.record);
  assert.equal(f.requestBodies.length, 0);
  assert.equal(f.service.getSnapshot("AubOS").pending, 20);
  assert.equal(f.service.getSnapshot("AubOS").state.tasks.length, 20);
  const first = inputs[0];
  const update = { ...first.operation, operationId: randomUUID(), action: "update", expectedRevision: 1, value: { title: "Later local title" } };
  await f.service.enqueue("AubOS", update, "Later local title", { ...first.record, title: "Later local title", version: 2 }, 1);
  const afterEdit = f.rendered.length;
  f.reconnect(); f.loseNextAcknowledgement();
  await f.service.synchronize("AubOS");
  assert.equal((await f.server.read("AubOS")).tasks.length, 1);
  assert.equal(f.service.getSnapshot("AubOS").pending, 21);
  await f.service.synchronize("AubOS");
  assert.equal(f.requestBodies.length, 1, "automatic synchronization respects the lost-ack deadline");
  f.advance(1000);
  await f.service.synchronize("AubOS");
  const server = await f.server.read("AubOS");
  assert.equal(server.tasks.length, 20); assert.equal(server.events.length, 21);
  assert.equal(f.service.getSnapshot("AubOS").pending, 0);
  assert.ok(f.service.getSnapshot("AubOS").queue.every(row => row.status === "accepted"));
  assert.ok(f.rendered.slice(afterEdit).every(state => state.tasks.find(record => record.id === first.record.id)?.title === "Later local title"));
  assert.equal(f.requestBodies.length, 22, "One response was lost; only that exact operation repeats");
  const firstAttempt = JSON.parse(f.requestBodies[0]), retry = JSON.parse(f.requestBodies[1]);
  assert.deepEqual(firstAttempt, retry);
  assert.ok(!JSON.stringify(f.replica.inspect(f.service.getSnapshot("AubOS").scope)).includes("transport-only-secret"));
});

test("renewing admission during a confirmed reply resumes remaining work immediately", async t => {
  const f = await fixture(t); f.offline();
  const first = task("First"), second = task("Second");
  for (const input of [first, second]) await f.service.enqueue("AubOS", input.operation, input.record.title, input.record);
  let release;
  f.holdNextReply(new Promise(resolve => { release = resolve; }));
  f.reconnect();
  const syncing = f.service.synchronize("AubOS");
  for (let i = 0; f.requestBodies.length < 1 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.requestBodies.length, 1);
  f.reconnect(); release(); await syncing;
  await f.service.synchronize("AubOS");
  assert.equal((await f.server.read("AubOS")).tasks.length, 2);
  assert.equal(f.service.getSnapshot("AubOS").pending, 0);
  assert.equal(f.service.getSnapshot("AubOS").syncing, false);
});

test("storage loss disables editing without hiding the previously observed queue", async t => {
  const f = await fixture(t); f.offline();
  const input = task("Keep this local task");
  await f.service.enqueue("AubOS", input.operation, input.record.title, input.record);
  f.failStorage();
  await f.service.ingest("AubOS", await f.server.read("AubOS"));
  const snapshot = f.service.getSnapshot("AubOS");
  assert.equal(snapshot.ready, false);
  assert.equal(f.service.canEdit("AubOS"), false);
  assert.equal(snapshot.queue[0].title, input.record.title);
  assert.match(snapshot.error, /storage is unavailable/);
});

test("an interrupted local confirmation refreshes queue inspection before returning its uncertain outcome", async t => {
  const f = await fixture(t); f.offline();
  const input = task("Inspect interrupted save"); f.interruptLocalReply();
  await assert.rejects(f.service.enqueue("AubOS", input.operation, input.record.title, input.record), /confirmation interrupted/);
  const snapshot = f.service.getSnapshot("AubOS");
  assert.equal(snapshot.pending, 1); assert.equal(snapshot.queue[0].title, input.record.title);
  assert.equal(snapshot.state.tasks[0].id, input.record.id);
  assert.match(snapshot.error, /confirmation interrupted/);
});

test("a known durable save stays confirmed when its first inspection read fails", async t => {
  const f = await fixture(t); f.offline();
  const input = task("Durable despite read failure"); f.failReadAfterSave();
  const result = await f.service.enqueue("AubOS", input.operation, input.record.title, input.record);
  assert.equal(result.operationId, input.operation.operationId);
  assert.equal(f.service.getSnapshot("AubOS").pending, 1);
  assert.equal(f.rendered.at(-1).tasks[0].id, input.record.id);
});

test("editor commands preserve record identity and imported fields through offline edits and deletion", async t => {
  const f = await fixture(t); f.offline();
  const createId = randomUUID();
  let intent = localCommand(f.service.getSnapshot("AubOS"), "task.create", { fields: { title: "Capture" } }, createId);
  await f.service.enqueue("AubOS", intent.operation, intent.title, intent.record);
  assert.equal(intent.operation.id, createId);
  const original = intent.operation;
  intent = localCommand(f.service.getSnapshot("AubOS"), "task.update", { id: createId, fields: { title: "Newer text" } }, randomUUID(), 1);
  await f.service.enqueue("AubOS", intent.operation, intent.title, intent.record, intent.baselineVersion);
  const replay = localCommand(f.service.getSnapshot("AubOS"), "task.create", { fields: { title: "Capture" } }, createId);
  assert.deepEqual(replay.operation, original);
  await f.service.enqueue("AubOS", replay.operation, replay.title, replay.record);
  assert.equal(f.service.getSnapshot("AubOS").state.tasks.length, 1);
  assert.equal(f.service.getSnapshot("AubOS").state.tasks[0].title, "Newer text");
  assert.throws(() => localCommand(f.service.getSnapshot("AubOS"), "task.update", { id: createId, fields: { title: "Stale" } }, randomUUID(), 1), /older local version/);
  intent = localCommand(f.service.getSnapshot("AubOS"), "task.delete", { id: createId }, randomUUID(), 2);
  await f.service.enqueue("AubOS", intent.operation, intent.title, intent.record, intent.baselineVersion);
  assert.equal(f.service.getSnapshot("AubOS").state.tasks.length, 0);
  f.reconnect(); await f.service.synchronize("AubOS");
  assert.equal((await f.server.read("AubOS")).tasks.length, 0);
  assert.equal((await f.server.read("AubOS")).events.length, 3);
});

test("an interrupted local create resolves by operation ID without consuming newer capture text", async t => {
  const f = await fixture(t); f.offline();
  const operationId = randomUUID();
  const original = localCommand(f.service.getSnapshot("AubOS"), "task.create", { fields: { title: "Original capture" } }, operationId);
  await f.service.enqueue("AubOS", original.operation, original.title, original.record);
  // Treat its confirmation as lost, then reopen from the durable queue.
  await f.service.hydrate("AubOS");
  const resolved = localCommand(f.service.getSnapshot("AubOS"), "task.create", { fields: { title: "Newer capture" } }, operationId);
  assert.equal(resolved.alreadySaved, true);
  assert.equal(resolved.retainedEdits, true);
  assert.equal(resolved.savedVersion, 1);
  assert.equal(resolved.operation.id, operationId);
  const update = localCommand(f.service.getSnapshot("AubOS"), "task.update", { id: resolved.operation.id, fields: { title: "Newer capture" } }, randomUUID(), resolved.savedVersion);
  await f.service.enqueue("AubOS", update.operation, update.title, update.record, update.baselineVersion);
  assert.equal(f.service.getSnapshot("AubOS").state.tasks.length, 1);
  assert.equal(f.service.getSnapshot("AubOS").state.tasks[0].title, "Newer capture");
  f.reconnect(); await f.service.synchronize("AubOS");
  const server = await f.server.read("AubOS");
  assert.equal(server.tasks.length, 1); assert.equal(server.tasks[0].title, "Newer capture");
});

test("accepted but unconfirmed local saves remain resolvable after clearing read copies", async t => {
  const f = await fixture(t), operationId = randomUUID();
  const original = localCommand(f.service.getSnapshot("AubOS"), "task.create", { fields: { title: "Accepted original" } }, operationId);
  await f.service.enqueue("AubOS", original.operation, original.title, original.record);
  await f.service.synchronize("AubOS");
  assert.equal(f.service.getSnapshot("AubOS").pending, 0);
  const key = f.service.getSnapshot("AubOS").scope;
  const next = f.replica.clearDevice(key, f.scope, false);
  assert.equal(f.replica.read(key).metadata, null);
  assert.equal(f.replica.read(key).outbox[0].status, "accepted");
  Object.assign(f.scope, next); f.reconnect();
  await f.service.ingest("AubOS", await f.server.read("AubOS"));
  const resolved = localCommand(f.service.getSnapshot("AubOS"), "task.create", { fields: { title: "Newer retained text" } }, operationId);
  assert.equal(resolved.alreadySaved, true); assert.equal(resolved.savedVersion, 1); assert.equal(resolved.retainedEdits, true); assert.equal(resolved.serverAccepted, true);
  const update = localCommand(f.service.getSnapshot("AubOS"), "task.update", { id: resolved.operation.id, fields: { title: "Newer retained text" } }, randomUUID(), resolved.savedVersion);
  await f.service.enqueue("AubOS", update.operation, update.title, update.record, update.baselineVersion);
  await f.service.synchronize("AubOS");
  const server = await f.server.read("AubOS");
  assert.equal(server.tasks.length, 1); assert.equal(server.events.length, 2);
  assert.equal(server.tasks[0].title, "Newer retained text");
});

for (const choice of ["server", "local"]) test(`a ${choice} resolution cannot supersede local edits queued after its comparison`, async t => {
  const f = await fixture(t);
  let server = await f.server.command("AubOS", { requestId: randomUUID(), expectedRevision: 0, action: "task.create", payload: { fields: { title: "Original" } } });
  await f.service.ingest("AubOS", server); f.offline();
  const id = server.tasks[0].id;
  const first = localCommand(f.service.getSnapshot("AubOS"), "task.update", { id, fields: { title: "Reviewed local text" } }, randomUUID(), 1);
  await f.service.enqueue("AubOS", first.operation, first.title, first.record, first.baselineVersion);
  await f.server.command("AubOS", { requestId: randomUUID(), expectedRevision: server.revision, action: "task.update", payload: { id, fields: { title: "Server edit" } } });
  f.reconnect(); await f.service.synchronize("AubOS");
  const review = reviewFor(f.service, first.operation.operationId);
  f.offline();
  const later = localCommand(f.service.getSnapshot("AubOS"), "task.update", { id, fields: { title: "Unreviewed newer text" } }, randomUUID(), 2);
  await f.service.enqueue("AubOS", later.operation, later.title, later.record, later.baselineVersion);
  const before = f.replica.read(f.service.getSnapshot("AubOS").scope);
  await assert.rejects(f.service.resolve("AubOS", first.operation.operationId, choice, review), /local version changed/);
  await assert.rejects(f.service.resolve("AubOS", first.operation.operationId, choice, { ...review, localRevision: 3 }), /local version changed/);
  assert.deepEqual(f.replica.read(f.service.getSnapshot("AubOS").scope), before);
  assert.equal(f.service.getSnapshot("AubOS").state.tasks[0].title, "Unreviewed newer text");
});

for (const choice of ["server", "local"]) test(`a reviewed conflict can keep the ${choice} version without replaying its superseded intents`, async t => {
  const f = await fixture(t);
  let server = await f.server.command("AubOS", { requestId: randomUUID(), expectedRevision: 0, action: "task.create", payload: { fields: { title: "Original" } } });
  await f.service.ingest("AubOS", server); f.offline();
  const id = server.tasks[0].id;
  const first = localCommand(f.service.getSnapshot("AubOS"), "task.update", { id, fields: { title: "First local text" } }, randomUUID(), 1);
  await f.service.enqueue("AubOS", first.operation, first.title, first.record, first.baselineVersion);
  const later = localCommand(f.service.getSnapshot("AubOS"), "task.update", { id, fields: { title: "Later local text" } }, randomUUID(), 2);
  await f.service.enqueue("AubOS", later.operation, later.title, later.record, later.baselineVersion);
  await assert.rejects(f.service.resolve("AubOS", first.operation.operationId, choice, reviewFor(f.service, first.operation.operationId)), /confirmed failure or conflict/);
  server = await f.server.command("AubOS", { requestId: randomUUID(), expectedRevision: server.revision, action: "task.update", payload: { id, fields: { title: "Server text" } } });
  f.reconnect(); await f.service.synchronize("AubOS");
  assert.equal(f.service.getSnapshot("AubOS").queue[0].status, "conflict");
  const review = reviewFor(f.service, first.operation.operationId);
  await assert.rejects(f.service.resolve("AubOS", first.operation.operationId, choice, { ...review, serverRevision: 1 }), /server version changed/);
  await f.service.resolve("AubOS", first.operation.operationId, choice, review);
  await f.service.synchronize("AubOS");
  const expected = choice === "local" ? "Later local text" : "Server text";
  assert.equal(f.service.getSnapshot("AubOS").state.tasks[0].title, expected);
  assert.equal((await f.server.read("AubOS")).tasks[0].title, expected);
  assert.equal(f.service.getSnapshot("AubOS").pending, 0);
  assert.equal(f.service.getSnapshot("AubOS").queue.filter(row => row.status === "superseded").length, 2);
  assert.equal(JSON.parse(f.service.getSnapshot("AubOS").queue[0].operation).value.title, "First local text");
  const before = (await f.server.read("AubOS")).events.length;
  await f.service.resolve("AubOS", first.operation.operationId, choice, review);
  await f.service.synchronize("AubOS");
  assert.equal((await f.server.read("AubOS")).events.length, before);
});

test("keeping a local version after server deletion creates an explicit copy", async t => {
  const f = await fixture(t);
  let server = await f.server.command("AubOS", { requestId: randomUUID(), expectedRevision: 0, action: "task.create", payload: { fields: { title: "Original" } } });
  await f.service.ingest("AubOS", server); f.offline();
  const id = server.tasks[0].id;
  const intent = localCommand(f.service.getSnapshot("AubOS"), "task.update", { id, fields: { title: "Retained copy" } }, randomUUID(), 1);
  await f.service.enqueue("AubOS", intent.operation, intent.title, intent.record, intent.baselineVersion);
  await f.server.command("AubOS", { requestId: randomUUID(), expectedRevision: server.revision, action: "task.delete", payload: { id } });
  f.reconnect(); await f.service.synchronize("AubOS");
  await f.service.resolve("AubOS", intent.operation.operationId, "local", reviewFor(f.service, intent.operation.operationId));
  await f.service.synchronize("AubOS");
  server = await f.server.read("AubOS");
  assert.equal(server.tasks.length, 1); assert.equal(server.tasks[0].title, "Retained copy");
  assert.notEqual(server.tasks[0].id, id);
});

test("auth expiry retains each queue row and a renewed session resumes the same operation", async t => {
  const f = await fixture(t); f.offline();
  const input = task("Keep during expiry"); await f.service.enqueue("AubOS", input.operation, input.record.title, input.record);
  f.reconnect(); f.rejectSession(true); await f.service.synchronize("AubOS");
  assert.equal(f.service.getSnapshot("AubOS").queue[0].status, "auth-required");
  assert.equal((await f.server.read("AubOS")).tasks.length, 0);
  f.rejectSession(false); await f.service.synchronize("AubOS");
  assert.equal(f.service.getSnapshot("AubOS").queue[0].status, "auth-required", "another automatic call is not fresh admission");
  f.reconnect(); await f.service.synchronize("AubOS");
  assert.equal(f.service.getSnapshot("AubOS").queue[0].status, "accepted");
  assert.equal((await f.server.read("AubOS")).tasks.length, 1);
});

test("another installation cannot receive or display the previous installation's queued edits", async t => {
  const f = await fixture(t); f.offline();
  const input = task("Original installation"); await f.service.enqueue("AubOS", input.operation, input.record.title, input.record);
  const originalScope = f.service.getSnapshot("AubOS").scope;
  const replacement = { ...f.identity, installationId: randomUUID() };
  workspaceAccess.admitOnline({ ...f.admission, ...replacement }, { ...f.scope, ...replacement });
  workspaceAccess.setProfile("AubOS"); workspaceAccess.confirmLive(workspaceAccess.getSnapshot());
  assert.equal(f.service.getSnapshot("AubOS").state, undefined);
  await f.service.synchronize("AubOS");
  assert.equal(f.requestBodies.length, 0);
  assert.equal(f.replica.inspect(originalScope).length, 1);
});

test("concurrent metadata ingestion retains the newest validated workspace revision", async t => {
  const f = await fixture(t), older = await f.server.read("AubOS");
  let newest = older;
  for (let revision = 0; revision < 3; revision++) newest = await f.server.command("AubOS", {
    requestId: randomUUID(), expectedRevision: revision, action: "settings.update", payload: { defaultOwner: "Owner", purpose: `Revision ${revision + 1}` } });
  const [first, second] = await Promise.all([f.service.ingest("AubOS", newest), f.service.ingest("AubOS", older)]);
  assert.equal(first.revision, 3); assert.equal(second.revision, 3);
  assert.equal(f.service.getSnapshot("AubOS").state.settings.purpose, "Revision 3");
});
