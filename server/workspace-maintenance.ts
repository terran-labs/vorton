import { constants, createWriteStream } from "node:fs";
import { mkdir, open, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { restoreBackup } from "./backup.ts";
import { atomicJson } from "./private-files.ts";
import { check } from "./errors.ts";

type MaintenanceReplica = {
  snapshot(scope: string): unknown;
  migrateWorkspaceFormat(admission: { backupVerified: true; writersExcluded: true }): boolean | Promise<boolean>;
  close(): void;
};
type Preparation = { archive: string; archiveSha256: string; into: string; databases: string[] };
export function parseWorkspacePreparationArguments(argv: string[]): Preparation {
  const values: Record<string, string> = {};
  const databases: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    check(["--archive", "--sha256", "--into", "--database"].includes(flag), "Unknown workspace preparation option");
    const value = argv[++index];
    check(value && !value.startsWith("--"), `Supply a value for ${flag}`);
    if (flag === "--database") databases.push(value);
    else {
      check(!Object.hasOwn(values, flag), `Repeated workspace preparation option ${flag}`);
      values[flag] = value;
    }
  }
  check(values["--archive"] && values["--sha256"] && values["--into"] && databases.length,
    "Supply --archive, --sha256, --into and at least one --database");
  check(/^[a-f0-9]{64}$/.test(values["--sha256"]), "An exact backup digest is required");
  check(new Set(databases).size === databases.length, "Select unique workspace databases");
  return { archive: values["--archive"], archiveSha256: values["--sha256"], into: values["--into"], databases };
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function snapshotHash(value: unknown) {
  const encoded = JSON.stringify(value);
  check(encoded !== undefined, "Workspace snapshot is missing");
  return hash(encoded);
}
async function fileHash(filename: string) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    check((await file.stat()).isFile(), "Expected a regular preparation file");
    const digest = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest("hex");
  } finally { await file.close(); }
}
async function flush(filename: string) {
  const file = await open(filename, "r");
  try { await file.sync(); } finally { await file.close(); }
}
const invariantQueries = [
  "SELECT scope,kind,id,revision,deleted,body FROM replica_records ORDER BY scope,kind,id",
  "SELECT * FROM replica_changes ORDER BY cursor",
  "SELECT * FROM sqlite_sequence WHERE name='replica_changes' ORDER BY name",
  "SELECT * FROM replica_receipts ORDER BY scope,operation_id",
  "SELECT * FROM replica_imports ORDER BY scope",
  "SELECT * FROM replica_generations ORDER BY scope",
  "SELECT * FROM legacy_exports ORDER BY scope",
  "SELECT * FROM replica_history_adoptions ORDER BY scope,request_id",
];
function inspect(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    check(db.prepare("PRAGMA integrity_check").get()?.integrity_check === "ok", "Preparation database integrity failed");
    const versions = db.prepare("SELECT version FROM replica_schema").all();
    check(versions.length === 1 && [1, 2].includes(Number(versions[0].version)), "Expected a supported workspace database");
    const version = Number(versions[0].version);
    const scopes = db.prepare(`SELECT scope FROM ${version === 1 ? "workspace_snapshots" : "workspace_roots"} ORDER BY scope`).all().map(row => String(row.scope));
    const digest = createHash("sha256");
    for (const sql of invariantQueries) {
      digest.update(sql + "\n");
      for (const row of db.prepare(sql).iterate()) digest.update(JSON.stringify(row) + "\n");
    }
    return { version, scopes, invariants: digest.digest("hex") };
  } finally { db.close(); }
}
function checkpoint(filename: string) {
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA busy_timeout=0");
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    check(result?.busy === 0 && Number(result.log) <= 0 && result.log === result.checkpointed, "Preparation checkpoint is incomplete");
  } finally { db.close(); }
}

/** Prepare an isolated restored copy. The injected runtime is trusted code,
 * never request data. No application may open this copy during preparation.
 * A directory without the final receipt is incomplete, not resumable success. */
export async function prepareWorkspaceMigration(input: Preparation, openReplica: (filename: string) => MaintenanceReplica) {
  check(/^[a-f0-9]{64}$/.test(input.archiveSha256), "An exact backup digest is required");
  check(input.databases.length > 0 && new Set(input.databases).size === input.databases.length, "Select unique workspace databases");
  const archive = path.resolve(input.archive), output = path.resolve(input.into), parent = path.dirname(output);
  check(await realpath(parent) === parent, "Use a physical preparation parent directory");
  check(await realpath(archive) === archive, "Backup path must not contain symlinks");
  const source = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  let owned = false;
  try {
    check((await source.stat()).isFile(), "Backup must be a regular archive");
    await mkdir(output, { mode: 0o700 }); owned = true;
    const pinnedArchive = path.join(output, "input.zip"), runtime = path.join(output, "runtime");
    const digest = createHash("sha256");
    await pipeline(source.createReadStream({ autoClose: false }), new Transform({ transform(chunk: Buffer, _encoding, next) {
      digest.update(chunk); next(null, chunk);
    } }), createWriteStream(pinnedArchive, { flags: "wx", mode: 0o600 }));
    await source.close();
    check(digest.digest("hex") === input.archiveSha256, "Backup digest mismatch");
    const manifest = await restoreBackup(pinnedArchive, runtime);
    const selected = input.databases.map(name => {
      const entry = manifest.files.find(file => file.path === name);
      check(entry?.kind === "sqlite", "Selected database is absent from the verified archive");
      return entry!;
    });
    const results = [];
    // Freeze every baseline before any migration callback can affect another
    // selected database. Final verification happens after all callbacks finish.
    const before = selected.map(entry => inspect(path.join(runtime, entry.path)));
    const snapshots = selected.map((entry, index) => {
      const replica = openReplica(path.join(runtime, entry.path));
      try { return before[index].scopes.map(scope => snapshotHash(replica.snapshot(scope))); }
      finally { replica.close(); }
    });
    const changes: boolean[] = [];
    for (const [index, entry] of selected.entries()) {
      const replica = openReplica(path.join(runtime, entry.path));
      try {
        const changed = await replica.migrateWorkspaceFormat({ backupVerified: true, writersExcluded: true });
        check(changed === (before[index].version === 1), "Unexpected workspace migration result");
        changes.push(changed);
      } finally { replica.close(); }
    }
    for (const [index, entry] of selected.entries()) {
      const filename = path.join(runtime, entry.path), original = before[index];
      const replica = openReplica(filename);
      try {
        check(original.scopes.every((scope, i) => snapshotHash(replica.snapshot(scope)) === snapshots[index][i]), "Migration changed workspace contents");
      } finally { replica.close(); }
      checkpoint(filename);
      const after = inspect(filename);
      check(after.version === 2 && JSON.stringify(after.scopes) === JSON.stringify(original.scopes) && after.invariants === original.invariants, "Migration changed retained history or scope identity");
      results.push({ path: entry.path, beforeVersion: original.version, afterVersion: after.version, changed: changes[index],
        beforeSha256: entry.sha256, afterSha256: await fileHash(filename), workspaceHashes: snapshots[index], invariantSha256: after.invariants });
    }
    const selectedNames = new Set(input.databases);
    const directories = new Set([runtime, output, parent]);
    for (const entry of manifest.files) {
      const filename = path.join(runtime, entry.path);
      if (!selectedNames.has(entry.path)) check(await fileHash(filename) === entry.sha256, "Migration changed an unselected resource");
      await flush(filename);
      for (let directory = path.dirname(filename); directory.startsWith(runtime); directory = path.dirname(directory)) directories.add(directory);
    }
    check(await fileHash(pinnedArchive) === input.archiveSha256, "Pinned archive changed during preparation");
    await flush(pinnedArchive);
    const receipt = { contract: "vorton.workspace-preparation.v1", archiveSha256: input.archiveSha256,
      originalManifest: manifest, databases: results, isolated: true, activated: false,
      historyAdoptionRequiredBeforeActivation: true };
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) await flush(directory);
    await atomicJson(path.join(output, "preparation.json"), receipt);
    return receipt;
  } catch (error) {
    if (owned) await rm(output, { recursive: true, force: true });
    throw error;
  } finally { await source.close(); }
}
