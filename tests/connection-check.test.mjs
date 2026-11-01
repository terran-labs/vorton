import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as retries from "../web/application/retry-gate.ts";

async function load(relative, dependencies = {}) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => dependencies[name] ?? {}, Error, AbortController, setTimeout, clearTimeout, Date, fetch, navigator: { onLine: true } });
  return exports;
}
// These checks exercise the real read deadline without starting device storage.
const reads = await load("../web/application/profile-cache.ts", { "./replica-service.ts": { ReplicaService: class {} }, "./retry-gate.ts": retries });
const checks = await load("../web/application/connection-check.ts", { "./profile-cache": reads });

test("request deadline includes a stalled response body and aborts without retrying", async () => {
  let calls = 0, signal;
  const fetcher = async (_, options) => { calls++; signal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; };
  await assert.rejects(reads.readJsonWithDeadline("/api/session", fetcher, 10), /timed out/);
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
});

test("browser offline hint does not override a reachable admitted installation", async () => {
  const result = await checks.checkConnection(async url => new Response(JSON.stringify(url === "/api/health"
    ? { status: "ready", service: "vorton-local" }
    : { installationId: "fixture", profiles: ["AubOS"] })), false);
  assert.equal(result.browserOnline, false); assert.equal(result.reachable, true); assert.equal(result.admitted, true);
});

test("server reachability and denied workspace access remain distinct", async () => {
  const result = await checks.checkConnection(async url => url === "/api/health"
    ? new Response(JSON.stringify({ status: "ready", service: "vorton-local" }))
    : new Response("denied", { status: 403 }), true);
  assert.equal(result.reachable, true); assert.equal(result.admitted, false);
  assert.match(result.sessionMessage, /403/);
});

test("a stalled server resolves to a failed connection test within its deadline", async () => {
  const result = await checks.checkConnection(() => new Promise(() => {}), true, 10);
  assert.equal(result.reachable, false); assert.equal(result.admitted, false);
  assert.match(result.serverMessage, /timed out/);
});
