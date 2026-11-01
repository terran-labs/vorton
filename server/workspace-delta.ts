import { fieldKind, itemKey, json, entityKind, object } from "./workspace-normalization.ts";
import type { Workspace, Layout, Descriptor, Membership } from "./workspace-normalization.ts";
import { canonicalJson } from "../shared/sync-contract.ts";

type Item = {
  collection: string; slot: number; key: string | null;
  kind?: string; id?: string; expectedRevision?: number;
  raw: string; body: string;
  operation: 'append' | 'replace'; expected?: Membership;
};
export type WorkspaceDelta = {
  revision: number;
  fields: { name: string; kind: string; raw: string | null }[];
  items: Item[];
  removes: { collection: string; slot: number; kind?: string; id?: string; expectedRevision?: number; expected?: Membership }[];
  auxiliary: { name: string; raw: string }[];
  removedFields?: string[]; removedAuxiliary?: string[];
  fieldOrder?: string[]; auxiliaryOrder?: string[];
  descriptors?: [string, Descriptor][]; completeDescriptors?: boolean;
};
/** Explicit mutation journal, attached only to the server's admitted read view.
 * No interception, identity guessing or automatic arbitrary callback retries. */
export class MutationJournal {
  private replacements = new Map<string, Set<number>>();
  private removals = new Map<string, Map<number, string | undefined>>();
  private appends = new Map<string, unknown[]>();
  private fields = new Set<string>();
  private auxiliary = new Set<string>();
  private removedFields = new Set<string>();
  readonly layout: Layout;
  constructor(layout: Layout) { this.layout = layout; }
  replace(name: string, index: number) { const set = this.replacements.get(name) ?? new Set(); set.add(index); this.replacements.set(name, set); }
  remove(name: string, index: number, id?: string) { const set = this.removals.get(name) ?? new Map(); set.set(index, id); this.removals.set(name, set); }
  append(name: string, value: unknown) { const items = this.appends.get(name) ?? []; items.push(value); this.appends.set(name, items); }
  field(name: string) { this.fields.add(name); }
  removeField(name: string) { this.removedFields.add(name); }
  aux(name: string) { this.auxiliary.add(name); }
  prepare(state: Workspace): WorkspaceDelta {
    const delta: WorkspaceDelta = { revision: state.revision, fields: [], items: [], removes: [], auxiliary: [], removedFields: [...this.removedFields],descriptors:[...this.layout.fields].map(([name,field])=>[name,{kind:field.kind,next:field.next,ordinal:field.ordinal}]),completeDescriptors:this.layout.complete };
    const ensure = (name: string) => { if (this.layout.fields.get(name)?.kind !== fieldKind(name, state[name])) this.fields.add(name); };
    const item = (collection: string, slot: number, value: unknown, operation: Item['operation']): Item => {
      const key = itemKey(value), kind = entityKind(collection);
      return { collection, slot, key, kind, id: kind ? key ?? undefined : undefined,operation,expected:operation==='replace'?this.layout.memberships?.get(collection)?.get(slot):undefined,
        raw: json(value), body: canonicalJson(value), expectedRevision: this.layout.records?.get(`${kind}/${key}`) };
    };
    for (const [name, indexes] of this.replacements) for (const index of indexes) {
      const slot = this.layout.fields.get(name)?.slots[index];
      if (slot === undefined) throw Error("Missing admitted collection position");
      delta.items.push(item(name, slot, (state[name] as unknown[])[index], 'replace'));
    }
    for (const [name, indexes] of this.removals) for (const [index, id] of indexes) {
      const slot = this.layout.fields.get(name)?.slots[index];
      if (slot === undefined) throw Error("Missing admitted collection position");
      delta.removes.push({ collection: name, slot, kind: entityKind(name), id, expectedRevision: this.layout.records?.get(`${entityKind(name)}/${id}`),expected:this.layout.memberships?.get(name)?.get(slot) });
    }
    for (const [name, values] of this.appends) {
      ensure(name); let slot = this.layout.fields.get(name)?.next ?? 0;
      for (const value of values) delta.items.push(item(name, slot++, value, 'append'));
    }
    for (const name of this.auxiliary) {
      ensure("auxiliary"); delta.auxiliary.push({ name, raw: json((state.auxiliary as Record<string, unknown>)[name]) });
    }
    for (const name of this.fields) delta.fields.push({ name, kind: fieldKind(name, state[name]), raw: fieldKind(name, state[name]) === "value" ? json(state[name]) : null });
    return delta;
  }
}
const journals = new WeakMap<object, MutationJournal>();
export const journal = (state: object) => journals.get(state);
export function attach(state: object, value: MutationJournal) { journals.set(state, value); }
export function appended(state: object, name: string, value: unknown) { journal(state)?.append(name, value); }
/** Trusted bulk compatibility only. Ordinary domain writers use the journal. */
export function bulkDelta(before: Workspace | undefined, after: Workspace, layout: Layout): WorkspaceDelta {
  // Freeze the JSON representation the old envelope retained, including omitted
  // undefined object keys and null array positions. Bulk callers alone pay this
  // whole-view conversion, always before the ordinary writer transaction.
  after = JSON.parse(json(after)) as Workspace;
  const j = new MutationJournal(layout);
  for (const [name, value] of Object.entries(after)) {
    if (name === "revision") { if (!layout.fields.has(name)) j.field(name); continue; }
    const old = before?.[name], kind = fieldKind(name, value);
    if (kind === "collection") {
      const previous = Array.isArray(old) ? old : [], next = value as unknown[];
      // Preserve stable positions for unchanged IDs and explicit order. Bulk
      // reorder replaces memberships, never changes the canonical feed by itself.
      const orderSame = next.length === previous.length && next.every((v, i) => itemKey(v) === itemKey(previous[i]));
      if (orderSame) next.forEach((v, i) => { if (json(v) !== json(previous[i])) j.replace(name, i); });
      else {
        previous.forEach((v, i) => j.remove(name, i, itemKey(v) ?? undefined));
        next.forEach(v => j.append(name, v));
      }
      if (!layout.fields.has(name) || layout.fields.get(name)?.kind !== kind) j.field(name);
    } else if (kind === "auxiliary") {
      for (const [key, entry] of Object.entries(value as object)) if (!object(old) || !Object.hasOwn(old, key) || json(old[key]) !== json(entry)) j.aux(key);
      if (!layout.fields.has(name) || layout.fields.get(name)?.kind !== kind) j.field(name);
    } else if (old === undefined || json(old) !== json(value)) j.field(name);
  }
  const delta = j.prepare(after);
  delta.removedFields = Object.keys(before ?? {}).filter(name => !Object.hasOwn(after, name));
  delta.removedAuxiliary = object(before?.auxiliary) ? Object.keys(before.auxiliary).filter(name => !object(after.auxiliary) || !Object.hasOwn(after.auxiliary, name)) : [];
  for (const [name, descriptor] of layout.fields) {
    if (descriptor.kind !== 'collection' || fieldKind(name, after[name]) === 'collection') continue;
    const previous = before?.[name] as unknown[];
    previous.forEach((v, index) => delta.removes.push({ collection: name, slot: descriptor.slots[index], kind: entityKind(name), id: itemKey(v) ?? undefined,expected:layout.memberships?.get(name)?.get(descriptor.slots[index]) }));
  }
  delta.fieldOrder = Object.keys(after);
  if (object(after.auxiliary)) delta.auxiliaryOrder = Object.keys(after.auxiliary);
  return delta;
}
