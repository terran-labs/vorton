import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.mjs";

async function fixture() {
  return new Store(await mkdtemp(path.join(os.tmpdir(), "vorton-store-")));
}
const cmd = (action, payload, expectedRevision = 0) => ({
  requestId: randomUUID(),
  expectedRevision,
  action,
  payload,
});
test("goals start empty, persist, and stay isolated", async () => {
  const store = await fixture();
  const state = await store.command(
    "AubOS",
    cmd("goal.create", { fields: { title: "Controlled goal" } }),
  );
  assert.equal(state.goals[0].title, "Controlled goal");
  assert.equal((await store.read("AubOS")).goals.length, 1);
  assert.equal((await store.read("FreedOS")).goals.length, 0);
  await assert.rejects(store.read("../AubOS"), /Unknown installation/);
  await assert.rejects(
    store.command(
      "FreedOS",
      cmd("task.create", {
        fields: { title: "Foreign task", goalId: state.goals[0].id },
      }),
    ),
    /does not belong/,
  );
});

test("twenty offline operations use domain validation and remain idempotent after reopening the Store", async () => {
  const store = await fixture();
  const operations = Array.from({ length: 20 }, (_, index) => ({ operationId: randomUUID(), kind: "task", id: randomUUID(),
    action: "create", expectedRevision: 0, value: { title: `Offline task ${index + 1}` } }));
  const receipts = [];
  for (const operation of operations) receipts.push(await store.sync("AubOS", operation));
  const reopened = new Store(store.root);
  for (let index = 0; index < operations.length; index++) assert.deepEqual(await reopened.sync("AubOS", operations[index]), receipts[index]);
  const state = await reopened.read("AubOS");
  assert.equal(state.tasks.length, 20);
  assert.equal(state.events.length, 20);
  assert.equal(state.revision, 20);
  assert.deepEqual(new Set(state.tasks.map(task => task.id)), new Set(operations.map(operation => operation.id)));
  assert.equal((await reopened.read("FreedOS")).tasks.length, 0);
  await assert.rejects(reopened.sync("AubOS", { ...operations[0], value: { title: "Reused identity" } }), /identity reused/);
  await assert.rejects(reopened.sync("AubOS", { ...operations[0], operationId: randomUUID(), id: randomUUID(), value: {} }), /title/);
  assert.equal((await reopened.read("AubOS")).revision, 20);
});

test("offline updates use record revisions across ordinary commands, with durable conflicts and deletion", async () => {
  const store = await fixture(), id = randomUUID();
  const make = extra => ({ operationId: randomUUID(), kind: "task", id, action: "update", expectedRevision: 1, value: { title: "Offline update" }, ...extra });
  await store.sync("AubOS", make({ action: "create", expectedRevision: 0, value: { title: "Created" } }));
  await store.command("AubOS", cmd("goal.create", { fields: { title: "Unrelated edit" } }, 1));
  const updated = await store.sync("AubOS", make({}));
  assert.equal(updated.status, "accepted");
  assert.equal(updated.revision, 2);
  const stale = make({ value: { title: "Stale edit" } });
  const conflict = await store.sync("AubOS", stale);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.current.value.title, "Offline update");
  const remove = make({ action: "delete", expectedRevision: 2 }); delete remove.value;
  const removed = await store.sync("AubOS", remove);
  assert.equal(removed.deleted, true);
  assert.equal(removed.revision, 3);
  assert.equal((await store.read("AubOS")).tasks.length, 0);
  assert.deepEqual(await store.sync("AubOS", stale), conflict);
  assert.deepEqual(await store.sync("AubOS", remove), removed);
  assert.equal((await store.sync("AubOS", make({ action: "create", expectedRevision: 0 }))).status, "conflict");
});

test("offline deletion preserves relationship and graduation rules", async () => {
  const store = await fixture(), goalId = randomUUID();
  const goal = { operationId: randomUUID(), kind: "goal", id: goalId, action: "create", expectedRevision: 0, value: { title: "Parent" } };
  await store.sync("AubOS", goal);
  await store.sync("AubOS", { operationId: randomUUID(), kind: "task", id: randomUUID(), action: "create", expectedRevision: 0,
    value: { title: "Linked task", goalId } });
  await assert.rejects(store.sync("AubOS", { operationId: randomUUID(), kind: "goal", id: goalId, action: "delete", expectedRevision: 1 }), /Remove links/);
  const state = await store.read("AubOS");
  assert.equal(state.goals.length, 1);
  assert.equal(state.events.length, 2);
});

test("a partial offline idea edit preserves every assessment and opaque historical field", async () => {
  const store = await fixture();
  const snapshot = await store.read("AubOS");
  const original = { id: "IDEA-2026-001", version: 71, title: "Assessed idea", description: "Original description", original: "Original capture",
    owner: "Owner", status: "exploring", projects: ["Project"], tags: ["Retained"], goalIds: [],
    value: "high", complexity: "low", effort: "medium", upkeep: "low", confidence: "high", pull: "high",
    startCondition: "Evidence first", experiment: "Small test", reviewOn: "", evidence: "reports/original.md",
    createdAt: "2026-01-01", updatedAt: "2026-01-02", history: [{ fields: { pull: "medium" }, reason: "Owner assessment" }],
    assessment: { provisional: true, source: "reports/assessment.md", unknownFutureField: 7 }, legacy: { unknown_column: "retained" } };
  snapshot.ideas = [original];
  await store.restoreSnapshot("AubOS", snapshot);
  const receipt = await store.sync("AubOS", { operationId: randomUUID(), kind: "idea", id: original.id,
    action: "update", expectedRevision: 1, value: { title: "Refined title" } });
  assert.equal(receipt.status, "accepted");
  const idea = (await store.read("AubOS")).ideas[0];
  for (const key of ["value", "complexity", "effort", "upkeep", "confidence", "pull", "description", "original", "evidence", "assessment", "legacy"])
    assert.deepEqual(idea[key], original[key], key);
  assert.equal(idea.history.length, 2);
  assert.deepEqual(idea.history[1].fields.assessment, original.assessment);
  await assert.rejects(store.sync("AubOS", { operationId: randomUUID(), kind: "idea", id: original.id,
    action: "update", expectedRevision: 2, value: { assessment: { provisional: false } } }), /Unexpected field/);
});

test("an unchanged imported long idea title survives another edit while new titles retain their limit", async () => {
  const store = await fixture();
  await store.command("AubOS", cmd("idea.create", { fields: { title: "Initial" } }));
  const directory = await store.directory("AubOS"), database = await store.openDatabase(directory);
  let original;
  try {
    const state = database.snapshot("AubOS");
    original = { ...state.ideas[0], title: "A retained historical title ".repeat(10) };
    state.ideas[0] = original;
    database.saveSnapshot("AubOS", state, state.revision);
  } finally { database.close(); }
  const op = { operationId: randomUUID(), kind: "idea", id: original.id, action: "update", expectedRevision: 2, value: { pull: "high" } };
  assert.equal((await store.sync("AubOS", op)).status, "accepted");
  assert.equal((await store.read("AubOS")).ideas[0].title, original.title);
  await assert.rejects(store.sync("AubOS", { ...op, operationId: randomUUID(), expectedRevision: 3, value: { title: "New title ".repeat(30) } }), /Invalid title/);
});

test("a partial task edit retains imported long titles and notes without accepting oversized replacements", async () => {
  const store = await fixture();
  await store.command("AubOS", cmd("task.create", { fields: { title: "Initial" } }));
  const database = await store.openDatabase(await store.directory("AubOS"));
  let original;
  try {
    const state = database.snapshot("AubOS");
    original = { ...state.tasks[0], title: "Historical title ".repeat(20), notes: "Original evidence and notes. ".repeat(400) };
    state.tasks[0] = original;
    database.saveSnapshot("AubOS", state, state.revision);
  } finally { database.close(); }
  const op = { operationId: randomUUID(), kind: "task", id: original.id, action: "update", expectedRevision: 2, value: { priority: "high" } };
  assert.equal((await store.sync("AubOS", op)).status, "accepted");
  const changed = (await store.read("AubOS")).tasks[0];
  assert.equal(changed.title, original.title);
  assert.equal(changed.notes, original.notes);
  await assert.rejects(store.sync("AubOS", { ...op, operationId: randomUUID(), expectedRevision: 3, value: { notes: "New evidence ".repeat(1000) } }), /Invalid notes/);
});
test("expected revision, exact retry, and conflicting retry are enforced", async () => {
  const store = await fixture();
  const command = cmd("goal.create", { fields: { title: "Goal" } });
  await store.command("AubOS", command);
  await store.command("AubOS", command);
  assert.equal((await store.read("AubOS")).goals.length, 1);
  await assert.rejects(
    store.command("AubOS", {
      ...command,
      payload: { fields: { title: "Substitution" } },
    }),
    /reused/,
  );
  await assert.rejects(
    store.command("AubOS", cmd("goal.create", { fields: { title: "Stale" } })),
    /out of date/,
  );
});

test("retained legacy receipts recognize identical JSON across whitespace and Unicode serialization", async () => {
  const store = await fixture(), requestId = randomUUID();
  const command = { requestId, expectedRevision: 0, action: "goal.create", payload: { fields: { title: "Café, idea: proof" } } };
  const state = await store.read("AubOS");
  state.revision = 1;
  state.goals = [{ id: "GOAL-2026-001", title: "Café, idea: proof" }];
  state.requests = [{ id: requestId, command: `{"action": "goal.create", "expectedRevision": 0, "payload": {"fields": {"title": "Caf\\u00e9, idea: proof"}}, "requestId": "${requestId}"}` }];
  await store.restoreSnapshot("AubOS", state);
  assert.equal((await store.command("AubOS", command)).goals.length, 1);
  await assert.rejects(store.command("AubOS", { ...command, payload: { fields: { title: "Different command" } } }), /identity was reused/);
  assert.equal((await store.read("AubOS")).revision, 1);
});
test("recommendations do not change goals until accepted, and acceptance is atomic", async () => {
  const store = await fixture();
  let s = await store.command(
    "FreedOS",
    cmd("recommendation.create", {
      role: "CTO",
      kind: "goal",
      rationale: "Controlled evidence",
      proposal: { title: "Improve a fixture" },
    }),
  );
  assert.equal(s.goals.length, 0);
  s = await store.command(
    "FreedOS",
    cmd(
      "recommendation.resolve",
      { id: s.recommendations[0].id, decision: "accepted" },
      s.revision,
    ),
  );
  assert.equal(s.goals.length, 1);
  assert.equal(s.recommendations[0].resultId, s.goals[0].id);
  assert.equal(s.events.length, 2);
});
test("goal reviews bind exact version, preserve history, and reject cycles", async () => {
  const store = await fixture();
  let s = await store.command(
    "AubOS",
    cmd("goal.create", { fields: { title: "Original" } }),
  );
  const id = s.goals[0].id;
  s = await store.command(
    "AubOS",
    cmd(
      "recommendation.create",
      {
        role: "COO",
        kind: "goal-review",
        targetId: id,
        targetVersion: 1,
        rationale: "Review",
        proposal: { title: "Suggested" },
      },
      s.revision,
    ),
  );
  s = await store.command(
    "AubOS",
    cmd("goal.update", { id, fields: { title: "Owner edit" } }, s.revision),
  );
  assert.equal(s.goals[0].history[0].fields.title, "Original");
  await assert.rejects(
    store.command(
      "AubOS",
      cmd(
        "recommendation.resolve",
        { id: s.recommendations[0].id, decision: "accepted" },
        s.revision,
      ),
    ),
    /changed since/,
  );
  await assert.rejects(
    store.command(
      "AubOS",
      cmd(
        "goal.update",
        { id, fields: { title: "Cycle", parentId: id } },
        s.revision,
      ),
    ),
    /cycle/,
  );
});
test("concurrent writes cannot lose updates", async () => {
  const store = await fixture();
  const outcomes = await Promise.allSettled(
    [1, 2].map((i) =>
      store.command(
        "AubOS",
        cmd("goal.create", { fields: { title: `Goal ${i}` } }),
      ),
    ),
  );
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  const persisted = await new Store(store.root).read("AubOS");
  assert.equal(persisted.goals.length, 1);
  assert.equal(persisted.events.length, 1);
});
test("SQLite owns concurrency even when an old directory lease survives a crash", async () => {
  const store = await fixture();
  await mkdir(path.join(await store.directory("AubOS"), ".writer"));
  const operations = Array.from({ length: 20 }, (_, index) => ({ operationId: randomUUID(), id: randomUUID(), kind: "task",
    action: "create", expectedRevision: 0, value: { title: `Concurrent task ${index + 1}` } }));
  const attempts = await Promise.all(operations.flatMap(operation => [store.sync("AubOS", operation), new Store(store.root).sync("AubOS", operation)]));
  assert.equal(attempts.length, 40);
  assert.ok(attempts.every(receipt => receipt.status === "accepted"));
  const state = await new Store(store.root).read("AubOS");
  assert.equal(state.tasks.length, 20);
  assert.equal(state.revision, 20);
  assert.equal(state.strategicAudit.length, 20);
  assert.equal(state.events.length, 20);
});
test("legacy import preserves complete records and retains the source export", async () => {
  const store = await fixture();
  const source = await store.read("AubOS");
  source.revision = 7;
  source.events.push({ id: "legacy-event", detail: "Historical evidence" });
  source.unknownFutureField = { evidence: ["private/reference.md"] };
  const filename = path.join(await store.directory("AubOS"), "core.json");
  const bytes = JSON.stringify(source);
  await writeFile(filename, bytes);
  await store.command("AubOS", cmd("goal.create", { fields: { title: "After migration" } }, 7));
  const reopened = await new Store(store.root).read("AubOS");
  assert.equal(reopened.revision, 8);
  assert.deepEqual(reopened.unknownFutureField, source.unknownFutureField);
  assert.deepEqual(reopened.events[0], source.events[0]);
  assert.equal(await readFile(filename, "utf8"), bytes);
  // Competing legacy writes fail closed instead of being silently ignored.
  await writeFile(filename, JSON.stringify({ ...source, revision: 100 }));
  await assert.rejects(store.read("AubOS"), /Legacy state changed/);
});
test("symlink profile paths fail closed", async () => {
  const store = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "vorton-outside-"));
  await symlink(outside, path.join(store.root, "AubOS"));
  await assert.rejects(store.read("AubOS"), /symlink/);
});
test("validation rejects fields, nonfinite progress, and impossible dates", async () => {
  const store = await fixture();
  for (const fields of [
    { title: "X", progress: 101 },
    { title: "X", reviewOn: "2026-02-30" },
    { title: "X", execute: true },
  ]) {
    await assert.rejects(
      store.command("AubOS", cmd("goal.create", { fields })),
    );
  }
  assert.equal((await store.read("AubOS")).revision, 0);
});
