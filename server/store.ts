import type { State, GoalFields, TaskFields, IdeaFields, OpportunityFields, LedgerFields, EntityMeta } from "../shared/domain.ts";
import { errorCode } from "./errors.ts";
type EntityFields = (GoalFields | TaskFields | IdeaFields | OpportunityFields | LedgerFields) & { ideaIds?: string[]; goalIds?: string[]; parentId?: string; goalId?: string; status?: string; notes?: string; description?: string };
type StoredEntity = EntityFields & EntityMeta & { origin?: string | null; original?: string };
type EntityKind = "goal" | "task" | "idea" | "opportunity" | "entry";
export type Command = { action: string; requestId?: string; expectedRevision?: number; expectedGeneration?: string; payload?: Record<string, unknown> };
export type RuntimeState = State & { schema: number; requests: { id: string; command: string }[]; ideas: NonNullable<State["ideas"]>; opportunities: NonNullable<State["opportunities"]>; ledger: NonNullable<State["ledger"]>; preferenceHistory: unknown[]; governance?: { tasks?: { retainCompletedOutcomes?: boolean; requireCompletionEvidence?: boolean } }; taskOutcomes?: { id: string; taskId: string; [key: string]: unknown }[]; [key: string]: unknown };
export type CommandPreflight = Pick<RuntimeState, 'profile' | 'revision' | 'syncGeneration' | 'goals' | 'tasks' | 'ideas' | 'opportunities' | 'ledger' | 'recommendations' | 'council' | 'governance' | 'taskOutcomes'>;
type AuxiliaryWorkspace = { revision: number; syncGeneration?: string; auxiliary?: Record<string, unknown> };
type CommandResult = { id?: string; actor?: string; detail?: string; title?: string; version?: number; resultId?: string };
import { readFile, open, lstat } from "node:fs/promises";
import { SqliteReplica, ReplicaFault } from "./sqlite-replica.ts";
import { parseSyncOperation, SYNC_PROTOCOL, canonicalJson } from "../shared/sync-contract.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MutationJournal, attach, journal, appended, bulkDelta } from "./workspace-delta.ts";
import { fieldKind, validateDescriptors } from "./workspace-normalization.ts";
import { coreIdentities, loadCouncil } from "../modules/council/config.ts";
import { publishCouncil } from "./council.ts";
import { importRecommendations } from "./review.ts";
import { validateCompletionOutcomes, recordDomainAudit } from "./domain-governance.ts";
import { Fault, check } from "./errors.ts";
import { safeDirectory, atomicJson } from "./private-files.ts";
export { Fault, check, safeDirectory, atomicJson };

export const roles = Object.freeze(coreIdentities.map(x => x.id));
import { text, choose, fields, labelsInput, ideaFields, ideaInput, legacyIdea, goalFields, goalInput, opportunityInput, entryInput, financePlanInput, taskFields, taskInput, recommendationInput as parseRecommendation } from "./domain-input.ts";
export { text, labelsInput, ideaFields, ideaInput, goalFields, goalInput, opportunityInput, entryInput, financePlanInput, taskFields, taskInput, legacyIdea } from "./domain-input.ts";
const timestamp = () => new Date().toISOString();
export function recommendationInput(input: unknown, allowedRoles: readonly string[] = roles) {
  return parseRecommendation(input, allowedRoles);
}
function initial(profile: string): RuntimeState {
  return {
    schema: 1,
    profile,
    revision: 0,
    goals: [],
    tasks: [],
    ideas: [],
    opportunities: [],
    ledger: [],
    settings: {defaultOwner:'Owner',purpose:''},
    preferenceHistory: [],
    recommendations: [],
    councilSessions: [],
    events: [],
    requests: [],
  };
}
export function validateState(value: unknown, profile: string): RuntimeState {
  const s = value as RuntimeState;
  check(
    s.schema === 1 &&
      s.profile === profile &&
      Number.isInteger(s.revision) &&
      s.revision >= 0,
    "State identity is invalid",
    503,
  );
  for (const key of ["goals", "tasks", "recommendations", "events", "requests"])
    check(Array.isArray(s[key]), "State is invalid", 503);
  check(s.councilSessions === undefined || Array.isArray(s.councilSessions), "Council sessions are invalid", 503);
  // Additive stores preserve older installations without seeding their records.
  for (const key of ['opportunities','ledger','preferenceHistory']) {
    s[key] ??= [];
    check(Array.isArray(s[key]), 'Business records are invalid', 503);
  }
  s.ideas ??= s.opportunities.map(legacyIdea);
  check(Array.isArray(s.ideas), "Ideas are invalid", 503);
  for (const row of s.opportunities) if (!s.ideas.some(i => i.id === row.id)) s.ideas.push(legacyIdea(row));
  s.settings ??= {defaultOwner:'Owner',purpose:''};
  try { validateCompletionOutcomes(s); }
  catch (error) { throw new Fault(503, error instanceof Error ? error.message : String(error)); }
  return s;
}
export class Store {
  root: string;
  allowedProfiles: string[] | null;
  organizationRoots: Record<string, string>;
  beforeCommand: ((profile: string, state: CommandPreflight, command: Command) => unknown | Promise<unknown>) | null;
  constructor(root: string, allowedProfiles: string[] | null = null, organizationRoots: Record<string, string> = {}, { beforeCommand = null }: { beforeCommand?: Store["beforeCommand"] } = {}) {
    this.root = path.resolve(root);
    this.allowedProfiles = allowedProfiles;
    this.organizationRoots = organizationRoots;
    this.beforeCommand = beforeCommand;
  }
  council(profile: string) { return loadCouncil(this.organizationRoots[profile] ?? path.join(this.root, profile), profile); }
  private preflight(state: RuntimeState): CommandPreflight {
    const { profile, revision, syncGeneration, goals, tasks, ideas, opportunities, ledger, recommendations, council, governance, taskOutcomes } = state;
    return structuredClone({ profile, revision, syncGeneration, goals, tasks, ideas, opportunities, ledger, recommendations, council, governance, taskOutcomes });
  }
  async directory(profile: string) {
    check(typeof profile === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(profile) && (!this.allowedProfiles || this.allowedProfiles.includes(profile)), "Unknown installation", 404);
    await safeDirectory(this.root);
    await safeDirectory(path.join(this.root, profile));
    const directory = path.join(this.root, profile, "state");
    await safeDirectory(directory);
    return directory;
  }
  async read(profile: string, { includeSyncCursor = false } = {}): Promise<RuntimeState> {
    const directory = await this.directory(profile);
    const database = await this.openDatabase(directory);
    let state, legacy, syncGeneration, syncCursor;
    try {
      // First-use identity creation precedes the read snapshot, so two readers
      // never attempt to upgrade deferred read locks into competing writers.
      database.generation(profile);
      ({ state, legacy, syncGeneration, syncCursor } = database.readTransaction(() => ({ state: database.snapshot(profile),
        legacy: database.legacyExport(profile), syncGeneration: database.generation(profile), syncCursor: includeSyncCursor ? database.head(profile) : undefined })));
      check(state || !database.hasRecords(profile), 'Record-only replica requires explicit workspace import', 503);
    } finally { database.close(); }
    if (state && legacy) {
      const source = await this.legacySource(directory);
      check(source === legacy.body, "Legacy state changed after SQLite migration. Reconcile the retained export before saving.", 503);
    }
    check(!includeSyncCursor || state, "Prepare the replica before reading its download boundary", 503);
    if (state) {
      delete state.syncCursor;
      return { ...validateState(state, profile), council: await this.council(profile), syncGeneration,
        ...(includeSyncCursor ? { syncCursor } : {}) };
    }
    // Legacy JSON remains untouched as the source export. Import on first
    // publication inside SQLite, never mutate during a read.
    const filename = path.join(directory, "core.json");
    try {
      check(
        !(await lstat(filename)).isSymbolicLink(),
        "State file must not be a symlink",
        503,
      );
      return { ...validateState(
        JSON.parse(await readFile(filename, "utf8")),
        profile,
      ), council: await this.council(profile), syncGeneration };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { ...initial(profile), council: await this.council(profile), syncGeneration };
      if (error instanceof SyntaxError)
        throw new Fault(
          503,
          "State is unreadable. Restore a verified backup; do not reset it.",
        );
      throw error;
    }
  }
  async replicaState(profile: string) {
    return this.withWorkspace(profile, async directory => {
      const source = await this.legacySource(directory), baseline = await this.read(profile);
      check(source === await this.legacySource(directory), "Legacy state changed while preparing its replica. Retry with the previous writer stopped.", 503);
      const database = await this.openDatabase(directory);
      try { database.initializeSnapshot(profile, baseline, source); }
      finally { database.close(); }
      return this.read(profile, { includeSyncCursor: true });
    });
  }
  async legacySource(directory: string) {
    const filename = path.join(directory, "core.json");
    try {
      check(!(await lstat(filename)).isSymbolicLink(), "State file must not be a symlink", 503);
      return await readFile(filename, "utf8");
    } catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
  }
  async openDatabase(directory: string) {
    const filename = path.join(directory, "core.sqlite3");
    // Establish private permissions and reject links before SQLite opens it.
    // The enclosing state directory is already validated by directory().
    let file;
    try { file = await open(filename, "wx", 0o600); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    await file?.close();
    const info = await lstat(filename);
    check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0,
      "SQLite state must be a private regular file", 503);
    return new SqliteReplica(filename);
  }
  async restoreSnapshot(profile: string, state: unknown) {
    const directory = await this.directory(profile);
    const database = await this.openDatabase(directory);
    try {
      check(database.initializeSnapshot(profile, validateState(structuredClone(state), profile)), "Restore requires an empty SQLite workspace", 409);
    } finally { database.close(); }
  }
  // Only a managed restore/cutover caller may invoke this trusted maintenance
  // API. The network command dispatcher has no history-adoption action.
  async adoptHistory(profile: string, input: Parameters<SqliteReplica["adoptHistory"]>[1]) {
    return this.withWorkspace(profile, async directory => {
      validateState(await this.read(profile), profile);
      const database = await this.openDatabase(directory);
      try { return database.adoptHistory(profile, input); }
      finally { database.close(); }
    });
  }
  async withWorkspace<T>(profile: string, change: (directory: string) => Promise<T>): Promise<T> {
    const directory = await this.directory(profile);
    try {
      return await change(directory);
    } catch (error) {
      if (error instanceof ReplicaFault) throw new Fault(error.status, error instanceof Error ? error.message : String(error), error.code);
      throw error;
    }
  }
  async readAuxiliary(profile: string, key: string): Promise<{ revision: number; syncGeneration: string; auxiliary?: Record<string, unknown> }> {
    const database = await this.openDatabase(await this.directory(profile));
    try {
      check(database.format === 2, 'Explicit workspace storage migration is required', 503, 'storage-migration-required');
      database.generation(profile);
      const result = database.readTransaction(() => {
        validateDescriptors(database.db,profile);
        const root = database.db.prepare('SELECT revision FROM workspace_roots WHERE scope=?').get(profile);
        if (!root) return undefined;
        const field = database.db.prepare("SELECT storage_kind,value_json FROM workspace_fields WHERE scope=? AND name='auxiliary'").get(profile);
        const entry = database.db.prepare('SELECT value_json FROM workspace_auxiliary WHERE scope=? AND name=?').get(profile, key);
        const auxiliary: Record<string, unknown> = {};
        if (field && field.storage_kind !== 'auxiliary') check(field.value_json === 'null', 'Auxiliary state is invalid', 503);
        if (entry) Object.defineProperty(auxiliary, key, { value: JSON.parse(String(entry.value_json)), enumerable: true });
        return { revision: Number(root.revision), syncGeneration: database.generation(profile), auxiliary, legacy: database.legacyExport(profile) };
      });
      if (!result) return await this.read(profile) as RuntimeState & { syncGeneration: string };
      if (result.legacy) check(await this.legacySource(await this.directory(profile)) === result.legacy.body, 'Legacy state changed after SQLite migration', 503);
      return result;
    } finally { database.close(); }
  }
  private async prepare(profile: string, excluded: ReadonlySet<string>, auxiliaryKey?: string) {
    const directory = await this.directory(profile);
    const database = await this.openDatabase(directory);
    try {
      database.generation(profile);
      if (!database.readWorkspace(profile, excluded, auxiliaryKey)) {
        const source = await this.legacySource(directory);
        const baseline = await this.read(profile);
        check(source === await this.legacySource(directory), 'Legacy state changed while preparing its replica. Retry with the previous writer stopped.', 503);
        database.initializeSnapshot(profile, baseline, source);
      }
      const prepared = database.readTransaction(() => ({ ...database.readWorkspace(profile, excluded, auxiliaryKey)!, generation: database.generation(profile), legacy: database.legacyExport(profile) }));
      if (prepared.legacy) check(await this.legacySource(directory) === prepared.legacy.body, "Legacy state changed after SQLite migration. Reconcile the retained export before saving.", 503);
      const rawBefore = excluded.size === 0 ? structuredClone(prepared.state) : undefined;
      const priorCouncil = JSON.stringify(prepared.state.council), priorGeneration = prepared.state.syncGeneration;
      const defaulted = ['settings','opportunities','ledger','preferenceHistory','ideas'].filter(key => prepared.state[key] == null);
      const originalIdeas = Array.isArray(prepared.state.ideas) ? prepared.state.ideas.length : 0;
      const state = validateState(prepared.state, profile);
      state.council = await this.council(profile); state.syncGeneration = prepared.generation;
      delete state.syncCursor;
      const j = new MutationJournal(prepared.layout);
      attach(state, j);
      for (const idea of state.ideas.slice(originalIdeas)) j.append('ideas', idea);
      for (const key of defaulted) j.field(key);
      for (const key of Object.keys(state)) if (!excluded.has(key) && prepared.layout.fields.get(key)?.kind !== fieldKind(key, state[key])) j.field(key);
      if (prepared.layout.fields.has('syncCursor')) j.removeField('syncCursor');
      // Council is a live admission dependency. Its small current value is
      // published with successful commands, as in the previous runtime.
      if (priorCouncil !== JSON.stringify(state.council)) j.field('council');
      if (priorGeneration !== state.syncGeneration) j.field('syncGeneration');
      return { state, layout: prepared.layout, j, rawBefore };
    } finally { database.close(); }
  }
  /** Explicit whole-view compatibility API for trusted fixture/maintenance
   * callers. Its reducer executes once, outside the SQLite writer lock. */
  async transactBulk(profile: string, command: Command, change: (state: RuntimeState) => CommandResult | Promise<CommandResult>) {
    return this.transactPrepared(profile, command, change, 'bulk');
  }
  async transact(profile: string, command: Command, change: (state: RuntimeState) => CommandResult | Promise<CommandResult>, preparation: 'bulk' | 'domain' = 'bulk') {
    // Keep the public transaction interception boundary used by callers that
    // reconcile lost responses. Only command() selects the domain journal.
    return preparation === 'domain' ? this.transactPrepared(profile, command, change, 'domain') : this.transactBulk(profile, command, change);
  }
  async transactAuxiliary(profile: string, command: Command, key: string, change: (state: AuxiliaryWorkspace) => CommandResult | Promise<CommandResult>) {
    return this.transactPrepared(profile, command, async state => {
      const workspace: AuxiliaryWorkspace = { revision: state.revision, syncGeneration: state.syncGeneration, auxiliary: state.auxiliary as Record<string, unknown> | undefined };
      const result = await change(workspace); state.auxiliary = workspace.auxiliary;
      return result;
    }, 'auxiliary', key);
  }
  private async commandReplay(profile: string, directory: string, command: Command, generation: string, serialized: string, checkRevision: boolean) {
    const database = await this.openDatabase(directory);
    try {
      const prior = database.admitCommand(profile, command.requestId!, generation, checkRevision ? command.expectedRevision : undefined);
      if (!prior) return false;
      let same = prior.command === serialized;
      if (!same) { try { same = canonicalJson(JSON.parse(prior.command)) === serialized; } catch {} }
      check(same, 'Request identity was reused with different contents', 409);
      return true;
    } finally { database.close(); }
  }
  private async transactPrepared(profile: string, command: Command, change: (state: RuntimeState) => CommandResult | Promise<CommandResult>, mode: 'bulk' | 'domain' | 'auxiliary', key?: string) {
    return this.withWorkspace(profile, async directory => {
      check(command && typeof command.requestId === 'string' && /^[a-f0-9-]{36}$/.test(command.requestId), 'A request identity is required');
      const excluded = mode === 'bulk' ? new Set<string>() : new Set(['requests','events','strategicAudit','preferenceHistory', ...(mode === 'domain' ? ['auxiliary'] : [])]);
      const { state, layout, j, rawBefore } = await this.prepare(profile, excluded, mode === 'auxiliary' ? key : undefined);
      const serialized = canonicalJson(command), generation = state.syncGeneration!;
      check(command.expectedGeneration === undefined || command.expectedGeneration === generation, 'The server history changed. Reconcile saved work before restarting synchronization.', 409, 'history-changed');
      // Durable identity precedes both revision and current dependencies.
      if (await this.commandReplay(profile, directory, command, generation, serialized, true)) return this.read(profile, { includeSyncCursor: true });
      check(command.expectedRevision === state.revision, 'This view is out of date. Refresh before saving.', 409);
      const before = mode === 'bulk' ? rawBefore : undefined;
      try {
        await this.beforeCommand?.(profile, this.preflight(state), command);
        if (await this.commandReplay(profile, directory, command, generation, serialized, true)) return this.read(profile, { includeSyncCursor: true });
        const result = await change(state);
        if (mode === 'auxiliary') { check(typeof key === 'string', 'Missing auxiliary key', 500); j.aux(key); }
        state.revision++;
        const event = { id: randomUUID(), at: timestamp(), action: command.action, subjectId: result?.id ?? '', actor: result?.actor ?? 'owner', revision: state.revision, detail: result?.detail ?? result?.title ?? '' };
        state.events.push(event); appended(state, 'events', event);
        const request = { id: command.requestId!, command: serialized };
        state.requests.push(request); appended(state, 'requests', request);
        check(JSON.stringify(state.council) === JSON.stringify(await this.council(profile)), 'Council configuration changed during publication. Refresh before saving.', 409);
        validateState(state, profile);
        const delta = mode === 'bulk' ? bulkDelta(before, state, layout) : j.prepare(state);
        const writer = await this.openDatabase(directory);
        try { writer.commitCommand(profile, { expectedRevision: command.expectedRevision!, generation, requestId: command.requestId!, command: serialized }, delta); }
        finally { writer.close(); }
        return this.read(profile, { includeSyncCursor: true });
      } catch (error) {
        // A durable decision that appeared during preparation wins over a
        // newly failed dependency. Generation and identity still run first.
        if (await this.commandReplay(profile, directory, command, generation, serialized, false)) return this.read(profile, { includeSyncCursor: true });
        throw error;
      }
    });
  }
  async changes(profile: string, after = 0, limit = 200, boundary: { head?: number; generation?: string } = {}) {
    return this.withWorkspace(profile, async directory => {
      const state = await this.read(profile);
      const database = await this.openDatabase(directory);
      try {
        database.initializeSnapshot(profile, state, await this.legacySource(directory));
        return { protocol: SYNC_PROTOCOL, ...database.feed(profile, after, limit, boundary) };
      } finally { database.close(); }
    });
  }
  async sync(profile: string, input: unknown, { generation }: { generation?: string } = {}) {
    let operation;
    try { operation = parseSyncOperation(input); }
    catch { throw new Fault(400, "Invalid synchronization operation"); }
    return this.withWorkspace(profile, async directory => {
      // A root CAS miss may retry pure domain preparation. Evidence callbacks
      // and arbitrary reducers never run again automatically.
      let admittedGeneration = generation;
      for (let attempt = 0; attempt < 64; attempt++) {
        const { state, j } = await this.prepare(profile, new Set(['requests','events','strategicAudit','preferenceHistory','auxiliary']));
        const database = await this.openDatabase(directory);
        const currentGeneration = state.syncGeneration!;
        try {
          admittedGeneration ??= currentGeneration;
          check(admittedGeneration === currentGeneration, 'The server history changed. Reconcile saved work before restarting synchronization.', 409, 'history-changed');
          const priorReceipt = database.operationReceipt(profile, operation, currentGeneration);
          if (priorReceipt) return { protocol: SYNC_PROTOCOL, generation: currentGeneration, ...priorReceipt };
          const current = database.record(profile, operation.kind, operation.id);
          const applicable = (current?.revision ?? 0) === operation.expectedRevision && (operation.action === 'create' ? !current : current && !current.deleted);
          if (!applicable) return { protocol: SYNC_PROTOCOL, generation: currentGeneration, ...database.commitSync(profile, operation, undefined, state.revision, currentGeneration) };
          if (this.beforeCommand) {
            const previous = state[`${operation.kind}s`].find(record => record.id === operation.id);
            await this.beforeCommand(profile, this.preflight(state), { action: `${operation.kind}.${operation.action}`, payload: { id: operation.id, fields: { ...previous, ...operation.value } } });
            const replay = database.operationReceipt(profile, operation, currentGeneration);
            if (replay) return { protocol: SYNC_PROTOCOL, generation: currentGeneration, ...replay };
          }
          const allowed = operation.kind === 'idea' ? ideaFields : operation.kind === 'goal' ? goalFields : taskFields;
          const previous = (state[`${operation.kind}s`] as StoredEntity[]).find(record => record.id === operation.id);
          const editable = previous ? Object.fromEntries(allowed.filter(key => Object.hasOwn(previous, key)).map(key => [key, (previous as unknown as Record<string, unknown>)[key]])) : {};
          const result = applyCommand(state, { requestId: operation.operationId, action: `${operation.kind}.${operation.action}`, payload: { id: operation.id, fields: operation.action === 'update' ? { ...editable, ...operation.value } : operation.value } }, { creationId: operation.action === 'create' ? operation.id : null });
          const expectedRevision = state.revision;
          state.revision++;
          const event = { id: operation.operationId, at: timestamp(), action: `${operation.kind}.${operation.action}`, subjectId: operation.id, actor: 'owner', revision: state.revision, detail: result?.title ?? 'Deleted record' };
          state.events.push(event); appended(state, 'events', event);
          validateState(state, profile);
          try {
            return { protocol: SYNC_PROTOCOL, generation: currentGeneration, ...database.commitSync(profile, operation, j.prepare(state), expectedRevision, currentGeneration) };
          } catch (error) {
            if (error instanceof ReplicaFault && error.code === 'workspace-cas' && !this.beforeCommand && attempt < 63) continue;
            throw error;
          }
        } catch (error) {
          const replay = database.operationReceipt(profile, operation, admittedGeneration ?? currentGeneration);
          if (replay) return { protocol: SYNC_PROTOCOL, generation: currentGeneration, ...replay };
          throw error;
        } finally { database.close(); }
      }
      throw new Fault(409, 'Workspace changed during preparation. Retry this saved operation.', 'workspace-cas');
    });
  }
  async command(profile: string, command: Command) {
    return this.transact(profile, command, state => applyCommand(state, command), 'domain');
  }
}
function relations(state: RuntimeState, data: EntityFields, kind: string, id = "") {
  for (const ideaId of data.ideaIds ?? []) check(state.ideas?.some(i => i.id === ideaId), "Linked idea does not belong to this installation");
  for (const linked of data.goalIds ?? []) check(state.goals.some(g => g.id === linked), "Linked goal does not belong to this installation");
  const goalId = kind === "goal" ? data.parentId : data.goalId;
  if (!goalId) return;
  check(
    state.goals.some((g) => g.id === goalId),
    "Linked goal does not belong to this installation",
  );
  if (kind === "goal") {
    const seen = new Set([id]);
    let current: string | undefined = goalId;
    while (current) {
      check(!seen.has(current), "Goal hierarchy would contain a cycle");
      seen.add(current);
      current = state.goals.find((g) => g.id === current)?.parentId;
    }
  }
}
function saveEntity(state: RuntimeState, kind: EntityKind, data: EntityFields, id: string, origin: string | null = null, creationId: string | null = null) {
  const collection = state[{goal:'goals',task:'tasks',idea:'ideas',opportunity:'opportunities',entry:'ledger'}[kind]] as StoredEntity[];
  const existing = id ? collection.find((g) => g.id === id) : null;
  if (id) check(existing, "Item not found in this installation", 404);
  if (!id && creationId) check(!collection.some(record => record.id === creationId), "Record identity already exists", 409);
  const taskPolicy = kind === "task" ? state.governance?.tasks : undefined;
  if (taskPolicy?.retainCompletedOutcomes && existing && data.status !== "done")
    check(!state.taskOutcomes?.some(outcome => outcome.taskId === id), "This completed task has a governed outcome. Create a follow-up task to preserve its history.", 409);
  const completing = kind === "task" && data.status === "done" && existing?.status !== "done";
  if (completing && taskPolicy?.requireCompletionEvidence)
    check(data.notes?.trim(), "Record completion evidence in Notes before marking a task done.");
  relations(state, data, kind, id);
  const entry = {
    ...existing,
    ...data,
    ...(kind === "idea" ? {original: existing?.original ?? (data.description || data.title)} : {}),
    id: id || creationId || randomUUID(),
    version: (existing?.version ?? 0) + 1,
    createdAt: existing?.createdAt ?? timestamp(),
    updatedAt: timestamp(),
    origin: existing?.origin ?? origin,
    history: [
      ...(existing?.history ?? []),
      ...(existing
        ? [
            {
              at: existing.updatedAt,
              version: existing.version,
              fields: Object.fromEntries(
                Object.entries(existing).filter(
                  ([k]) => !["history"].includes(k),
                ),
              ),
            },
          ]
        : []),
    ],
  };
  const collectionName = {goal:'goals',task:'tasks',idea:'ideas',opportunity:'opportunities',entry:'ledger'}[kind];
  if (existing) { const index = collection.indexOf(existing); collection[index] = entry; journal(state)?.replace(collectionName, index); }
  else { collection.push(entry); appended(state, collectionName, entry); }
  if (completing && taskPolicy?.retainCompletedOutcomes) {
    (state.taskOutcomes ??= []).push({ id: randomUUID(), taskId: entry.id, at: entry.updatedAt,
      type: "owner_reported_completion", actualResult: entry.notes,
      evidence: { kind: "sqlite-record", workspaceRevision: state.revision + 1, record: structuredClone(entry) },
      authority: "Owner marked task complete; no external authority granted." });
    appended(state, 'taskOutcomes', state.taskOutcomes!.at(-1));
  }
  return entry;
}
function saveIdea(state: RuntimeState, data: IdeaFields, id: string, origin: string | null = null, creationId: string | null = null) {
  const prior = id ? state.ideas.find(i => i.id === id) : null;
  check(data.status !== "graduated" || prior?.status === "graduated", "Use Graduate to goal to commit an idea");
  check(prior?.status !== "graduated" || data.status === "graduated", "Graduated ideas retain their goal and commitment history");
  check(data.status !== "graduated" || JSON.stringify(data.goalIds) === JSON.stringify(prior!.goalIds), "Graduation links must be preserved");
  return saveEntity(state, "idea", data, id, origin, creationId);
}
export function applyCommand(state: RuntimeState, command: Command, { creationId = null }: { creationId?: string | null } = {}): CommandResult {
  const proposal = command.action === "recommendation.resolve"
    ? structuredClone(state.recommendations.find(item => item.id === command.payload?.id)) : undefined;
  const result = reduceCommand(state, command, { creationId });
  recordDomainAudit(state, command, result, proposal);
  return result;
}
function reduceCommand(state: RuntimeState, command: Command, { creationId = null }: { creationId?: string | null } = {}): CommandResult {
  const { action, payload = {} } = command;
  if (action === "council.publish") return publishCouncil(state, payload);
  if (action === "recommendations.import") return importRecommendations(state, payload);
  state.ideas ??= (state.opportunities ?? []).map(legacyIdea);
  if (["task.delete", "goal.delete", "idea.delete"].includes(action)) {
    fields(payload, ["id", "fields"]);
    const kind = action.split(".")[0], id = text(payload.id, "record ID", 200);
    const collection = state[`${kind}s`] as StoredEntity[], existing = collection.find(record => record.id === id);
    check(existing, "Item not found in this installation", 404);
    if (kind === "task" && state.governance?.tasks?.retainCompletedOutcomes)
      check(!state.taskOutcomes?.some(outcome => outcome.taskId === id), "This completed task has a governed outcome. Keep its history and create a follow-up task.", 409);
    if (kind === "goal") {
      check(!state.tasks.some(task => task.goalId === id) && !state.goals.some(goal => goal.parentId === id) &&
        !state.ideas.some(idea => idea.goalIds?.includes(id)), "Remove links to this goal before deleting it", 409);
    } else if (kind === "idea") {
      check(existing.status !== "graduated", "Graduated ideas retain their goal and commitment history", 409);
      check(![...state.goals, ...state.tasks].some(record => record.ideaIds?.includes(id)), "Remove links to this idea before deleting it", 409);
    }
    check(!state.recommendations.some(item => item.targetId === id && ["pending", "deferred"].includes(item.status)),
      "Resolve pending recommendations before deleting this record", 409);
    const index = collection.indexOf(existing);
    journal(state)?.remove(`${kind}s`, index, id);
    collection.splice(index, 1);
    return existing;
  }
  if (["idea.create", "idea.update"].includes(action)) {
    const id = action.endsWith("update") ? text(payload.id, "idea ID", 80) : "";
    return saveIdea(state, ideaInput(payload.fields, id ? state.ideas.find(idea => idea.id === id) : null), id, null, creationId);
  }
  if (action === "idea.graduate") return graduateIdea(state, payload);
  if (['opportunity.create','opportunity.update','entry.create','entry.update'].includes(action)) {
    const kind=action.split('.')[0] as "opportunity" | "entry";
    const saved = saveEntity(state,kind,kind==='opportunity'?opportunityInput(payload.fields):entryInput(payload.fields),action.endsWith('update')?text(payload.id,'Record ID',80):'');
    if (kind === 'opportunity' && !state.ideas.some(i => i.id === saved.id)) { state.ideas.push(legacyIdea(saved as OpportunityFields & EntityMeta)); appended(state, 'ideas', state.ideas.at(-1)); }
    return saved;
  }
  if (action === 'settings.update') {
    fields(payload,['defaultOwner','purpose']);
    const next={defaultOwner:text(payload.defaultOwner,'default owner',120),purpose:text(payload.purpose,'purpose',1000,false)};
    (state.preferenceHistory??=[]).push({kind:'settings',revision:state.revision+1,at:timestamp(),before:state.settings??null,after:next});
    state.settings=next;
    appended(state, 'preferenceHistory', state.preferenceHistory.at(-1)); journal(state)?.field('settings');
    return {detail:'Updated workspace preferences'};
  }
  if (action === 'finance.plan.update') {
    const next=financePlanInput(payload);
    (state.preferenceHistory??=[]).push({kind:'financePlan',revision:state.revision+1,at:timestamp(),before:state.financePlan??null,after:next});
    state.financePlan=next;
    appended(state, 'preferenceHistory', state.preferenceHistory.at(-1)); journal(state)?.field('financePlan');
    return {detail:'Updated finance assumptions'};
  }
  if (action === "goal.create" || action === "goal.update")
    return saveEntity(
      state,
      "goal",
      goalInput(payload.fields),
      action.endsWith("update") ? text(payload.id, "goal ID", 80) : "",
      null, creationId,
    );
  if (action === "task.create" || action === "task.update") {
    const id = action.endsWith("update") ? text(payload.id, "task ID", 80) : "";
    return saveEntity(
      state,
      "task",
      taskInput(payload.fields, id ? state.tasks.find(task => task.id === id) : null),
      id,
      null, creationId,
    );
  }
  if (action === "recommendation.create") {
    const data = recommendationInput(payload, state.council?.identities.map(x => x.id) ?? roles);
    relations(
      state,
      data.proposal,
      data.kind === "idea-graduate" || data.kind.startsWith("goal") ? "goal" : data.kind.startsWith("idea") ? "idea" : "task",
      data.targetId,
    );
    if (data.kind.endsWith("-review") || data.kind === "idea-graduate") {
      const target = (
        data.kind.startsWith("idea") ? state.ideas : data.kind.startsWith("goal") ? state.goals : state.tasks
      ).find((i) => i.id === data.targetId);
      check(
        target && target.version === data.targetVersion,
        "Recommendation target is stale or outside this installation",
        409,
      );
    }
    const recommendation = {
      ...data,
      id: randomUUID(),
      status: "pending",
      createdAt: timestamp(),
    };
    state.recommendations.push(recommendation);
    appended(state, 'recommendations', recommendation);
    return recommendation;
  }
  if (action === "recommendation.resolve") {
    const item = state.recommendations.find((r) => r.id === payload.id);
    check(item, "Recommendation not found", 404);
    check(
      ["pending", "deferred"].includes(item.status),
      "Recommendation already resolved",
      409,
    );
    choose(payload.decision, ["accepted", "rejected", "deferred"], "decision");
    if (payload.decision === "accepted") {
      if (item.kind === "idea-graduate") {
        const saved = graduateIdea(state, {id: item.targetId, targetVersion: item.targetVersion, fields: payload.fields ?? item.proposal}, item.id);
        item.resultId = saved.id;
      } else {
      const kind = item.kind.startsWith("idea") ? "idea" : item.kind.startsWith("goal") ? "goal" : "task";
      const collection = kind === "idea" ? state.ideas : kind === "goal" ? state.goals : state.tasks;
      if (item.kind.endsWith("-review"))
        check(
          collection.find((t) => t.id === item.targetId)?.version ===
            item.targetVersion,
          "Target changed since this recommendation. Request a fresh review.",
          409,
        );
      const data =
        kind === "idea" ? ideaInput(payload.fields ?? item.proposal) : kind === "goal"
          ? goalInput(payload.fields ?? item.proposal)
          : taskInput(payload.fields ?? item.proposal);
      const targetId = item.kind.endsWith("-review") ? item.targetId : "";
      const saved = kind === "idea" ? saveIdea(state, data as IdeaFields, targetId, item.id) : saveEntity(state, kind, data, targetId, item.id);
      item.resultId = saved.id;
      }
    }
    item.status = payload.decision as string;
    (item as typeof item & { resolvedAt: string }).resolvedAt = timestamp();
    item.ownerNote = text(payload.note ?? "", "note", 4000, false);
    journal(state)?.replace('recommendations', state.recommendations.indexOf(item));
    return item;
  }
  throw new Fault(400, "Unknown command");
}

function graduateIdea(state: RuntimeState, payload: Record<string, unknown>, origin: string | null = null) {
  const idea = state.ideas.find(i => i.id === payload.id);
  check(idea && idea.version === payload.targetVersion, "Idea changed or is outside this installation. Refresh before graduating.", 409);
  check(idea.status !== "graduated", "Idea has already graduated", 409);
  check(idea.status !== "archived", "Restore the archived idea before graduating", 409);
  let goal;
  if (payload.goalId) {
    goal = state.goals.find(g => g.id === payload.goalId);
    check(goal, "Linked goal does not belong to this installation");
    const {id, version, createdAt, updatedAt, history, origin: priorOrigin, ...data} = goal as typeof goal & { origin?: string | null };
    goal = saveEntity(state, "goal", goalInput({...data, ideaIds: [...new Set([...(goal.ideaIds ?? []), idea.id])]}), goal.id);
  } else {
    const proposed = payload.fields as Partial<GoalFields> | undefined;
    const data = goalInput({...proposed, projects: proposed?.projects ?? idea.projects, tags: proposed?.tags ?? idea.tags,
      ideaIds: [...new Set([...(proposed?.ideaIds ?? []), idea.id])]});
    check(data.successCriteria.trim(), "Define success before graduating an idea");
    goal = saveEntity(state, "goal", data, "", origin);
  }
  const data = Object.fromEntries(ideaFields.map(key => [key, idea[key]]));
  saveEntity(state, "idea", ideaInput({...data, status: "graduated", goalIds: [...new Set([...idea.goalIds, goal.id])]}), idea.id, origin);
  return goal;
}
