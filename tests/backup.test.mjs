import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm, symlink, lstat } from "node:fs/promises";
import { createWriteStream, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { ZipFile } from "yazl";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.mjs";
import { createDailyBackup, restoreBackup, listBackupResources } from "../server/backup.ts";

const sha256 = value => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.changes("AubOS");
  const held = await store.openDatabase(await store.directory("AubOS"));
  t.after(() => held.close());
  const operations = Array.from({ length: 20 }, (_, index) => ({ operationId: randomUUID(), id: randomUUID(),
    kind: "task", action: "create", expectedRevision: 0, value: { title: `Retained task ${index + 1}`, notes: "managed/evidence.txt" } }));
  for (const operation of operations) await store.sync("AubOS", operation);
  await mkdir(path.join(root, "managed/nested"), { recursive: true });
  await writeFile(path.join(root, "managed/evidence.txt"), "Original evidence\n");
  await writeFile(path.join(root, "managed/nested/π.bin"), Buffer.alloc(64 * 1024, 39));
  await writeFile(path.join(root, "local.config.json"), JSON.stringify({ frontend: "vite" }));
  const source = { root, databases: ["AubOS/state/core.sqlite3"], resources: ["managed", "local.config.json"],
    recovery: { profiles: ["AubOS"], sourceVersion: "fixture", integrationKeys: "Retained separately" } };
  return { root, store, held, operations, source, directory: path.join(root, "backups") };
}

test("daily ZIP restores live WAL records, receipts, managed files and configuration", async t => {
  const f = await fixture(t);
  assert.ok((await lstat(path.join(f.root, "AubOS/state/core.sqlite3-wal"))).size > 0);
  const archive = await createDailyBackup(f.source, f.directory, new Date("2026-10-30T12:00:00Z"));
  assert.equal((await lstat(archive)).mode & 0o077, 0);
  const target = path.join(f.root, "restored");
  const manifest = await restoreBackup(archive, target);
  assert.equal(manifest.files.length, 4);
  assert.deepEqual(manifest.recovery.profiles, f.source.recovery.profiles);
  assert.deepEqual(manifest.recovery.resourceSelection.roots, [...f.source.resources].sort());
  for (const filename of ["managed/evidence.txt", "managed/nested/π.bin", "local.config.json"])
    assert.deepEqual(await readFile(path.join(target, filename)), await readFile(path.join(f.root, filename)));
  const restored = new Store(target);
  const before = await restored.read("AubOS");
  assert.equal(before.tasks.length, 20);
  for (const operation of f.operations) assert.equal((await restored.sync("AubOS", operation)).status, "accepted");
  assert.equal((await restored.read("AubOS")).revision, before.revision, "Lost acknowledgements replay without another write after restore");
  await assert.rejects(restoreBackup(archive, target), /EEXIST/);
  assert.equal((await f.store.read("AubOS")).tasks.length, 20);
});

test("concurrent daily runs publish one verified archive and keep the source unchanged", async t => {
  const f = await fixture(t), before = await f.store.read("AubOS"), now = new Date("2026-10-30T12:00:00Z");
  await mkdir(f.directory);
  await writeFile(path.join(f.directory, "daily-2020-01-01.zip"), "Expired archive");
  const archives = await Promise.all([createDailyBackup(f.source, f.directory, now), createDailyBackup(f.source, f.directory, now)]);
  assert.equal(archives[0], archives[1]);
  assert.deepEqual(await readdir(f.directory), ["daily-2026-10-30.zip"]);
  assert.deepEqual(await f.store.read("AubOS"), before);
});

test("same-day scope changes reject without replacing the existing archive", async t => {
  const f = await fixture(t), other = await fixture(t), now = new Date("2026-10-30T12:00:00Z");
  await new Store(f.root).changes("Second");
  const archive = await createDailyBackup(f.source, f.directory, now), before = await readFile(archive);
  await writeFile(path.join(f.root, "extra.txt"), "Additional requested resource");
  const changed = [
    { ...f.source, databases: ["Second/state/core.sqlite3"] },
    { ...f.source, resources: [...f.source.resources, "extra.txt"] },
    other.source,
  ];
  for (const source of changed) await assert.rejects(createDailyBackup(source, f.directory, now), /different resource selection/);
  assert.deepEqual(await readFile(archive), before);
  assert.equal(await createDailyBackup({ ...f.source, resources: [...f.source.resources].reverse() }, f.directory, now), archive);
});

test("concurrent requests for different roots cannot certify one another's archive", async t => {
  const first = await fixture(t), second = await fixture(t), now = new Date("2026-10-30T12:00:00Z");
  const results = await Promise.allSettled([createDailyBackup(first.source, first.directory, now), createDailyBackup(second.source, first.directory, now)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failure = results.find(result => result.status === "rejected");
  assert.match(failure.reason.message, /different resource selection/);
  assert.deepEqual(await readdir(first.directory), ["daily-2026-10-30.zip"]);
});

test("retention removes only daily archives older than ninety days after successful verification", async t => {
  const f = await fixture(t), now = new Date("2026-10-30T12:00:00Z");
  await mkdir(f.directory);
  const cutoff = new Date(Date.UTC(2026, 9, 30) - 89 * 86400_000).toISOString().slice(0, 10);
  const expired = new Date(Date.UTC(2026, 9, 30) - 90 * 86400_000).toISOString().slice(0, 10);
  const retained = [`daily-${cutoff}.zip`, "migration-original.zip", "operator-export.zip"];
  for (const name of [...retained, `daily-${expired}.zip`]) await writeFile(path.join(f.directory, name), "Retention fixture");
  await createDailyBackup(f.source, f.directory, now);
  assert.deepEqual((await readdir(f.directory)).sort(), [...retained, "daily-2026-10-30.zip"].sort());
});

test("failed capture retains the previous archive and never prunes recovery files", async t => {
  const f = await fixture(t);
  const archive = await createDailyBackup(f.source, f.directory, new Date("2026-10-30T12:00:00Z"));
  const before = await readFile(archive);
  await writeFile(path.join(f.directory, "daily-2020-01-01.zip"), "Keep until successful backup");
  await symlink("/dev/null", path.join(f.root, "managed/unsafe"));
  await assert.rejects(createDailyBackup(f.source, f.directory, new Date("2026-10-31T12:00:00Z")), /symlinks/);
  assert.deepEqual(await readFile(archive), before);
  assert.deepEqual((await readdir(f.directory)).sort(), ["daily-2020-01-01.zip", "daily-2026-10-30.zip"]);
});

test("resource exclusions preserve their manifest scope and live SQL sidecars enter only through the snapshot", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "managed/cache"));
  await writeFile(path.join(f.root, "managed/cache/reinstallable.txt"), "Disposable cache");
  const source = { ...f.source, resources: [...f.source.resources, "AubOS/state"], excludes: ["managed/cache"] };
  const files = await listBackupResources(source);
  assert.equal(files.some(filename => filename.includes("cache") || filename.includes("core.sqlite3")), false);
  const archive = await createDailyBackup(source, f.directory);
  const manifest = await restoreBackup(archive, path.join(f.root, "selected-restore"));
  assert.deepEqual(manifest.recovery.resourceSelection.excludes, source.excludes);
  assert.equal(manifest.files.filter(file => file.kind === "sqlite").length, 1);
  assert.equal(manifest.files.some(file => /-wal$|-shm$/.test(file.path)), false);
});

test("a managed file changed during archive creation rejects the candidate and keeps the earlier backup", async t => {
  const f = await fixture(t);
  const archive = await createDailyBackup(f.source, f.directory, new Date("2026-10-30T12:00:00Z"));
  const before = await readFile(archive), addFile = ZipFile.prototype.addFile;
  let changed = false;
  t.mock.method(ZipFile.prototype, "addFile", function(filename, metadata, options) {
    if (!changed && metadata === "data/managed/evidence.txt") {
      changed = true;
      writeFileSync(path.join(f.root, "managed/evidence.txt"), "Replaced while the archive was being prepared\n");
    }
    return addFile.call(this, filename, metadata, options);
  });
  await assert.rejects(createDailyBackup(f.source, f.directory, new Date("2026-10-31T12:00:00Z")), /changed during backup/);
  assert.equal(changed, true);
  assert.deepEqual(await readFile(archive), before);
  assert.deepEqual(await readdir(f.directory), ["daily-2026-10-30.zip"]);
});

async function archiveFixture(root, files, entries) {
  const filename = path.join(root, randomUUID() + ".zip"), zip = new ZipFile();
  const written = pipeline(zip.outputStream, createWriteStream(filename));
  zip.addBuffer(Buffer.from(JSON.stringify({ contract: "vorton.backup.v1", createdAt: "2026-10-30T12:00:00Z", recovery: {}, files })), "backup.json");
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.data), entry.path, entry.mode ? { mode: entry.mode } : {});
  zip.end(); await written; return filename;
}

for (const suffix of ["-wal", "-journal", "-shm"]) test(`restore rejects a snapshot with a later ${suffix} entry`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-sidecar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "source.sqlite3"), database = new DatabaseSync(filename);
  database.exec("CREATE TABLE records(id TEXT PRIMARY KEY); INSERT INTO records VALUES('retained')");
  database.close();
  const bytes = await readFile(filename), sidecar = Buffer.from("Later sidecar");
  const files = [{ path: "store.sqlite3", bytes: bytes.length, sha256: sha256(bytes), kind: "sqlite", tables: { records: 1 } },
    { path: "store.sqlite3" + suffix, bytes: sidecar.length, sha256: sha256(sidecar), kind: "file" }];
  const archive = await archiveFixture(root, files, [{ path: "data/store.sqlite3", data: bytes }, { path: "data/store.sqlite3" + suffix, data: sidecar }]);
  const target = path.join(root, "restored");
  await assert.rejects(restoreBackup(archive, target), /sidecars/);
  await assert.rejects(lstat(target), /ENOENT/);
});
for (const failure of ["missing", "duplicate", "unexpected", "digest", "symlink", "traversal", "collision"]) {
  test(`restore rejects ${failure} without leaving a partial destination`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vorton-invalid-archive-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = { path: "managed/file.txt", bytes: 4, sha256: sha256("data"), kind: "file" };
    const files = [file], entries = [{ path: "data/managed/file.txt", data: "data" }];
    if (failure === "missing") entries.length = 0;
    if (failure === "duplicate") entries.push(entries[0]);
    if (failure === "unexpected") entries.push({ path: "data/extra.txt", data: "data" });
    if (failure === "digest") entries[0].data = "fake";
    if (failure === "symlink") entries[0].mode = 0o120777;
    if (failure === "traversal") file.path = "../escape";
    if (failure === "collision") files.push({ ...file, path: "managed/FILE.txt" });
    const archive = await archiveFixture(root, files, entries), target = path.join(root, "restored");
    await assert.rejects(restoreBackup(archive, target));
    await assert.rejects(lstat(target), /ENOENT/);
  });
}

test("truncated archives fail verification and source resources cannot contain the backup directory", async t => {
  const f = await fixture(t);
  await assert.rejects(createDailyBackup({ ...f.source, resources: ["managed"] }, path.join(f.root, "managed/backups")), /resource tree/);
  const archive = await createDailyBackup(f.source, f.directory, new Date("2026-10-30T12:00:00Z"));
  const broken = path.join(f.root, "truncated.zip");
  await writeFile(broken, (await readFile(archive)).subarray(0, 100));
  await assert.rejects(restoreBackup(broken, path.join(f.root, "broken-restore")));
  await assert.rejects(lstat(path.join(f.root, "broken-restore")), /ENOENT/);
});
