import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, lstat, readdir, copyFile, mkdtemp, rm, open, link, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { ZipFile } from "yazl";
import { openPromise } from "yauzl";
import { check, errorCode } from "./errors.ts";
import { canonicalJson, SYNC_PROTOCOL } from "../shared/sync-contract.ts";
import { installedVersion } from "./version.ts";

type FileRecord = { path: string; bytes: number; sha256: string; kind: "file" | "sqlite"; tables?: Record<string, number> };
export type BackupManifest = {
  contract: "vorton.backup.v1"; createdAt: string; recovery: Record<string, unknown>; files: FileRecord[];
};
export type BackupSource = { root: string; databases: string[]; resources: string[]; excludes?: string[]; protectedResources?: string[]; recovery: Record<string, unknown> };
const MAX_FILES = 100_000, MAX_BYTES = 100 * 1024 ** 3, MAX_MANIFEST = 16 * 1024 ** 2;

function relativePath(value: unknown): asserts value is string {
  check(typeof value === "string" && value.length > 0 && value.length < 4096 &&
    !value.includes("\\") && !/[\x00-\x1f\x7f:]/.test(value) &&
    value.split("/").every(part => part && part !== "." && part !== ".."), "Invalid backup resource path");
  const parts = value.normalize("NFC").toLowerCase().split("/");
  check(!parts.some((part, index) => part === ".runtime" && parts[index + 1] === "secrets"),
    "Integration recovery keys must be retained separately from the data archive");
}
async function sourcePath(root: string, relative: string): Promise<string> {
  relativePath(relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    check(!(await lstat(current)).isSymbolicLink(), "Backup resources must not contain symlinks");
  }
  return current;
}
async function digest(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}
function tableCounts(database: DatabaseSync): Record<string, number> {
  check(database.prepare("PRAGMA integrity_check").get()!.integrity_check === "ok", "Backup database integrity check failed");
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => {
    const name = String(row.name), quoted = '"' + name.replaceAll('"', '""') + '"';
    return [name, Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get()!.count)];
  }));
}
export async function listBackupResources(source: BackupSource): Promise<string[]> {
  const root = path.resolve(source.root), resources = source.resources;
  check((source.excludes ?? []).every(pattern => typeof pattern === "string" && pattern.length > 0), "Invalid backup exclusion");
  const normalized = (value: string) => value.normalize("NFC").toLowerCase();
  const snapshots = new Set(source.databases.flatMap(database => [database, ...["-wal", "-journal", "-shm"].map(suffix => database + suffix)]).map(normalized));
  const protectedResources = new Set((source.protectedResources ?? []).map(normalized));
  const files: string[] = [];
  async function walk(relative: string) {
    if (snapshots.has(normalized(relative)) || protectedResources.has(normalized(relative)) || source.excludes?.some(pattern => path.matchesGlob(relative, pattern))) return;
    const filename = await sourcePath(root, relative), info = await lstat(filename);
    if (info.isDirectory()) {
      for (const name of (await readdir(filename)).sort()) await walk(`${relative}/${name}`);
    } else {
      check(info.isFile(), "Only regular managed files can enter a backup");
      files.push(relative);
      check(files.length <= MAX_FILES, "Backup contains too many managed files");
    }
  }
  for (const relative of resources) await walk(relative);
  return files.sort();
}

function parseManifest(input: unknown): BackupManifest {
  check(input !== null && typeof input === "object", "Invalid backup manifest");
  const value = input as BackupManifest;
  check(value.contract === "vorton.backup.v1" && typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) && value.recovery !== null && typeof value.recovery === "object" &&
    Array.isArray(value.files) && value.files.length <= MAX_FILES, "Invalid backup manifest");
  const seen = new Set<string>(); let bytes = 0;
  for (const file of value.files) {
    check(file !== null && typeof file === "object", "Invalid backup entry");
    relativePath(file.path);
    const key = file.path.normalize("NFC").toLowerCase();
    check(!seen.has(key), "Duplicate backup resource path"); seen.add(key);
    check(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256) &&
      ["file", "sqlite"].includes(file.kind), "Invalid backup entry");
    bytes += file.bytes;
    check(bytes <= MAX_BYTES, "Backup exceeds the supported restore size");
    if (file.kind === "sqlite") check(file.tables !== null && typeof file.tables === "object" &&
      Object.values(file.tables).every(count => Number.isSafeInteger(count) && count >= 0), "Missing database verification metadata");
  }
  for (const file of value.files.filter(file => file.kind === "sqlite")) {
    const database = file.path.normalize("NFC").toLowerCase();
    for (const suffix of ["-wal", "-journal", "-shm"])
      check(!seen.has(database + suffix), "A database snapshot cannot include live SQLite sidecars");
  }
  return value;
}

/** Extract only described regular files into a new private directory. Nothing
 * is activated and no existing installation can be overwritten. */
export async function restoreBackup(archive: string, target: string): Promise<BackupManifest> {
  check((await lstat(archive)).isFile() && !(await lstat(archive)).isSymbolicLink(), "Backup must be a regular archive");
  await mkdir(target, { mode: 0o700 }); // Exclusive claim, including empty existing directories.
  let complete = false;
  try {
    const zip = await openPromise(archive, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
    try {
      let manifest: BackupManifest | undefined;
      const remaining = new Map<string, FileRecord>();
      for await (const entry of zip.eachEntry()) {
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        check(mode === 0 || mode === 0o100000, "Backup contains a non-regular entry");
        check(!entry.isEncrypted(), "Encrypted backup archives are not supported");
        if (!manifest) {
          check(entry.fileName === "backup.json" && entry.uncompressedSize <= MAX_MANIFEST, "Backup manifest must be the first entry");
          const chunks: Buffer[] = []; let length = 0;
          for await (const chunk of await zip.openReadStreamPromise(entry)) {
            length += chunk.length; check(length <= MAX_MANIFEST, "Backup manifest is too large"); chunks.push(chunk);
          }
          manifest = parseManifest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          for (const file of manifest.files) remaining.set(`data/${file.path}`, file);
          continue;
        }
        const file = remaining.get(entry.fileName);
        check(file && entry.uncompressedSize === file.bytes, "Unexpected or duplicate backup entry");
        remaining.delete(entry.fileName);
        const filename = path.join(target, file.path);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        let size = 0; const hash = createHash("sha256");
        const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > file.bytes) callback(Error("Backup resource exceeds its declared size"));
          else { hash.update(chunk); callback(null, chunk); }
        } });
        await pipeline(await zip.openReadStreamPromise(entry), verify, createWriteStream(filename, { flags: "wx", mode: 0o600 }));
        check(size === file.bytes && hash.digest("hex") === file.sha256, "Backup resource verification failed");
      }
      check(manifest && remaining.size === 0, "Backup is incomplete");
      // Verify the final extracted set, after every allowed entry is present.
      for (const file of manifest.files.filter(file => file.kind === "sqlite")) {
        const database = new DatabaseSync(path.join(target, file.path), { readOnly: true });
        try { check(JSON.stringify(tableCounts(database)) === JSON.stringify(file.tables), "Restored database contents differ"); }
        finally { database.close(); }
      }
      complete = true;
      return manifest;
    } finally { zip.close(); }
  } finally { if (!complete) await rm(target, { recursive: true, force: true }); }
}

/** Publish only after a full isolated restore passes. Archives contain no
 * application encryption; the integration vault keeps its existing ciphertext. */
export async function createDailyBackup(source: BackupSource, directory: string, now = new Date(), applicationVersion = installedVersion.version): Promise<string> {
  check(!Number.isNaN(now.getTime()), "Invalid backup date");
  const root = path.resolve(source.root), destination = path.resolve(directory);
  check(source.databases.length > 0, "A full backup requires an authoritative database");
  for (const relative of source.resources) {
    relativePath(relative);
    const resource = path.join(root, relative);
    check(destination !== resource && !destination.startsWith(resource + path.sep), "Backup archives cannot be inside a managed resource tree");
  }
  check((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink(), "Backup root must be a regular directory");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  check(!(await lstat(destination)).isSymbolicLink(), "Backup directory must not be a symlink");
  const filename = path.join(destination, `daily-${now.toISOString().slice(0, 10)}.zip`);
  const sorted = (values: string[]) => [...new Set(values)].sort();
  const selection = { sourceRoot: createHash("sha256").update(await realpath(root)).digest("hex"),
    databases: sorted(source.databases), roots: sorted(source.resources), excludes: sorted(source.excludes ?? []), protectedResources: sorted(source.protectedResources ?? []) };
  const sameSelection = (manifest: BackupManifest) => {
    const existing = manifest.recovery.resourceSelection as typeof selection | undefined;
    check(existing && typeof existing.sourceRoot === "string" && Array.isArray(existing.databases) && Array.isArray(existing.roots) && Array.isArray(existing.excludes) &&
      canonicalJson({ sourceRoot: existing.sourceRoot, databases: sorted(existing.databases), roots: sorted(existing.roots), excludes: sorted(existing.excludes), protectedResources: sorted(existing.protectedResources ?? []) }) === canonicalJson(selection),
    "Today's archive has a different resource selection. Use a separate backup directory; the existing archive was kept.", 409);
  };
  const stage = await mkdtemp(path.join(destination, ".preparing-"));
  try {
    try {
      await lstat(filename);
      sameSelection(await restoreBackup(filename, path.join(stage, "already-verified")));
      await pruneDailyBackups(destination, now);
      return filename;
    } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    const files = await listBackupResources(source);
    const manifest: BackupManifest = { contract: "vorton.backup.v1", createdAt: now.toISOString(),
      recovery: { ...source.recovery, application: { version: applicationVersion, syncProtocol: SYNC_PROTOCOL }, resourceSelection: selection }, files: [] };
    const data = path.join(stage, "data");
    // Files must span the database capture unchanged. Copying them afterwards
    // would miss a resource replaced between the SQL snapshot and its copy.
    for (const relative of [...files, ...source.databases]) {
      relativePath(relative);
      const original = await sourcePath(root, relative), target = path.join(data, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const isDatabase = source.databases.includes(relative);
      let tables: Record<string, number> | undefined;
      if (isDatabase) {
        const database = new DatabaseSync(original, { readOnly: true });
        try { database.prepare("VACUUM INTO ?").run(target); } finally { database.close(); }
        const snapshot = new DatabaseSync(target, { readOnly: true });
        try { tables = tableCounts(snapshot); } finally { snapshot.close(); }
      } else await copyFile(original, target);
      const info = await lstat(target);
      manifest.files.push({ path: relative, bytes: info.size, sha256: await digest(target), kind: isDatabase ? "sqlite" : "file", ...(tables ? { tables } : {}) });
    }
    parseManifest(manifest); // Validate collisions and limits before archiving.
    const archive = path.join(stage, "candidate.zip"), zip = new ZipFile();
    const encoded = Buffer.from(JSON.stringify(manifest));
    check(encoded.length <= MAX_MANIFEST, "Backup manifest is too large");
    const output = createWriteStream(archive, { flags: "wx", mode: 0o600 });
    zip.on("error", error => output.destroy(error));
    const written = pipeline(zip.outputStream, output);
    zip.addBuffer(encoded, "backup.json", { mode: 0o100600 });
    for (const file of manifest.files) zip.addFile(path.join(data, file.path), `data/${file.path}`, { mode: 0o100600 });
    zip.end(); await written;
    // Detect changing or newly added resources instead of blessing a torn file set.
    check(JSON.stringify(await listBackupResources(source)) === JSON.stringify(files), "Managed files changed during backup; retry");
    for (const file of manifest.files.filter(file => file.kind === "file"))
      check(await digest(await sourcePath(root, file.path)) === file.sha256, "Managed files changed during backup; retry");
    await restoreBackup(archive, path.join(stage, "verified"));
    const durable = await open(archive, "r");
    try { await durable.sync(); } finally { await durable.close(); }
    try { await link(archive, filename); }
    catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      sameSelection(await restoreBackup(filename, path.join(stage, "concurrent-winner")));
    }
    const parent = await open(destination, "r");
    try { await parent.sync(); } finally { await parent.close(); }
    await pruneDailyBackups(destination, now);
    return filename;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function pruneDailyBackups(directory: string, now: Date, retainDays = 90): Promise<void> {
  check(Number.isSafeInteger(retainDays) && retainDays >= 1, "Invalid backup retention");
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (retainDays - 1) * 86400_000).toISOString().slice(0, 10);
  for (const name of await readdir(directory)) {
    const match = /^daily-(\d{4}-\d{2}-\d{2})\.zip$/.exec(name);
    if (match && match[1] < cutoff) {
      const filename = path.join(directory, name);
      try {
        const info = await lstat(filename);
        check(info.isFile() && !info.isSymbolicLink(), "Unsafe backup retention entry");
        await rm(filename);
      } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    }
  }
}
