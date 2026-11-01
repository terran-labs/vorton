import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalReplica } from "../web/application/replica-sql.ts";

const scope = "installation/AubOS/owner", generation = randomUUID();
function open(filename = ":memory:") {
  const database = new DatabaseSync(filename);
  const replica = new LocalReplica({ run: (sql, parameters = []) => { database.prepare(sql).run(...parameters); },
    all: (sql, parameters = []) => database.prepare(sql).all(...parameters) });
  replica.initialize();
  return { database, replica };
}
test("a new save cannot cross a generation change between preparation and the worker transaction", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const input = create("Prepared under old history"), nextGeneration = randomUUID();
    database.prepare("UPDATE workspace_meta SET generation=? WHERE scope=?").run(nextGeneration, scope);
    assert.throws(() => replica.enqueue(scope, input.operation, input.record.title, input.record, undefined, generation), error => error.code === "history-changed");
    assert.equal(replica.inspect(scope).length, 0); assert.equal(replica.read(scope).records.length, 0);
    assert.equal(replica.read(scope).metadata.generation, nextGeneration);
  } finally { database.close(); }
});
const feed = (changes = []) => ({ protocol: "vorton.sync.v1", generation, cursor: changes.at(-1)?.cursor ?? 0, changes });
function prepare(replica) { replica.configure(scope, "AubOS", { profile: "AubOS", revision: 0, syncGeneration: generation }); replica.pull(scope, 0, feed()); }
const create = (title = "Task") => {
  const operation = { operationId: randomUUID(), kind: "task", id: randomUUID(), action: "create", expectedRevision: 0, value: { title } };
  return { operation, record: { id: operation.id, title, version: 1 } };
};
const accepted = (operation, value, cursor = 1) => ({ protocol: "vorton.sync.v1", generation,
  status: "accepted", operationId: operation.operationId, kind: operation.kind, id: operation.id,
  revision: operation.expectedRevision + 1, deleted: operation.action === "delete", value, cursor });

test("forget fences stale requests durably and clears only the selected installation", () => {
  const { database, replica } = open();
  try {
    const epoch = { readEpoch: 0, draftEpoch: 0 };
    replica.authorize(scope, epoch); prepare(replica);
    const input = create("Unsent work"); replica.enqueue(scope, input.operation, input.record.title, input.record);
    const other = "other-installation/AubOS/owner";
    replica.authorize(other, epoch);
    replica.configure(other, "AubOS", { profile: "AubOS", revision: 0, syncGeneration: generation });
    replica.pull(other, 0, feed());
    assert.throws(() => replica.clearDevice(scope, epoch, false), /Pending local changes/);
    assert.equal(replica.read(scope).outbox.length, 1);
    assert.equal(replica.exportDevice(scope).outbox.length, 1);
    database.exec("CREATE TRIGGER interrupted_clear BEFORE DELETE ON workspace_meta BEGIN SELECT RAISE(ABORT,'interrupted clear'); END");
    assert.throws(() => replica.clearDevice(scope, epoch, true), /interrupted clear/);
    replica.authorize(scope, epoch);
    assert.equal(replica.read(scope).records.length, 1, "A failed clear restores records and keeps its previous epoch");
    database.exec("DROP TRIGGER interrupted_clear");
    const next = replica.clearDevice(scope, epoch, true);
    assert.equal(replica.read(scope).outbox.length, 0);
    assert.ok(replica.read(other).metadata);
    replica.initialize();
    assert.throws(() => replica.authorize(scope, epoch), /cleared in another window/);
    assert.throws(() => replica.reconcile(scope, accepted(input.operation, input.record)), /does not match/);
    replica.authorize(scope, next); prepare(replica);
    const newer = create("Newly admitted work"); replica.enqueue(scope, newer.operation, newer.record.title, newer.record);
    assert.deepEqual(replica.clearDevice(scope, epoch, true), next, "A retry finishes the old clear without deleting newly admitted work");
    assert.equal(replica.read(scope).outbox.length, 1);
    assert.throws(() => replica.authorize(scope, { readEpoch: 1, draftEpoch: 0 }), /cleared/);
  } finally { database.close(); }
});

test("twenty local records and separate operation rows survive database close and additive initialization", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "vorton-client-sql-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "replica.sqlite3");
  let opened = open(filename); prepare(opened.replica);
  const inputs = Array.from({ length: 20 }, (_, i) => create(`Offline task ${i + 1}`));
  for (const input of inputs) opened.replica.enqueue(scope, input.operation, input.record.title, input.record);
  opened.database.close(); opened = open(filename);
  try {
    const saved = opened.replica.read(scope);
    assert.equal(saved.records.length, 20);
    assert.deepEqual(saved.outbox.map(row => row.title), inputs.map(input => input.record.title));
    assert.ok(saved.outbox.every(row => row.status === "pending"));
    assert.equal(opened.replica.read("another/workspace/owner").records.length, 0);
    for (const input of inputs) opened.replica.enqueue(scope, input.operation, input.record.title, input.record);
    assert.equal(opened.replica.inspect(scope).length, 20);
    assert.throws(() => opened.replica.enqueue(scope, { ...inputs[0].operation, value: { title: "Different" } }, "Different", inputs[0].record), /identity was reused/);
  } finally { opened.database.close(); }
});

test("storage failure rolls back both the local record and operation row", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    database.exec("CREATE TRIGGER quota_failure BEFORE INSERT ON local_records BEGIN SELECT RAISE(ABORT,'simulated quota failure'); END");
    const input = create();
    assert.throws(() => replica.enqueue(scope, input.operation, input.record.title, input.record), /simulated quota failure/);
    assert.equal(replica.read(scope).records.length, 0);
    assert.equal(replica.inspect(scope).length, 0);
    database.exec("DROP TRIGGER quota_failure");
    replica.enqueue(scope, input.operation, input.record.title, input.record);
    assert.equal(replica.inspect(scope).length, 1);
  } finally { database.close(); }
});

test("resolution commits its replacement operation and retained intents atomically", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const input = create("Original"), remote = { ...input.record, title: "Server edit", version: 2 };
    replica.pull(scope, 0, feed([{ cursor: 1, kind: "task", id: input.record.id, revision: 1, deleted: false, value: input.record }]));
    const operation = { ...input.operation, operationId: randomUUID(), action: "update", expectedRevision: 1, value: { title: "Local edit" } };
    replica.enqueue(scope, operation, "Local edit", { ...input.record, title: "Local edit", version: 2 });
    replica.reconcile(scope, { ...accepted(operation, remote), status: "conflict", current: remote });
    replica.pull(scope, 1, feed([{ cursor: 2, kind: "task", id: input.record.id, revision: 2, deleted: false, value: remote }]));
    const before = replica.read(scope);
    database.exec("CREATE TRIGGER resolution_quota BEFORE INSERT ON local_resolutions BEGIN SELECT RAISE(ABORT,'resolution quota'); END");
    const review = { serverRevision: 2, localRevision: 2, queueTail: operation.operationId };
    assert.throws(() => replica.resolve(scope, operation.operationId, "local", randomUUID(), review), /resolution quota/);
    assert.deepEqual(replica.read(scope), before);
    database.exec("DROP TRIGGER resolution_quota");
    replica.resolve(scope, operation.operationId, "local", randomUUID(), review);
    assert.equal(replica.read(scope).outbox.length, 2);
    assert.equal(replica.read(scope).outbox[0].status, "superseded");
    assert.equal(JSON.parse(replica.read(scope).records[0].body).title, "Local edit");
  } finally { database.close(); }
});

test("discarding a failed local creation retains dependent work with an actionable failure", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const goal = create("Local goal"); goal.operation.kind = "goal";
    replica.enqueue(scope, goal.operation, goal.record.title, goal.record);
    const task = create("Dependent task");
    task.operation.value.goalId = goal.record.id; task.record.goalId = goal.record.id;
    replica.enqueue(scope, task.operation, task.record.title, task.record);
    replica.mark(scope, goal.operation.operationId, "failed", "Goal needs correction");
    replica.resolve(scope, goal.operation.operationId, "server", randomUUID(), { serverRevision: 0, localRevision: 1, queueTail: goal.operation.operationId });
    const rows = replica.inspect(scope);
    assert.equal(rows[0].status, "superseded"); assert.equal(rows[1].status, "failed");
    assert.match(rows[1].error, /linked local creation/);
    assert.equal(JSON.parse(replica.read(scope).records.find(row => row.id === task.record.id).body).title, "Dependent task");
    assert.equal(replica.next(scope), null);
  } finally { database.close(); }
});

test("workspace metadata commits only with a valid generation and never regresses", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const before = replica.read(scope).metadata;
    replica.configure(scope, "AubOS", { profile: "AubOS", revision: 5, syncGeneration: generation, settings: { purpose: "Newer" } });
    assert.deepEqual(replica.read(scope).metadata, before, "Staging is not a verified metadata publication");
    assert.throws(() => replica.pull(scope, 0, { ...feed(), generation: randomUUID() }), /Server history changed/);
    assert.deepEqual(replica.read(scope).metadata, before);
    replica.pull(scope, 0, feed());
    const newer = replica.read(scope).metadata;
    assert.equal(JSON.parse(newer.body).revision, 5);
    replica.configure(scope, "AubOS", { profile: "AubOS", revision: 3, syncGeneration: generation, settings: { purpose: "Older" } });
    replica.pull(scope, 0, feed());
    assert.deepEqual(replica.read(scope).metadata, newer);
    assert.throws(() => replica.configure(scope, "AubOS", { profile: "AubOS", revision: 9, syncGeneration: randomUUID() }), /Server history changed/);
    assert.deepEqual(replica.read(scope).metadata, newer);
  } finally { database.close(); }
});

test("an incomplete initial page cannot authorize a worker enqueue", () => {
  const { database, replica } = open();
  try {
    replica.configure(scope, "AubOS", { profile: "AubOS", revision: 2, syncGeneration: generation });
    const first = create("Remote one"), second = create("Remote two"), local = create("Local three");
    replica.pull(scope, 0, { ...feed([{ cursor: 1, kind: "task", id: first.record.id, revision: 1, deleted: false, value: first.record }]), head: 2 });
    assert.throws(() => replica.enqueue(scope, local.operation, local.record.title, local.record), /initial record download/);
    assert.equal(replica.inspect(scope).length, 0);
    const partial = replica.read(scope).metadata;
    assert.throws(() => replica.pull(scope, 1, { ...feed(), cursor: 1, head: 1 }), /boundary moved backwards/);
    assert.deepEqual(replica.read(scope).metadata, partial);
    replica.pull(scope, 1, feed([{ cursor: 2, kind: "task", id: second.record.id, revision: 1, deleted: false, value: second.record }]));
    replica.enqueue(scope, local.operation, local.record.title, local.record);
    assert.equal(replica.read(scope).records.length, 3);
  } finally { database.close(); }
});
test("newer staged metadata cannot make an older record boundary ready or regress downloaded metadata", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const first = create("First snapshot record"), second = create("Newer snapshot record"), local = create("Local proposal");
    replica.configure(scope, "AubOS", { profile: "AubOS", revision: 2, syncGeneration: generation, syncCursor: 2 });
    replica.pull(scope, 0, feed([{ cursor: 1, kind: "task", id: first.record.id, revision: 1, deleted: false, value: first.record }]));
    const partial = replica.read(scope).metadata;
    assert.equal(partial.cursor, 1); assert.equal(partial.download_head, 2);
    assert.throws(() => replica.enqueue(scope, local.operation, local.record.title, local.record), /initial record download/);
    replica.pull(scope, 1, feed([{ cursor: 2, kind: "task", id: second.record.id, revision: 1, deleted: false, value: second.record }]));
    const complete = replica.read(scope).metadata;
    replica.configure(scope, "AubOS", { profile: "AubOS", revision: 3, syncGeneration: generation, syncCursor: 1 });
    assert.equal(replica.read(scope).stagedMetadata, null); assert.deepEqual(replica.read(scope).metadata, complete);
  } finally { database.close(); }
});

test("an unresolved reference is rejected before a later create can be queued", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const input = create("Linked task"); input.record.goalId = randomUUID(); input.operation.value.goalId = input.record.goalId;
    assert.throws(() => replica.enqueue(scope, input.operation, input.record.title, input.record), /linked record is unavailable/);
    assert.equal(replica.inspect(scope).length, 0);
    assert.equal(replica.read(scope).records.length, 0);
  } finally { database.close(); }
});

test("receipts preserve later local edits, unblock dependencies and remain idempotent after remote pull", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const first = create("First title"); replica.enqueue(scope, first.operation, first.record.title, first.record);
    const second = { ...first.operation, operationId: randomUUID(), action: "update", expectedRevision: 1, value: { title: "Later edit" } };
    const later = { ...first.record, title: "Later edit", version: 2 };
    replica.enqueue(scope, second, later.title, later, 1);
    assert.equal(replica.next(scope).operation_id, first.operation.operationId);
    replica.mark(scope, first.operation.operationId, "sending");
    const receipt = accepted(first.operation, first.record);
    replica.reconcile(scope, receipt); replica.reconcile(scope, receipt);
    assert.equal(JSON.parse(replica.read(scope).records[0].body).title, "Later edit");
    assert.equal(replica.next(scope).operation_id, second.operationId);
    replica.pull(scope, 0, feed([{ cursor: 1, kind: "task", id: first.operation.id, revision: 1, deleted: false, value: first.record }]));
    assert.equal(JSON.parse(replica.read(scope).records[0].body).title, "Later edit");
    replica.reconcile(scope, accepted(second, later, 2));
    assert.equal(replica.next(scope), null);
    assert.equal(replica.read(scope).records[0].revision, 2);
    assert.ok(replica.inspect(scope).every(row => row.status === "accepted"));
  } finally { database.close(); }
});

test("conflicts block dependent operations while failures and expired authentication remain inspectable", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const input = create(); replica.enqueue(scope, input.operation, input.record.title, input.record);
    replica.enqueue(scope, { ...input.operation, operationId: randomUUID(), action: "update", expectedRevision: 1 }, "Later edit", { ...input.record, version: 2 }, 1);
    replica.reconcile(scope, { protocol: "vorton.sync.v1", generation, operationId: input.operation.operationId, status: "conflict", current: null });
    assert.equal(replica.next(scope), null);
    const independent = create("Independent"); replica.enqueue(scope, independent.operation, independent.record.title, independent.record);
    assert.equal(replica.next(scope).operation_id, independent.operation.operationId);
    replica.mark(scope, independent.operation.operationId, "auth-required", "Reconnect to renew the session.");
    assert.equal(replica.next(scope), null);
    assert.equal(replica.inspect(scope).length, 3);
    assert.equal(replica.inspect(scope)[2].error, "Reconnect to renew the session.");
    assert.equal(JSON.parse(replica.read(scope).records.find(row => row.id === input.operation.id).body).version, 2);
  } finally { database.close(); }
});

test("a linked offline task waits for its goal while unrelated records can synchronize", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const goal = { operationId: randomUUID(), id: randomUUID(), kind: "goal", action: "create", expectedRevision: 0, value: { title: "Offline goal" } };
    replica.enqueue(scope, goal, "Offline goal", { id: goal.id, title: "Offline goal", version: 1 });
    const linked = create("Linked task"); linked.operation.value.goalId = goal.id; linked.record.goalId = goal.id;
    replica.enqueue(scope, linked.operation, linked.record.title, linked.record);
    replica.mark(scope, goal.operationId, "failed", "Goal needs review.");
    assert.equal(replica.next(scope), null);
    const unrelated = create("Independent task"); replica.enqueue(scope, unrelated.operation, unrelated.record.title, unrelated.record);
    assert.equal(replica.next(scope).operation_id, unrelated.operation.operationId);
    replica.mark(scope, goal.operationId, "pending");
    replica.reconcile(scope, accepted(goal, { id: goal.id, title: "Offline goal", version: 1 }));
    assert.equal(replica.next(scope).operation_id, linked.operation.operationId);
    assert.deepEqual(JSON.parse(replica.inspect(scope)[1].dependencies), [goal.operationId]);
  } finally { database.close(); }
});

test("server generation changes and invalid acknowledgements cannot erase pending work", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const input = create(); replica.enqueue(scope, input.operation, input.record.title, input.record);
    const before = replica.read(scope);
    assert.throws(() => replica.pull(scope, 0, { ...feed(), generation: randomUUID() }), /Server history changed/);
    assert.throws(() => replica.reconcile(scope, { ...accepted(input.operation, input.record), generation: randomUUID() }), /does not match/);
    assert.deepEqual(replica.read(scope), before);
  } finally { database.close(); }
});

test("a delayed acknowledgement cannot replace a newer server change", () => {
  const { database, replica } = open();
  try {
    prepare(replica);
    const input = create("Original");
    replica.pull(scope, 0, feed([{ cursor: 1, kind: "task", id: input.operation.id, revision: 1, deleted: false, value: input.record }]));
    const update = { ...input.operation, operationId: randomUUID(), action: "update", expectedRevision: 1, value: { title: "Local accepted edit" } };
    const local = { ...input.record, title: "Local accepted edit", version: 2 };
    replica.enqueue(scope, update, local.title, local, 1);
    const newer = { ...input.record, title: "Newer server edit", version: 3 };
    replica.pull(scope, 1, feed([{ cursor: 3, kind: "task", id: input.operation.id, revision: 3, deleted: false, value: newer }]));
    assert.equal(JSON.parse(replica.read(scope).records[0].body).title, local.title, "An outstanding local edit stays inspectable");
    replica.reconcile(scope, accepted(update, local, 2));
    assert.equal(JSON.parse(replica.read(scope).records[0].body).title, newer.title);
    assert.equal(replica.read(scope).records[0].revision, 3);
    assert.equal(JSON.parse(replica.inspect(scope)[0].receipt).value.title, local.title, "The accepted edit remains in its receipt");
  } finally { database.close(); }
});

test("initial-worker data upgrades without discarding records or queued operations", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE local_records(scope TEXT,kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(scope,kind,id));
      CREATE TABLE outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,
      record_id TEXT NOT NULL,title TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL,error TEXT,UNIQUE(scope,operation_id));`);
    const input = create("Before upgrade");
    database.prepare("INSERT INTO local_records VALUES(?,?,?,?)").run(scope, "task", input.operation.id, JSON.stringify(input.record));
    database.prepare("INSERT INTO outbox(scope,operation_id,kind,record_id,title,operation,status) VALUES(?,?,?,?,?,?,'pending')")
      .run(scope, input.operation.operationId, "task", input.operation.id, input.record.title, JSON.stringify(input.operation));
    const replica = new LocalReplica({ run: (sql, parameters = []) => { database.prepare(sql).run(...parameters); }, all: (sql, parameters = []) => database.prepare(sql).all(...parameters) });
    replica.initialize(); prepare(replica);
    assert.equal(replica.read(scope).records[0].revision, 1);
    assert.equal(replica.inspect(scope)[0].title, "Before upgrade");
    assert.equal(replica.inspect(scope)[0].generation, generation);
    database.prepare("UPDATE local_schema SET version=99").run();
    assert.throws(() => replica.initialize(), /needs a newer Vorton/);
    assert.equal(replica.inspect(scope).length, 1);
  } finally { database.close(); }
});
