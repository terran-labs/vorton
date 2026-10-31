import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../web/application/offline-access.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { WorkspaceAccess } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const admission = { installationId: "f6e8faf1-0667-4889-b01f-a6cc924fa726", variant: "private", profiles: ["AubOS", "FreedOS"], verifiedAt: 10, schema: 1 };
const scope = { installationId: admission.installationId, variant: "private", readEpoch: 0, draftEpoch: 0 };
const ticket = access => ({ ...access.getSnapshot() });

test("saved admission permits scoped reads and never confers write authority", () => {
  const access = new WorkspaceAccess(); access.manage("private"); access.restore(admission, scope); access.setProfile("AubOS");
  assert.equal(access.getSnapshot().canWrite, false);
  assert.equal(access.assertReadable(ticket(access)).installationId, admission.installationId);
  assert.equal(access.readScope("FreedOS").installationId, admission.installationId);
  assert.equal(access.readScope("LastResort"), undefined);
  assert.throws(() => access.assertLive(ticket(access)), /Reconnect/);
  assert.equal(access.confirmLive(ticket(access)), false);
});
test("online session requires current active data confirmation; resume fences earlier write tickets", () => {
  const access = new WorkspaceAccess(); access.manage("private"); access.admitOnline(admission, scope); access.setProfile("AubOS");
  const before = ticket(access); assert.equal(access.getSnapshot().canWrite, false);
  assert.equal(access.confirmLive(before), true); assert.equal(access.assertLive(before).canWrite, true);
  access.beginReconcile(); assert.equal(access.getSnapshot().canWrite, false);
  assert.throws(() => access.assertLive(before), /older connection/);
  assert.equal(access.confirmLive(before), false);
  access.admitOnline(admission, scope); access.setProfile("FreedOS");
  assert.equal(access.confirmLive({ ...ticket(access), profile: "AubOS" }), false);
  assert.equal(access.confirmLive(ticket(access)), true);
});
test("identity, variant and known profile changes revoke old readable and live tickets", () => {
  const access = new WorkspaceAccess(); access.manage("private"); access.admitOnline(admission, scope); access.setProfile("AubOS"); access.confirmLive(ticket(access));
  const old = ticket(access);
  access.admitOnline({ ...admission, profiles: ["FreedOS"] }, scope);
  assert.equal(access.getSnapshot().profile, null); assert.equal(access.readScope("AubOS"), undefined);
  assert.throws(() => access.assertReadable(old));
  access.admitOnline({ ...admission, installationId: "85bce832-f54d-40a4-a31a-ea477f6e1d90" });
  assert.equal(access.getSnapshot().scope, undefined); assert.equal(access.getSnapshot().canWrite, false);
  assert.throws(() => access.admitOnline({ ...admission, variant: "portable" }));
});
test("full forget suppresses automatic reconcile and stale notifications cannot revoke newly captured scope", () => {
  const access = new WorkspaceAccess(); access.manage("private"); access.admitOnline(admission, scope); access.setProfile("AubOS");
  const change = { ...scope, readEpoch: 1, draftEpoch: 1, contract: "vorton.offline-store.v1", type: "FORGOTTEN" };
  access.storageChanged(change);
  assert.equal(access.getSnapshot().status, "forgotten"); assert.equal(access.getSnapshot().scope, undefined);
  assert.equal(access.beginReconcile(), false); assert.equal(access.beginReconcile(true), true);
  access.admitOnline(admission, { ...scope, readEpoch: 1, draftEpoch: 1 }); access.setProfile("AubOS"); access.confirmLive(ticket(access));
  access.storageChanged(change); assert.equal(access.getSnapshot().canWrite, true);
});
test("managed flag is sticky and unmanaged default is never an implicit write fallback", () => {
  const access = new WorkspaceAccess(); assert.equal(access.getSnapshot().managed, false);
  assert.throws(() => access.assertLive(ticket(access)));
  access.manage("private"); access.fail("Offline"); assert.equal(access.getSnapshot().managed, true);
  let calls = 0; const unsubscribe = access.subscribe(() => calls++); access.beginReconcile(); unsubscribe(); access.fail("Offline"); assert.equal(calls, 1);
});

test("late saved admission cannot undo clearing or forgetting", () => {
  for (const type of ["READS_CLEARED", "FORGOTTEN"]) {
    const access = new WorkspaceAccess();
    access.manage("private"); access.restore(admission, scope); access.setProfile("AubOS");
    access.storageChanged({ ...scope, readEpoch: 1, draftEpoch: type === "FORGOTTEN" ? 1 : 0, contract: "vorton.offline-store.v1", type });
    const cleared = access.getSnapshot();
    access.restore(admission, scope);
    assert.equal(access.getSnapshot(), cleared);
    assert.equal(access.beginReconcile(), false);
    assert.equal(access.readScope("AubOS"), undefined);
  }
});

test("observing the same live identity retains saved paint while storage admission finishes", () => {
  const access = new WorkspaceAccess();
  access.manage("private"); access.restore(admission, scope); access.setProfile("AubOS");
  access.beginReconcile();
  access.admitOnline(admission, undefined, false);
  assert.deepEqual(access.readScope("AubOS"), scope);
  assert.equal(access.getSnapshot().onlineAdmission, false);
  assert.equal(access.getSnapshot().canWrite, false);
  access.admitOnline({ ...admission, installationId: "85bce832-f54d-40a4-a31a-ea477f6e1d90" }, undefined, false);
  assert.equal(access.readScope("AubOS"), undefined);
});
