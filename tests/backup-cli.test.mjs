import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.mjs";
import { workspaceBackupSource } from "../server/backup-service.ts";
import { parseBackupArguments, runBackupCommand } from "../server/backup-cli.ts";

test("backup command captures a full archive and isolated restore never touches the live source", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-backup-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.sync("Example", { operationId: randomUUID(), id: randomUUID(), kind: "task", action: "create", expectedRevision: 0,
    value: { title: "Retained CLI record" } });
  let sourceCalls = 0;
  const options = { directory: path.join(root, "backups"), source: async () => { sourceCalls++; return workspaceBackupSource(root, ["Example"]); } };
  const backup = await runBackupCommand([], options);
  assert.equal(backup.verified, true);
  assert.match(backup.archive, /\.zip$/);
  const target = path.join(root, "restored");
  const result = await runBackupCommand(["--restore", backup.archive, "--into", target], {
    ...options, source: async () => { throw Error("Restoration must not open the live source"); },
  });
  assert.equal(result.restored, true);
  assert.equal(result.isolated, true);
  assert.equal(result.activated, false);
  assert.equal(result.historyAdoptionRequired, true);
  assert.equal(sourceCalls, 1);
  const separate = path.join(root, "separate-backups");
  const requested = await runBackupCommand(["--directory", separate], options);
  assert.ok(requested.archive.startsWith(separate + path.sep));
  assert.equal((await new Store(target).read("Example")).tasks[0].title, "Retained CLI record");
  await assert.rejects(runBackupCommand(["--restore", backup.archive, "--into", target], options), /EEXIST/);
  assert.equal((await store.read("Example")).tasks.length, 1);
});

test("invalid or ambiguous CLI arguments reject before a capture can start", async () => {
  let calls = 0;
  const options = { directory: "unused", source: async () => { calls++; throw Error("Must not run"); } };
  for (const argv of [["--restroe", "archive.zip"], ["--restore", "archive.zip"], ["--into", "new"], ["--root"],
    ["--root", "one", "--root", "two"], ["--restore", "archive.zip", "--into", "new", "--profile", "Example"]])
    await assert.rejects(runBackupCommand(argv, options));
  assert.equal(calls, 0);
  assert.deepEqual(parseBackupArguments(["--root", "data", "--profile", "Example", "--resource", "documents"]),
    { root: "data", profiles: ["Example"], resources: ["documents"] });
});
