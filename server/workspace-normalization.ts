import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../shared/sync-contract.ts";
import { Fault } from "./errors.ts";

export type Workspace = { revision: number; [key: string]: unknown };
export const collections = new Set(["goals", "tasks", "ideas", "opportunities", "ledger", "recommendations", "councilSessions", "events", "requests", "preferenceHistory", "taskOutcomes", "strategicAudit"]);
export const entityKind = (name: string): string | undefined => name === 'tasks' ? 'task' : name === 'goals' ? 'goal' : name === 'ideas' ? 'idea' : undefined;
export const normalizedSchema = `
CREATE TABLE workspace_roots(scope TEXT PRIMARY KEY, storage_version INTEGER NOT NULL CHECK(storage_version=2), revision INTEGER NOT NULL);
CREATE TABLE workspace_fields(scope TEXT NOT NULL,name TEXT NOT NULL,ordinal INTEGER NOT NULL,storage_kind TEXT NOT NULL,value_json TEXT,next_slot INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,name),UNIQUE(scope,ordinal));
CREATE TABLE workspace_items(scope TEXT NOT NULL,collection TEXT NOT NULL,slot INTEGER NOT NULL,item_key TEXT,entity_kind TEXT,entity_id TEXT,value_json TEXT,
 PRIMARY KEY(scope,collection,slot),CHECK((entity_kind IS NOT NULL AND entity_id IS NOT NULL AND value_json IS NULL) OR (entity_kind IS NULL AND entity_id IS NULL AND value_json IS NOT NULL)));
CREATE INDEX workspace_item_identity ON workspace_items(scope,collection,item_key,slot);
CREATE UNIQUE INDEX workspace_entity_membership ON workspace_items(scope,entity_kind,entity_id) WHERE entity_kind IS NOT NULL;
CREATE TABLE workspace_auxiliary(scope TEXT NOT NULL,name TEXT NOT NULL,ordinal INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(scope,name),UNIQUE(scope,ordinal));`;
export const own = (target: object, key: string, value: unknown) => Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
export const json = (value: unknown): string => {
  const result = JSON.stringify(value);
  if (result === undefined) throw Error("Unsupported workspace JSON value");
  return result;
};
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** Raw JSON owns representation; the wire body is a checked canonical
 * projection. Equal values with different property order are legitimate. */
export function decodedRecord(row: { raw_body: unknown; body: unknown; deleted: unknown }, identity?: string): unknown {
  try {
    if (typeof row.raw_body !== 'string' || typeof row.body !== 'string' || (row.deleted !== 0 && row.deleted !== 1)) throw Error();
    const value: unknown = JSON.parse(row.raw_body);
    if (canonicalJson(value) !== row.body || (row.deleted === 1 && value !== null)) throw Error();
    if (row.deleted === 0 && identity !== undefined && (!object(value) || value.id !== identity)) throw Error();
    return value;
  } catch {
    throw new Fault(503, 'Normalized record authority and projection disagree. Restore verified storage before continuing.', 'storage-corrupt');
  }
}
export function itemKey(value: unknown): string | null { return object(value) && typeof value.id === "string" ? value.id : null; }
export function fieldKind(name: string, value: unknown): string {
  return name === "revision" ? "revision" : collections.has(name) && Array.isArray(value) ? "collection" : name === "auxiliary" && object(value) ? "auxiliary" : "value";
}
export type Descriptor = { kind: string; next: number; ordinal?: number };
export type Membership = { key: string | null; kind: string | null; id: string | null; raw: string | null };
export type Layout = {
  fields: Map<string, Descriptor & { slots: number[] }>;
  revision: number; records?: Map<string, number>;
  memberships?: Map<string, Map<number, Membership>>; complete?: boolean;
};
export type ReadWorkspace = { state: Workspace; layout: Layout };
const corrupt = (): never => { throw new Fault(503, 'Normalized workspace descriptors or membership are invalid', 'storage-corrupt'); };
/** Validate metadata with indexed collection-boundary seeks. Never scan or parse
 * unrelated history/auxiliary bodies, including when called before publication. */
export function validateDescriptors(db: DatabaseSync, scope: string): Map<string, Descriptor> {
  const root = db.prepare('SELECT revision,storage_version FROM workspace_roots WHERE scope=?').get(scope);
  const fields = new Map<string, Descriptor>();
  for (const row of db.prepare('SELECT name,ordinal,storage_kind,next_slot,value_json IS NOT NULL AS has_value FROM workspace_fields WHERE scope=? ORDER BY ordinal').all(scope)) {
    const name = String(row.name), kind = String(row.storage_kind), next = Number(row.next_slot), ordinal = Number(row.ordinal);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || !Number.isSafeInteger(next) || next < 0 ||
        !['value','revision','collection','auxiliary'].includes(kind) ||
        (kind === 'value') !== Boolean(row.has_value) ||
        (kind === 'revision') !== (name === 'revision') ||
        (kind === 'collection' && !collections.has(name)) || (kind === 'auxiliary' && name !== 'auxiliary')) corrupt();
    fields.set(name, {kind,next,ordinal});
  }
  const auxiliary = db.prepare('SELECT 1 FROM workspace_auxiliary WHERE scope=? LIMIT 1').get(scope);
  if (auxiliary && fields.get('auxiliary')?.kind !== 'auxiliary') corrupt();
  // Seek distinct collection names through the primary key, rather than walk
  // every request/event slot merely to validate its descriptor.
  let after: string | undefined;
  while (true) {
    const row = after === undefined
      ? db.prepare('SELECT collection FROM workspace_items WHERE scope=? ORDER BY collection LIMIT 1').get(scope)
      : db.prepare('SELECT collection FROM workspace_items WHERE scope=? AND collection>? ORDER BY collection LIMIT 1').get(scope,after);
    if (!row) break;
    const name = String(row.collection), descriptor = fields.get(name);
    if (!descriptor || descriptor.kind !== 'collection') corrupt();
    const first = Number(db.prepare('SELECT slot FROM workspace_items WHERE scope=? AND collection=? ORDER BY slot LIMIT 1').get(scope,name)!.slot);
    const last = Number(db.prepare('SELECT slot FROM workspace_items WHERE scope=? AND collection=? ORDER BY slot DESC LIMIT 1').get(scope,name)!.slot);
    if (!Number.isSafeInteger(first) || first < 0 || !Number.isSafeInteger(last) || last >= descriptor!.next) corrupt();
    after = name;
  }
  if (root) {
    if (root.storage_version !== 2 || !Number.isSafeInteger(Number(root.revision)) || Number(root.revision) < 0 || fields.get('revision')?.kind !== 'revision') corrupt();
  } else if (fields.size || auxiliary || after !== undefined) corrupt();
  return fields;
}
/** Caller holds a read or write transaction. Excluded collections are shape-only
 * domain preparation views, never passed to trusted arbitrary callbacks. */
export function assemble(db: DatabaseSync, scope: string, exclude: ReadonlySet<string> = new Set(), auxiliaryKey?: string): ReadWorkspace | undefined {
  validateDescriptors(db,scope);
  const root = db.prepare("SELECT revision FROM workspace_roots WHERE scope=?").get(scope);
  if (!root) return undefined;
  const orphan = db.prepare(`SELECT 1 FROM replica_records r WHERE r.scope=? AND r.deleted=0 AND NOT EXISTS
    (SELECT 1 FROM workspace_items i WHERE i.scope=r.scope AND i.entity_kind=r.kind AND i.entity_id=r.id AND i.item_key=r.id
      AND i.collection=CASE r.kind WHEN 'task' THEN 'tasks' WHEN 'goal' THEN 'goals' WHEN 'idea' THEN 'ideas' END) LIMIT 1`).get(scope);
  if (orphan) throw new Fault(503, 'Normalized record membership is invalid', 'storage-corrupt');
  const state = {} as Workspace, layout: Layout = { fields: new Map(), revision: Number(root.revision), records: new Map(), memberships: new Map(), complete: true };
  for (const field of db.prepare("SELECT * FROM workspace_fields WHERE scope=? ORDER BY ordinal").all(scope)) {
    const name = String(field.name), kind = String(field.storage_kind), slots: number[] = [];
    layout.fields.set(name, { kind, next: Number(field.next_slot), ordinal:Number(field.ordinal), slots });
    if (kind === "revision") own(state, name, Number(root.revision));
    else if (kind === "value") own(state, name, name === 'auxiliary' && exclude.has(name) ? undefined : JSON.parse(String(field.value_json)));
    else if (kind === "collection") {
      const values: unknown[] = [];
      const memberships = new Map<number, Membership>(); layout.memberships!.set(name,memberships);
      if (!exclude.has(name)) for (const row of db.prepare(`SELECT i.slot,i.item_key,i.entity_kind,i.entity_id,i.value_json,r.raw_body,r.body,r.deleted,r.revision FROM workspace_items i
        LEFT JOIN replica_records r ON r.scope=i.scope AND r.kind=i.entity_kind AND r.id=i.entity_id
        WHERE i.scope=? AND i.collection=? ORDER BY i.slot`).all(scope, name)) {
        slots.push(Number(row.slot));
        if (!Number.isSafeInteger(Number(row.slot)) || Number(row.slot) < 0) corrupt();
        memberships.set(Number(row.slot),{key:row.item_key === null ? null : String(row.item_key),kind:row.entity_kind === null ? null : String(row.entity_kind),id:row.entity_id === null ? null : String(row.entity_id),raw:row.value_json === null ? null : String(row.value_json)});
        if (row.entity_kind !== null) layout.records!.set(`${row.entity_kind}/${row.entity_id}`, Number(row.revision));
        if (row.entity_kind === null) {
          if (entityKind(name)) corrupt();
          values.push(JSON.parse(String(row.value_json)));
        }
        else {
          if (row.deleted !== 0 || row.entity_kind !== entityKind(name) || row.item_key !== row.entity_id) throw new Fault(503, 'Invalid normalized entity membership', 'storage-corrupt');
          values.push(decodedRecord({raw_body:row.raw_body,body:row.body,deleted:row.deleted},String(row.entity_id)));
        }
      }
      own(state, name, values);
    } else if (kind === "auxiliary") {
      const values = {};
      if (!exclude.has(name)) {
        const rows = auxiliaryKey === undefined ? db.prepare("SELECT name,value_json FROM workspace_auxiliary WHERE scope=? ORDER BY ordinal").all(scope)
          : db.prepare("SELECT name,value_json FROM workspace_auxiliary WHERE scope=? AND name=?").all(scope, auxiliaryKey);
        for (const row of rows) own(values, String(row.name), JSON.parse(String(row.value_json)));
      }
      own(state, name, values);
    } else throw Error("Unsupported normalized workspace field");
  }
  return { state, layout };
}
