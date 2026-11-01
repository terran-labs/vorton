import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { LocalReplica } from "../web/application/replica-sql.ts";
import { findRetainedDrafts, verifyRetainedDraft } from "../web/application/draft-recovery.ts";

function fixture(t, kind) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const replica = new LocalReplica({ run: (sql, args = []) => { db.prepare(sql).run(...args); }, all: (sql, args = []) => db.prepare(sql).all(...args) });
  replica.initialize();
  const scope = "installation/AubOS/owner", generation = randomUUID(), next = randomUUID(), id = randomUUID();
  const state = syncGeneration => ({ profile: "AubOS", revision: 0, syncGeneration, syncCursor: 0 });
  replica.configure(scope, "AubOS", state(generation));
  replica.pull(scope, 0, { protocol: "vorton.sync.v1", generation, head: 0, cursor: 0, changes: [] });
  replica.enqueue(scope, { operationId: randomUUID(), kind, id, action: "create", expectedRevision: 0, value: { title: "Queued version" } }, "Queued version", { id, title: "Queued version", version: 1 });
  const reviewId = randomUUID(); replica.beginHistoryReview(scope, "AubOS", state(next), reviewId);
  const comparison = replica.historyComparison(scope, reviewId);
  replica.adoptHistoryReview(scope, reviewId, randomUUID(), comparison.comparison, next);
  const proposal = replica.inspect(scope).find(row => row.status === "conflict"), copy = randomUUID();
  replica.resolve(scope, proposal.operation_id, "local", copy, { serverRevision: 0, localRevision: 1, queueTail: proposal.operation_id });
  const key = { profile: "AubOS", schema: 1, kind: `${kind}-editor-v1`, targetId: copy };
  const target = { profile: "AubOS", kind: key.kind, id: copy, generation: next, version: 1, localRevision: 1 };
  const draft = { key: { ...key, targetId: id }, fields: { title: "Newer unsubmitted text" }, baseline: { version: 1, syncGeneration: generation }, savedAt: 100 };
  const resolve = async (kind, id, generation, review) => review
    ? replica.reviewRecordIdentity(scope, kind, id, generation, review) : replica.resolveRecordIdentity(scope, kind, id, generation);
  return { db, replica, scope, key, target, draft, resolve };
}

for (const kind of ["task", "goal", "idea"]) {
  test(`${kind} editor discovers a copy's retained draft without changing text, storage or records`, async t => {
    const f = fixture(t, kind), drafts = [f.draft], before = f.replica.exportDevice(f.scope), original = structuredClone(drafts);
    const found = await findRetainedDrafts(drafts, f.target, f.key, f.resolve);
    assert.equal(found.candidates.length, 1); assert.equal(found.ambiguous, false);
    const reviewed = await verifyRetainedDraft(found.candidates[0], f.key, async () => drafts, f.resolve);
    assert.equal(reviewed.key.targetId, f.draft.key.targetId, "the source storage key is retained");
    assert.equal(reviewed.fields.title, "Newer unsubmitted text");
    assert.deepEqual(drafts, original); assert.deepEqual(f.replica.exportDevice(f.scope), before);
    assert.equal((await findRetainedDrafts(drafts, { ...f.target, profile: "Other" }, f.key, f.resolve)).candidates.length, 0);
    assert.equal((await findRetainedDrafts([{ ...f.draft, baseline: {} }], f.target, f.key, f.resolve)).candidates.length, 0);
  });

  test(`${kind} editor rejects a changed source, competing draft and changed target`, async t => {
    const f = fixture(t, kind);
    const candidate = (await findRetainedDrafts([f.draft], f.target, f.key, f.resolve)).candidates[0];
    await assert.rejects(verifyRetainedDraft(candidate, f.key, async () => [{ ...f.draft, savedAt: 101 }], f.resolve), /changed during review/);
    const direct = { ...f.draft, key: f.key, baseline: { syncGeneration: f.target.generation }, savedAt: 102 };
    assert.equal((await findRetainedDrafts([f.draft, direct], f.target, f.key, f.resolve)).ambiguous, true);
    await assert.rejects(verifyRetainedDraft(candidate, f.key, async () => [f.draft, direct], f.resolve), /Multiple or changed/);
    let reads = 0;
    await assert.rejects(verifyRetainedDraft(candidate, f.key, async () => ++reads === 1 ? [f.draft] : [f.draft, direct], f.resolve), /changed during review/);
    const fields = { id: f.target.id, title: "Concurrent local edit", version: 2 };
    f.replica.enqueue(f.scope, { operationId: randomUUID(), kind, id: f.target.id, action: "update", expectedRevision: 1, value: { title: fields.title } }, fields.title, fields, 1, f.target.generation);
    await assert.rejects(verifyRetainedDraft(candidate, f.key, async () => [f.draft], f.resolve), /record changed during draft review/);
    assert.equal(f.draft.fields.title, "Newer unsubmitted text");
  });
}

test("a source key bound to another record cannot associate by key or title", async t => {
  const f = fixture(t, "task"), bound = { ...f.draft, fields: { ...f.draft.fields, __vortonLocalRecord: f.target.id }, baseline: { syncGeneration: f.target.generation } };
  const oldTarget = { ...f.target, id: f.draft.key.targetId };
  assert.equal((await findRetainedDrafts([bound], oldTarget, bound.key, f.resolve)).currentPresent, false);
  assert.equal((await findRetainedDrafts([bound], f.target, f.key, f.resolve)).candidates.length, 1);
});
