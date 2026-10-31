import { errorCode } from "./errors.ts";
import type { SQLOutputValue } from "node:sqlite";
type SqlRow = Record<string, SQLOutputValue>;
export type VaultOptions = { create?: boolean };
export type VaultRecord<T> = { id: string; value: T };
export type IndexRow = { id: string; position: number; pending?: number };
/** Values are authenticated JSON owned by the calling integration. Generic reads
 * describe that integration's persisted schema, not external input validation. */
export interface VaultTransaction {
  get<T = unknown>(id: string): T | null;
  list<T = unknown>(prefix?: string): VaultRecord<T>[];
  ids(prefix?: string): string[];
  recordBatch<T = unknown>(prefix: string, after: string, limit: number): VaultRecord<T>[];
  dayToken(day: string): string;
  indexStats(): { total: number; pending: number; generation: number };
  indexDirty(): boolean;
  indexDirtyBatch<T = unknown>(limit: number): VaultRecord<T>[];
  indexDay(token: string): IndexRow[];
  indexPending(after: number, limit: number): IndexRow[];
  indexHistory(offset: number, limit: number): { id: string }[];
  indexPut(id: string, metadata: unknown, day: string, pending: boolean): void;
  scan<T = unknown>(prefix: string, visit: (record: VaultRecord<T>) => unknown): void;
  put(id: string, value: unknown): void;
  remove(id: string): void;
  clear(): void;
}
// Preserve the existing truthy `then` rejection, including non-callable values.
function thenable(value: unknown): boolean { return Boolean((value as { then?: unknown } | null | undefined)?.then); }
import path from "node:path";
import { constants } from "node:fs";
import { open, lstat, link, unlink } from "node:fs/promises";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { safeDirectory, check, Fault } from "./store.ts";

const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const missing = (error: unknown) => errorCode(error) === "ENOENT";

async function exists(filename: string) {
  try {
    const info = await lstat(filename);
    check(info.isFile() && !info.isSymbolicLink(), "Invalid integration storage", 503);
    check((info.mode & 0o077) === 0, "Integration storage must be private", 503);
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}

/** Atomic key publication prevents another process observing a partially written key. */
async function createKey(filename: string) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(randomBytes(32));
    await file.sync();
  } finally { await file.close(); }
  try {
    try { await link(temporary, filename); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    const directory = await open(path.dirname(filename), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary); }
}

/**
 * One-owner encrypted integration storage. SQLite supplies crash-safe transactions;
 * AES-GCM binds every value to its workspace, module and record identity.
 * This does not isolate processes sharing the owner's OS account. The master key
 * is deliberately outside the database and must be recovered separately.
 */
export class IntegrationVault {
  profiles: Set<string>;
  onRead: (id: string) => void;
  root: string; runtime: string; directory: string; filename: string; externalKey: boolean; keyFile: string;
  constructor(root: string, profiles: string[], { keyFile = process.env.VORTON_INTEGRATION_KEY_FILE, onRead = () => {} }: { keyFile?: string; onRead?: (id: string) => void } = {}) {
    check(Array.isArray(profiles) && profiles.length > 0 && profiles.every(p => identifier.test(p)), "Invalid integration profiles");
    this.profiles = new Set(profiles);
    this.onRead = onRead;
    this.root = path.resolve(root);
    this.runtime = path.join(this.root, ".runtime");
    this.directory = path.join(this.runtime, "integrations");
    this.filename = path.join(this.directory, "vault.sqlite");
    this.externalKey = Boolean(keyFile);
    this.keyFile = keyFile ? path.resolve(keyFile) : path.join(this.runtime, "secrets", "integrations.key");
  }

  async run<R>(profile: string, module: string, callback: (tx: VaultTransaction) => R, { create = false }: VaultOptions = {}): Promise<R | null> {
    check(this.profiles.has(profile), "Unknown installation", 404);
    check(identifier.test(module), "Invalid integration module");
    let db: DatabaseSync | undefined, key: Buffer | undefined;
    try {
      // Inspect each parent rather than trusting recursive mkdir through a symlink.
      for (const directory of [this.root, this.runtime, this.directory]) {
        if (!create) {
          try { const s = await lstat(directory); check(s.isDirectory() && !s.isSymbolicLink(), "Invalid integration directory", 503); }
          catch (error) { if (missing(error)) return null; throw error; }
        } else await safeDirectory(directory);
      }
      const present = await exists(this.filename);
      if (!present && !create) return null;
      if (!this.externalKey) await safeDirectory(path.dirname(this.keyFile));
      if (!(await exists(this.keyFile))) {
        // Never silently replace a lost key: it would make retained records unreadable.
        check(!present && !this.externalKey && create, "Integration encryption key unavailable. Restore the original key.", 503);
        await createKey(this.keyFile);
      }
      const keyHandle = await open(this.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { key = await keyHandle.readFile(); } finally { await keyHandle.close(); }
      check(key.length === 32, "Invalid integration encryption key", 503);
      if (!present) {
        try { const file = await open(this.filename, "wx", 0o600); await file.close(); }
        catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      }
      check(await exists(this.filename), "Integration database unavailable", 503);
      db = new DatabaseSync(this.filename);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;");
      db.exec("CREATE TABLE IF NOT EXISTS records (profile TEXT NOT NULL, module TEXT NOT NULL, id TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(profile,module,id))");
      // Only keyed day equality, pending state and ingestion order are exposed.
      // Recording times, content hashes and sizes stay in encrypted metadata.
      db.exec(`CREATE TABLE IF NOT EXISTS record_index (
        position INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, module TEXT NOT NULL,
        id TEXT NOT NULL, day_token TEXT NOT NULL, pending INTEGER NOT NULL,
        UNIQUE(profile,module,id));
        CREATE INDEX IF NOT EXISTS record_index_day ON record_index(profile,module,day_token,position);
        CREATE INDEX IF NOT EXISTS record_index_pending ON record_index(profile,module,pending,position);
        CREATE INDEX IF NOT EXISTS record_index_order ON record_index(profile,module,position);
        CREATE TABLE IF NOT EXISTS index_counts (profile TEXT NOT NULL,module TEXT NOT NULL,total INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(profile,module));
        CREATE TABLE IF NOT EXISTS index_dirty (profile TEXT NOT NULL,module TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(profile,module,id));
        CREATE TRIGGER IF NOT EXISTS record_dirty_insert AFTER INSERT ON records WHEN substr(NEW.id,1,13)='conversation:' BEGIN
          INSERT OR IGNORE INTO index_dirty VALUES(NEW.profile,NEW.module,NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS record_dirty_update AFTER UPDATE ON records WHEN substr(NEW.id,1,13)='conversation:' BEGIN
          INSERT OR IGNORE INTO index_dirty VALUES(NEW.profile,NEW.module,NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS record_dirty_delete AFTER DELETE ON records WHEN substr(OLD.id,1,13)='conversation:' BEGIN
          DELETE FROM record_index WHERE profile=OLD.profile AND module=OLD.module AND id=OLD.id;
          DELETE FROM index_dirty WHERE profile=OLD.profile AND module=OLD.module AND id=OLD.id;
          DELETE FROM records WHERE profile=OLD.profile AND module=OLD.module AND id='metadata:'||OLD.id;
          DELETE FROM records WHERE profile=OLD.profile AND module=OLD.module AND id='council-cache';
          DELETE FROM records WHERE profile=OLD.profile AND module=OLD.module AND id>='council-page:' AND id<'council-page;';
        END;
        CREATE TRIGGER IF NOT EXISTS record_index_insert AFTER INSERT ON record_index BEGIN
          INSERT INTO index_counts(profile,module,total,pending,generation) VALUES(NEW.profile,NEW.module,1,NEW.pending,1)
          ON CONFLICT(profile,module) DO UPDATE SET total=total+1,pending=pending+NEW.pending,generation=generation+1;
        END;
        CREATE TRIGGER IF NOT EXISTS record_index_update AFTER UPDATE ON record_index BEGIN
          UPDATE index_counts SET pending=pending+NEW.pending-OLD.pending,generation=generation+1 WHERE profile=NEW.profile AND module=NEW.module;
        END;
        CREATE TRIGGER IF NOT EXISTS record_index_delete AFTER DELETE ON record_index BEGIN
          UPDATE index_counts SET total=total-1,pending=pending-OLD.pending,generation=generation+1 WHERE profile=OLD.profile AND module=OLD.module;
        END;`);
      const database = db, secret = key;
      const aad = (id: string) => Buffer.from(JSON.stringify(["vorton.integration.v1", profile, module, id]));
      const read = (row: SqlRow | undefined): unknown => {
        if (!row) return null;
        this.onRead(row.id as string);
        const payload = Buffer.from(row.payload as Uint8Array);
        check(payload.length >= 29 && payload[0] === 1, "Invalid encrypted integration record", 503);
        const decipher = createDecipheriv("aes-256-gcm", secret, payload.subarray(1, 13));
        decipher.setAAD(aad(row.id as string));
        decipher.setAuthTag(payload.subarray(13, 29));
        return JSON.parse(Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]).toString("utf8"));
      };
      const api: VaultTransaction = {
        get: <T>(id: string) => read(database.prepare("SELECT id,payload FROM records WHERE profile=? AND module=? AND id=?").get(profile, module, id)) as T | null,
        list: <T>(prefix = "") => database.prepare("SELECT id,payload FROM records WHERE profile=? AND module=? AND substr(id,1,?)=? ORDER BY id").all(profile, module, prefix.length, prefix).map(r => ({ id: r.id as string, value: read(r) as T })),
        ids: (prefix = "") => database.prepare("SELECT id FROM records WHERE profile=? AND module=? AND substr(id,1,?)=? ORDER BY id").all(profile, module, prefix.length, prefix).map(row => row.id as string),
        recordBatch: <T>(prefix: string, after: string, limit: number) => database.prepare("SELECT id,payload FROM records WHERE profile=? AND module=? AND id>=? AND id<? AND id>? ORDER BY id LIMIT ?").all(profile, module, prefix, `${prefix}\uffff`, after, limit).map(row => ({ id: row.id as string, value: read(row) as T })),
        dayToken: day => createHmac("sha256", secret).update(JSON.stringify(["vorton.day.v1", profile, module, day])).digest("hex"),
        indexStats: () => ({ total: 0, pending: 0, generation: 0, ...database.prepare("SELECT total,pending,generation FROM index_counts WHERE profile=? AND module=?").get(profile, module) as Partial<{ total: number; pending: number; generation: number }> }),
        indexDirty: () => Boolean(database.prepare("SELECT 1 FROM index_dirty WHERE profile=? AND module=? LIMIT 1").get(profile, module)),
        indexDirtyBatch: <T>(limit: number) => database.prepare("SELECT r.id,r.payload FROM index_dirty d JOIN records r USING(profile,module,id) WHERE d.profile=? AND d.module=? ORDER BY d.id LIMIT ?").all(profile, module, limit).map(row => ({ id: row.id as string, value: read(row) as T })),
        indexDay: token => database.prepare("SELECT id,position,pending FROM record_index WHERE profile=? AND module=? AND day_token=? ORDER BY position LIMIT 10001").all(profile, module, token) as IndexRow[],
        indexPending: (after, limit) => database.prepare("SELECT id,position FROM record_index WHERE profile=? AND module=? AND pending=1 AND position>? ORDER BY position LIMIT ?").all(profile, module, after, limit) as IndexRow[],
        indexHistory: (offset, limit) => database.prepare("SELECT id FROM record_index WHERE profile=? AND module=? ORDER BY position DESC LIMIT ? OFFSET ?").all(profile, module, limit, offset) as { id: string }[],
        indexPut: (id, metadata, day, pending) => {
          api.put(`metadata:${id}`, metadata);
          database.prepare("INSERT INTO record_index(profile,module,id,day_token,pending) VALUES(?,?,?,?,?) ON CONFLICT(profile,module,id) DO UPDATE SET day_token=excluded.day_token,pending=excluded.pending").run(profile, module, id, api.dayToken(day), Number(pending));
          database.prepare("DELETE FROM index_dirty WHERE profile=? AND module=? AND id=?").run(profile, module, id);
        },
        scan: <T>(prefix: string, visit: (record: VaultRecord<T>) => unknown) => {
          for (const row of database.prepare("SELECT id,payload FROM records WHERE profile=? AND module=? AND substr(id,1,?)=? ORDER BY id").iterate(profile, module, prefix.length, prefix)) {
            check(!thenable(visit({ id: row.id as string, value: read(row) as T })), "Integration visitor must be synchronous", 500);
          }
        },
        put: (id, value) => {
          check(typeof id === "string" && /^[a-zA-Z0-9:._-]{1,160}$/.test(id), "Invalid integration record identity");
          const plain = Buffer.from(JSON.stringify(value));
          check(plain.length <= 8 * 1024 * 1024, "Integration record too large", 413);
          const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, nonce);
          cipher.setAAD(aad(id));
          const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
          plain.fill(0);
          const payload = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
          database.prepare("INSERT INTO records(profile,module,id,payload) VALUES(?,?,?,?) ON CONFLICT(profile,module,id) DO UPDATE SET payload=excluded.payload").run(profile, module, id, payload);
        },
        remove: id => {
          database.prepare("DELETE FROM record_index WHERE profile=? AND module=? AND id=?").run(profile, module, id);
          database.prepare("DELETE FROM records WHERE profile=? AND module=? AND id IN (?,?)").run(profile, module, id, `metadata:${id}`);
        },
        clear: () => {
          database.prepare("DELETE FROM record_index WHERE profile=? AND module=?").run(profile, module);
          database.prepare("DELETE FROM records WHERE profile=? AND module=?").run(profile, module);
        },
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = callback(api);
        check(!thenable(result), "Integration transaction must be synchronous", 500);
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      if (error instanceof Fault) throw error;
      // Cryptographic and SQLite errors may carry paths or attacker-controlled values.
      throw new Fault(503, "Integration storage unavailable. Records were not reset.");
    } finally { db?.close(); key?.fill(0); }
  }
}
