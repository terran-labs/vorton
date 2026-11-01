import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalReplica } from "../web/application/replica-sql.ts";

const scope = "installation/AubOS/owner", oldGeneration = randomUUID(), newGeneration = randomUUID();
const state = (generation, head = 0) => ({ profile: "AubOS", revision: 0, syncGeneration: generation, syncCursor: head });
const page = (changes = [], head = 2) => ({ protocol: "vorton.sync.v1", generation: newGeneration, head, cursor: changes.at(-1)?.cursor ?? 0, changes });
const change = (cursor, title = "Restored task", id = randomUUID()) => ({ cursor, kind: "task", id, revision: 1, deleted: false, value: { id, title, version: 1 } });
function open(filename = ":memory:") {
  const db = new DatabaseSync(filename);
  const replica = new LocalReplica({ run: (sql, parameters = []) => { db.prepare(sql).run(...parameters); },
    all: (sql, parameters = []) => db.prepare(sql).all(...parameters) });
  replica.initialize();
  return { db, replica };
}
function prepare(replica, target = scope) {
  replica.configure(target, "AubOS", state(oldGeneration));
  replica.pull(target, 0, { protocol: "vorton.sync.v1", generation: oldGeneration, head: 0, cursor: 0, changes: [] });
}
function save(replica, title = "Locally saved task") {
  const id = randomUUID(), operationId = randomUUID();
  const operation = { operationId, kind: "task", id, action: "create", expectedRevision: 0, value: { title } };
  const record = { id, title, version: 1 };
  replica.enqueue(scope, operation, title, record);
  return { operation, record, receipt: { protocol: "vorton.sync.v1", generation: oldGeneration, operationId, status: "accepted", kind: "task", id,
    revision: 1, deleted: false, value: record, cursor: 1 } };
}

test("a staged history persists separately and fences direct mutation and sending across reopen", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "vorton-history-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "replica.sqlite3");
  let { db, replica } = open(file);
  prepare(replica); const saved = save(replica), original = replica.read(scope), reviewId = randomUUID();
  const restored = [change(1), change(2)];
  replica.beginHistoryReview(scope, "AubOS", state(newGeneration, 2), reviewId);
  replica.pullHistoryReview(scope, reviewId, 0, page([restored[0]]));
  assert.throws(() => replica.historyComparison(scope, reviewId), /Finish downloading/);
  db.close(); ({ db, replica } = open(file));
  try {
    assert.deepEqual(replica.read(scope).records, original.records);
    assert.deepEqual(replica.read(scope).acceptedRecords, original.acceptedRecords);
    assert.deepEqual(replica.read(scope).metadata, original.metadata);
    assert.deepEqual(replica.inspect(scope), original.outbox);
    assert.equal(replica.read(scope).historyReview.cursor, 1);
    assert.equal(replica.next(scope), null);
    assert.throws(() => save(replica, "Should remain a draft"), error => error.code === "history-changed");
    assert.throws(() => replica.configure(scope, "AubOS", state(oldGeneration)), error => error.code === "history-changed");
    assert.throws(() => replica.pull(scope, 0, { protocol: "vorton.sync.v1", generation: oldGeneration, cursor: 0, changes: [] }), error => error.code === "history-changed");
    assert.throws(() => replica.resolve(scope, saved.operation.operationId, "server", randomUUID(), { serverRevision: 0, localRevision: 1, queueTail: saved.operation.operationId }), error => error.code === "history-changed");
    // Original uncertain local attempts remain resolvable without adding work.
    replica.enqueue(scope, saved.operation, saved.record.title, saved.record);
    replica.pullHistoryReview(scope, reviewId, 1, page([restored[1]]));
    assert.equal(replica.historyComparison(scope, reviewId).baseline.history_candidates.length, 2);
    assert.deepEqual(replica.read(scope).records, original.records);
    assert.equal(db.prepare("SELECT version FROM local_schema").get().version, 8);
  } finally { db.close(); }
});

test("candidate identity and explicit boundaries reject incomplete, foreign and changed history without partial writes", () => {
  const { db, replica } = open();
  try {
    prepare(replica);
    const reviewId = randomUUID();
    assert.throws(() => replica.beginHistoryReview(scope, "AubOS", { ...state(newGeneration), syncCursor: undefined }, reviewId), /captured record boundary/);
    assert.throws(() => replica.beginHistoryReview(scope, "AubOS", state(oldGeneration), reviewId), /original saved workspace/);
    replica.beginHistoryReview(scope, "AubOS", state(newGeneration, 2), reviewId);
    const before = replica.exportDevice(scope);
    replica.beginHistoryReview(scope, "AubOS", state(newGeneration, 2), reviewId);
    assert.deepEqual(replica.exportDevice(scope), before, "replaying preparation preserves its identity and verification time");
    assert.throws(() => replica.beginHistoryReview(scope, "AubOS", state(newGeneration, 3), reviewId), /different restored history/);
    assert.throws(() => replica.beginHistoryReview(scope, "AubOS", state(newGeneration, 2), randomUUID()), /different restored history/);
    const first = change(1), second = change(2);
    for (const feed of [page([first], 3), { ...page([first]), generation: oldGeneration }, { ...page([first]), head: undefined },
      page([first, { ...second, revision: 0 }]), { ...page([first]), cursor: 2 }]) {
      assert.throws(() => replica.pullHistoryReview(scope, reviewId, 0, feed));
      assert.deepEqual(replica.exportDevice(scope), before);
    }
    assert.throws(() => replica.pullHistoryReview("other/AubOS/owner", reviewId, 0, page([first])), /current restored-history review/);
    replica.pullHistoryReview(scope, reviewId, 0, page([first]));
    assert.throws(() => replica.pullHistoryReview(scope, reviewId, 1, page([{ ...second, id: first.id, value: { ...first.value, title: "Changed without revision" } }])), /without advancing/);
    assert.equal(replica.read(scope).historyReview.cursor, 1);
    replica.pullHistoryReview(scope, reviewId, 1, page([{ ...second, id: first.id, revision: 2, deleted: true, value: null }]));
    const comparison = replica.historyComparison(scope, reviewId);
    assert.equal(comparison.baseline.history_candidates[0].deleted, 1);
    assert.equal(comparison.baseline.history_candidates[0].body, "null");
  } finally { db.close(); }
});

test("read clearing preserves a pending history review and full forget removes only its installation", () => {
  const { db, replica } = open();
  try {
    prepare(replica); prepare(replica, "other/AubOS/owner");
    const epoch = { readEpoch: 0, draftEpoch: 0 }, reviewId = randomUUID();
    replica.authorize(scope, epoch);
    replica.beginHistoryReview(scope, "AubOS", state(newGeneration), reviewId);
    const before = replica.exportDevice(scope);
    assert.throws(() => replica.clearDevice(scope, epoch, false), /restored history is awaiting review/);
    assert.deepEqual(replica.exportDevice(scope), before);
    replica.clearDevice(scope, epoch, true);
    assert.equal(replica.exportDevice(scope).history_reviews.length, 0);
    assert.equal(replica.exportDevice(scope).history_candidates.length, 0);
    assert.ok(replica.read("other/AubOS/owner").metadata);
    assert.throws(() => replica.authorize(scope, epoch), /cleared in another window/);
  } finally { db.close(); }
});

test("late acknowledgements change historical proof and comparison identity without publishing into either history", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const saved = save(replica), reviewId = randomUUID();
    replica.beginHistoryReview(scope, "AubOS", state(newGeneration), reviewId);
    const before = replica.historyComparison(scope, reviewId), records = replica.read(scope).records;
    replica.reconcile(scope, saved.receipt);
    const after = replica.historyComparison(scope, reviewId);
    assert.notEqual(before.comparison, after.comparison, "confirmation must recheck the complete comparison");
    assert.deepEqual(replica.read(scope).records, records);
    assert.equal(replica.read(scope).acceptedRecords.length, 0);
    assert.equal(replica.exportDevice(scope).history_candidates.length, 0);
    replica.reconcile(scope, saved.receipt);
    assert.equal(replica.historyComparison(scope, reviewId).comparison, after.comparison);
    assert.throws(() => replica.reconcile(scope, { ...saved.receipt, value: { ...saved.record, title: "Other acknowledgement" } }), /different acknowledgement/);
    assert.throws(() => replica.reconcile(scope, { ...saved.receipt, generation: newGeneration }), /does not match/);
  } finally { db.close(); }
});

test("old-generation accepted receipts cannot alter a replacement projection or revive superseded work", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const saved = save(replica);
    // Model the publication boundary independently of the future adoption UI.
    db.prepare("UPDATE workspace_meta SET generation=? WHERE scope=?").run(newGeneration, scope);
    db.prepare("UPDATE local_records SET body=? WHERE scope=?").run(JSON.stringify({ ...saved.record, title: "Restored current version" }), scope);
    db.prepare("UPDATE outbox SET status='superseded',error='Owner reviewed this historical change' WHERE scope=?").run(scope);
    const records = replica.read(scope).records;
    replica.reconcile(scope, saved.receipt);
    assert.deepEqual(replica.read(scope).records, records);
    assert.equal(replica.read(scope).acceptedRecords.length, 0);
    assert.equal(replica.inspect(scope)[0].status, "superseded");
    assert.equal(replica.inspect(scope)[0].error, "Owner reviewed this historical change");
    assert.equal(JSON.parse(replica.inspect(scope)[0].receipt).generation, oldGeneration);
  } finally { db.close(); }
});

test("candidate write failures roll back records and cursor together", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const reviewId = randomUUID();
    replica.beginHistoryReview(scope, "AubOS", state(newGeneration, 2), reviewId);
    const before = replica.exportDevice(scope);
    db.exec("CREATE TRIGGER no_candidate_cursor BEFORE UPDATE ON history_reviews BEGIN SELECT RAISE(ABORT,'candidate quota'); END");
    assert.throws(() => replica.pullHistoryReview(scope, reviewId, 0, page([change(1), change(2)])), /candidate quota/);
    assert.deepEqual(replica.exportDevice(scope), before);
    db.exec("DROP TRIGGER no_candidate_cursor");
    replica.pullHistoryReview(scope, reviewId, 0, page([change(1), change(2)]));
    const comparison = replica.historyComparison(scope, reviewId);
    assert.equal(comparison.review.cursor, 2);
    assert.equal(comparison.baseline.history_candidates.length, 2);
  } finally { db.close(); }
});

function compare(replica, changes = [], generation = newGeneration) {
  const reviewId = randomUUID(), head = changes.at(-1)?.cursor ?? 0;
  replica.beginHistoryReview(scope, "AubOS", state(generation, head), reviewId);
  replica.pullHistoryReview(scope, reviewId, 0, { ...page(changes, head), generation });
  return { reviewId, ...replica.historyComparison(scope, reviewId) };
}

test("adoption atomically archives old state and creates separately labelled blocked proposals once", () => {
  const { db, replica } = open();
  try {
    prepare(replica);
    const queued = save(replica, "Unaccepted create"), accepted = save(replica, "Accepted after backup");
    replica.reconcile(scope, accepted.receipt);
    const cached = change(2, "Older cached read");
    replica.pull(scope, 0, { ...page([{ ...change(1, accepted.record.title, accepted.record.id), value: accepted.record }, cached], 2), generation: oldGeneration });
    const captured = compare(replica), requestId = randomUUID();
    const result = replica.adoptHistoryReview(scope, captured.reviewId, requestId, captured.comparison, newGeneration);
    assert.equal(result.recoveries, 3); assert.equal(result.counter, 1);
    assert.equal(replica.read(scope).metadata.generation, newGeneration);
    assert.equal(replica.read(scope).metadata.cursor, 0);
    assert.equal(replica.read(scope).metadata.download_head, 0);
    assert.equal(replica.read(scope).historyReview, null);
    assert.equal(replica.read(scope).acceptedRecords.length, 0);
    assert.equal(replica.read(scope).records.length, 3);
    const outbox = replica.inspect(scope), proposals = outbox.filter(row => row.status === "conflict");
    assert.equal(proposals.length, 3);
    assert.equal(proposals.find(row => row.record_id === queued.record.id).recovery_origin, "queued-intent");
    assert.equal(proposals.find(row => row.record_id === accepted.record.id).recovery_origin, "historically-accepted");
    assert.equal(proposals.find(row => row.record_id === cached.id).recovery_origin, "cached-history");
    assert.ok(proposals.every(row => row.generation === newGeneration && !row.receipt));
    assert.equal(outbox.find(row => row.operation_id === queued.operation.operationId).status, "superseded");
    assert.equal(outbox.find(row => row.operation_id === accepted.operation.operationId).status, "accepted");
    assert.equal(replica.next(scope), null, "no historical difference is automatically replayed");
    const exported = replica.exportDevice(scope);
    assert.equal(exported.history_adoptions.length, 1);
    assert.equal(exported.history_adoptions[0].comparison, captured.comparison);
    assert.equal(exported.history_epochs[0].counter, 1);
    assert.deepEqual(replica.adoptHistoryReview(scope, captured.reviewId, requestId, captured.comparison, newGeneration), result);
    assert.deepEqual(replica.exportDevice(scope), exported, "lost-confirmation retry creates neither another archive nor another proposal");
    assert.throws(() => replica.adoptHistoryReview(scope, captured.reviewId, requestId, captured.comparison + " ", newGeneration), /already used/);
  } finally { db.close(); }
});

test("adoption rejects a stale comparison and rolls back every publication write on failure", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const saved = save(replica), captured = compare(replica), requestId = randomUUID();
    replica.reconcile(scope, saved.receipt);
    assert.throws(() => replica.adoptHistoryReview(scope, captured.reviewId, requestId, captured.comparison, newGeneration), /changed during review/);
    assert.equal(replica.exportDevice(scope).history_adoptions.length, 0);
    assert.equal(replica.read(scope).metadata.generation, oldGeneration);
    const fresh = replica.historyComparison(scope, captured.reviewId), before = replica.exportDevice(scope);
    assert.throws(() => replica.adoptHistoryReview(scope, captured.reviewId, requestId, fresh.comparison, randomUUID()), /changed again/);
    db.exec("CREATE TRIGGER adoption_quota BEFORE INSERT ON history_adoptions BEGIN SELECT RAISE(ABORT,'adoption quota'); END");
    assert.throws(() => replica.adoptHistoryReview(scope, captured.reviewId, requestId, fresh.comparison, newGeneration), /adoption quota/);
    assert.deepEqual(replica.exportDevice(scope), before);
    db.exec("DROP TRIGGER adoption_quota");
    assert.equal(replica.adoptHistoryReview(scope, captured.reviewId, requestId, fresh.comparison, newGeneration).recoveries, 1);
  } finally { db.close(); }
});

test("pending and historically accepted deletions survive adoption without inferring deletion of new candidate records", () => {
  for (const acknowledge of [false, true]) {
    const { db, replica } = open();
    try {
      prepare(replica); const original = change(1, "Deleted on this device");
      replica.pull(scope, 0, { ...page([original], 1), generation: oldGeneration });
      const operation = { operationId: randomUUID(), kind: "task", id: original.id, action: "delete", expectedRevision: 1 };
      replica.enqueue(scope, operation, original.value.title, null);
      if (acknowledge) replica.reconcile(scope, { protocol: "vorton.sync.v1", generation: oldGeneration, operationId: operation.operationId,
        status: "accepted", kind: "task", id: original.id, revision: 2, deleted: true, value: null, cursor: 2 });
      const added = change(2, "Exists only in restored history"), captured = compare(replica, [original, added]);
      const result = replica.adoptHistoryReview(scope, captured.reviewId, randomUUID(), captured.comparison, newGeneration);
      assert.equal(result.recoveries, 1);
      const proposal = replica.inspect(scope).find(row => row.status === "conflict");
      assert.equal(JSON.parse(proposal.operation).action, "delete");
      assert.equal(proposal.recovery_origin, acknowledge ? "historically-accepted" : "queued-intent");
      assert.equal(replica.read(scope).records.find(row => row.id === original.id).body, "null");
      assert.equal(JSON.parse(replica.read(scope).records.find(row => row.id === added.id).body).title, added.value.title);
      assert.equal(replica.next(scope), null);
    } finally { db.close(); }
  }
});

test("matching editable values do not create recovery conflicts for timestamps and record versions", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const original = change(1, "Same editable value", "legacy-task-1");
    replica.pull(scope, 0, { ...page([original], 1), generation: oldGeneration });
    const captured = compare(replica, [{ ...original, value: { ...original.value, version: 20, updatedAt: "different" } }]);
    assert.equal(replica.adoptHistoryReview(scope, captured.reviewId, randomUUID(), captured.comparison, newGeneration).recoveries, 0);
    assert.equal(replica.inspect(scope).length, 0);
    assert.equal(JSON.parse(replica.read(scope).records[0].body).version, 20);
  } finally { db.close(); }
});

test("a legacy record absent from the backup stays reviewable and historical replay cannot undo a later adoption", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const original = change(1, "Retained legacy task", "legacy-task-1");
    replica.pull(scope, 0, { ...page([original], 1), generation: oldGeneration });
    const first = compare(replica), requestId = randomUUID();
    const result = replica.adoptHistoryReview(scope, first.reviewId, requestId, first.comparison, newGeneration);
    const proposal = replica.inspect(scope).find(row => row.status === "conflict");
    assert.equal(proposal.record_id, "legacy-task-1"); assert.equal(proposal.recovery_origin, "cached-history");
    const thirdGeneration = randomUUID(), second = compare(replica, [], thirdGeneration);
    assert.equal(replica.adoptHistoryReview(scope, second.reviewId, randomUUID(), second.comparison, thirdGeneration).counter, 2);
    assert.equal(replica.inspect(scope).find(row => row.status === "conflict").recovery_origin, "cached-history", "another restore cannot relabel cached history as unsent user intent");
    const before = replica.exportDevice(scope);
    assert.deepEqual(replica.adoptHistoryReview(scope, first.reviewId, requestId, first.comparison, newGeneration), result);
    assert.deepEqual(replica.exportDevice(scope), before);
    assert.equal(replica.read(scope).metadata.generation, thirdGeneration);
  } finally { db.close(); }
});

test("late conflict receipts preserve superseded review decisions and invalidate the next comparison", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const saved = save(replica), first = compare(replica);
    replica.adoptHistoryReview(scope, first.reviewId, randomUUID(), first.comparison, newGeneration);
    const thirdGeneration = randomUUID(), second = compare(replica, [], thirdGeneration), before = replica.read(scope);
    const original = replica.inspect(scope).find(row => row.operation_id === saved.operation.operationId);
    const receipt = { protocol: "vorton.sync.v1", generation: oldGeneration, operationId: saved.operation.operationId, status: "conflict", current: null };
    replica.reconcile(scope, receipt);
    const after = replica.read(scope), row = after.outbox.find(row => row.operation_id === saved.operation.operationId);
    assert.equal(row.status, "superseded"); assert.equal(row.error, original.error);
    assert.deepEqual(after.records, before.records); assert.deepEqual(after.acceptedRecords, before.acceptedRecords);
    assert.notEqual(replica.historyComparison(scope, second.reviewId).comparison, second.comparison);
    replica.reconcile(scope, receipt);
    assert.deepEqual(replica.read(scope), after);
  } finally { db.close(); }
});

test("adoption receipts survive reopen and read clearing retains the archive and adoption counter", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "vorton-adopted-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "replica.sqlite3");
  let { db, replica } = open(filename);
  prepare(replica); save(replica);
  const captured = compare(replica), requestId = randomUUID();
  const result = replica.adoptHistoryReview(scope, captured.reviewId, requestId, captured.comparison, newGeneration);
  db.close(); ({ db, replica } = open(filename));
  try {
    assert.deepEqual(replica.adoptHistoryReview(scope, captured.reviewId, requestId, captured.comparison, newGeneration), result);
    const proposal = replica.inspect(scope).find(row => row.status === "conflict");
    replica.resolve(scope, proposal.operation_id, "server", randomUUID(), { serverRevision: 0, localRevision: 1, queueTail: proposal.operation_id });
    const epoch = { readEpoch: 0, draftEpoch: 0 };
    replica.authorize(scope, epoch);
    replica.clearDevice(scope, epoch, false);
    const exported = replica.exportDevice(scope);
    assert.equal(exported.history_epochs[0].counter, 1);
    assert.equal(exported.history_adoptions.length, 1);
    assert.equal(exported.history_adoptions[0].comparison, captured.comparison);
    assert.equal(exported.workspace_meta.length, 0);
    assert.equal(exported.local_resolutions.length, 1);
  } finally { db.close(); }
});

test("an earlier acceptance cannot certify later cached edits or deletions through repeated adoption", () => {
  for (const deleted of [false, true]) {
    const { db, replica } = open();
    try {
      prepare(replica); const accepted = save(replica, "Accepted title A");
      replica.reconcile(scope, accepted.receipt);
      const original = { ...change(1, accepted.record.title, accepted.record.id), value: accepted.record };
      const later = { ...original, cursor: 2, revision: 2, deleted, value: deleted ? null : { ...accepted.record, title: "Cached title B", version: 2 } };
      replica.pull(scope, 0, { ...page([original, later], 2), generation: oldGeneration });
      const first = compare(replica, [original]);
      replica.adoptHistoryReview(scope, first.reviewId, randomUUID(), first.comparison, newGeneration);
      let proposal = replica.inspect(scope).find(row => row.status === "conflict");
      assert.equal(proposal.recovery_origin, "cached-history");
      assert.equal(JSON.parse(replica.read(scope).records[0].body)?.title ?? null, deleted ? null : "Cached title B");
      const thirdGeneration = randomUUID(), second = compare(replica, [original], thirdGeneration);
      replica.adoptHistoryReview(scope, second.reviewId, randomUUID(), second.comparison, thirdGeneration);
      proposal = replica.inspect(scope).find(row => row.status === "conflict");
      assert.equal(proposal.recovery_origin, "cached-history", "incorrect acceptance cannot propagate into another adoption");
    } finally { db.close(); }
  }
});

function reviewOf(replica, proposal) {
  const local = replica.read(scope).records.find(row => row.kind === proposal.kind && row.id === proposal.record_id);
  const base = replica.read(scope).acceptedRecords.find(row => row.kind === proposal.kind && row.id === proposal.record_id);
  const pending = replica.inspect(scope).filter(row => row.kind === proposal.kind && row.record_id === proposal.record_id && !["accepted", "superseded"].includes(row.status));
  return { serverRevision: base?.revision ?? 0, localRevision: local.revision, queueTail: pending.at(-1).operation_id };
}

test("read clearing retains the history boundary and accepted attempts through another restore", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const saved = save(replica);
    replica.reconcile(scope, saved.receipt);
    const epoch = { readEpoch: 0, draftEpoch: 0 };
    replica.authorize(scope, epoch); replica.clearDevice(scope, epoch, false);
    assert.equal(replica.read(scope).metadata, null);
    assert.equal(replica.read(scope).historyIdentity.generation, oldGeneration);
    assert.throws(() => replica.configure(scope, "AubOS", state(newGeneration)), error => error.code === "history-changed");
    const comparison = compare(replica);
    assert.equal(comparison.differences.length, 1);
    replica.adoptHistoryReview(scope, comparison.reviewId, randomUUID(), comparison.comparison, newGeneration);
    const proposal = replica.inspect(scope).find(row => row.status === "conflict");
    assert.equal(proposal.recovery_origin, "historically-accepted");
    const copyId = randomUUID();
    replica.resolve(scope, proposal.operation_id, "local", copyId, reviewOf(replica, proposal));
    assert.equal(replica.recoverAttempt(scope, saved.operation.operationId).identity.id, copyId);
    assert.throws(() => replica.beginHistoryReview(scope, "AubOS", state(oldGeneration), randomUUID()), /reused an earlier history/);
    replica.clearDevice(scope, { readEpoch: 1, draftEpoch: 0 }, true);
    assert.equal(replica.read(scope).historyIdentity, null);
  } finally { db.close(); }
});

test("staged metadata and rejected pages cannot establish trusted history identity", () => {
  const { db, replica } = open();
  try {
    replica.configure(scope, "AubOS", state(oldGeneration));
    assert.equal(replica.read(scope).historyIdentity, null);
    assert.throws(() => replica.pull(scope, 0, page([], 0)), error => error.code === "history-changed");
    assert.equal(replica.read(scope).historyIdentity, null);
    replica.pull(scope, 0, { ...page([], 0), generation: oldGeneration });
    assert.equal(replica.read(scope).historyIdentity.generation, oldGeneration);
  } finally { db.close(); }
});

test("schema upgrade recovers a cleared history identity from retained acceptance", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const saved = save(replica); replica.reconcile(scope, saved.receipt);
    replica.authorize(scope, { readEpoch: 0, draftEpoch: 0 });
    replica.clearDevice(scope, { readEpoch: 0, draftEpoch: 0 }, false);
    db.exec("DROP TABLE history_identity; UPDATE local_schema SET version=7");
    replica.initialize();
    assert.equal(replica.read(scope).historyIdentity.generation, oldGeneration);
    assert.throws(() => replica.configure(scope, "AubOS", state(newGeneration)), error => error.code === "history-changed");
    assert.equal(compare(replica).differences.length, 1);
  } finally { db.close(); }
});

test("a technical absence left by a recovery copy is never inferred as a deletion", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const saved = save(replica), first = compare(replica);
    replica.adoptHistoryReview(scope, first.reviewId, randomUUID(), first.comparison, newGeneration);
    const proposal = replica.inspect(scope).find(row => row.status === "conflict"), copyId = randomUUID();
    replica.resolve(scope, proposal.operation_id, "local", copyId, reviewOf(replica, proposal));
    const third = randomUUID(), original = { ...change(1, saved.record.title, saved.record.id), value: saved.record };
    const second = compare(replica, [original], third);
    assert.equal(second.differences.length, 1);
    assert.equal(second.differences[0].id, copyId);
    replica.adoptHistoryReview(scope, second.reviewId, randomUUID(), second.comparison, third);
    const originalRow = replica.read(scope).records.find(row => row.id === saved.record.id);
    assert.equal(JSON.parse(originalRow.body).title, saved.record.title);
    assert.equal(replica.inspect(scope).filter(row => row.status === "conflict" && row.record_id === saved.record.id).length, 0);
  } finally { db.close(); }
});

test("original attempts and capture record identities follow a recovery copy across lost confirmation and reopen", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "vorton-history-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "replica.sqlite3");
  let { db, replica } = open(filename);
  prepare(replica); const saved = save(replica, "Capture committed before confirmation was lost"), captured = compare(replica);
  replica.adoptHistoryReview(scope, captured.reviewId, randomUUID(), captured.comparison, newGeneration);
  const proposal = replica.inspect(scope).find(row => row.status === "conflict"), resolutionId = randomUUID(), review = reviewOf(replica, proposal);
  replica.resolve(scope, proposal.operation_id, "local", resolutionId, review);
  db.close(); ({ db, replica } = open(filename));
  try {
    assert.deepEqual(replica.resolve(scope, proposal.operation_id, "local", resolutionId, review), { resolutionId });
    const recovered = replica.recoverAttempt(scope, saved.operation.operationId);
    assert.equal(recovered.original.operation_id, saved.operation.operationId);
    assert.equal(recovered.saved.operation_id, resolutionId);
    assert.equal(recovered.identity.id, resolutionId);
    assert.equal(recovered.identity.generation, newGeneration);
    assert.equal(recovered.saved.local_version, 1);
    assert.equal(recovered.disposition, "saved");
    assert.equal(JSON.parse(recovered.record.body).title, saved.record.title);
    assert.deepEqual(replica.resolveRecordIdentity(scope, "task", saved.record.id, oldGeneration), { id: resolutionId, generation: newGeneration });
    const update = { operationId: randomUUID(), kind: "task", id: recovered.identity.id, expectedRevision: recovered.record.revision,
      action: "update", value: { title: "Newer typing retained after reopening" } };
    replica.enqueue(scope, update, update.value.title, { ...JSON.parse(recovered.record.body), title: update.value.title, version: 2 }, 1, newGeneration);
    assert.equal(replica.read(scope).records.filter(row => row.body !== "null").length, 1);
    assert.equal(replica.inspect(scope).filter(row => row.generation === newGeneration && JSON.parse(row.operation).action === "create").length, 1);
    assert.equal(replica.recoverAttempt(scope, saved.operation.operationId).identity.id, resolutionId);
    assert.throws(() => replica.recoverAttempt("other/AubOS/owner", saved.operation.operationId), /unavailable/);
    assert.deepEqual(replica.resolveRecordIdentity("other/AubOS/owner", "task", saved.record.id, oldGeneration), { id: saved.record.id, generation: oldGeneration });
  } finally { db.close(); }
});

test("identity mappings follow another adoption and copy without changing the first decision", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const saved = save(replica), first = compare(replica);
    replica.adoptHistoryReview(scope, first.reviewId, randomUUID(), first.comparison, newGeneration);
    const firstProposal = replica.inspect(scope).find(row => row.status === "conflict"), firstCopy = randomUUID();
    replica.resolve(scope, firstProposal.operation_id, "local", firstCopy, reviewOf(replica, firstProposal));
    const thirdGeneration = randomUUID(), second = compare(replica, [], thirdGeneration);
    replica.adoptHistoryReview(scope, second.reviewId, randomUUID(), second.comparison, thirdGeneration);
    const secondProposal = replica.inspect(scope).find(row => row.status === "conflict"), secondCopy = randomUUID();
    replica.resolve(scope, secondProposal.operation_id, "local", secondCopy, reviewOf(replica, secondProposal));
    assert.equal(replica.recoverAttempt(scope, saved.operation.operationId).identity.id, secondCopy);
    assert.equal(replica.recoverAttempt(scope, firstCopy).identity.id, secondCopy);
    assert.deepEqual(replica.resolveRecordIdentity(scope, "task", saved.record.id, oldGeneration), { id: secondCopy, generation: thirdGeneration });
    assert.equal(replica.read(scope).records.filter(row => row.body !== "null").length, 1);
    assert.equal(replica.exportDevice(scope).local_resolutions.find(row => row.operation_id === firstProposal.operation_id).resolution_id, firstCopy);
    const before = replica.exportDevice(scope);
    assert.throws(() => replica.beginHistoryReview(scope, "AubOS", state(oldGeneration), randomUUID()), /reused an earlier history identity/);
    assert.deepEqual(replica.exportDevice(scope), before);
  } finally { db.close(); }
});

test("a failed copy rolls back redirects, operation mappings and the retained resolution", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const saved = save(replica), captured = compare(replica);
    replica.adoptHistoryReview(scope, captured.reviewId, randomUUID(), captured.comparison, newGeneration);
    const proposal = replica.inspect(scope).find(row => row.status === "conflict"), before = replica.exportDevice(scope);
    db.exec("CREATE TRIGGER copy_quota BEFORE INSERT ON local_resolutions BEGIN SELECT RAISE(ABORT,'copy quota'); END");
    assert.throws(() => replica.resolve(scope, proposal.operation_id, "local", randomUUID(), reviewOf(replica, proposal)), /copy quota/);
    assert.deepEqual(replica.exportDevice(scope), before);
    assert.equal(replica.recoverAttempt(scope, saved.operation.operationId).saved.operation_id, proposal.operation_id);
  } finally { db.close(); }
});

test("a reviewed server choice and already absent deletion retain explicit recovery outcomes", () => {
  for (const choice of ["server", "local"]) {
    const { db, replica } = open();
    try {
      prepare(replica); const original = change(1, "Deletion reviewed after restore");
      replica.pull(scope, 0, { ...page([original], 1), generation: oldGeneration });
      const operation = { operationId: randomUUID(), kind: "task", id: original.id, action: "delete", expectedRevision: 1 };
      replica.enqueue(scope, operation, original.value.title, null);
      const captured = compare(replica, [original]);
      replica.adoptHistoryReview(scope, captured.reviewId, randomUUID(), captured.comparison, newGeneration);
      // Another server deletion makes keeping this deletion a reviewed no-op.
      replica.pull(scope, 1, { ...page([{ ...original, cursor: 2, revision: 2, deleted: true, value: null }], 2), generation: newGeneration });
      const proposal = replica.inspect(scope).find(row => row.status === "conflict");
      replica.resolve(scope, proposal.operation_id, choice, randomUUID(), reviewOf(replica, proposal));
      const recovered = replica.recoverAttempt(scope, operation.operationId);
      assert.equal(recovered.disposition, choice === "server" ? "server" : "deleted");
      assert.equal(recovered.record.body, "null");
      assert.equal(replica.next(scope), null);
    } finally { db.close(); }
  }
});

test("the durable adoption counter requires history on new worker saves even after read clearing", () => {
  const { db, replica } = open();
  try {
    prepare(replica); const captured = compare(replica);
    replica.adoptHistoryReview(scope, captured.reviewId, randomUUID(), captured.comparison, newGeneration);
    const epoch = { readEpoch: 0, draftEpoch: 0 };
    replica.authorize(scope, epoch); replica.clearDevice(scope, epoch, false);
    replica.configure(scope, "AubOS", state(newGeneration)); replica.pull(scope, 0, page([], 0));
    const operation = { operationId: randomUUID(), kind: "task", id: randomUUID(), action: "create", expectedRevision: 0, value: { title: "Reviewed new record" } };
    const record = { id: operation.id, title: operation.value.title, version: 1 }, before = replica.exportDevice(scope);
    assert.throws(() => replica.enqueue(scope, operation, record.title, record), error => error.code === "draft-review-required");
    assert.deepEqual(replica.exportDevice(scope), before);
    replica.enqueue(scope, operation, record.title, record, undefined, newGeneration);
    assert.equal(replica.read(scope).adoptionCounter, 1);
    assert.equal(replica.read(scope).records.length, 1);
  } finally { db.close(); }
});
