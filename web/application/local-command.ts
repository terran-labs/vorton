import type { ReplicaSnapshot, AttemptRecovery } from "./replica-service";
import { RECORD_FIELDS, canonicalJson, parseSyncOperation, type SyncOperation } from "../../shared/sync-contract.ts";

export function supportsLocalCommand(action: string) { return /^(task|goal|idea)\.(create|update|delete)$/.test(action); }

/** Resolve the original durable attempt before interpreting newer form text.
 * A reviewed recovery copy has its own operation and record identities. */
export function recoveredLocalCommand(snapshot: ReplicaSnapshot, action: string, payload: unknown, operationId: string, recovery: AttemptRecovery) {
  const match = /^(task|goal|idea)\.(create|update|delete)$/.exec(action);
  if (!match || !snapshot.ready || !snapshot.state || !payload || typeof payload !== "object" || Array.isArray(payload))
    throw Error("Restore device storage before checking this saved attempt.");
  const input = payload as { id?: unknown; fields?: unknown };
  const original = parseSyncOperation(JSON.parse(String(recovery.original.operation)));
  if (original.operationId !== operationId || original.kind !== match[1] || original.action !== match[2] ||
      original.action !== "create" && input.id !== original.id && input.id !== recovery.identity.id)
    throw Error("This saved attempt belongs to a different action or record.");
  if (recovery.disposition !== "saved")
    throw Error("This attempt was already resolved using server history. Your text remains in this draft. Copy it before discarding the draft if you want to start a new record.");
  const operation = parseSyncOperation(JSON.parse(String(recovery.saved.operation)));
  if (operation.kind !== original.kind || operation.kind !== recovery.saved.kind || operation.id !== recovery.saved.record_id ||
      recovery.identity.generation !== snapshot.state.syncGeneration)
    throw Error("Saved history changed while checking this attempt. Refresh and review before saving; your text remains here.");
  const record = recovery.record && recovery.record.body !== "null" ? JSON.parse(String(recovery.record.body)) as Record<string, unknown> : null;
  if (record && (Array.isArray(record) || record.id !== recovery.identity.id)) throw Error("The reviewed record identity is unavailable. Export local changes before proceeding.");
  const fields = input.fields;
  const differs = (saved: SyncOperation) => !fields || typeof fields !== "object" || Object.entries(fields)
    .some(([key, value]) => canonicalJson(saved.value?.[key]) !== canonicalJson(value));
  const retainedEdits = original.action !== "delete" && (differs(original) || differs(operation));
  const generation = typeof recovery.saved.generation === "string" ? recovery.saved.generation : undefined;
  return { operation, recordId: recovery.identity.id, record, title: String(recovery.saved.title), generation, baselineVersion: undefined,
    savedVersion: typeof recovery.saved.local_version === "number" ? recovery.saved.local_version : undefined,
    retainedEdits, alreadySaved: true, serverAccepted: recovery.saved.status === "accepted" && generation === snapshot.state.syncGeneration };
}

/** Construct a local intent without transport credentials or server-owned
 * metadata in its payload. Updates retain opaque imported record properties. */
export function localCommand(snapshot: ReplicaSnapshot, action: string, payload: unknown, operationId: string, baselineVersion?: number, baselineGeneration?: string | null) {
  const match = /^(task|goal|idea)\.(create|update|delete)$/.exec(action);
  if (!match || !snapshot.ready || !snapshot.state || !payload || typeof payload !== "object" || Array.isArray(payload)) throw Error("Offline editing is not ready for this action.");
  const kind = match[1] as keyof typeof RECORD_FIELDS, mode = match[2] as "create" | "update" | "delete";
  const input = payload as { id?: unknown; fields?: unknown };
  const prior = snapshot.queue.find(row => row.operation_id === operationId);
  if (prior) {
    const operation = parseSyncOperation(JSON.parse(prior.operation));
    if (operation.kind !== kind || operation.action !== mode || mode !== "create" && operation.id !== input.id)
      throw Error("This local attempt belongs to a different action.");
    const retainedEdits = mode !== "delete" && (!input.fields || typeof input.fields !== "object" || Object.entries(input.fields)
      .some(([key, value]) => canonicalJson(operation.value?.[key]) !== canonicalJson(value)));
    const current = snapshot.rows.find(row => row.kind === kind && row.id === operation.id);
    return { operation, recordId: operation.id, record: mode === "delete" || !current || current.body === "null" ? null : JSON.parse(current.body) as Record<string, unknown>,
      title: prior.title, generation: prior.generation ?? undefined, baselineVersion: undefined, savedVersion: prior.local_version ?? undefined, retainedEdits, alreadySaved: true, serverAccepted: prior.status === "accepted" && prior.generation === snapshot.state.syncGeneration };
  }
  // null explicitly identifies a draft lacking history, while callers without
  // a draft baseline remain compatible before the first device adoption.
  if (baselineGeneration === null || Number(snapshot.adoptionCounter ?? 0) > 0 && baselineGeneration === undefined)
    throw Error("This draft has no reviewed server history. Review current records before saving; your text remains saved.");
  if (baselineGeneration !== undefined && baselineGeneration !== snapshot.state.syncGeneration)
    throw Error("Server history changed since this draft began. Review current records before saving. Your text remains saved on this device.");
  const id = mode === "create" ? operationId : input.id;
  if (typeof id !== "string") throw Error("A record identity is required.");
  const row = snapshot.rows.find(row => row.kind === kind && row.id === id);
  const previous = mode !== "create" && row && row.body !== "null" ? JSON.parse(row.body) as Record<string, unknown> : undefined;
  if (mode !== "create" && !previous) throw Error("This record is no longer available on this device.");
  if (baselineVersion !== undefined && previous?.version !== baselineVersion) throw Error("This editor contains an older local version. Review the current record; your text remains saved as a draft.");
  const changes = mode === "delete" ? {} : input.fields;
  if (!changes || typeof changes !== "object" || Array.isArray(changes) ||
    Object.keys(changes).some(key => !(RECORD_FIELDS[kind] as readonly string[]).includes(key))) throw Error("Unexpected record fields.");
  const owner = snapshot.state.settings?.defaultOwner ?? "Owner";
  const common = { title: "", owner, projects: [], tags: [] };
  const defaults = kind === "task" ? { ...common, ideaIds: [], notes: "", goalId: "", dueOn: "", status: "todo", priority: "normal" }
    : kind === "goal" ? { ...common, ideaIds: [], intent: "", successCriteria: "", horizon: "", parentId: "", reviewOn: "", milestones: [], evidence: "", progress: 0, status: "active", priority: "normal" }
    : { ...common, description: "", goalIds: [], status: "inbox", value: "unknown", complexity: "unknown", effort: "unknown", upkeep: "unknown", confidence: "unknown", pull: "unknown", startCondition: "", experiment: "", reviewOn: "", evidence: "" };
  const fields = { ...defaults, ...previous, ...changes } as Record<string, unknown>;
  if (typeof fields.title !== "string" || !fields.title.trim()) throw Error("A title is required before saving locally.");
  const governed = snapshot.state as unknown as { governance?: { tasks?: { requireCompletionEvidence?: boolean; retainCompletedOutcomes?: boolean } }; taskOutcomes?: { taskId: string }[] };
  if (kind === "task") {
    if (mode !== "delete" && fields.status === "done" && previous?.status !== "done" && governed.governance?.tasks?.requireCompletionEvidence &&
      (typeof fields.notes !== "string" || !fields.notes.trim())) throw Error("Record completion evidence in Notes before marking a task done.");
    if (governed.governance?.tasks?.retainCompletedOutcomes && governed.taskOutcomes?.some(outcome => outcome.taskId === id) && (mode === "delete" || fields.status !== "done"))
      throw Error("This completed task has a governed outcome. Keep its history and create a follow-up task.");
  }
  const title = fields.title;
  const now = new Date().toISOString();
  const { history = [], ...priorFields } = previous ?? {};
  const record = mode === "delete" ? null : { ...fields, id, version: Number(previous?.version ?? 0) + 1,
    createdAt: previous?.createdAt ?? now, updatedAt: now, origin: previous?.origin ?? null,
    ...(kind === "idea" ? { original: previous?.original ?? (fields.description || title) } : {}),
    history: [...(Array.isArray(history) ? history : []), ...(previous ? [{ at: previous.updatedAt, version: previous.version, fields: priorFields }] : [])] };
  const value = mode === "create" ? Object.fromEntries(RECORD_FIELDS[kind].map(key => [key, fields[key]])) : changes;
  const operation = parseSyncOperation({ operationId, kind, id, action: mode, expectedRevision: mode === "create" ? 0 : row?.revision ?? 0,
    ...(mode === "delete" ? {} : { value }) });
  return { operation, recordId: operation.id, record, title, generation: snapshot.state.syncGeneration, baselineVersion, savedVersion: record?.version, retainedEdits: false, alreadySaved: false, serverAccepted: false };
}
