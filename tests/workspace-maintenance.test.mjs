import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, stat, access } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createDailyBackup } from "../server/backup.ts";
import { prepareWorkspaceMigration, parseWorkspacePreparationArguments } from "../server/workspace-maintenance.ts";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// Synthetic format adapter: these tests prove orchestration, not the A3
// normalization algorithm, whose exact runtime parity is a separate gate.
function openFixture(filename, mutate = () => {}) {
  const db = new DatabaseSync(filename);
  return {
    snapshot: scope => JSON.parse(db.prepare("SELECT body FROM workspace_snapshots WHERE scope=?").get(scope).body),
    migrateWorkspaceFormat(admission) {
      assert.deepEqual(admission, { backupVerified: true, writersExcluded: true });
      const version = db.prepare("SELECT version FROM replica_schema").get().version;
      if (version === 1) db.exec("UPDATE replica_schema SET version=2; CREATE TABLE workspace_roots(scope TEXT PRIMARY KEY); INSERT INTO workspace_roots SELECT scope FROM workspace_snapshots;");
      mutate(db, filename);
      return version === 1;
    },
    close: () => db.close(),
  };
}
async function fixture(t, { version = 1, second = false, unsupportedSecond = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workspace-preparation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databases = second ? ["first.sqlite3", "second.sqlite3"] : ["first.sqlite3"];
  for (const name of databases) {
    const db = new DatabaseSync(path.join(root, name));
    if (unsupportedSecond && name === "second.sqlite3") { db.exec("CREATE TABLE vault(value TEXT)"); db.close(); continue; }
    db.exec(`CREATE TABLE replica_schema(version INTEGER); INSERT INTO replica_schema VALUES(1);
      CREATE TABLE workspace_snapshots(scope TEXT PRIMARY KEY,body TEXT);
      CREATE TABLE replica_records(scope TEXT,kind TEXT,id TEXT,revision INTEGER,deleted INTEGER,body TEXT);
      CREATE TABLE replica_changes(cursor INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT,kind TEXT,id TEXT,revision INTEGER,deleted INTEGER,body TEXT);
      CREATE TABLE replica_receipts(scope TEXT,operation_id TEXT,digest TEXT,result TEXT);
      CREATE TABLE replica_imports(scope TEXT,digest TEXT,source TEXT);
      CREATE TABLE replica_generations(scope TEXT,generation TEXT);
      CREATE TABLE legacy_exports(scope TEXT,body TEXT);
      CREATE TABLE replica_history_adoptions(scope TEXT,request_id TEXT,payload TEXT,result TEXT);
      INSERT INTO replica_generations VALUES('Synthetic','original-generation');
      INSERT INTO replica_changes VALUES(7,'Synthetic','task','T-1',1,0,'{"id":"T-1"}');
      INSERT INTO replica_receipts VALUES('Synthetic','operation','digest','{"status":"accepted"}');`);
    db.prepare("INSERT INTO workspace_snapshots VALUES(?,?)").run("Synthetic", JSON.stringify({ revision: 4, tasks: [{ id: "T-1" }], events: [], requests: [] }));
    db.close();
    if (version === 2) { const replica = openFixture(path.join(root, name)); replica.migrateWorkspaceFormat({ backupVerified: true, writersExcluded: true }); replica.close(); }
  }
  await writeFile(path.join(root, "evidence.txt"), "Synthetic retained evidence\n");
  const archive = await createDailyBackup({ root, databases, resources: ["evidence.txt"], recovery: {} }, path.join(root, "backups"));
  const original = await readFile(archive);
  const input = { archive, archiveSha256: hash(original), into: path.join(root, "prepared"), databases: [databases[0]] };
  return { root, input, original, databases };
}

for (const version of [1, 2]) test(`preparation verifies an isolated ${version === 1 ? "migration" : "no-op"} and retains the pinned backup`, async t => {
  const f = await fixture(t, { version, second: true });
  const receipt = await prepareWorkspaceMigration(parseWorkspacePreparationArguments([
    "--archive", f.input.archive, "--sha256", f.input.archiveSha256,
    "--into", f.input.into, ...f.input.databases.flatMap(name => ["--database", name]),
  ]), openFixture);
  assert.equal(receipt.activated, false);
  assert.equal(receipt.historyAdoptionRequiredBeforeActivation, true);
  assert.equal(receipt.databases[0].changed, version === 1);
  assert.equal(receipt.databases[0].beforeVersion, version);
  assert.equal(receipt.databases[0].afterVersion, 2);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.input.into, "preparation.json"))), receipt);
  assert.deepEqual(await readFile(f.input.archive), f.original);
  assert.deepEqual(await readFile(path.join(f.input.into, "input.zip")), f.original);
  const untouched = receipt.originalManifest.files.find(file => file.path === "second.sqlite3");
  assert.equal(hash(await readFile(path.join(f.input.into, "runtime/second.sqlite3"))), untouched.sha256);
  assert.equal((await stat(f.input.into)).mode & 0o077, 0);
  assert.equal((await stat(path.join(f.input.into, "preparation.json"))).mode & 0o077, 0);
});

test("existing output is never overwritten or removed", async t => {
  const f = await fixture(t); await mkdir(f.input.into); await writeFile(path.join(f.input.into, "keep"), "untouched");
  await assert.rejects(prepareWorkspaceMigration(f.input, openFixture), /EEXIST/);
  assert.equal(await readFile(path.join(f.input.into, "keep"), "utf8"), "untouched");
});

test("operator arguments require an explicit pinned archive and isolated destination", () => {
  const valid = ["--archive", "synthetic.zip", "--sha256", "a".repeat(64), "--into", "isolated", "--database", "one.sqlite3"];
  assert.deepEqual(parseWorkspacePreparationArguments([...valid, "--database", "two.sqlite3"]), {
    archive: "synthetic.zip", archiveSha256: "a".repeat(64), into: "isolated", databases: ["one.sqlite3", "two.sqlite3"],
  });
  for (const args of [[], valid.slice(0, -2), valid.slice(2), [...valid, "--into", "another"],
    [...valid, "--database", "one.sqlite3"], [...valid, "--activate"], [...valid, "--writers-excluded", "true"],
    [...valid, "--database"], valid.map(value => value === "a".repeat(64) ? "unverified" : value)]) {
    assert.throws(() => parseWorkspacePreparationArguments(args));
  }
});

for (const defect of ["digest", "unlisted", "resource", "duplicate"]) test(`invalid ${defect} admission performs no migration`, async t => {
  const f = await fixture(t); let calls = 0;
  if (defect === "digest") f.input.archiveSha256 = "0".repeat(64);
  if (defect === "unlisted") f.input.databases = ["../first.sqlite3"];
  if (defect === "resource") f.input.databases = ["evidence.txt"];
  if (defect === "duplicate") f.input.databases.push(f.input.databases[0]);
  await assert.rejects(prepareWorkspaceMigration(f.input, filename => { calls++; return openFixture(filename); }));
  assert.equal(calls, 0); await assert.rejects(access(f.input.into));
  assert.deepEqual(await readFile(f.input.archive), f.original);
});

for (const defect of ["callback", "generation", "workspace", "resource", "unselected-database"]) test(`failed ${defect} verification removes only the new preparation`, async t => {
  const f = await fixture(t, { second: true });
  await assert.rejects(prepareWorkspaceMigration(f.input, filename => openFixture(filename, db => {
    if (defect === "callback") throw Error("synthetic migration failure");
    if (defect === "generation") db.exec("UPDATE replica_generations SET generation='changed'");
    if (defect === "workspace") db.exec("UPDATE workspace_snapshots SET body='{}'");
    if (defect === "resource") writeFileSync(path.join(path.dirname(filename), "evidence.txt"), "changed");
    if (defect === "unselected-database") writeFileSync(path.join(path.dirname(filename), "second.sqlite3"), "changed");
  })));
  await assert.rejects(access(f.input.into));
  assert.deepEqual(await readFile(f.input.archive), f.original);
});

test("a later database failure leaves no completed partial preparation", async t => {
  const f = await fixture(t, { second: true }); f.input.databases = f.databases; let calls = 0;
  await assert.rejects(prepareWorkspaceMigration(f.input, filename => openFixture(filename, () => { if (++calls === 2) throw Error("second database failed"); })), /second database/);
  assert.equal(calls, 2); await assert.rejects(access(f.input.into));
  assert.deepEqual(await readFile(f.input.archive), f.original);
});

test("a manifest-listed unrelated SQLite database rejects every migration before callbacks", async t => {
  const f = await fixture(t, { second: true, unsupportedSecond: true }); f.input.databases = f.databases; let calls = 0;
  await assert.rejects(prepareWorkspaceMigration(f.input, filename => { calls++; return openFixture(filename); }));
  assert.equal(calls, 0); await assert.rejects(access(f.input.into));
});

test("a correctly pinned but truncated archive fails verification before migration", async t => {
  const f = await fixture(t); const truncated = f.original.subarray(0, 40);
  await writeFile(f.input.archive, truncated); f.input.archiveSha256 = hash(truncated); let calls = 0;
  await assert.rejects(prepareWorkspaceMigration(f.input, filename => { calls++; return openFixture(filename); }));
  assert.equal(calls, 0); await assert.rejects(access(f.input.into));
  assert.deepEqual(await readFile(f.input.archive), truncated);
});

test("an incomplete WAL checkpoint cannot produce a receipt", async t => {
  const f = await fixture(t); let held;
  try {
    await assert.rejects(prepareWorkspaceMigration(f.input, filename => openFixture(filename, db => {
      db.exec("PRAGMA journal_mode=WAL");
      held = new DatabaseSync(filename); held.exec("BEGIN"); held.prepare("SELECT * FROM replica_generations").all();
      db.exec("CREATE TABLE synthetic_checkpoint_pressure(value TEXT)");
    })), /checkpoint/);
    await assert.rejects(access(f.input.into));
  } finally { held?.close(); }
});

for (const defect of ["later-generation", "later-workspace", "earlier-workspace", "pinned-archive"]) test(`final verification rejects ${defect} changes across callbacks`, async t => {
  const f = await fixture(t, { second: true }); f.input.databases = f.databases; let calls = 0;
  await assert.rejects(prepareWorkspaceMigration(f.input, filename => openFixture(filename, (_db, current) => {
    calls++;
    if (defect === "pinned-archive") {
      if (calls === 2) writeFileSync(path.join(path.dirname(path.dirname(current)), "input.zip"), "changed retained archive");
      return;
    }
    const earlier = defect === "earlier-workspace";
    if (calls !== (earlier ? 1 : 2)) return;
    const other = new DatabaseSync(path.join(path.dirname(current), earlier ? "second.sqlite3" : "first.sqlite3"));
    try {
      if (defect === "later-generation") other.exec("UPDATE replica_generations SET generation='changed-later'");
      else other.exec("UPDATE workspace_snapshots SET body='{}'");
    } finally { other.close(); }
  })), /Migration changed|Pinned archive changed/);
  assert.equal(calls, 2); await assert.rejects(access(f.input.into));
  assert.deepEqual(await readFile(f.input.archive), f.original);
});
