import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseSyncOperation, parseSyncRequest } from "../shared/sync-contract.ts";

test("sync transport requires stable identities and rejects credentials and malformed revisions", () => {
  const operation = { operationId: randomUUID(), id: randomUUID(), kind: "task", action: "create", expectedRevision: 0, value: { title: "Offline" } };
  assert.deepEqual(parseSyncOperation(operation), operation);
  for (const change of [{ token: "must-not-persist" }, { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: 1 }, { id: "server-must-not-regenerate" }, { operationId: "------------------------------------" }, { kind: "settings" }, { value: [] }])
    assert.throws(() => parseSyncOperation({ ...operation, ...change }));
  assert.throws(() => parseSyncOperation(null));
  assert.equal(parseSyncOperation({ ...operation, id: "ACT-2026-001", action: "update", expectedRevision: 3 }).id, "ACT-2026-001");
});

test("sync requests bind protocol and server generation without accepting a client-selected scope", () => {
  const request = { protocol: "vorton.sync.v1", generation: randomUUID(), operation: {
    operationId: randomUUID(), id: randomUUID(), kind: "task", action: "create", expectedRevision: 0, value: { title: "Saved locally" } } };
  assert.deepEqual(parseSyncRequest(request), request);
  for (const change of [{ scope: "foreign/workspace" }, { token: "credential" }, { generation: "bad" }, { protocol: "future" }])
    assert.throws(() => parseSyncRequest({ ...request, ...change }));
});
