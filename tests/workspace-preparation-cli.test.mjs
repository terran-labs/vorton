import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "../server/store.ts";
import { SqliteReplica } from "../server/sqlite-replica.ts";
import { createDailyBackup } from "../server/backup.ts";

const run = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
for (const extension of ["mjs", "ts"]) for (const version of [1, 2]) {
  test(`${extension} operator prepares a verified format-${version} archive without activation`, async t => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workspace-cli-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root);
    const operation = { operationId: randomUUID(), id: randomUUID(), kind: "task", action: "create", expectedRevision: 0, value: { title: "Synthetic retained CLI task" } };
    const accepted = await store.sync("Synthetic", operation);
    const filename = path.join(root, "Synthetic/state/core.sqlite3");
    const replica = new SqliteReplica(filename);
    const before = replica.snapshot("Synthetic"), generation = replica.generation("Synthetic");
    if (version === 1) replica.exportV1(path.join(root, "legacy.sqlite3"));
    replica.close();
    const selected = version === 1 ? "legacy.sqlite3" : "Synthetic/state/core.sqlite3";
    const archive = await createDailyBackup({ root, databases: [selected], resources: [], recovery: {} }, path.join(root, "backups"));
    const original = hash(await readFile(archive)), sourceHash = hash(await readFile(filename));
    const into = path.join(root, "prepared");
    const entry = fileURLToPath(new URL(`../scripts/prepare-workspace.${extension}`, import.meta.url));
    const { stdout } = await run(process.execPath, [entry, "--archive", archive, "--sha256", original, "--into", into, "--database", selected]);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.activated, false);
    assert.equal(receipt.historyAdoptionRequiredBeforeActivation, true);
    assert.equal(receipt.databases[0].changed, version === 1);
    assert.equal(receipt.databases[0].beforeVersion, version);
    assert.equal(receipt.databases[0].afterVersion, 2);
    assert.deepEqual(JSON.parse(await readFile(path.join(into, "preparation.json"))), receipt);
    const restored = new SqliteReplica(path.join(into, "runtime", selected));
    try {
      assert.deepEqual(restored.snapshot("Synthetic"), before);
      assert.equal(restored.generation("Synthetic"), generation);
      assert.equal(JSON.parse(restored.db.prepare("SELECT result FROM replica_receipts WHERE scope=? AND operation_id=?").get("Synthetic", operation.operationId).result).status, accepted.status);
    } finally { restored.close(); }
    assert.equal(hash(await readFile(filename)), sourceHash);
    assert.equal(hash(await readFile(archive)), original);
    await assert.rejects(run(process.execPath, [entry, "--archive", archive, "--sha256", original, "--into", into, "--database", selected]), /EEXIST/);
    assert.deepEqual(JSON.parse(await readFile(path.join(into, "preparation.json"))), receipt);
  });
}

test("both preparation aliases are inactive on import and reject activation arguments", async () => {
  for (const extension of ["mjs", "ts"]) {
    const entry = new URL(`../scripts/prepare-workspace.${extension}`, import.meta.url);
    const imported = await run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry.href)})`]);
    assert.equal(imported.stdout, "");
    await assert.rejects(run(process.execPath, [fileURLToPath(entry), "--activate", "true"]), /Unknown workspace preparation option/);
  }
});
