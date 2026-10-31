import type { State } from "../types";
import { workspaceAccess, type WorkspaceAccessTicket } from "./offline-access.ts";
import { readSavedModel, saveVerifiedModel, isOfflineScopeCurrent, captureReadTicket } from "./offline-store.ts";
import { ReplicaService } from "./replica-service.ts";
import { retryGate, retryScope, responseValue, RetryFailure, cancelled, transient, type RetryGate } from "./retry-gate.ts";

export type Session = { token: string; profiles: string[]; installationId: string; variant: "private" | "portable" };
export type ProfileSnapshot = { state?: State; error?: string; loading: boolean; verifiedAt?: number; saved?: boolean };
type Entry = { snapshot: ProfileSnapshot; generation: number; ingestion?: symbol; fetchedAt: number; liveRead?: { epoch: number; generation?: string }; pendingEpoch?: number; pending?: Promise<State>; hydratingEpoch?: number; hydrating?: Promise<State | undefined>; listeners: Set<() => void> };

/** Bound the complete read, including a response body that stalls after headers.
 * Mutations never use this helper and are never automatically retried. */
export async function readJsonWithDeadline(url: string, fetcher: typeof fetch = (...args) => fetch(...args), milliseconds = 8000, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  if (signal?.aborted) throw cancelled();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let response: Response;
        try { response = await fetcher(url, { cache: "no-store", credentials: "same-origin", signal: controller.signal }); }
        catch (error) { throw signal?.aborted ? cancelled() : transient(error); }
        if (signal?.aborted) throw cancelled();
        return await responseValue(response);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RetryFailure("Connection timed out. Saved content remains available.", "transient")); }, milliseconds); }),
      new Promise<never>((_, reject) => { controller.signal.addEventListener("abort", () => reject(signal?.aborted ? cancelled() : new RetryFailure("Connection timed out. Saved content remains available.", "transient")), { once: true }); }),
    ]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

function decodeWorkspaceState(value: unknown): State {
  const state = value as State | null;
  if (!state || typeof state.profile !== "string" || !Number.isFinite(state.revision) ||
      ![state.goals, state.tasks, state.recommendations, state.events].every(Array.isArray))
    throw new RetryFailure("Invalid workspace response", "validation");
  if (state.canonical) {
    const canonical = state.canonical;
    if (typeof canonical !== "object") throw new RetryFailure("Unsupported workspace projection", "validation");
    const compact = "projection" in canonical && canonical.projection === "workspace-v1" && ["governed-registers", "sqlite"].includes(canonical.source);
    const full = !("projection" in canonical) && Array.isArray(canonical.goals) && Array.isArray(canonical.tasks);
    if (!compact && !full) throw new RetryFailure("Unsupported workspace projection", "validation");
  }
  return state;
}

// Cache identity is the exact admitted profile, never the currently visible page.
// A canonical mutation advances the generation so an older GET cannot undo it.
export class ProfileCache {
  private entries = new Map<string, Entry>();
  private namespace = "legacy";
  private namespaceGeneration = 0;
  private replica?: ReplicaService;
  private requests = new Map<AbortController, { epoch: number; managed: boolean }>();
  private fetcher: typeof fetch;
  private retries: RetryGate;
  constructor(fetcher: typeof fetch = (...args) => fetch(...args), retries: RetryGate = retryGate) { this.fetcher = fetcher; this.retries = retries; }
  suspend() { for (const controller of this.requests.keys()) controller.abort(); }
  attachReplica(replica: ReplicaService) { this.replica = replica; }
  clear() {
    this.suspend();
    this.namespaceGeneration++;
    for (const entry of this.entries.values()) { entry.generation++; entry.ingestion = undefined; entry.pending = undefined; entry.hydrating = undefined; entry.liveRead = undefined; entry.fetchedAt = 0; this.publish(entry, { loading: false }); }
  }
  private synchronize() {
    const access = workspaceAccess.getSnapshot();
    for (const [controller, ticket] of this.requests) if (ticket.managed && ticket.epoch !== access.epoch) controller.abort();
    const namespace = access.managed ? `${access.variant}:${access.installationId ?? ""}:${["cleared", "forgotten"].includes(access.status) ? "paused" : "active"}` : "legacy";
    if (namespace !== this.namespace) { this.namespace = namespace; this.clear(); }
    if (access.managed) for (const [profile, entry] of this.entries) {
      if (!access.admittedProfiles.includes(profile) && (entry.snapshot.state || entry.pending || entry.hydrating)) { entry.generation++; entry.ingestion = undefined; entry.pending = undefined; entry.hydrating = undefined; this.publish(entry, { loading: false }); }
    }
    return access;
  }
  private entry(profile: string): Entry {
    let entry = this.entries.get(profile);
    if (!entry) {
      entry = { snapshot: { loading: false }, generation: 0, fetchedAt: 0, listeners: new Set() };
      this.entries.set(profile, entry);
    }
    return entry;
  }
  read(profile: string) { this.synchronize(); return this.entry(profile).snapshot; }
  canConfirmLive(profile: string, ticket: WorkspaceAccessTicket) {
    const access = this.synchronize();
    try { workspaceAccess.assertReadable(ticket); } catch { return false; }
    const proof = this.entry(profile).liveRead, local = this.replica?.getSnapshot(profile);
    return access.onlineAdmission && access.profile === profile && ticket.profile === profile && proof?.epoch === ticket.epoch &&
      !local?.historyChanged && (!local?.serverGeneration || local.serverGeneration === proof.generation);
  }
  subscribe(profile: string, listener: () => void) {
    const entry = this.entry(profile);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }
  private publish(entry: Entry, snapshot: ProfileSnapshot) {
    entry.snapshot = snapshot;
    entry.listeners.forEach(listener => listener());
  }
  write(profile: string, state: State, persist = true, ingest = true) {
    const access = this.synchronize();
    if (access.managed && (!access.installationId || !access.admittedProfiles.includes(profile) || ["cleared", "forgotten"].includes(access.status))) throw new Error("This workspace is unavailable in the current installation.");
    if (state.profile !== profile) throw new Error("Installation mismatch. Refusing to display records.");
    const remote = state;
    state = this.replica?.overlay(profile, state) ?? state;
    const entry = this.entry(profile);
    const ingestion = ingest && this.replica && access.onlineAdmission ? Symbol() : undefined;
    entry.ingestion = ingestion;
    entry.generation++;
    entry.pending = undefined;
    entry.fetchedAt = Date.now();
    this.publish(entry, { state, loading: false, verifiedAt: entry.fetchedAt, saved: false });
    const scope = workspaceAccess.readScope(profile);
    if (persist && scope && access.onlineAdmission) void saveVerifiedModel(scope, { key: { installationId: scope.installationId, variant: scope.variant, profile, schema: 1, kind: "workspace", id: "current" }, verifiedAt: entry.fetchedAt, value: remote });
    if (ingestion && this.replica && entry.ingestion === ingestion) {
      // An earlier synchronization may publish while this ingestion waits for
      // it. That display update must not discard the confirmed ingestion's
      // result. New reads, writes and authority changes still retire its owner.
      void this.replica.ingest(profile, remote).then(local => {
        this.synchronize();
        if (access.managed) workspaceAccess.assertReadable({ ...access, profile });
        if (local && entry.ingestion === ingestion && local.syncGeneration === remote.syncGeneration &&
            !this.replica?.getSnapshot(profile).historyChanged) this.writeReplica(profile, local);
        if (entry.ingestion === ingestion) entry.ingestion = undefined;
      }).catch(() => { if (entry.ingestion === ingestion) entry.ingestion = undefined; });
    }
  }
  writeReplica(profile: string, state: State) {
    const access = this.synchronize();
    if (!access.installationId || !access.admittedProfiles.includes(profile) || ["cleared", "forgotten"].includes(access.status) || state.profile !== profile) return;
    const entry = this.entry(profile);
    if (entry.snapshot.state?.syncGeneration !== state.syncGeneration) entry.ingestion = undefined;
    entry.generation++; entry.pending = undefined; entry.fetchedAt = 0;
    this.publish(entry, { state, loading: false, saved: true, verifiedAt: this.replica?.getSnapshot(profile).verifiedAt });
  }
  hydrate(profile: string): Promise<State | undefined> {
    const access = this.synchronize(), entry = this.entry(profile);
    if (entry.snapshot.state && (!this.replica || this.replica.getSnapshot(profile).ready)) return Promise.resolve(entry.snapshot.state);
    if (entry.hydrating && entry.hydratingEpoch === access.epoch) return entry.hydrating;
    const scope = workspaceAccess.readScope(profile);
    if (!scope || !access.installationId) return Promise.resolve(undefined);
    const namespace = this.namespaceGeneration;
    const generation = entry.generation;
    const hydrating = (async () => {
      const local = await this.replica?.hydrate(profile);
      if (local && namespace === this.namespaceGeneration && generation === entry.generation) {
        this.publish(entry, { state: local, loading: Boolean(entry.pending), saved: true, verifiedAt: this.replica?.getSnapshot(profile).verifiedAt });
        return local;
      }
      const saved = await readSavedModel<State>(scope, { installationId: scope.installationId, variant: scope.variant, profile, schema: 1, kind: "workspace", id: "current" });
      if (!saved.ok || !saved.value) return;
      const current = await isOfflineScopeCurrent(scope);
      const admission = this.synchronize();
      const readScope = workspaceAccess.readScope(profile);
      if (!current.ok || !current.value || namespace !== this.namespaceGeneration || entry.snapshot.state ||
          !admission.admittedProfiles.includes(profile) || admission.installationId !== scope.installationId || admission.variant !== scope.variant ||
          !readScope || readScope.installationId !== scope.installationId || readScope.variant !== scope.variant ||
          readScope.readEpoch !== scope.readEpoch) return;
      try {
        const state = decodeWorkspaceState(saved.value.value);
        if (state.profile !== profile) return;
        entry.fetchedAt = 0; // Hydration never restarts the online freshness TTL.
        this.publish(entry, { ...entry.snapshot, state, loading: Boolean(entry.pending), verifiedAt: saved.value.verifiedAt, saved: true });
        return state;
      } catch { return; }
    })();
    entry.hydrating = hydrating;
    entry.hydratingEpoch = access.epoch;
    const settled = () => { if (entry.hydrating === hydrating) entry.hydrating = undefined; };
    void hydrating.then(settled, settled);
    return hydrating;
  }
  load(profile: string, force = false): Promise<State> {
    const access = this.synchronize();
    const entry = this.entry(profile);
    if (access.managed && (!access.installationId || !access.admittedProfiles.includes(profile) || ["cleared", "forgotten"].includes(access.status))) return Promise.reject(new Error("This workspace is unavailable in the current installation."));
    if (access.managed && !access.onlineAdmission) return this.hydrate(profile).then(state => { if (!state) throw new Error("No saved records are available for this workspace. Reconnect to load them."); return state; });
    if (access.managed && entry.pending && entry.pendingEpoch !== access.epoch) { entry.generation++; entry.pending = undefined; }
    if (access.managed && entry.pending && entry.pendingEpoch === access.epoch) return entry.pending;
    if (!force && entry.pending) return entry.pending;
    if (!force && entry.snapshot.state && Date.now() - entry.fetchedAt < 30_000) return Promise.resolve(entry.snapshot.state);
    if (access.managed && (typeof document !== "undefined" && document.visibilityState === "hidden" || typeof navigator !== "undefined" && navigator.onLine === false)) return Promise.reject(cancelled());
    const retryKey = retryScope(access, profile);
    let attempt: ReturnType<RetryGate["begin"]> | undefined;
    try { if (access.managed) attempt = this.retries.begin(retryKey); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController();
    this.requests.set(controller, { epoch: access.epoch, managed: access.managed });
    entry.ingestion = undefined;
    const generation = ++entry.generation;
    const namespace = this.namespaceGeneration;
    const ticket = { ...access, profile };
    this.publish(entry, { ...entry.snapshot, loading: true });
    const pending = (async () => {
      try {
        const scope = workspaceAccess.readScope(profile);
        const key = scope && { installationId: scope.installationId, variant: scope.variant, profile, schema: 1, kind: "workspace" as const, id: "current" };
        const readTicket = scope && key ? await captureReadTicket(scope, key) : undefined;
        if (access.managed) workspaceAccess.assertReadable(ticket);
        if (readTicket && !readTicket.ok && readTicket.reason === "obsolete") throw new RetryFailure("Saved workspace scope changed before loading.", "cancelled");
        if (readTicket && !readTicket.ok && readTicket.reason === "invalid") throw new Error("Saved workspace storage failed validation before loading.");
        if (controller.signal.aborted) throw cancelled();
        if (attempt && attempt.revision !== this.retries.version(retryKey)) this.retries.begin(retryKey);
        const remoteState = decodeWorkspaceState(await readJsonWithDeadline(`/api/${profile.toLowerCase()}/state?view=workspace`, this.fetcher, 8000, controller.signal));
        let state = remoteState;
        if (state.profile !== profile) throw new RetryFailure("Installation mismatch. Refusing to display records.", "validation");
        this.synchronize();
        if (access.managed) workspaceAccess.assertReadable(ticket);
        if (namespace !== this.namespaceGeneration || (access.managed && !workspaceAccess.getSnapshot().admittedProfiles.includes(profile))) throw new Error("The installation changed while records were loading.");
        // A replica publication may supersede this GET's display without
        // invalidating its read evidence for the current admitted connection.
        // This proof never comes from hydration and never replaces metadata.
        const replicaGeneration = this.replica?.getSnapshot(profile).serverGeneration;
        if (generation === entry.generation || !replicaGeneration || replicaGeneration === remoteState.syncGeneration)
          entry.liveRead = { epoch: ticket.epoch, generation: remoteState.syncGeneration };
        if (generation !== entry.generation) return entry.snapshot.state ?? state;
        state = await this.replica?.ingest(profile, state) ?? state;
        if (access.managed) workspaceAccess.assertReadable(ticket);
        if (generation === entry.generation) {
          const olderThanReplica = remoteState.syncGeneration && (this.replica?.getSnapshot(profile).serverRevision ?? 0) > remoteState.revision;
          if (scope && key && readTicket?.ok && !olderThanReplica) {
            const saved = await saveVerifiedModel(scope, { key, verifiedAt: Date.now(), value: remoteState }, readTicket.value);
            if (!saved.ok && saved.reason === "obsolete") throw new RetryFailure("Newer workspace records were saved while this request was loading. Refresh again.", "cancelled");
            if (!saved.ok && saved.reason === "invalid") throw new Error("Saved workspace storage failed validation. Keep local work and verify device storage.");
            workspaceAccess.assertReadable(ticket);
          }
          if (generation === entry.generation) this.write(profile, state, false, false);
        }
        if (attempt && !this.replica) this.retries.finish(attempt, true);
        return entry.snapshot.state ?? state;
      } catch (reason) {
        if (attempt && !controller.signal.aborted && ticket.epoch === workspaceAccess.getSnapshot().epoch) this.retries.fail(retryKey, reason);
        if (access.managed) workspaceAccess.assertReadable(ticket);
        if (generation !== entry.generation && entry.snapshot.state) return entry.snapshot.state;
        if (generation === entry.generation) this.publish(entry, { ...entry.snapshot, error: reason instanceof Error ? reason.message : "Workspace unavailable", loading: false });
        throw reason;
      } finally {
        this.requests.delete(controller);
        if (attempt) this.retries.finish(attempt, false);
        if (entry.generation === generation) entry.pending = undefined;
      }
    })();
    entry.pending = pending;
    entry.pendingEpoch = access.epoch;
    return pending;
  }
}

export const profileCache = new ProfileCache();
export const profileReplica = new ReplicaService({ session: (signal, attempt) => loadSession(true, { signal, attempt }), sessionVersion: () => sessionGeneration, publish: (profile, state) => profileCache.writeReplica(profile, state) });
profileCache.attachReplica(profileReplica);
type SessionOptions = { signal?: AbortSignal; key?: string; explicit?: boolean; admission?: boolean; attempt?: ReturnType<RetryGate["begin"]> };
let sessionRequest: { promise: Promise<Session>; controller: AbortController; leases: number; settled: boolean } | undefined;
let cachedSession: { key: string; value: Session } | undefined;
let sessionGeneration = 0;
export function loadSession(force = false, options: SessionOptions = {}): Promise<Session> {
  const key = options.attempt?.key ?? options.key ?? retryScope(workspaceAccess.getSnapshot());
  if (options.signal?.aborted) return Promise.reject(cancelled());
  if (typeof document !== "undefined" && document.visibilityState === "hidden" || typeof navigator !== "undefined" && navigator.onLine === false) return Promise.reject(cancelled());
  let attempt: ReturnType<RetryGate["begin"]>;
  try { attempt = options.attempt ?? retryGate.begin(key, options.explicit, options.admission && options.explicit); } catch (error) { return Promise.reject(error); }
  try { retryGate.revalidate(attempt); } catch (error) { return Promise.reject(error); }
  if (!force && cachedSession?.key === key) { retryGate.finish(attempt, false); return Promise.resolve(cachedSession.value); }
  if (!sessionRequest) {
    sessionGeneration++;
    const controller = new AbortController();
    const request = { controller, leases: 0, settled: false, promise: undefined as unknown as Promise<Session> };
    request.promise = readJsonWithDeadline("/api/session", undefined, 8000, controller.signal).then(value => {
    const session = value as Session;
    if (!session || typeof session !== "object") throw new RetryFailure("Invalid workspace session", "validation");
    if (typeof session.token !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(session.installationId) || !["private", "portable"].includes(session.variant) || !Array.isArray(session.profiles) || !session.profiles.every((id: unknown) => typeof id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))) throw new RetryFailure("Invalid workspace session", "validation");
    return session as Session;
    }).finally(() => { request.settled = true; if (sessionRequest === request) sessionRequest = undefined; });
    sessionRequest = request;
  }
  const request = sessionRequest;
  request.leases++;
  let abort: (() => void) | undefined;
  const ownership = new Promise<never>((_, reject) => {
    abort = () => reject(cancelled());
    options.signal?.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([request.promise, ownership]).then(session => {
    if (options.signal?.aborted) throw cancelled();
    cachedSession = { key, value: session };
    // A renewed token alone cannot clear delivery backoff or storage/history.
    return session;
  }).catch(error => { if (!options.signal?.aborted) retryGate.fail(key, error); throw error; }).finally(() => {
    if (abort) options.signal?.removeEventListener("abort", abort);
    if (!options.attempt) retryGate.finish(attempt, false);
    if (--request.leases === 0 && !request.settled) {
      if (sessionRequest === request) sessionRequest = undefined;
      request.controller.abort();
    }
  });
}
