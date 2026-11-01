import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteReplica } from "../server/sqlite-replica.ts";

const scope = "installation/workspace/user";

test("paged downloads keep their captured head while later writes remain available to the next download", () => {
  const store = new SqliteReplica(":memory:");
  try {
    store.put(scope, "task", "first", 1, false, { id: "first", title: "First" });
    const foreign = store.put("other-workspace", "task", "other", 1, false, { id: "other", title: "Other" });
    store.put(scope, "task", "second", 1, false, { id: "second", title: "Second" });
    const first = store.feed(scope, 0, 1);
    assert.equal(first.more, true); assert.equal(first.head, 3); assert.equal(first.cursor, 1);
    store.put(scope, "task", "first", 2, false, { id: "first", title: "Updated after capture" });
    const boundary = { head: first.head, generation: first.generation };
    const last = store.feed(scope, first.cursor, 1, boundary);
    assert.equal(last.head, 3); assert.equal(last.cursor, 3); assert.equal(last.more, false);
    assert.deepEqual(last.changes.map(row => row.id), ["second"]);
    const next = store.feed(scope, last.cursor);
    assert.equal(next.changes[0].value.title, "Updated after capture"); assert.equal(next.cursor, 4);
    for (const invalid of [{ head: foreign, generation: first.generation }, { head: 99, generation: first.generation }, { head: 3 }])
      assert.throws(() => store.feed(scope, 0, 1, invalid), error => error.status === 400);
    assert.throws(() => store.feed(scope, 0, 1, { head: 3, generation: randomUUID() }), error => error.code === "history-changed");
  } finally { store.close(); }
});
const operation = (extra = {}) => ({ operationId: randomUUID(), kind: "task", id: randomUUID(), expectedRevision: 0, action: "create", value: { title: "Offline task" }, ...extra });
const validate = ({ value }) => {
  if (!value?.title?.trim()) throw Error("A title is required");
  return value;
};
test("twenty operations survive reopen and lost acknowledgements without duplicates", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vorton-sqlite-"));
  const filename = path.join(directory, "state.sqlite");
  let store = new SqliteReplica(filename);
  try {
    const operations = Array.from({ length: 20 }, (_, i) => operation({ value: { title: `Task ${i + 1}` } }));
    const receipts = operations.map(op => store.apply(scope, op, validate));
    store.close(); store = new SqliteReplica(filename);
    assert.deepEqual(operations.map(op => store.apply(scope, op, validate)), receipts);
    assert.equal(store.changes(scope).length, 20);
    assert.equal(store.changes("another/workspace/user").length, 0);
    assert.equal(store.changes(scope, receipts[9].cursor).length, 10);
    assert.throws(() => store.apply(scope, { ...operations[0], value: { title: "Different" } }, validate), /identity reused/);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});
test("conflicts remain stable, deletion has a tombstone, validation rolls back", () => {
  const store = new SqliteReplica(":memory:");
  try {
    const create = operation(); store.apply(scope, create, validate);
    const stale = operation({ id: create.id, action: "update", value: { title: "Stale" } });
    const conflict = store.apply(scope, stale, validate);
    assert.equal(conflict.status, "conflict");
    const remove = operation({ id: create.id, action: "delete", expectedRevision: 1 });
    const deleted = store.apply(scope, remove, validate);
    assert.equal(deleted.deleted, true);
    assert.deepEqual(store.apply(scope, stale, validate), conflict);
    assert.equal(store.changes(scope).length, 2);
    assert.equal(store.apply(scope, operation({ id: create.id }), validate).status, "conflict");
    assert.throws(() => store.apply(scope, operation({ value: {} }), validate), /title/);
    assert.equal(store.changes(scope).length, 2);
  } finally { store.close(); }
});
test("import preserves opaque history, relationships and every assessment field atomically", () => {
  const store = new SqliteReplica(":memory:");
  try {
    const source = { tasks: [{ id: "T-1", goalIds: ["G-1"], history: [{ evidence: "relative/file.md" }] }], goals: [{ id: "G-1" }], ideas: [{ id: "I-1", pull: "high", assessment: { provisional: true, unknownFutureField: 7 } }], history: { requests: { old: "receipt" } } };
    const digest = store.import(scope, source);
    assert.equal(store.import(scope, source), digest);
    assert.deepEqual(store.record(scope, "idea", "I-1").value, source.ideas[0]);
    assert.deepEqual(JSON.parse(store.db.prepare("SELECT source FROM replica_imports WHERE scope=?").get(scope).source), source);
    assert.throws(() => store.import(scope, { ...source, ideas: [] }), /different source/);
    assert.throws(() => store.import("bad", { tasks: [{ id: "duplicate" }, { id: "duplicate" }] }), /duplicate/);
    assert.equal(store.changes("bad").length, 0);
  } finally { store.close(); }
});

test("workspace operations commit domain history, revisions, changes and durable receipts together", () => {
  const store = new SqliteReplica(":memory:");
  const reduce = (state, input) => {
    if (!input.value?.title) throw Error("A title is required");
    const collection = state[`${input.kind}s`] ??= [];
    const next = { id: input.id, ...input.value };
    if (input.action === "create") collection.push(next);
    else collection.splice(collection.findIndex(record => record.id === input.id), 1, ...(input.action === "delete" ? [] : [next]));
    state.revision++;
    state.events.push({ operationId: input.id, action: input.action });
    return state;
  };
  try {
    store.importWorkspace(scope, { revision: 0, tasks: [], events: [] }, { retained: "original" });
    const create = operation();
    const accepted = store.applyWorkspace(scope, create, reduce);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.revision, 1);
    assert.equal(store.snapshot(scope).tasks[0].id, create.id);
    assert.equal(store.snapshot(scope).events.length, 1);
    assert.deepEqual(store.applyWorkspace(scope, create, () => { throw Error("A retry must not repeat domain work"); }), accepted);
    assert.equal(store.snapshot(scope).revision, 1);
    const conflict = operation({ id: create.id, action: "update", value: { title: "Stale" } });
    assert.equal(store.applyWorkspace(scope, conflict, reduce).status, "conflict");
    const update = operation({ id: create.id, action: "update", expectedRevision: 1, value: { title: "Updated" } });
    assert.equal(store.applyWorkspace(scope, update, reduce).revision, 2);
    assert.equal(store.snapshot(scope).tasks[0].title, "Updated");
    const remove = operation({ id: create.id, action: "delete", expectedRevision: 2 });
    assert.equal(store.applyWorkspace(scope, remove, (state, input) => reduce(state, { ...input, value: { title: "Delete" } })).deleted, true);
    assert.equal(store.snapshot(scope).tasks.length, 0);
    assert.equal(store.snapshot(scope).events.length, 3);
    assert.equal(store.changes(scope).length, 3);
    assert.throws(() => store.apply(scope, operation(), validate), /domain command layer/);
    assert.deepEqual(store.applyWorkspace(scope, conflict, reduce).status, "conflict");
  } finally { store.close(); }
});

test("invalid domain reductions roll back the snapshot, changes and receipt", () => {
  const store = new SqliteReplica(":memory:");
  try {
    store.importWorkspace(scope, { revision: 0, tasks: [], events: [] }, {});
    const op = operation();
    assert.throws(() => store.applyWorkspace(scope, op, state => ({ ...state, revision: 1 })), /did not apply/);
    assert.equal(store.snapshot(scope).revision, 0);
    assert.equal(store.changes(scope).length, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM replica_receipts").get().count, 0);
    assert.throws(() => store.applyWorkspace(scope, op, state => state), /advance the workspace revision/);
    assert.equal(store.snapshot(scope).revision, 0);
  } finally { store.close(); }
});
