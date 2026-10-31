import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.mjs";
import { AuxiliaryState } from "../server/auxiliary-state.ts";

async function fixture(t, auxiliary) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-auxiliary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root), initial = await store.read("AubOS");
  initial.storage = { contract: "vorton.sqlite-workspace.v1" };
  if (auxiliary) initial.auxiliary = { fixture: auxiliary };
  await store.restoreSnapshot("AubOS", initial);
  const legacyFile = path.join(root, "retained.json");
  const service = () => new AuxiliaryState({ store: async () => store, scope: "AubOS", key: "fixture", legacyFile,
    initial: () => ({ revision: 0, text: "" }), validate: value => {
      assert.ok(value && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.text === "string");
      return value;
    } });
  return { root, store, legacyFile, service };
}

test("auxiliary records persist through trusted commands and reject ordinary command dispatch", async t => {
  const f = await fixture(t, { revision: 7, text: "Imported text", original: { retained: true } });
  await writeFile(f.legacyFile, "Retained source export");
  const result = await f.service().change(value => { value.text = "Saved text"; value.revision++; return value.text; });
  assert.equal(result, "Saved text");
  assert.deepEqual(await f.service().read(), { revision: 8, text: "Saved text", original: { retained: true } });
  assert.equal(await readFile(f.legacyFile, "utf8"), "Retained source export");
  const workspace = await f.store.read("AubOS");
  assert.equal(workspace.revision, 1); assert.equal(workspace.events.length, 1); assert.equal(workspace.requests.length, 1);
  await assert.rejects(f.store.command("AubOS", { requestId: randomUUID(), expectedRevision: 1,
    action: "private.fixture", payload: { key: "fixture" } }), /Unknown command/);
  await assert.rejects(f.service().change(value => { value.text = 17; }));
  assert.equal((await f.service().read()).text, "Saved text");
  assert.equal((await f.store.read("AubOS")).revision, 1);
});

test("a retained but unimported auxiliary source blocks empty replacement", async t => {
  const f = await fixture(t);
  await writeFile(f.legacyFile, "Existing private source");
  await assert.rejects(f.service().read(), /has not been imported/);
  await assert.rejects(f.service().change(value => { value.text = "Replacement"; }), /has not been imported/);
  const workspace = await f.store.read("AubOS");
  assert.equal(workspace.revision, 0); assert.equal(workspace.auxiliary, undefined);
  assert.equal(await readFile(f.legacyFile, "utf8"), "Existing private source");
});

test("a concurrent planning command rejects a held auxiliary update without lost records or auxiliary changes", async t => {
  const f = await fixture(t);
  let entered, release;
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const update = f.service().change(async value => { value.text = "Stale private change"; entered(); await gate; });
  await enteredGate;
  await f.store.command("AubOS", { requestId: randomUUID(), expectedRevision: 0, action: "task.create", payload: { fields: { title: "Concurrent task" } } });
  release(); await assert.rejects(update, /out of date/);
  const workspace = await f.store.read("AubOS");
  assert.equal(workspace.tasks.length, 1); assert.equal(workspace.revision, 1); assert.equal(workspace.requests.length, 1);
  assert.equal(workspace.auxiliary, undefined); assert.equal((await f.service().read()).text, "");
  await assert.rejects(access(f.legacyFile));
});

test("browser history is explicit and a restored history rejects unchanged auxiliary revisions without audit", async t => {
  const f = await fixture(t, { revision: 7, text: "Retained" });
  const read = await f.service().readWithHistory();
  assert.deepEqual(read.value, { revision: 7, text: "Retained" });
  assert.equal(read.syncGeneration, (await f.store.read("AubOS")).syncGeneration);
  let reductions = 0;
  for (const expectedGeneration of [undefined, null, "", 17])
    await assert.rejects(f.service().change(() => { reductions++; }, { expectedGeneration }), error => error.code === "history-required");
  await f.store.adoptHistory("AubOS", { requestId: randomUUID(), expectedGeneration: read.syncGeneration, expectedRevision: 0 });
  const before = await f.store.read("AubOS");
  await assert.rejects(f.service().change(() => { reductions++; }, { expectedGeneration: read.syncGeneration }), error => error.code === "history-changed");
  assert.equal(reductions, 0); assert.deepEqual(await f.store.read("AubOS"), before);
  await f.service().change(value => { value.text = "Fresh"; }, { expectedGeneration: before.syncGeneration });
  assert.equal((await f.service().read()).text, "Fresh");
});

for (const browser of [false, true]) test(`history adoption fences a held ${browser ? "browser" : "trusted"} reducer at commit`, async t => {
  const f = await fixture(t, { revision: 7, text: "Retained" });
  const baseline = await f.store.read("AubOS");
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const held = f.service().change(async value => { value.text = "Held"; entered(); await gate; }, browser ? { expectedGeneration: baseline.syncGeneration } : undefined);
  await ready;
  await f.store.adoptHistory("AubOS", { requestId: randomUUID(), expectedGeneration: baseline.syncGeneration, expectedRevision: baseline.revision });
  const restored = await f.store.read("AubOS");
  release(); await assert.rejects(held, error => error.code === "history-changed");
  assert.deepEqual(await f.store.read("AubOS"), restored);
});

test("a read held across adoption keeps its auxiliary value and generation in one snapshot", async t => {
  const f = await fixture(t, { revision: 7, text: "Reviewed" });
  const originalRead = f.store.read.bind(f.store);
  const originalAuxiliaryRead = f.store.readAuxiliary.bind(f.store);
  const reviewed = await originalRead("AubOS");
  f.store.readAuxiliary = async (scope, key) => {
    const snapshot = await originalAuxiliaryRead(scope, key);
    f.store.readAuxiliary = originalAuxiliaryRead;
    await f.store.adoptHistory(scope, { requestId: randomUUID(), expectedGeneration: snapshot.syncGeneration, expectedRevision: snapshot.revision });
    return snapshot;
  };
  const snapshot = await f.service().readWithHistory();
  assert.equal(snapshot.syncGeneration, reviewed.syncGeneration);
  assert.deepEqual(snapshot.value, reviewed.auxiliary.fixture);
  assert.notEqual(snapshot.syncGeneration, (await originalRead("AubOS")).syncGeneration);
});
