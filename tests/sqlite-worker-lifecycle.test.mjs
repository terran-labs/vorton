import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { canonicalJson, parseSyncOperation } from "../shared/sync-contract.ts";
import { LocalReplica } from "../web/application/replica-sql.ts";

const source = await readFile(new URL("../web/application/sqlite-worker.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  let busy = true, available = true, paused = false, failOpen = false;
  let closes = 0, releases = 0;
  const answers = new Map(), waiters = new Map();
  const pool = {
    isPaused: () => paused,
    pauseVfs() { paused = true; },
    async unpauseVfs() { paused = false; },
    OpfsSAHPoolDb: class {
      constructor() { if (failOpen) throw Error("Cannot open persistent storage"); }
      exec() { return []; }
      close() { closes++; }
    },
  };
  const navigator = { get locks() { return available ? { request: async (_name, _options, work) => { await work(busy ? null : {}); if (!busy) releases++; } } : undefined; }, storage: { getDirectory() {} } };
  const context = vm.createContext({ exports: {}, navigator,
    require(name) {
      if (name === "@sqlite.org/sqlite-wasm") return { default: async () => ({ installOpfsSAHPoolVfs: async () => pool }) };
      if (name.includes("sync-contract")) return { canonicalJson, parseSyncOperation };
      if (name.includes("replica-sql")) return { LocalReplica };
      throw Error(`Unexpected dependency ${name}`);
    },
    postMessage(value) { answers.set(value.requestId, value); waiters.get(value.requestId)?.(value); },
  });
  vm.runInContext(compiled, context);
  let sequence = 0;
  return {
    setBusy(value) { busy = value; }, setAvailable(value) { available = value; }, setFailOpen(value) { failOpen = value; },
    get closes() { return closes; }, get releases() { return releases; }, get paused() { return paused; },
    request(action) {
      const requestId = ++sequence;
      const result = new Promise(resolve => waiters.set(requestId, resolve));
      context.onmessage({ data: { requestId, scope: "synthetic/workspace/owner", action } });
      return result;
    },
  };
}
test("a busy or unavailable device store can be retried without resetting its data", async () => {
  const worker = harness();
  assert.equal((await worker.request("inspect")).ok, false);
  worker.setBusy(false);
  assert.equal((await worker.request("inspect")).ok, true);
  await worker.request("close");
  assert.equal(worker.closes, 1);
  assert.equal(worker.paused, true);
  worker.setAvailable(false);
  assert.equal((await worker.request("inspect")).ok, false);
  worker.setAvailable(true);
  assert.equal((await worker.request("inspect")).ok, true);
  await worker.request("close");
});
test("failed persistent open releases ownership and permits a later retry", async () => {
  const worker = harness(); worker.setBusy(false); worker.setFailOpen(true);
  assert.equal((await worker.request("inspect")).ok, false);
  assert.equal(worker.paused, true);
  worker.setFailOpen(false);
  assert.equal((await worker.request("inspect")).ok, true);
  assert.equal(worker.paused, false);
  await worker.request("close");
});
