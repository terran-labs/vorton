import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store, goalInput, taskInput } from "../server/store.mjs";
import { replicaMetadata } from "../server/replica-metadata.ts";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-replica-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root), { syncGeneration, ...state } = await store.read("Example");
  const meta = { version: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", history: [] };
  state.goals = [{ ...goalInput({ title: "Retained goal" }), ...meta, id: "original-goal" }];
  state.tasks = [{ ...taskInput({ title: "Retained task", goalId: "original-goal" }), ...meta, id: "original-task", evidence: { original: true } }];
  const filename = path.join(root, "Example/state/core.json"), bytes = JSON.stringify(state);
  await writeFile(filename, bytes, { mode: 0o600 });
  return { root, store, state, filename, bytes };
}

test("a legacy workspace is initialized before its captured download boundary is returned", async t => {
  const f = await fixture(t), state = await f.store.replicaState("Example");
  const feed = await f.store.changes("Example", 0, 200, { head: state.syncCursor, generation: state.syncGeneration });
  assert.equal(state.syncCursor, 2); assert.equal(feed.head, state.syncCursor); assert.equal(feed.more, false);
  assert.deepEqual(feed.changes.find(row => row.kind === "task").value, f.state.tasks[0]);
  assert.deepEqual(feed.changes.find(row => row.kind === "goal").value, f.state.goals[0]);
  assert.equal(await readFile(f.filename, "utf8"), f.bytes);
  const metadata = replicaMetadata({ ...state, requests: [{ id: "SYNTHETIC_PRIVATE_RECEIPT" }],
    auxiliary: { notes: "SYNTHETIC_PRIVATE_AUXILIARY" }, canonical: { goals: [{ private: "SYNTHETIC_PRIVATE_REGISTER" }], tasks: [] } });
  assert.deepEqual(metadata.tasks, []); assert.deepEqual(metadata.goals, []); assert.deepEqual(metadata.ideas, []);
  assert.deepEqual(metadata.canonical, { source: "sqlite", projection: "workspace-v1" });
  assert.equal(JSON.stringify(metadata).includes("SYNTHETIC_PRIVATE"), false);
});

test("a changing legacy source cannot be blessed as a different replica baseline", async t => {
  const f = await fixture(t), original = f.store.read.bind(f.store);
  let changed = false;
  f.store.read = async (...args) => {
    const state = await original(...args);
    if (!changed) { changed = true; await writeFile(f.filename, JSON.stringify({ ...f.state, revision: 1 })); }
    return state;
  };
  await assert.rejects(f.store.replicaState("Example"), /Legacy state changed while preparing/);
  const database = await f.store.openDatabase(await f.store.directory("Example"));
  try { assert.equal(database.snapshot("Example"), undefined); assert.equal(database.head("Example"), 0); }
  finally { database.close(); }
  assert.equal(JSON.parse(await readFile(f.filename, "utf8")).revision, 1, "An external source change must not be overwritten");
});
