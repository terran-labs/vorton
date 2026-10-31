import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson as encode } from "../shared/sync-contract.ts";
import { assemble, normalizedSchema, json, decodedRecord, validateDescriptors } from "./workspace-normalization.ts";
import type { Membership } from './workspace-normalization.ts';
import { bulkDelta, MutationJournal } from "./workspace-delta.ts";
import type { WorkspaceDelta } from "./workspace-delta.ts";
import { openSync, closeSync, unlinkSync } from "node:fs";

type RecordValue = { id: string; [key: string]: unknown };
type ExportSource = { tasks?: RecordValue[]; goals?: RecordValue[]; ideas?: RecordValue[]; [key: string]: unknown };
type Snapshot = ExportSource & { revision: number };
type Operation = {
  operationId: string; kind: "task" | "goal" | "idea"; id: string;
  expectedRevision: number; action: "create" | "update" | "delete"; value?: unknown;
};
type ReplicaRecord = { kind: string; id: string; revision: number; deleted: boolean; value: unknown };
type ValidationInput = { scope: string; action: Operation["action"]; kind: Operation["kind"]; id: string; value: unknown; current: ReplicaRecord | undefined };
type MutationResult = { revision: number; cursor: number; deleted: boolean; value: unknown };
type HistoryAdoption = { scope: string; requestId: string; previousGeneration: string; generation: string; revision: number };

export class ReplicaFault extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}
const fail = (message: string, status = 409, code?: string): never => { throw new ReplicaFault(status, message, code); };
function storedFormat(database: DatabaseSync): number | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='replica_schema'").get()) return undefined;
  const versions = database.prepare('SELECT version FROM replica_schema').all();
  const version = versions.length === 1 ? Number(versions[0]!.version) : 0;
  if (![1,2].includes(version)) fail('Unsupported workspace storage format',503);
  return version;
}

// Storage primitive only. Authentication and governed domain validation belong
// to the caller. Never accept a scope supplied by an unauthenticated request.
export class SqliteReplica {
  db: DatabaseSync;
  format: number;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
      const admitted = storedFormat(this.db);
      if (admitted !== undefined) { this.format = admitted; return; }
      this.format = 2;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Another process may have initialized this previously empty file
        // while this connection waited for the writer lock.
        const concurrent = storedFormat(this.db);
        if (concurrent !== undefined) { this.format = concurrent; this.db.exec('COMMIT'); return; }
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) fail('Unrecognized SQLite storage; explicit maintenance is required',503);
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS replica_schema(version INTEGER PRIMARY KEY CHECK(version=2));
        INSERT INTO replica_schema VALUES(2);
        CREATE TRIGGER reject_legacy_bootstrap BEFORE INSERT ON replica_schema WHEN NEW.version=1 BEGIN SELECT RAISE(ABORT,'Workspace format 2 requires a compatible runtime'); END;
        CREATE TABLE IF NOT EXISTS replica_records(
          scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
          revision INTEGER NOT NULL, deleted INTEGER NOT NULL, body TEXT, raw_body TEXT,
          PRIMARY KEY(scope,kind,id));
        CREATE TABLE IF NOT EXISTS replica_changes(
          cursor INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
          kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
          deleted INTEGER NOT NULL, body TEXT);
        CREATE INDEX IF NOT EXISTS replica_scope_cursor ON replica_changes(scope,cursor);
        CREATE TABLE IF NOT EXISTS replica_receipts(
          scope TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL,
          result TEXT NOT NULL, PRIMARY KEY(scope,operation_id));
        CREATE TABLE IF NOT EXISTS replica_imports(
          scope TEXT PRIMARY KEY, digest TEXT NOT NULL, source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS replica_generations(scope TEXT PRIMARY KEY, generation TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_exports(scope TEXT PRIMARY KEY, body TEXT);
        CREATE TABLE IF NOT EXISTS replica_history_adoptions(scope TEXT NOT NULL, request_id TEXT NOT NULL,
          payload TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,request_id));`);
        this.db.exec(normalizedSchema);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    } catch (error) { this.db.close(); throw error; }
  }
  private writable() { if (this.format !== 2) fail("Workspace format 1 is read-only; explicit verified maintenance is required", 503, "storage-migration-required"); }
  close() { this.db.close(); }
  generation(scope: string): string {
    const existing = this.db.prepare("SELECT generation FROM replica_generations WHERE scope=?").get(scope);
    if (existing) return String(existing.generation);
    this.writable();
    this.db.prepare("INSERT OR IGNORE INTO replica_generations VALUES(?,?)").run(scope, randomUUID());
    return String(this.db.prepare("SELECT generation FROM replica_generations WHERE scope=?").get(scope)!.generation);
  }
  head(scope: string): number {
    const cursor = Number(this.db.prepare("SELECT COALESCE(MAX(cursor),0) AS head FROM replica_changes WHERE scope=?").get(scope)!.head);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return fail("Unsupported server change cursor", 503);
    return cursor;
  }
  /** Maintenance primitive for a verified restored snapshot under writer
   * exclusion. Never called by an HTTP command or ordinary application startup.
   * A replay returns the historical result, not a claim it is still current. */
  adoptHistory(scope: string, input: { requestId: string; expectedGeneration: string; expectedRevision: number }): HistoryAdoption {
    if (!/^[a-f0-9-]{36}$/i.test(input.requestId) || !/^[a-f0-9-]{36}$/i.test(input.expectedGeneration) ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail("Invalid history adoption request", 400);
    const payload = encode(input);
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT payload,result FROM replica_history_adoptions WHERE scope=? AND request_id=?").get(scope, input.requestId);
      if (prior) {
        if (prior.payload !== payload) fail("History adoption identity reused with different contents");
        return JSON.parse(String(prior.result)) as HistoryAdoption;
      }
      const root = this.db.prepare("SELECT revision FROM workspace_roots WHERE scope=?").get(scope);
      const fields = this.db.prepare("SELECT name,storage_kind,next_slot FROM workspace_fields WHERE scope=? AND name IN ('events','requests','syncGeneration')").all(scope);
      if (!root || fields.filter(row => ['events','requests'].includes(String(row.name)) && row.storage_kind === 'collection').length !== 2) return fail("A verified restored workspace snapshot is required before adopting history", 503);
      if (this.generation(scope) !== input.expectedGeneration) fail("Server history changed before adoption", 409, "history-changed");
      if (Number(root.revision) !== input.expectedRevision) fail("Workspace changed before history adoption");
      if (this.commandReceipt(scope, input.requestId) || this.hasReceipt(scope, input.requestId))
        fail("History adoption identity belongs to an existing operation");
      const generation = randomUUID(), revision = Number(root.revision) + 1;
      if (!Number.isSafeInteger(revision)) fail("Workspace revision is exhausted", 503);
      const next = { revision, syncGeneration: generation, events: [], requests: [] };
      const j = new MutationJournal({ revision: Number(root.revision), fields: new Map(fields.map(row => [String(row.name), { kind: String(row.storage_kind), next: Number(row.next_slot), slots: [] }])) });
      j.field('syncGeneration');
      j.append('events', { id: input.requestId, at: new Date().toISOString(), action: "maintenance.history.adopt", subjectId: scope, actor: "installation", revision, detail: "Restored server history adopted. Device changes require review." });
      j.append('requests', { id: input.requestId, command: encode({ ...input, action: "maintenance.history.adopt" }) });
      this.publish(scope, j.prepare(next));
      this.db.prepare("UPDATE replica_generations SET generation=? WHERE scope=?").run(generation, scope);
      const result = { scope, requestId: input.requestId, previousGeneration: input.expectedGeneration, generation, revision };
      this.db.prepare("INSERT INTO replica_history_adoptions VALUES(?,?,?,?)").run(scope, input.requestId, payload, encode(result));
      return result;
    });
  }
  feed(scope: string, after = 0, limit = 200, boundary: { head?: number; generation?: string } = {}) {
    return this.transaction(() => {
      const generation = this.generation(scope);
      const currentHead = this.head(scope);
      if (boundary.generation !== undefined && boundary.generation !== generation)
        fail("The server history changed. Reconcile saved work before restarting synchronization.", 409, "history-changed");
      if (after > currentHead) fail("The server history changed. Reconcile saved work before restarting synchronization.", 409, "history-changed");
      const head = boundary.head ?? currentHead;
      if (boundary.head !== undefined && boundary.generation === undefined) fail("A download boundary requires its server history identity", 400);
      if (!Number.isSafeInteger(head) || head < after || head > currentHead ||
          (head !== 0 && !this.db.prepare("SELECT 1 FROM replica_changes WHERE scope=? AND cursor=?").get(scope, head)))
        fail("Invalid server download boundary", 400);
      const changes = this.changes(scope, after, limit, head);
      const cursor = changes.at(-1)?.cursor ?? after;
      return { generation, changes, cursor, head, more: cursor < head };
    });
  }
  snapshot(scope: string): Snapshot | undefined {
    if (this.format === 1) {
      const row = this.db.prepare("SELECT body FROM workspace_snapshots WHERE scope=?").get(scope);
      return row ? JSON.parse(String(row.body)) : undefined;
    }
    return this.readWorkspace(scope)?.state as Snapshot | undefined;
  }
  readWorkspace(scope: string, exclude: ReadonlySet<string> = new Set(), auxiliaryKey?: string) {
    this.writable();
    return this.readTransaction(() => assemble(this.db, scope, exclude, auxiliaryKey));
  }
  commandReceipt(scope: string, id: string): { id: string; command: string } | undefined {
    this.writable();
    const row = this.db.prepare("SELECT value_json FROM workspace_items WHERE scope=? AND collection='requests' AND item_key=? ORDER BY slot LIMIT 1").get(scope, id);
    return row ? JSON.parse(String(row.value_json)) : undefined;
  }
  admitCommand(scope: string, id: string, generation: string, expectedRevision?: number) {
    return this.readTransaction(() => {
      if (this.generation(scope) !== generation) fail('The server history changed', 409, 'history-changed');
      if (this.hasReceipt(scope, id) || this.db.prepare('SELECT 1 FROM replica_history_adoptions WHERE scope=? AND request_id=?').get(scope, id)) fail('Operation identity belongs to the synchronization protocol or maintenance');
      const prior = this.commandReceipt(scope, id);
      if (!prior) validateDescriptors(this.db,scope);
      if (!prior && expectedRevision !== undefined && this.revision(scope) !== expectedRevision) fail('This view is out of date. Refresh before saving.', 409, 'workspace-cas');
      return prior;
    });
  }
  hasRecords(scope: string) { return Boolean(this.db.prepare('SELECT 1 FROM replica_records WHERE scope=? LIMIT 1').get(scope)); }
  private revision(scope: string): number { return Number(this.db.prepare("SELECT revision FROM workspace_roots WHERE scope=?").get(scope)?.revision ?? 0); }
  legacyExport(scope: string) {
    return this.db.prepare("SELECT body FROM legacy_exports WHERE scope=?").get(scope);
  }
  saveSnapshot(scope: string, state: Snapshot, expectedRevision: number | null = null, legacySource: string | null = null, expectedGeneration?: string) {
    this.writable();
    const before = this.readWorkspace(scope);
    const delta = bulkDelta(before?.state, state, before?.layout ?? { fields: new Map(), revision: 0 });
    return this.transaction(() => {
      if (expectedGeneration !== undefined && this.generation(scope) !== expectedGeneration) fail("The server history changed", 409, "history-changed");
      if (expectedRevision !== null && this.revision(scope) !== expectedRevision) fail("This view is out of date. Refresh before saving.");
      this.publish(scope, delta, legacySource);
    });
  }
  saveCommandSnapshot(scope: string, state: Snapshot, publication: { expectedRevision: number; generation: string; requestId: string }) {
    const before = this.readWorkspace(scope);
    const request = (state.requests as { id: string; command: string }[]).find(item => item.id === publication.requestId);
    if (!request) return fail("Missing command receipt", 500);
    return this.commitCommand(scope, { ...publication, command: request.command }, bulkDelta(before?.state, state, before?.layout ?? { fields: new Map(), revision: 0 })).cursor;
  }
  initializeSnapshot(scope: string, state: Snapshot, legacySource: string | null = null): boolean {
    this.writable();
    if (this.db.prepare("SELECT 1 FROM workspace_roots WHERE scope=?").get(scope)) return false;
    const delta = bulkDelta(undefined, state, { fields: new Map(), revision: 0 });
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM workspace_roots WHERE scope=?").get(scope)) return false;
      if (this.db.prepare("SELECT 1 FROM replica_records WHERE scope=? LIMIT 1").get(scope)) fail("Record-only replica requires explicit workspace import", 503);
      this.publish(scope, delta, legacySource);
      return true;
    });
  }
  /** Publish only pre-serialized changed rows. Caller owns the writer transaction. */
  private publish(scope: string, delta: WorkspaceDelta, legacySource: string | null = null) {
    if (!Number.isSafeInteger(delta.revision) || delta.revision < 0) fail("Invalid workspace revision", 400);
    const descriptors = validateDescriptors(this.db,scope);
    if (delta.completeDescriptors && descriptors.size !== delta.descriptors?.length) fail('Prepared workspace descriptors changed',503,'storage-corrupt');
    for (const [name,expected] of delta.descriptors ?? []) {
      const current = descriptors.get(name);
      if (!current || current.kind !== expected.kind || current.next !== expected.next ||
          (expected.ordinal !== undefined && current.ordinal !== expected.ordinal)) fail('Prepared workspace descriptors changed',503,'storage-corrupt');
    }
    const membership = (collection: string, slot: number, expected?: Membership) => {
      const row = this.db.prepare('SELECT item_key,entity_kind,entity_id,value_json FROM workspace_items WHERE scope=? AND collection=? AND slot=?').get(scope,collection,slot);
      if (!expected || !row || row.item_key !== expected.key || row.entity_kind !== expected.kind ||
          row.entity_id !== expected.id || row.value_json !== expected.raw) fail('Prepared workspace membership changed',503,'storage-corrupt');
    };
    for (const item of delta.items) {
      if (!Number.isSafeInteger(item.slot) || item.slot < 0 || (item.operation === 'append' && !Number.isSafeInteger(item.slot+1))) fail('Invalid prepared collection slot allocation',503,'storage-corrupt');
      if (item.operation === 'append') {
        if (this.db.prepare('SELECT 1 FROM workspace_items WHERE scope=? AND collection=? AND slot=?').get(scope,item.collection,item.slot)) fail('Append collection slot is occupied',503,'storage-corrupt');
      } else membership(item.collection,item.slot,item.expected);
    }
    for (const item of delta.removes) membership(item.collection,item.slot,item.expected);
    const initialized = this.db.prepare("SELECT 1 FROM workspace_roots WHERE scope=?").get(scope);
    // Root CAS protects the complete domain dependency set. Explicit changed
    // record revisions also fence lower-level trusted record operations.
    for (const item of [...delta.items, ...delta.removes]) if (item.kind && item.id && item.expectedRevision !== undefined) {
      const row = this.db.prepare('SELECT revision FROM replica_records WHERE scope=? AND kind=? AND id=?').get(scope, item.kind, item.id);
      if (Number(row?.revision ?? 0) !== item.expectedRevision) fail('Prepared record changed before publication', 409, 'workspace-cas');
    }
    const removedRecords = new Map(delta.removes.filter(item=>item.kind && item.id).map(item=>[`${item.kind}/${item.id}`,this.record(scope,item.kind!,item.id!)]));
    if (!initialized) this.db.prepare("INSERT OR IGNORE INTO legacy_exports VALUES(?,?)").run(scope, legacySource);
    this.db.prepare("INSERT INTO workspace_roots VALUES(?,2,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision").run(scope, delta.revision);
    for (const name of delta.removedFields ?? []) this.db.prepare('DELETE FROM workspace_fields WHERE scope=? AND name=?').run(scope, name);
    for (const name of delta.removedAuxiliary ?? []) this.db.prepare('DELETE FROM workspace_auxiliary WHERE scope=? AND name=?').run(scope, name);
    for (const field of delta.fields) {
      this.db.prepare(`INSERT INTO workspace_fields(scope,name,ordinal,storage_kind,value_json,next_slot)
        VALUES(?,?,(SELECT COALESCE(MAX(ordinal),-1)+1 FROM workspace_fields WHERE scope=?),?,?,0)
        ON CONFLICT(scope,name) DO UPDATE SET storage_kind=excluded.storage_kind,value_json=excluded.value_json`)
        .run(scope, field.name, scope, field.kind, field.raw);
    }
    const retained = new Set(delta.items.filter(item => item.kind).map(item => `${item.kind}/${item.id}`));
    for (const item of delta.removes) {
      const prior = removedRecords.get(`${item.kind}/${item.id}`);
      this.db.prepare("DELETE FROM workspace_items WHERE scope=? AND collection=? AND slot=?").run(scope, item.collection, item.slot);
      if (item.kind && item.id && !retained.has(`${item.kind}/${item.id}`)) {
        if (prior && !prior.deleted) this.put(scope, item.kind, item.id, prior.revision + 1, true, null);
      }
    }
    const seen = new Set<string>();
    for (const item of delta.items) {
      if (item.kind) {
        if (!item.id || seen.has(`${item.kind}/${item.id}`)) return fail("Invalid or duplicate workspace identity", 400);
        seen.add(`${item.kind}/${item.id}`);
        const prior = this.db.prepare("SELECT revision,deleted,body,raw_body FROM replica_records WHERE scope=? AND kind=? AND id=?").get(scope, item.kind, item.id);
        if (!prior || prior.deleted || prior.body !== item.body) {
          const revision = Number(prior?.revision ?? 0) + 1;
          this.db.prepare(`INSERT INTO replica_records(scope,kind,id,revision,deleted,body,raw_body) VALUES(?,?,?,?,0,?,?)
            ON CONFLICT(scope,kind,id) DO UPDATE SET revision=excluded.revision,deleted=0,body=excluded.body,raw_body=excluded.raw_body`).run(scope, item.kind, item.id, revision, item.body, item.raw);
          this.db.prepare("INSERT INTO replica_changes(scope,kind,id,revision,deleted,body) VALUES(?,?,?,?,0,?)").run(scope, item.kind, item.id, revision, item.body);
        } else if (prior.raw_body !== item.raw) this.db.prepare("UPDATE replica_records SET raw_body=? WHERE scope=? AND kind=? AND id=?").run(item.raw, scope, item.kind, item.id);
      }
      if (item.operation === 'append') {
        this.db.prepare('INSERT INTO workspace_items VALUES(?,?,?,?,?,?,?)')
          .run(scope,item.collection,item.slot,item.key,item.kind??null,item.id??null,item.kind?null:item.raw);
      } else {
        const expected = item.expected!;
        const changed = this.db.prepare(`UPDATE workspace_items SET item_key=?,entity_kind=?,entity_id=?,value_json=?
          WHERE scope=? AND collection=? AND slot=? AND item_key IS ? AND entity_kind IS ? AND entity_id IS ? AND value_json IS ?`)
          .run(item.key,item.kind??null,item.id??null,item.kind?null:item.raw,scope,item.collection,item.slot,expected.key,expected.kind,expected.id,expected.raw);
        if (changed.changes !== 1) fail('Prepared workspace membership changed',503,'storage-corrupt');
      }
      this.db.prepare("UPDATE workspace_fields SET next_slot=? WHERE scope=? AND name=? AND next_slot<?").run(item.slot + 1, scope, item.collection, item.slot + 1);
    }
    for (const entry of delta.auxiliary) this.db.prepare(`INSERT INTO workspace_auxiliary VALUES(?,?,(SELECT COALESCE(MAX(ordinal),-1)+1 FROM workspace_auxiliary WHERE scope=?),?)
      ON CONFLICT(scope,name) DO UPDATE SET value_json=excluded.value_json`).run(scope, entry.name, scope, entry.raw);
    if (delta.fieldOrder) {
      this.db.prepare('UPDATE workspace_fields SET ordinal=-ordinal-1 WHERE scope=?').run(scope);
      delta.fieldOrder.forEach((name, ordinal) => this.db.prepare('UPDATE workspace_fields SET ordinal=? WHERE scope=? AND name=?').run(ordinal, scope, name));
    }
    if (delta.auxiliaryOrder) {
      this.db.prepare('UPDATE workspace_auxiliary SET ordinal=-ordinal-1 WHERE scope=?').run(scope);
      delta.auxiliaryOrder.forEach((name, ordinal) => this.db.prepare('UPDATE workspace_auxiliary SET ordinal=? WHERE scope=? AND name=?').run(ordinal, scope, name));
    }
  }
  commitCommand(scope: string, publication: { expectedRevision: number; generation: string; requestId: string; command: string }, delta: WorkspaceDelta): { replay: boolean; cursor: number } {
    return this.transaction(() => {
      if (this.generation(scope) !== publication.generation) fail("The server history changed", 409, "history-changed");
      if (this.hasReceipt(scope, publication.requestId) || this.db.prepare("SELECT 1 FROM replica_history_adoptions WHERE scope=? AND request_id=?").get(scope, publication.requestId)) fail("Operation identity belongs to the synchronization protocol or maintenance");
      const prior = this.commandReceipt(scope, publication.requestId);
      if (prior) {
        let same = prior.command === publication.command;
        if (!same) { try { same = encode(JSON.parse(prior.command)) === publication.command; } catch {} }
        if (!same) fail("Request identity was reused with different contents");
        return { replay: true, cursor: this.head(scope) };
      }
      if (this.revision(scope) !== publication.expectedRevision) fail("This view is out of date. Refresh before saving.", 409, "workspace-cas");
      this.publish(scope, delta);
      return { replay: false, cursor: this.head(scope) };
    });
  }
  /** Cutover primitive. Call only after domain validation and exclusion of all
   * legacy writers. Raw exports, full history and the initial change feed share
   * one commit; a partially imported workspace must never become readable. */
  importWorkspace(scope: string, state: Snapshot, source: unknown) {
    if (typeof scope !== "string" || !scope || scope.length > 500) fail("Invalid import scope", 400);
    const retained = { source, snapshot: state };
    const serialized = JSON.stringify(retained);
    const digest = createHash("sha256").update(encode(retained)).digest("hex");
    const delta = bulkDelta(undefined, state, { fields: new Map(), revision: 0 });
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT digest FROM replica_imports WHERE scope=?").get(scope);
      if (prior) {
        if (prior.digest !== digest) fail("A different source was already imported");
        return digest;
      }
      if (this.db.prepare("SELECT 1 FROM workspace_roots WHERE scope=?").get(scope) || this.db.prepare("SELECT 1 FROM replica_records WHERE scope=? LIMIT 1").get(scope))
        fail("Import requires an empty workspace");
      this.publish(scope, delta);
      this.db.prepare("INSERT INTO replica_imports VALUES(?,?,?)").run(scope, digest, serialized);
      return digest;
    });
  }
  transaction<T>(fn: () => T): T {
    this.writable();
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  readTransaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  record(scope: string, kind: string, id: string): ReplicaRecord | undefined {
    return this.readTransaction(() => {
      if (this.format === 2) validateDescriptors(this.db,scope);
      const row = this.db.prepare("SELECT * FROM replica_records WHERE scope=? AND kind=? AND id=?").get(scope, kind, id);
      if (!row) return undefined;
      if (this.format === 2) {
        const initialized = Boolean(this.db.prepare('SELECT 1 FROM workspace_roots WHERE scope=?').get(scope));
        decodedRecord({raw_body:row.raw_body,body:row.body,deleted:row.deleted},initialized ? id : undefined);
        if (initialized) {
          const membership = this.db.prepare('SELECT collection,item_key FROM workspace_items WHERE scope=? AND entity_kind=? AND entity_id=?').get(scope,kind,id);
          if (row.deleted ? Boolean(membership) : !membership || membership.collection !== `${kind}s` || membership.item_key !== id) fail('Normalized record membership is invalid',503,'storage-corrupt');
        }
      }
      return { kind, id, revision: Number(row.revision), deleted: Boolean(row.deleted), value: JSON.parse(String(row.body)) };
    });
  }
  hasReceipt(scope: string, operationId: string): boolean {
    // Admission may skip current-time preflight for an already decided intent.
    // applyMutation still verifies its payload digest before returning it.
    return Boolean(this.db.prepare("SELECT 1 FROM replica_receipts WHERE scope=? AND operation_id=?").get(scope, operationId));
  }
  operationReceipt(scope: string, operation: Operation, generation?: string) {
    return this.readTransaction(() => {
      if (generation !== undefined && this.generation(scope) !== generation) fail("The server history changed", 409, "history-changed");
      if (this.commandReceipt(scope, operation.operationId) || this.db.prepare("SELECT 1 FROM replica_history_adoptions WHERE scope=? AND request_id=?").get(scope, operation.operationId)) fail("Operation identity belongs to an earlier command protocol");
      const prior = this.db.prepare("SELECT digest,result FROM replica_receipts WHERE scope=? AND operation_id=?").get(scope, operation.operationId);
      if (!prior) return undefined;
      if (prior.digest !== createHash('sha256').update(encode(operation)).digest('hex')) fail("Operation identity reused with different contents");
      return JSON.parse(String(prior.result));
    });
  }
  changes(scope: string, after = 0, limit = 100, through = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail("Invalid change cursor", 400);
    if (!Number.isSafeInteger(through) || through < after) fail("Invalid server download boundary", 400);
    return this.db.prepare("SELECT * FROM replica_changes WHERE scope=? AND cursor>? AND cursor<=? ORDER BY cursor LIMIT ?").all(scope, after, through, limit)
      .map(row => ({ cursor: Number(row.cursor), kind: String(row.kind), id: String(row.id), revision: Number(row.revision), deleted: Boolean(row.deleted), value: JSON.parse(String(row.body)) }));
  }
  put(scope: string, kind: string, id: string, revision: number, deleted: boolean, value: unknown) {
    this.writable();
    const body = encode(value);
    this.db.prepare(`INSERT INTO replica_records(scope,kind,id,revision,deleted,body,raw_body) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(scope,kind,id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,body=excluded.body,raw_body=excluded.raw_body`)
      .run(scope, kind, id, revision, Number(deleted), body, json(value));
    return Number(this.db.prepare("INSERT INTO replica_changes(scope,kind,id,revision,deleted,body) VALUES(?,?,?,?,?,?)")
      .run(scope, kind, id, revision, Number(deleted), body).lastInsertRowid);
  }
  apply(scope: string, operation: Operation, validate: (input: ValidationInput) => unknown) {
    return this.applyMutation(scope, operation, input => {
      if (this.snapshot(scope)) fail("Workspace operations must use the domain command layer", 500);
      // Validators must be synchronous and side-effect free. No network or
      // filesystem work may span this short authoritative transaction.
      const checked = validate(input);
      if (checked && typeof checked === "object" && "then" in checked && typeof checked.then === "function") fail("Async validators are unsupported", 500);
      const revision = (input.current?.revision ?? 0) + 1;
      const deleted = input.action === "delete";
      const value = deleted ? null : checked;
      return { revision, deleted, value, cursor: this.put(scope, input.kind, input.id, revision, deleted, value) };
    });
  }
  /** The same receipt protocol, applied through the workspace's domain reducer.
   * Its snapshot, record revisions, change feed and receipt share one commit. */
  applyWorkspace(scope: string, operation: Operation, reduce: (state: Snapshot, input: ValidationInput) => Snapshot, expectedGeneration?: string) {
    expectedGeneration ??= this.generation(scope);
    const prior = this.operationReceipt(scope, operation, expectedGeneration);
    if (prior) return prior;
    const current = this.record(scope, operation.kind, operation.id);
    if ((current?.revision ?? 0) !== operation.expectedRevision || (operation.action === 'create' ? Boolean(current) : !current || current.deleted)) return this.commitSync(scope, operation, undefined, 0, expectedGeneration);
    const before = this.readWorkspace(scope);
    if (!before) return fail("Workspace migration is required before synchronization", 503);
    const next = reduce(structuredClone(before.state) as Snapshot, { scope, ...operation, value: operation.value, current: this.record(scope, operation.kind, operation.id) });
    if (!next || next.revision !== before.state.revision + 1) fail("Domain command must advance the workspace revision", 500);
    return this.commitSync(scope, operation, bulkDelta(before.state, next, before.layout), before.state.revision, expectedGeneration);
  }
  commitSync(scope: string, operation: Operation, delta: WorkspaceDelta | undefined, expectedRevision: number, expectedGeneration?: string) {
    return this.applyMutation(scope, operation, input => {
      if (this.revision(scope) !== expectedRevision) fail("Workspace changed during validation. Retry this saved operation.", 409, "workspace-cas");
      if (!delta || delta.revision !== expectedRevision + 1) return fail("Missing prepared domain mutation", 500);
      this.publish(scope, delta);
      const record = this.record(scope, input.kind, input.id);
      if (!record || record.revision !== (input.current?.revision ?? 0) + 1 || record.deleted !== (input.action === "delete"))
        return fail("Domain command did not apply the requested operation", 500);
      const row = this.db.prepare("SELECT MAX(cursor) AS cursor FROM replica_changes WHERE scope=?").get(scope)!;
      return { revision: record.revision, cursor: Number(row.cursor), deleted: record.deleted, value: record.value };
    }, expectedGeneration);
  }
  private applyMutation(scope: string, operation: Operation, mutate: (input: ValidationInput) => MutationResult, expectedGeneration?: string) {
    if (typeof scope !== "string" || !scope || scope.length > 500) fail("Invalid authenticated scope", 400);
    const { operationId, kind, id, expectedRevision, action, value } = operation;
    if (!/^[a-f0-9-]{36}$/i.test(operationId ?? "") || !["task", "goal", "idea"].includes(kind) ||
        typeof id !== "string" || !id || id.length > 200 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !["create", "update", "delete"].includes(action)) fail("Invalid operation", 400);
    const digest = createHash("sha256").update(encode(operation)).digest("hex");
    return this.transaction(() => {
      if (expectedGeneration !== undefined && this.generation(scope) !== expectedGeneration)
        fail("The server history changed. Reconcile saved work before restarting synchronization.", 409, "history-changed");
      if (this.commandReceipt(scope, operationId) || this.db.prepare("SELECT 1 FROM replica_history_adoptions WHERE scope=? AND request_id=?").get(scope, operationId)) fail("Operation identity belongs to an earlier command protocol");
      const prior = this.db.prepare("SELECT * FROM replica_receipts WHERE scope=? AND operation_id=?").get(scope, operationId);
      if (prior) {
        if (prior.digest !== digest) fail("Operation identity reused with different contents");
        return JSON.parse(String(prior.result));
      }
      const current = this.record(scope, kind, id);
      let result;
      if ((current?.revision ?? 0) !== expectedRevision || (action === "create" ? Boolean(current) : !current || current.deleted)) {
        result = { status: "conflict", operationId, current: current ?? null };
      } else {
        result = { status: "accepted", operationId, kind, id, ...mutate({ scope, action, kind, id, value, current }) };
      }
      this.db.prepare("INSERT INTO replica_receipts VALUES(?,?,?,?)").run(scope, operationId, digest, encode(result));
      return result;
    });
  }
  /** Explicit maintenance only. Backup verification and excluded writers are
   * installation admission gates, never supplied by an HTTP request. */
  migrateWorkspaceFormat(admission: { backupVerified: boolean; writersExcluded: boolean }) {
    if (admission.backupVerified !== true || admission.writersExcluded !== true) fail("Verified backup and writer exclusion are required", 503);
    if (this.format === 2) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const plans = this.db.prepare("SELECT scope,body FROM workspace_snapshots ORDER BY scope").all().map(row => {
        const scope = String(row.scope), state = JSON.parse(String(row.body)) as Snapshot;
        if (!Number.isSafeInteger(state.revision) || state.revision < 0) fail("Invalid workspace revision", 503);
        const seen = new Set<string>();
        for (const kind of ["task", "goal", "idea"] as const) {
          const values = state[`${kind}s`] ?? [];
          if (!Array.isArray(values)) fail("Invalid workspace records", 503);
          for (const value of values) {
            const key = `${kind}/${value?.id}`;
            if (!value || typeof value.id !== "string" || !value.id || seen.has(key)) fail("Invalid or duplicate workspace identity", 503);
            seen.add(key);
            const current = this.db.prepare("SELECT body,deleted FROM replica_records WHERE scope=? AND kind=? AND id=?").get(scope, kind, value.id);
            if (!current || current.deleted || current.body !== encode(value)) fail("Envelope and replica records diverge; reconciliation is required", 503);
          }
        }
        for (const record of this.db.prepare("SELECT kind,id FROM replica_records WHERE scope=? AND deleted=0").all(scope))
          if (!seen.has(`${record.kind}/${record.id}`)) fail("Replica record has no envelope membership; reconciliation is required", 503);
        return { scope, state, delta: bulkDelta(undefined, state, { fields: new Map(), revision: 0 }) };
      });
      this.db.exec("ALTER TABLE replica_records ADD COLUMN raw_body TEXT; UPDATE replica_records SET raw_body=body");
      for (const row of this.db.prepare('SELECT raw_body,body,deleted FROM replica_records').all()) decodedRecord({raw_body:row.raw_body,body:row.body,deleted:row.deleted});
      this.db.exec(normalizedSchema);
      this.format = 2;
      for (const plan of plans) {
        this.publish(plan.scope, plan.delta);
        if (json(assemble(this.db, plan.scope)!.state) !== json(plan.state)) fail("Normalized workspace parity failed", 503);
      }
      this.db.exec(`ALTER TABLE workspace_snapshots RENAME TO workspace_snapshot_exports_v1;
        CREATE TRIGGER freeze_v1_insert BEFORE INSERT ON workspace_snapshot_exports_v1 BEGIN SELECT RAISE(ABORT,'Historical export is immutable'); END;
        CREATE TRIGGER freeze_v1_update BEFORE UPDATE ON workspace_snapshot_exports_v1 BEGIN SELECT RAISE(ABORT,'Historical export is immutable'); END;
        CREATE TRIGGER freeze_v1_delete BEFORE DELETE ON workspace_snapshot_exports_v1 BEGIN SELECT RAISE(ABORT,'Historical export is immutable'); END;
        DROP TABLE replica_schema;
        CREATE TABLE replica_schema(version INTEGER PRIMARY KEY CHECK(version=2)); INSERT INTO replica_schema VALUES(2);
        CREATE TRIGGER reject_legacy_bootstrap BEFORE INSERT ON replica_schema WHEN NEW.version=1 BEGIN SELECT RAISE(ABORT,'Workspace format 2 requires a compatible runtime'); END;`);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); this.format = 1; throw error; }
  }
  /** Isolated consistent rollback export. Old supported runtime verification is
   * a separate required maintenance gate before using this output. */
  exportV1(filename: string) {
    this.writable();
    if (this.db.isTransaction) fail('Legacy export requires an independent committed read snapshot', 503);
    const fd = openSync(filename, "wx", 0o600); closeSync(fd);
    let output: DatabaseSync | undefined;
    try {
      output = new DatabaseSync(filename);
      const target = output;
      this.readTransaction(() => {
        for (const row of this.db.prepare(`SELECT scope FROM workspace_roots UNION SELECT scope FROM workspace_fields
          UNION SELECT scope FROM workspace_items UNION SELECT scope FROM workspace_auxiliary`).all()) validateDescriptors(this.db,String(row.scope));
        // Validate every raw/canonical pair, including standalone primitive
        // replicas and tombstones, before publishing a legacy representation.
        for (const row of this.db.prepare('SELECT scope,kind,id FROM replica_records').all()) this.record(String(row.scope),String(row.kind),String(row.id));
        target.exec("BEGIN IMMEDIATE");
        target.exec("CREATE TABLE replica_schema(version INTEGER PRIMARY KEY CHECK(version=1)); INSERT INTO replica_schema VALUES(1); CREATE TABLE workspace_snapshots(scope TEXT PRIMARY KEY,body TEXT NOT NULL)");
        for (const name of ["replica_records", "replica_changes", "replica_receipts", "replica_imports", "replica_generations", "legacy_exports", "replica_history_adoptions"]) {
          const definition = String(this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)!.sql);
          target.exec(name === "replica_records" ? "CREATE TABLE replica_records(scope TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,body TEXT,PRIMARY KEY(scope,kind,id))" : definition);
          const columns = target.prepare(`PRAGMA table_info(${name})`).all().map(row => String(row.name));
          const insert = target.prepare(`INSERT INTO ${name}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
          for (const row of this.db.prepare(`SELECT ${columns.join(",")} FROM ${name}`).all()) insert.run(...columns.map(column => row[column]!));
        }
        target.exec("CREATE INDEX replica_scope_cursor ON replica_changes(scope,cursor)");
        const sequence = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='replica_changes'").get();
        if (sequence) {
          target.prepare("DELETE FROM sqlite_sequence WHERE name='replica_changes'").run();
          target.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('replica_changes',?)").run(sequence.seq!);
        }
        for (const row of this.db.prepare("SELECT scope FROM workspace_roots ORDER BY scope").all()) {
          const scope = String(row.scope), body = json(assemble(this.db, scope)!.state);
          target.prepare("INSERT INTO workspace_snapshots VALUES(?,?)").run(scope, body);
          if (target.prepare("SELECT body FROM workspace_snapshots WHERE scope=?").get(scope)?.body !== body) fail("Legacy export verification failed", 503);
        }
        if (target.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") fail("Legacy export integrity check failed", 503);
        target.exec("COMMIT");
      });
      target.close(); output = undefined;
    } catch (error) { output?.close(); unlinkSync(filename); throw error; }
  }
  import(scope: string, source: ExportSource) {
    // Preserve the complete export, including fields the replica does not
    // interpret. Reimport requires byte-equivalent canonical content.
    const serialized = encode(source);
    const digest = createHash("sha256").update(serialized).digest("hex");
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT digest FROM replica_imports WHERE scope=?").get(scope);
      if (prior) { if (prior.digest !== digest) fail("A different source was already imported"); return digest; }
      if (this.db.prepare("SELECT 1 FROM workspace_roots WHERE scope=?").get(scope) || this.db.prepare("SELECT 1 FROM replica_records WHERE scope=? LIMIT 1").get(scope)) fail("Import requires an empty scope");
      for (const kind of ["task", "goal", "idea"] as const) {
        for (const record of source[`${kind}s`] ?? []) {
          if (typeof record.id !== "string" || !record.id || this.record(scope, kind, record.id)) fail("Invalid or duplicate import identity", 400);
          this.put(scope, kind, record.id, 1, false, record);
        }
      }
      this.db.prepare("INSERT INTO replica_imports VALUES(?,?,?)").run(scope, digest, serialized);
      return digest;
    });
  }
}
