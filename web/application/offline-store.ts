export type OfflineVariant = "private" | "portable";
export type OfflineIdentity = { installationId: string; variant: OfflineVariant };
export type OfflineScope = OfflineIdentity & { readEpoch: number; draftEpoch: number };
export type OfflineResult<T> = { ok: true; value: T } | { ok: false; reason: "unavailable" | "quota" | "obsolete" | "invalid" };
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type SavedAdmission = OfflineIdentity & { schema: 1; profiles: string[]; verifiedAt: number; lastRoute?: string };
export type ReadKey = OfflineIdentity & { profile: string; schema: number; kind: "workspace" | "dashboard-manifest" | "dashboard-view" | "dashboard-part"; id: string };
export type SavedModel<T> = { key: ReadKey; verifiedAt: number; value: T };
export type OfflineReadTicket = { key: ReadKey; readEpoch: number; version: number };
export type OfflineAdmissionTicket = { variant: OfflineVariant; version: number };
export type DraftKey = { profile: string; schema: 1; kind: "forge-capture-v1" | "idea-editor-v1" | "goal-editor-v1" | "task-editor-v1"; targetId: string };
export type SavedDraft = {
  key: DraftKey; fields: Record<string, JSONValue>; savedAt: number;
  baseline?: { revision?: number; version?: number; syncGeneration?: string; sourceDigest?: string; relations?: Record<string, string[]> };
};
export type OfflineStoreChange = OfflineScope & { contract: "vorton.offline-store.v1"; type: "READS_CLEARED" | "FORGOTTEN" };

const DB_NAME = "vorton-offline-v1";
const CHANNEL = "vorton:offline-store";
const READS = "readModels", DRAFTS = "drafts";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const profilePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
type Epoch = { readEpoch: number; draftEpoch: number; lastSavedAt: number };
const emptyEpoch = (): Epoch => ({ readEpoch: 0, draftEpoch: 0, lastSavedAt: 0 });
const ok = <T,>(value: T): OfflineResult<T> => ({ ok: true, value });
const failed = (reason: "unavailable" | "quota" | "obsolete" | "invalid"): OfflineResult<never> => ({ ok: false, reason });
const storageFailure = (error: unknown) => failed(error instanceof DOMException && error.name === "QuotaExceededError" ? "quota" : "unavailable");
const identityValid = (value: OfflineIdentity) => Boolean(value && uuid.test(value.installationId) && ["private", "portable"].includes(value.variant));
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
const scopeValid = (value: OfflineScope) => identityValid(value) && count(value.readEpoch) && count(value.draftEpoch);
const epochValid = (value: Epoch) => Boolean(value && count(value.readEpoch) && count(value.draftEpoch) && count(value.lastSavedAt));
const epochKey = (identity: OfflineIdentity) => ["epoch", identity.variant, identity.installationId];
const admissionKey = (variant: OfflineVariant) => ["admission", variant];
const admissionVersionKey = (variant: OfflineVariant) => ["admissionVersion", variant];
const modelKey = (key: ReadKey) => ["model", key.variant, key.installationId, key.profile, key.schema, key.kind, key.id];
const draftKey = (scope: OfflineScope, key: DraftKey) => ["draft", scope.variant, scope.installationId, key.profile, key.schema, key.kind, key.targetId];
const draftValid = (key: DraftKey) => Boolean(key && profilePattern.test(key.profile) && key.schema === 1 && ["forge-capture-v1", "idea-editor-v1", "goal-editor-v1", "task-editor-v1"].includes(key.kind) && typeof key.targetId === "string" && key.targetId.length > 0 && key.targetId.length <= 256);
const readKeyValid = (scope: OfflineScope, key: ReadKey) => Boolean(scopeValid(scope) && key && identityValid(key) && key.installationId === scope.installationId && key.variant === scope.variant && profilePattern.test(key.profile) && count(key.schema) && key.schema > 0 && ["workspace", "dashboard-manifest", "dashboard-view", "dashboard-part"].includes(key.kind) && typeof key.id === "string" && key.id.length > 0 && key.id.length <= 1024);
const admissionValid = (value: SavedAdmission) => Boolean(value && identityValid(value) && value.schema === 1 && count(value.verifiedAt) && Array.isArray(value.profiles) && value.profiles.every(profile => typeof profile === "string" && profilePattern.test(profile)) && persistable(value) && (value.lastRoute === undefined || (typeof value.lastRoute === "string" && value.lastRoute.startsWith("/") && !value.lastRoute.startsWith("//") && value.lastRoute.length <= 2048)));
const sameKey = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function draftEnvelopeValid(draft: Omit<SavedDraft, "savedAt">) {
  const baseline = draft?.baseline;
  return Boolean(draft && draftValid(draft.key) && draft.fields && typeof draft.fields === "object" && !Array.isArray(draft.fields) && persistable(draft) && (baseline === undefined || (baseline !== null && typeof baseline === "object" && !Array.isArray(baseline) && (baseline.revision === undefined || Number.isFinite(baseline.revision)) && (baseline.version === undefined || count(baseline.version)) && (baseline.syncGeneration === undefined || (typeof baseline.syncGeneration === "string" && baseline.syncGeneration.length > 0 && baseline.syncGeneration.length <= 200)) && (baseline.sourceDigest === undefined || typeof baseline.sourceDigest === "string") && (baseline.relations === undefined || (typeof baseline.relations === "object" && baseline.relations !== null && !Array.isArray(baseline.relations) && Object.values(baseline.relations).every(ids => Array.isArray(ids) && ids.every(id => typeof id === "string")))))));
}

// Accept explicit model/form values, not Request/Response instances, functions,
// credentials. There is no command queue API. Uint8Array preserves evidence bytes.
function persistable(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 64 || ancestors.has(value)) return false;
  if (value instanceof Uint8Array) return value.byteLength <= 4_000_000;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = Object.entries(value).every(([key, entry]) => !["token", "sessiontoken", "x-vorton-session"].includes(key.toLowerCase()) && persistable(entry, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

let connection: Promise<IDBDatabase | undefined> | undefined;
function open(): Promise<IDBDatabase | undefined> {
  if (connection) return connection;
  connection = new Promise<IDBDatabase | undefined>(resolve => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB_NAME, 1); } catch { resolve(undefined); return; }
    let settled = false;
    const finish = (db?: IDBDatabase) => { if (!settled) { settled = true; clearTimeout(timer); resolve(db); } else db?.close(); };
    const timer = setTimeout(() => finish(), 1500);
    request.onupgradeneeded = () => { for (const name of [READS, DRAFTS]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); };
    request.onerror = () => finish();
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      finish(db);
    };
  }).then(db => { if (!db) connection = undefined; return db; });
  return connection;
}

// All checks and writes stay in one IDB transaction. Clearing advances durable
// epochs in that same transaction, fencing late saves even in another tab.
async function transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, result: (value: OfflineResult<T>) => void) => void): Promise<OfflineResult<T>> {
  const db = await open();
  if (!db) return failed("unavailable");
  return new Promise(resolve => {
    let tx: IDBTransaction, result: OfflineResult<T> = failed("unavailable");
    try { tx = db.transaction(stores, mode); } catch { connection = undefined; resolve(result); return; }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => resolve(tx.error ? storageFailure(tx.error) : result.ok ? failed("unavailable") : result);
    try { run(tx, value => { result = value; }); } catch (error) { result = storageFailure(error); tx.abort(); }
  });
}
function withScope<T>(scope: OfflineScope, area: "reads" | "drafts", mode: IDBTransactionMode, run: (tx: IDBTransaction, epoch: Epoch, result: (value: OfflineResult<T>) => void) => void): Promise<OfflineResult<T>> {
  if (!scopeValid(scope)) return Promise.resolve(failed("invalid"));
  return transaction([READS, ...(area === "drafts" ? [DRAFTS] : [])], mode, (tx, result) => {
    const request = tx.objectStore(READS).get(epochKey(scope));
    request.onsuccess = () => {
      const epoch: Epoch = request.result ?? emptyEpoch();
      if (!epochValid(epoch)) { result(failed("invalid")); return; }
      if (epoch[area === "reads" ? "readEpoch" : "draftEpoch"] !== scope[area === "reads" ? "readEpoch" : "draftEpoch"]) { result(failed("obsolete")); return; }
      try { run(tx, epoch, result); } catch (error) { result(storageFailure(error)); tx.abort(); }
    };
  });
}

export function captureOfflineScope(identity: OfflineIdentity): Promise<OfflineResult<OfflineScope>> {
  if (!identityValid(identity)) return Promise.resolve(failed("invalid"));
  return transaction([READS], "readonly", (tx, result) => {
    const request = tx.objectStore(READS).get(epochKey(identity));
    request.onsuccess = () => {
      const epoch: Epoch = request.result ?? emptyEpoch();
      result(epochValid(epoch) ? ok({ installationId: identity.installationId, variant: identity.variant, readEpoch: epoch.readEpoch, draftEpoch: epoch.draftEpoch }) : failed("invalid"));
    };
  });
}
export async function isOfflineScopeCurrent(scope: OfflineScope, area: "reads" | "drafts" = "reads"): Promise<OfflineResult<boolean>> {
  const result = await withScope<boolean>(scope, area, "readonly", (_tx, _epoch, done) => done(ok(true)));
  return !result.ok && result.reason === "obsolete" ? ok(false) : result;
}

/** Capture before issuing the session request. The variant-wide counter survives
 * pointer removal and compares observations from different installations. */
export function captureAdmissionTicket(variant: OfflineVariant): Promise<OfflineResult<OfflineAdmissionTicket>> {
  if (!["private", "portable"].includes(variant)) return Promise.resolve(failed("invalid"));
  return transaction([READS], "readonly", (tx, result) => {
    const request = tx.objectStore(READS).get(admissionVersionKey(variant));
    request.onsuccess = () => { const version = request.result ?? 0; result(count(version) ? ok({ variant, version }) : failed("invalid")); };
  });
}
export function captureReadTicket(scope: OfflineScope, key: ReadKey): Promise<OfflineResult<OfflineReadTicket>> {
  if (!readKeyValid(scope, key)) return Promise.resolve(failed("invalid"));
  return withScope(scope, "reads", "readonly", (tx, _epoch, result) => {
    const request = tx.objectStore(READS).get(modelKey(key));
    request.onsuccess = () => { const version = request.result?.storageVersion ?? 0; result(count(version) ? ok({ key: { ...key }, readEpoch: scope.readEpoch, version }) : failed("invalid")); };
  });
}

export function saveVerifiedAdmission(scope: OfflineScope, admission: SavedAdmission, ticket?: OfflineAdmissionTicket): Promise<OfflineResult<void>> {
  if (!scopeValid(scope) || !admissionValid(admission) || admission.variant !== scope.variant || admission.installationId !== scope.installationId) return Promise.resolve(failed("invalid"));
  if (ticket && (ticket.variant !== scope.variant || !count(ticket.version))) return Promise.resolve(failed("invalid"));
  const routeSavedAt = Date.now();
  return withScope(scope, "reads", "readwrite", (tx, _epoch, result) => {
    const store = tx.objectStore(READS), request = store.get(admissionKey(scope.variant)), counter = store.get(admissionVersionKey(scope.variant));
    counter.onsuccess = () => {
      const previous = request.result, version = counter.result ?? 0;
      if (!count(version) || !count(version + 1)) { result(failed("invalid")); return; }
      if (ticket && ticket.version !== version) { result(failed("obsolete")); return; }
      const valid = admissionValid(previous?.admission) && previous.admission.variant === scope.variant && count(previous.readEpoch);
      const sameIdentity = valid && previous.admission.installationId === admission.installationId;
      // verifiedAt orders observed read models, never opaque source revisions.
      // Equal authority conflicts fail closed, including installation replacement.
      if (!ticket && valid && (previous.admission.verifiedAt > admission.verifiedAt ||
          (previous.admission.verifiedAt === admission.verifiedAt && (!sameIdentity || !sameKey(previous.admission.profiles, admission.profiles))))) { result(failed("obsolete")); return; }
      const oldRouteAt = count(previous?.routeSavedAt) ? previous.routeSavedAt : 0;
      const replaceRoute = admission.lastRoute !== undefined && (!sameIdentity || routeSavedAt > oldRouteAt);
      const saved = { ...admission, ...(sameIdentity && !replaceRoute && previous.admission.lastRoute !== undefined ? { lastRoute: previous.admission.lastRoute } : {}) };
      try {
        store.put({ admission: saved, readEpoch: scope.readEpoch, routeSavedAt: replaceRoute ? routeSavedAt : sameIdentity ? oldRouteAt : 0 }, admissionKey(scope.variant));
        if (!sameIdentity || previous.admission.verifiedAt !== admission.verifiedAt || !sameKey(previous.admission.profiles, admission.profiles)) store.put(version + 1, admissionVersionKey(scope.variant));
        result(ok(undefined));
      } catch (error) { result(storageFailure(error)); tx.abort(); }
    };
  });
}
export function readSavedAdmission(variant: OfflineVariant): Promise<OfflineResult<{ admission: SavedAdmission; scope: OfflineScope } | undefined>> {
  if (!["private", "portable"].includes(variant)) return Promise.resolve(failed("invalid"));
  return transaction([READS], "readonly", (tx, result) => {
    const saved = tx.objectStore(READS).get(admissionKey(variant));
    saved.onsuccess = () => {
      const entry = saved.result as { admission: SavedAdmission; readEpoch: number } | undefined;
      if (!entry) { result(ok(undefined)); return; }
      if (!admissionValid(entry.admission) || entry.admission.variant !== variant || !count(entry.readEpoch)) { result(failed("invalid")); return; }
      const request = tx.objectStore(READS).get(epochKey(entry.admission));
      request.onsuccess = () => {
        const epoch: Epoch = request.result ?? emptyEpoch();
        if (!epochValid(epoch)) { result(failed("invalid")); return; }
        result(entry.readEpoch === epoch.readEpoch ? ok({ admission: entry.admission, scope: { installationId: entry.admission.installationId, variant, readEpoch: epoch.readEpoch, draftEpoch: epoch.draftEpoch } }) : ok(undefined));
      };
    };
  });
}
export function saveVerifiedModel<T>(scope: OfflineScope, model: SavedModel<T>, ticket?: OfflineReadTicket): Promise<OfflineResult<void>> {
  if (!model || !readKeyValid(scope, model.key) || !count(model.verifiedAt) || !persistable(model.value)) return Promise.resolve(failed("invalid"));
  if (ticket && (!readKeyValid(scope, ticket.key) || !sameKey(modelKey(ticket.key), modelKey(model.key)) || ticket.readEpoch !== scope.readEpoch || !count(ticket.version))) return Promise.resolve(failed("invalid"));
  return withScope(scope, "reads", "readwrite", (tx, _epoch, result) => {
    const store = tx.objectStore(READS), request = store.get(modelKey(model.key));
    request.onsuccess = () => {
      const previous = request.result;
      const version = previous?.storageVersion ?? 0;
      if (!count(version) || !count(version + 1)) { result(failed("invalid")); return; }
      if (ticket && ticket.version !== version) { result(failed("obsolete")); return; }
      if (!ticket && previous && readKeyValid(scope, previous.key) && sameKey(modelKey(previous.key), modelKey(model.key)) && count(previous.verifiedAt) && persistable(previous.value) && previous.verifiedAt >= model.verifiedAt) { result(failed("obsolete")); return; }
      try { store.put({ ...model, storageVersion: version + 1 }, modelKey(model.key)); result(ok(undefined)); }
      catch (error) { result(storageFailure(error)); tx.abort(); }
    };
  });
}
export function readSavedModel<T>(scope: OfflineScope, key: ReadKey): Promise<OfflineResult<SavedModel<T> | undefined>> {
  if (!readKeyValid(scope, key)) return Promise.resolve(failed("invalid"));
  return withScope(scope, "reads", "readonly", (tx, _epoch, result) => {
    const request = tx.objectStore(READS).get(modelKey(key)); request.onsuccess = () => {
      const model = request.result;
      result(model === undefined || (model && readKeyValid(scope, model.key) && sameKey(modelKey(model.key), modelKey(key)) && count(model.verifiedAt) && count(model.storageVersion ?? 0) && persistable(model.value)) ? ok(model) : failed("invalid"));
    };
  });
}
export function readDraft(scope: OfflineScope, key: DraftKey): Promise<OfflineResult<SavedDraft | undefined>> {
  if (!draftValid(key)) return Promise.resolve(failed("invalid"));
  return withScope(scope, "drafts", "readonly", (tx, _epoch, result) => {
    const request = tx.objectStore(DRAFTS).get(draftKey(scope, key)); request.onsuccess = () => {
      const draft = request.result;
      result(draft === undefined || (draftEnvelopeValid(draft) && sameKey(draftKey(scope, draft.key), draftKey(scope, key)) && count(draft.savedAt)) ? ok(draft) : failed("invalid"));
    };
  });
}
export function readDrafts(scope: OfflineScope): Promise<OfflineResult<SavedDraft[]>> {
  return withScope(scope, "drafts", "readonly", (tx, _epoch, result) => {
    const drafts: SavedDraft[] = [];
    const request = tx.objectStore(DRAFTS).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { result(ok(drafts)); return; }
      const key = cursor.key;
      if (Array.isArray(key) && key[0] === "draft" && key[1] === scope.variant && key[2] === scope.installationId) {
        const value = cursor.value;
        if (!draftEnvelopeValid(value) || !count(value.savedAt) || !sameKey(key, draftKey(scope, value.key))) {
          result(failed("invalid")); return;
        }
        drafts.push(value);
      }
      cursor.continue();
    };
  });
}
// Guarded editors compare their last observed save; null requires an empty slot.
// Omitting options preserves the existing overwrite API for legacy callers.
export function saveDraft(scope: OfflineScope, draft: Omit<SavedDraft, "savedAt">, options?: { expectedSavedAt: number | null }): Promise<OfflineResult<SavedDraft>> {
  if (!draftEnvelopeValid(draft) || (options !== undefined && (!options || (options.expectedSavedAt !== null && !count(options.expectedSavedAt))))) return Promise.resolve(failed("invalid"));
  return withScope(scope, "drafts", "readwrite", (tx, epoch, result) => {
    const store = tx.objectStore(DRAFTS);
    const commit = () => {
      const savedAt = Math.max(Date.now(), epoch.lastSavedAt + 1);
      if (!count(savedAt)) { result(failed("invalid")); return; }
      const saved = { ...draft, savedAt };
      try {
        tx.objectStore(READS).put({ ...epoch, lastSavedAt: savedAt }, epochKey(scope));
        store.put(saved, draftKey(scope, draft.key)); result(ok(saved));
      } catch (error) { result(storageFailure(error)); tx.abort(); }
    };
    if (options === undefined) { commit(); return; }
    const request = store.get(draftKey(scope, draft.key));
    request.onsuccess = () => {
      const matches = options.expectedSavedAt === null ? request.result === undefined : request.result?.savedAt === options.expectedSavedAt;
      if (!matches) { result(failed("obsolete")); return; }
      commit();
    };
  });
}
export function removeDraft(scope: OfflineScope, key: DraftKey, expectedSavedAt: number): Promise<OfflineResult<boolean>> {
  if (!draftValid(key) || !count(expectedSavedAt)) return Promise.resolve(failed("invalid"));
  return withScope(scope, "drafts", "readwrite", (tx, _epoch, result) => {
    const store = tx.objectStore(DRAFTS), request = store.get(draftKey(scope, key));
    request.onsuccess = () => { const matches = request.result?.savedAt === expectedSavedAt; if (matches) store.delete(draftKey(scope, key)); result(ok(matches)); };
  });
}

const listeners = new Set<(change: OfflineStoreChange) => void>();
let channel: BroadcastChannel | undefined;
const changeValid = (value: OfflineStoreChange) => Boolean(value && value.contract === "vorton.offline-store.v1" && ["READS_CLEARED", "FORGOTTEN"].includes(value.type) && scopeValid(value));
const notify = (change: OfflineStoreChange) => { for (const listener of listeners) { try { listener(change); } catch { /* A listener cannot undo committed storage. */ } } };
const receive = (event: MessageEvent) => { if (changeValid(event.data)) notify(event.data); };
const receiveStorage = (event: StorageEvent) => { if (event.key !== CHANNEL || !event.newValue) return; try { const change = JSON.parse(event.newValue); if (changeValid(change)) notify(change); } catch { /* Ignore unrelated/corrupt notifications. */ } };
export function subscribeOfflineStore(listener: (change: OfflineStoreChange) => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    try { channel = new BroadcastChannel(CHANNEL); channel.onmessage = receive; } catch { globalThis.addEventListener?.("storage", receiveStorage); }
  }
  return () => { listeners.delete(listener); if (!listeners.size) { channel?.close(); channel = undefined; globalThis.removeEventListener?.("storage", receiveStorage); } };
}
function broadcast(change: OfflineStoreChange) {
  notify(change);
  try { const sender = channel ?? new BroadcastChannel(CHANNEL); sender.postMessage(change); if (sender !== channel) sender.close(); }
  catch { try { localStorage.setItem(CHANNEL, JSON.stringify(change)); } catch { /* Durable epochs remain authoritative without notification. */ } }
}
export async function clearSavedData(scope: OfflineScope, mode: "reads" | "all" = "reads"): Promise<OfflineResult<OfflineScope>> {
  if (!scopeValid(scope) || !["reads", "all"].includes(mode)) return failed("invalid");
  const result = await transaction<OfflineScope>([READS, DRAFTS], "readwrite", (tx, done) => {
    const request = tx.objectStore(READS).get(epochKey(scope));
    request.onsuccess = () => {
      const epoch: Epoch = request.result ?? emptyEpoch();
      if (!epochValid(epoch)) { done(failed("invalid")); return; }
      if (epoch.readEpoch !== scope.readEpoch || (mode === "all" && epoch.draftEpoch !== scope.draftEpoch)) { done(failed("obsolete")); return; }
      const next = { ...epoch, readEpoch: epoch.readEpoch + 1, draftEpoch: epoch.draftEpoch + (mode === "all" ? 1 : 0) };
      if (!epochValid(next)) { done(failed("invalid")); return; }
      tx.objectStore(READS).put(next, epochKey(scope));
      // Fence session requests even when no admission pointer has been saved yet.
      const counter = tx.objectStore(READS).get(admissionVersionKey(scope.variant));
      counter.onsuccess = () => {
        const version = counter.result ?? 0;
        if (!count(version) || !count(version + 1)) { done(failed("invalid")); tx.abort(); return; }
        try { tx.objectStore(READS).put(version + 1, admissionVersionKey(scope.variant)); }
        catch (error) { done(storageFailure(error)); tx.abort(); }
      };
      for (const name of [READS, ...(mode === "all" ? [DRAFTS] : [])]) {
        const cursor = tx.objectStore(name).openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result; if (!row) return;
          const key = row.key;
          if (Array.isArray(key) && ((["model", "draft"].includes(String(key[0])) && key[1] === scope.variant && key[2] === scope.installationId) || (key[0] === "admission" && key[1] === scope.variant && row.value.admission?.installationId === scope.installationId))) {
            row.delete();
          }
          row.continue();
        };
      }
      done(ok({ installationId: scope.installationId, variant: scope.variant, readEpoch: next.readEpoch, draftEpoch: next.draftEpoch }));
    };
  });
  if (result.ok) broadcast({ ...result.value, contract: "vorton.offline-store.v1", type: mode === "all" ? "FORGOTTEN" : "READS_CLEARED" });
  return result;
}
