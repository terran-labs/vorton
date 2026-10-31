import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, taskInput, validateState } from "../server/store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-governance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new Store(root);
}
const command = (state, action, payload) => ({ requestId: randomUUID(), expectedRevision: state.revision, action, payload });

for (const transport of ["command", "sync"]) test(`${transport} cannot commit after a generation-only change during asynchronous validation`, async t => {
  const store = await fixture(t), initial = await store.read("AubOS");
  let entered, release;
  const enteredGate = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  store.beforeCommand = async () => { entered(); await gate; };
  const operation = { operationId: randomUUID(), id: randomUUID(), kind: "task", action: "create", expectedRevision: 0, value: { title: "Stale history write" } };
  const writing = transport === "command"
    ? store.command("AubOS", command(initial, "task.create", { fields: { title: "Stale history write" } }))
    : store.sync("AubOS", operation, { generation: initial.syncGeneration });
  await enteredGate;
  const connection = await new Store(store.root).openDatabase(await store.directory("AubOS")), nextGeneration = randomUUID();
  try { connection.db.prepare("UPDATE replica_generations SET generation=? WHERE scope=?").run(nextGeneration, "AubOS"); }
  finally { connection.close(); }
  release(); await assert.rejects(writing, error => error.code === "history-changed" && error.status === 409);
  const state = await store.read("AubOS");
  assert.equal(state.revision, 0); assert.equal(state.tasks.length, 0); assert.equal(state.events.length, 0); assert.equal(state.requests.length, 0);
  assert.equal(state.syncGeneration, nextGeneration);
  const checked = await store.openDatabase(await store.directory("AubOS"));
  try { assert.equal(checked.db.prepare("SELECT COUNT(*) AS count FROM replica_receipts").get().count, 0); }
  finally { checked.close(); }
  store.beforeCommand = undefined;
  await assert.rejects(store.command("AubOS", { ...command(state, "task.create", { fields: { title: "Old draft" } }), expectedGeneration: initial.syncGeneration }), error => error.code === "history-changed");
  const saved = await store.command("AubOS", { ...command(state, "task.create", { fields: { title: "Reviewed new history" } }), expectedGeneration: nextGeneration });
  assert.equal(saved.tasks.length, 1);
});

test("governed imports reject missing, duplicate and orphan outcomes without altering the workspace", async t => {
  const store = await fixture(t), state = await store.read("AubOS");
  state.governance = { tasks: { retainCompletedOutcomes: true } };
  state.tasks = [{ id: "original-task", status: "done" }];
  await assert.rejects(store.restoreSnapshot("AubOS", state), /missing its governed outcome/);
  assert.equal((await store.read("AubOS")).tasks.length, 0);
  state.taskOutcomes = [{ id: "original-outcome", taskId: "original-task", legacy: { result_evidence: "unavailable-original.md" } }];
  assert.throws(() => validateState({ ...state, taskOutcomes: [...state.taskOutcomes, { id: "second", taskId: "original-task" }] }, "AubOS"), /duplicate outcomes/);
  assert.throws(() => validateState({ ...state, tasks: [] }, "AubOS"), /requires a completed task/);
  await store.restoreSnapshot("AubOS", state);
  const reopened = await new Store(store.root).read("AubOS");
  assert.deepEqual(reopened.taskOutcomes, state.taskOutcomes);
  await assert.rejects(store.command("AubOS", command(reopened, "task.delete", { id: "original-task" })), /governed outcome/);
});

test("accepted recommendation retains proposal and owner decision atomically and only once", async t => {
  const store = await fixture(t);
  let state = await store.read("AubOS");
  state = await store.command("AubOS", command(state, "recommendation.create", {
    role: state.council.identities[0].id, kind: "task", targetId: "", targetVersion: null,
    rationale: "Small test", tradeoffs: "Owner time", confidence: "medium", evidence: "original-proposal.md",
    proposal: { title: "Proposed task" },
  }));
  const proposal = structuredClone(state.recommendations[0]);
  const accept = command(state, "recommendation.resolve", { id: proposal.id, decision: "accepted", note: "Owner approved this local task" });
  state = await store.command("AubOS", accept);
  const audit = state.strategicAudit.at(-1);
  assert.equal(audit.operationId, accept.requestId);
  assert.equal(audit.workspaceRevision, state.revision);
  assert.deepEqual(audit.decision.proposal, proposal);
  assert.equal(audit.decision.choice, "accepted");
  assert.equal(audit.decision.resultId, state.tasks[0].id);
  assert.match(audit.authority, /no external action/);
  await new Store(store.root).command("AubOS", accept);
  assert.deepEqual((await store.read("AubOS")).strategicAudit, state.strategicAudit);
  await assert.rejects(store.command("AubOS", command(state, "recommendation.resolve", { id: proposal.id, decision: "rejected" })), /already resolved/);
  assert.deepEqual((await store.read("AubOS")).strategicAudit, state.strategicAudit);
});

test("lost sync acknowledgement replays its audit identity without another entry", async t => {
  const store = await fixture(t);
  const operation = { operationId: randomUUID(), id: randomUUID(), kind: "task", action: "create", expectedRevision: 0, value: { title: "Offline task" } };
  await store.sync("AubOS", operation);
  await new Store(store.root).sync("AubOS", operation);
  const state = await store.read("AubOS");
  assert.equal(state.strategicAudit.length, 1);
  assert.equal(state.strategicAudit[0].operationId, operation.operationId);
  assert.equal(state.strategicAudit[0].subjectId, operation.id);
});

test("a second restore cannot overwrite a populated workspace", async t => {
  const store = await fixture(t), original = await store.read("AubOS");
  await store.command("AubOS", command(original, "task.create", { fields: { title: "Already authoritative" } }));
  await assert.rejects(new Store(store.root).restoreSnapshot("AubOS", original), /empty SQLite workspace/);
  assert.equal((await store.read("AubOS")).tasks[0].title, "Already authoritative");
});

for (const transport of ["command", "sync"]) test(`${transport} uses the winning revision-zero restore after an empty read`, async t => {
  const store = await fixture(t), restored = await store.read("AubOS");
  restored.tasks = [{ ...taskInput({ title: "Restored task", notes: "Retained evidence" }), id: "original-restored-task",
    version: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", history: [] }];
  let entered, release;
  const held = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const originalRead = store.read.bind(store);
  let first = true, baseline;
  store.read = async profile => {
    const state = await originalRead(profile);
    if (first) { first = false; entered(); await resume; }
    return state;
  };
  store.beforeCommand = async (_, state) => { baseline = structuredClone(state); };
  const intent = transport === "command" ? command(restored, "task.create", { fields: { title: "New command task" } })
    : { operationId: randomUUID(), kind: "task", action: "update", id: restored.tasks[0].id, expectedRevision: 1, value: { title: "Updated restored task" } };
  const attempt = store[transport]("AubOS", intent);
  // Attach failure handling before releasing either asynchronous path.
  const finished = attempt.then(value => ({ value }), error => ({ error }));
  await held;
  try { await new Store(store.root).restoreSnapshot("AubOS", restored); }
  finally { release(); }
  const outcome = await finished;
  assert.equal(outcome.error, undefined);
  assert.equal(baseline.tasks[0].id, restored.tasks[0].id, "Evidence preflight must see the authoritative restored model");
  const final = await originalRead("AubOS");
  assert.equal(final.tasks.find(task => task.id === restored.tasks[0].id).notes, "Retained evidence");
  assert.equal(final.tasks.length, transport === "command" ? 2 : 1);
  assert.equal(final.revision, 1);
});
