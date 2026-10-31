import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-history-adoption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const operation = { operationId: randomUUID(), id: randomUUID(), kind: "task", action: "create", expectedRevision: 0, value: { title: "Retained task" } };
  const receipt = await store.sync("Example", operation);
  const state = await store.read("Example");
  const input = { requestId: randomUUID(), expectedGeneration: state.syncGeneration, expectedRevision: state.revision };
  return { root, store, operation, receipt, state, input };
}

test("history adoption preserves records and sync receipts and replays a lost acknowledgement once", async t => {
  const f = await fixture(t), other = await f.store.read("Other");
  const adopted = await f.store.adoptHistory("Example", f.input);
  assert.notEqual(adopted.generation, f.state.syncGeneration);
  assert.equal(adopted.previousGeneration, f.state.syncGeneration);
  assert.deepEqual(await new Store(f.root).adoptHistory("Example", f.input), adopted);
  const state = await f.store.read("Example");
  assert.deepEqual(state.tasks, f.state.tasks); assert.deepEqual(state.goals, f.state.goals); assert.deepEqual(state.ideas, f.state.ideas);
  assert.equal(state.revision, f.state.revision + 1); assert.equal(state.syncGeneration, adopted.generation);
  assert.equal(state.events.length, f.state.events.length + 1); assert.equal(state.requests.length, f.state.requests.length + 1);
  assert.equal(state.events.at(-1).action, "maintenance.history.adopt");
  assert.deepEqual(await f.store.read("Other"), other);
  await assert.rejects(f.store.sync("Example", f.operation, { generation: f.state.syncGeneration }), error => error.code === "history-changed");
  const replay = await f.store.sync("Example", f.operation, { generation: adopted.generation });
  const { generation: oldGeneration, ...oldReceipt } = f.receipt;
  const { generation: newGeneration, ...newReceipt } = replay;
  assert.deepEqual(newReceipt, oldReceipt); assert.equal(newGeneration, adopted.generation);
  assert.equal((await f.store.read("Example")).events.length, state.events.length);
  await assert.rejects(f.store.adoptHistory("Example", { ...f.input, expectedRevision: state.revision }), /identity reused/);
  await assert.rejects(f.store.adoptHistory("Example", { ...f.input, requestId: randomUUID(), expectedRevision: state.revision }), error => error.code === "history-changed");
  await assert.rejects(f.store.command("Example", { requestId: randomUUID(), expectedRevision: state.revision,
    expectedGeneration: state.syncGeneration, action: "maintenance.history.adopt", payload: {} }), /Unknown command/);
});

test("failed history adoption rolls back the generation, snapshot, event and adoption receipt together", async t => {
  const f = await fixture(t), database = await f.store.openDatabase(await f.store.directory("Example"));
  try {
    database.db.exec("CREATE TRIGGER fail_adoption BEFORE INSERT ON replica_history_adoptions BEGIN SELECT RAISE(ABORT, 'Injected adoption failure'); END");
    await assert.rejects(f.store.adoptHistory("Example", f.input), /Injected adoption failure/);
    assert.deepEqual(await f.store.read("Example"), f.state);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM replica_history_adoptions").get().count, 0);
  } finally { database.close(); }
});

test("replaying a historical adoption after a newer adoption cannot change current history", async t => {
  const f = await fixture(t), first = await f.store.adoptHistory("Example", f.input);
  const second = await f.store.adoptHistory("Example", { requestId: randomUUID(), expectedGeneration: first.generation, expectedRevision: first.revision });
  const current = await f.store.read("Example");
  assert.deepEqual(await f.store.adoptHistory("Example", f.input), first);
  assert.deepEqual(await f.store.read("Example"), current);
  assert.equal(current.syncGeneration, second.generation);
  assert.equal(current.revision, f.state.revision + 2);
});

test("maintenance cannot invent a restored snapshot in an empty storage root", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-history-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root), state = await store.read("Example");
  await assert.rejects(store.adoptHistory("Example", { requestId: randomUUID(), expectedGeneration: state.syncGeneration, expectedRevision: 0 }), /restored workspace snapshot/);
  const database = await store.openDatabase(await store.directory("Example"));
  try { assert.equal(database.snapshot("Example"), undefined); }
  finally { database.close(); }
});

test("one operation identity cannot create records through both command transports", async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.command("Example", { requestId: f.operation.operationId, expectedRevision: f.state.revision,
    action: "task.create", payload: { fields: { title: "Duplicate transport attempt" } } }), /synchronization protocol/);
  assert.equal((await f.store.read("Example")).tasks.length, 1);
  const id = randomUUID();
  const state = await f.store.command("Example", { requestId: id, expectedRevision: f.state.revision,
    action: "task.create", payload: { fields: { title: "Foreground task" } } });
  await assert.rejects(f.store.sync("Example", { ...f.operation, operationId: id, id: randomUUID() }, { generation: state.syncGeneration }), /earlier command protocol/);
  assert.equal((await f.store.read("Example")).tasks.length, 2);
  await assert.rejects(f.store.adoptHistory("Example", { requestId: id, expectedRevision: state.revision, expectedGeneration: state.syncGeneration }), /existing operation/);
});
