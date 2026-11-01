import test from "node:test";
import assert from "node:assert/strict";
import { omiWorkflow } from "../server/omi-workflow.mjs";
import { omiWorkflow as typedWorkflow } from "../server/omi-workflow.ts";

const day = "2026-09-27", now = Date.parse("2026-09-29T00:00:00Z");
const enabled = { enabled: true, councilEnabled: true, keyConfigured: true };
function fixture(overrides = {}) {
  const calls = [];
  const service = { status: async () => enabled, sync: async (profile, options) => { calls.push([profile, options]); return { status: "partial", code: "filtered_end_unverified" }; }, ...overrides };
  return { calls, workflow: omiWorkflow("unused-synthetic-root", ["Example"], { services: { Example: service }, clock: () => now }) };
}
test("workflow compatibility and refresh preserve bounded sequential ingestion", async () => {
  assert.equal(omiWorkflow, typedWorkflow);
  const { calls, workflow } = fixture();
  assert.equal((await workflow.refresh("Example", day)).status, "ready");
  assert.deepEqual(calls, [
    ["Example", { day, mode: "replay", maxPages: 20 }],
    ["Example", { day, mode: "recent", maxPages: 2 }],
    ["Example", { day, mode: "backfill", maxPages: 8 }],
  ]);
});
test("partial replay, failures and exclusions cannot fall through to historical catch-up", async () => {
  for (const receipt of [{ status: "partial", code: "request_budget" }, { status: "failed", code: "http_429" }, { status: "partial", code: "filtered_end_unverified", scanExcluded: 1 }]) {
    let calls = 0;
    const { workflow } = fixture({ sync: async () => { calls++; return receipt; } });
    assert.notEqual((await workflow.refresh("Example", day)).status, "ready");
    assert.equal(calls, 1);
  }
});
test("retry, open days and private failures retain admission without leaking diagnostics", async () => {
  for (const overrides of [{ status: async () => ({ ...enabled, retryAt: "2026-09-30T00:00:00Z" }) }, { status: async () => { throw Error("SYNTHETIC_PRIVATE_CANARY"); } }]) {
    const { workflow, calls } = fixture(overrides);
    const result = await workflow.refresh("Example", day);
    assert.equal(result.status, "deferred"); assert.equal(calls.length, 0);
    assert.ok(!JSON.stringify(result).includes("CANARY"));
  }
  const { workflow, calls } = fixture();
  assert.equal((await workflow.refresh("Example", "2026-09-30")).code, "day_in_progress");
  assert.throws(() => workflow.service("Other"), /Unknown installation/);
  assert.equal(calls.length, 0);
  const absent = fixture({ sync: async () => null });
  assert.deepEqual(await absent.workflow.refresh("Example", day), { status: "deferred", code: "ingestion_unavailable" });
});
