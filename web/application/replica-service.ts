import type { State } from "../types";
import type { Session } from "./profile-cache";
import type { RemoteFeed, DeviceEpoch, ResolutionReview, IdentityReview } from "./replica-sql";
import type { LocalReplica } from "./replica-sql";
import { clearSavedData, readDrafts, isOfflineScopeCurrent, type OfflineScope } from "./offline-store.ts";
import { workspaceAccess, type WorkspaceAccessTicket } from "./offline-access.ts";
import { SqliteClient } from "./sqlite-client.ts";
import { SYNC_PROTOCOL, type SyncOperation } from "../../shared/sync-contract.ts";
import { retryGate, RetryGate, RetryFailure, RetryDeferred, retryReason, responseValue, cancelled, transient, policyFailure, type RetryAttempt } from "./retry-gate.ts";

export type QueueRow = { sequence: number; operation_id: string; kind: string; record_id: string; title: string; recovery_origin?: string | null;
  operation: string; status: string; error: string | null; receipt: string | null; generation: string | null; local_version: number | null; dependencies: string };
type WorkspaceRows = { metadata: { profile: string; body: string; generation: string | null; cursor: number; download_head: number; verified_at: number } | null;
  historyReview?: { review_id: string; generation: string; head: number; cursor: number } | null; adoptionCounter?: number;
  historyIdentity?: { profile: string; generation: string } | null;
  stagedMetadata?: { body: string; generation: string } | null;
  records: { kind: string; id: string; body: string; revision: number }[];
  acceptedRecords: { kind: string; id: string; body: string; revision: number; deleted: number }[]; outbox: QueueRow[] };
export type ReplicaSnapshot = { scope?: string; ready: boolean; state?: State; rows: WorkspaceRows["records"];
  serverRows: WorkspaceRows["acceptedRecords"];
  queue: QueueRow[]; pending: number; syncing: boolean; error?: string; verifiedAt?: number; serverRevision?: number; historyChanged?: boolean;
  historyReview?: WorkspaceRows["historyReview"]; adoptionCounter?: number; reviewing?: boolean; serverGeneration?: string; storageRecovery?: boolean; serverStorageRecovery?: boolean; verificationReady?: boolean; verifying?: boolean };
const EMPTY: ReplicaSnapshot = { ready: false, rows: [], serverRows: [], queue: [], pending: 0, syncing: false };
type Context = { scope: string; profile: string; ticket: WorkspaceAccessTicket; deviceEpoch: DeviceEpoch; incarnation: number; retryVersion?: number; historyReview?: boolean; verification?: RetryAttempt; ownerSignal?: AbortSignal; callerSignal?: AbortSignal; sessionVersion?: number };
type Transport = Pick<SqliteClient, "request">;
export type HistoryComparison = ReturnType<LocalReplica["historyComparison"]>;
export type AttemptRecovery = ReturnType<LocalReplica["recoverAttempt"]>;
type Entry = { snapshot: ReplicaSnapshot; preparing?: Promise<State | undefined>; syncing?: Promise<void>; syncContext?: Context; pulling?: Promise<void>; reviewing?: Promise<unknown>; verifying?: Promise<void>; recoveryReadOnly?: boolean; verification?: { context: Context; generation?: string } };

/** Foreground orchestration only. Credentials stay in memory and never enter
 * worker requests. The SQLite worker decides when a local save is durable. */
export class ReplicaService {
  private entries = new Map<string, Entry>();
  private listeners = new Map<string, Set<() => void>>();
  private client: Transport;
  private session: (signal?: AbortSignal, attempt?: ReturnType<RetryGate["begin"]>) => Promise<Session>;
  private publishState: (profile: string, state: State) => void;
  private fetcher: typeof fetch;
  private stop?: () => void;
  private networkActive = true;
  private requests = new Set<AbortController>();
  private incarnation = 0;
  private retries: RetryGate;
  private localStorageFailures = new Map<string, number>();
  private serverStorageFailures = new Map<string, { token: number; generation?: string }>();
  private authEpochs = new Map<string, number>();
  private sessionSerial = 0;
  private sessionVersion: () => number;
  constructor(options: { client?: Transport; session: (signal?: AbortSignal, attempt?: ReturnType<RetryGate["begin"]>) => Promise<Session>;
    publish: (profile: string, state: State) => void; fetcher?: typeof fetch; retries?: RetryGate; sessionVersion?: () => number }) {
    this.client = options.client ?? new SqliteClient();
    this.session = options.session; this.publishState = options.publish;
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
    this.retries = options.retries ?? retryGate;
    this.sessionVersion = options.sessionVersion ?? (() => this.sessionSerial);
  }
  private context(profile: string): Context {
    const access = workspaceAccess.getSnapshot();
    const saved = workspaceAccess.readScope(profile);
    if (!access.managed || !saved || !access.installationId) throw Error("This workspace has no saved device admission.");
    const ticket = { ...access, profile };
    workspaceAccess.assertReadable(ticket);
    return { profile, ticket, scope: `${saved.variant}/${saved.installationId}/${profile}/owner`, deviceEpoch: { readEpoch: saved.readEpoch, draftEpoch: saved.draftEpoch }, incarnation: this.incarnation };
  }
  private request(context: Context, action: string, payload: Record<string, unknown> = {}) {
    return this.client.request(context.scope, action, { ...payload, deviceEpoch: context.deviceEpoch });
  }
  async exportDevice(profile: string) {
    const context = this.context(profile);
    const scope = workspaceAccess.readScope(profile)!;
    const data = await this.request(context, "export-device");
    const drafts = await readDrafts(scope);
    if (!drafts.ok) throw Error("Saved drafts could not be included. Device export was not completed; keep your text before forgetting this installation.");
    const current = await isOfflineScopeCurrent(scope);
    if (!current.ok || !current.value) throw Error("Device storage changed during export. Retry before forgetting this installation.");
    workspaceAccess.assertReadable(context.ticket);
    return { format: "vorton.local-recovery.v1", installationId: context.ticket.installationId, variant: context.ticket.variant,
      exportedAt: new Date().toISOString(), data, drafts: drafts.value };
  }
  async clearDevice(scope: OfflineScope, all: boolean) {
    const access = workspaceAccess.getSnapshot();
    const profile = access.profile ?? access.admittedProfiles[0];
    if (!profile || scope.installationId !== access.installationId || scope.variant !== access.variant) throw Error("This installation is no longer available.");
    // Revoke sending authority before asking storage to fence old requests.
    workspaceAccess.beginReconcile(true);
    const key = `${scope.variant}/${scope.installationId}/${profile}/owner`;
    await this.client.request(key, "clear-device", { deviceEpoch: { readEpoch: scope.readEpoch, draftEpoch: scope.draftEpoch }, all });
    const result = await clearSavedData(scope, all ? "all" : "reads");
    if (!result.ok) throw Error("SQLite records were cleared, but draft storage did not confirm its clear. Retry these controls to finish; reconnecting is blocked until both stores agree.");
    for (const [key, entry] of this.entries) if (key.startsWith(`${scope.variant}/${scope.installationId}/`)) entry.snapshot = { ...EMPTY, scope: key };
    return result;
  }
  private entry(context: Context) {
    let entry = this.entries.get(context.scope);
    if (!entry) { entry = { snapshot: { ...EMPTY, scope: context.scope } }; this.entries.set(context.scope, entry); }
    return entry;
  }
  private publish(context: Context, update: Partial<ReplicaSnapshot>) {
    workspaceAccess.assertReadable(context.ticket);
    const entry = this.entry(context); entry.snapshot = { ...entry.snapshot, ...update };
    this.listeners.get(context.profile)?.forEach(listener => listener());
  }
  getSnapshot(profile: string): ReplicaSnapshot {
    try { const context = this.context(profile); return this.entries.get(context.scope)?.snapshot ?? EMPTY; }
    catch { return EMPTY; }
  }
  subscribe(profile: string, listener: () => void) {
    const listeners = this.listeners.get(profile) ?? new Set<() => void>();
    this.listeners.set(profile, listeners); listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  canEdit(profile: string) {
    const snapshot = this.getSnapshot(profile);
    return snapshot.ready && !snapshot.historyChanged && workspaceAccess.getSnapshot().profile === profile;
  }
  start() {
    if (this.stop) return () => {};
    this.networkActive = true;
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
    let epoch = workspaceAccess.getSnapshot().epoch;
    const cancel = () => { this.incarnation++; clearTimeout(timer); timer = undefined; for (const controller of this.requests) controller.abort(); };
    const schedule = () => {
      clearTimeout(timer); timer = undefined;
      if (stopped || !this.networkActive || document.visibilityState === "hidden" || typeof navigator !== "undefined" && navigator.onLine === false) return;
      const profile = workspaceAccess.getSnapshot().profile;
      if (!profile) return;
      let context: Context;
      try { context = this.context(profile); } catch { return; }
      const state = this.retries.inspect(context.scope);
      if (!state.paused) timer = setTimeout(foreground, state.remaining || 30_000);
    };
    const foreground = () => {
      clearTimeout(timer); timer = undefined;
      if (!this.networkActive || typeof document !== "undefined" && document.visibilityState === "hidden" || typeof navigator !== "undefined" && navigator.onLine === false) return;
      const profile = workspaceAccess.getSnapshot().profile;
      if (!profile) return;
      let context: Context;
      try { context = this.context(profile); } catch { return; }
      const entry = this.entry(context), prior = entry.syncContext;
      const joinedRetired = Boolean(entry.syncing && prior && workspaceAccess.getSnapshot().canWrite &&
        (prior.incarnation !== context.incarnation || prior.ticket.epoch !== context.ticket.epoch));
      const task = this.getSnapshot(profile).ready ? this.synchronize(profile) : this.hydrate(profile).then(state => {
        workspaceAccess.assertReadable(context.ticket);
        if (state) this.publishState(profile, state);
        return this.synchronize(profile);
      });
      void task.catch(error => this.failure(context, error, true)).finally(() => {
        if (!stopped && context.incarnation === this.incarnation && context.ticket.epoch === workspaceAccess.getSnapshot().epoch) {
          // This callback belongs to the fresh foreground event, not the retired
          // pipeline it joined. Recheck the gate after that owner releases it.
          if (joinedRetired) foreground(); else schedule();
        }
      });
    };
    const suspend = () => {
      this.networkActive = false;
      cancel();
    };
    const resume = () => { this.networkActive = true; foreground(); };
    const visibility = () => { if (document.visibilityState === "hidden") suspend(); else resume(); };
    const unsubscribe = workspaceAccess.subscribe(() => {
      if (epoch !== workspaceAccess.getSnapshot().epoch) { epoch = workspaceAccess.getSnapshot().epoch; cancel(); }
      const profile = workspaceAccess.getSnapshot().profile;
      if (profile) try { this.observeStorage(this.context(profile)); } catch { /* Saved authority changed. */ }
      for (const listeners of this.listeners.values()) listeners.forEach(listener => listener());
      foreground();
    });
    const unsubscribeRetry = this.retries.subscribe(() => {
      const profile = workspaceAccess.getSnapshot().profile;
      if (profile) try { this.observeStorage(this.context(profile)); } catch { /* Saved authority changed. */ }
      schedule();
    });
    window.addEventListener("online", resume);
    window.addEventListener("offline", suspend);
    window.addEventListener("pageshow", resume);
    window.addEventListener("pagehide", suspend, true);
    document.addEventListener("visibilitychange", visibility);
    schedule();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      suspend();
      unsubscribe(); unsubscribeRetry();
      window.removeEventListener("online", resume); window.removeEventListener("offline", suspend); window.removeEventListener("pageshow", resume);
      window.removeEventListener("pagehide", suspend, true);
      document.removeEventListener("visibilitychange", visibility);
      if (this.stop === stop) this.stop = undefined;
    };
    this.stop = stop;
    const profile = workspaceAccess.getSnapshot().profile;
    if (profile) try { this.observeStorage(this.context(profile)); } catch { /* Saved authority changed. */ }
    return stop;
  }
  private async json(context: Context, url: string, options: RequestInit = {}): Promise<unknown> {
    this.requireNetwork(context);
    workspaceAccess.assertReadable(context.ticket);
    if (context.verification) {
      if (options.method && options.method !== "GET") throw new RetryFailure("Read-only verification cannot send a saved operation.", "validation");
      this.retries.revalidate(context.verification);
    } else if (context.retryVersion !== undefined && context.retryVersion !== this.retries.version(context.scope))
      this.retries.begin(context.scope, false, false, context.historyReview);
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.ownerSignal?.addEventListener("abort", abort, { once: true });
    this.requests.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          let response: Response;
          try { response = await this.fetcher(url, { ...options, cache: "no-store", credentials: "same-origin", signal: controller.signal }); }
          catch (error) { throw controller.signal.aborted ? cancelled() : transient(error); }
          this.requireNetwork(context);
          return await responseValue(response);
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new RetryFailure("Connection timed out. Local changes remain saved.", "transient")); controller.abort(); }, 8000); }),
        new Promise<never>((_, reject) => { controller.signal.addEventListener("abort", () => reject(cancelled()), { once: true }); }),
      ]);
    } finally { clearTimeout(timer); context.ownerSignal?.removeEventListener("abort", abort); this.requests.delete(controller); }
  }
  private requireNetwork(context?: Context) {
    if (!this.networkActive || context && (context.incarnation !== this.incarnation || context.ownerSignal?.aborted || context.callerSignal?.aborted) ||
        typeof document !== "undefined" && document.visibilityState === "hidden" ||
        typeof navigator !== "undefined" && navigator.onLine === false) throw cancelled();
  }
  private async renewSession(context: Context, attempt?: ReturnType<RetryGate["begin"]>) {
    this.requireNetwork(context);
    const serial = ++this.sessionSerial;
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.ownerSignal?.addEventListener("abort", abort, { once: true });
    this.requests.add(controller);
    try {
      const pending = this.session(controller.signal, attempt), version = this.sessionVersion();
      const session = await Promise.race([pending, new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(cancelled()), { once: true }))]);
      this.requireNetwork(context);
      if (serial !== this.sessionSerial || version !== this.sessionVersion()) throw cancelled();
      context.sessionVersion = version;
      return { ...session, profiles: [...session.profiles] };
    } finally { context.ownerSignal?.removeEventListener("abort", abort); this.requests.delete(controller); }
  }
  private async rows(context: Context): Promise<WorkspaceRows> {
    workspaceAccess.assertReadable(context.ticket);
    const rows = await this.request(context, "workspace") as WorkspaceRows;
    workspaceAccess.assertReadable(context.ticket);
    if (!rows || !Array.isArray(rows.records) || !Array.isArray(rows.outbox)) throw Error("Invalid device storage response.");
    return rows;
  }
  private async refresh(context: Context, notify: boolean): Promise<State | undefined> {
    const rows = await this.rows(context), metadata = rows.metadata;
    const pending = rows.outbox.filter(row => !["accepted", "superseded"].includes(row.status)).length;
    let state: State | undefined;
    const ready = Boolean(metadata?.generation && metadata.cursor >= metadata.download_head);
    if (metadata && ready) {
      const body = JSON.parse(metadata.body);
      if (metadata.profile !== context.profile || body.profile !== context.profile) throw Error("Device records belong to another workspace.");
      const records = rows.records.filter(row => row.body !== "null").map(row => {
        const value = JSON.parse(row.body);
        if (!["task", "goal", "idea"].includes(row.kind) || !value || value.id !== row.id) throw Error("Device record integrity needs attention. Local work was not reset.");
        return { kind: row.kind, value };
      });
      state = { ...body, revision: body.revision + pending,
        tasks: records.filter(row => row.kind === "task").map(row => row.value),
        goals: records.filter(row => row.kind === "goal").map(row => row.value),
        ideas: records.filter(row => row.kind === "idea").map(row => row.value) } as State;
    }
    const adopted = Number(rows.adoptionCounter ?? 0) > Number(this.entry(context).snapshot.adoptionCounter ?? 0);
    const historyChanged = Boolean(rows.historyReview) || !adopted && this.entry(context).snapshot.historyChanged;
    this.publish(context, { ready, state, rows: rows.records, serverRows: rows.acceptedRecords ?? [], queue: rows.outbox, pending,
      historyChanged, historyReview: rows.historyReview ?? null, adoptionCounter: rows.adoptionCounter ?? 0,
      serverGeneration: metadata?.generation ?? rows.historyIdentity?.generation ?? undefined,
      verifiedAt: metadata?.verified_at || undefined, serverRevision: metadata ? Number(JSON.parse(metadata.body).revision) : undefined,
      error: historyChanged ? this.entry(context).snapshot.error : undefined });
    if (notify && state) this.publishState(context.profile, state);
    return state;
  }
  async hydrate(profile: string, recover = false): Promise<State | undefined> {
    let context: Context;
    try { context = this.context(profile); } catch { return; }
    try {
      const state = await this.refresh(context, false);
      if (recover) await this.recoverLocalStorage(context);
      return state;
    }
    catch (error) {
      if (context.incarnation !== this.incarnation || retryReason(error) === "cancelled") return;
      try { this.publish(context, { ready: false, error: (error as Error).message }); } catch { /* Scope changed. */ }
      return;
    }
  }
  private async recoverLocalStorage(context: Context) {
    workspaceAccess.assertReadable(context.ticket);
    this.observeLocalStorage(context);
    const token = this.localStorageFailures.get(context.scope), generation = this.entry(context).snapshot.serverGeneration;
    if (token !== undefined) {
      // Re-read each uncertain immutable attempt through the kernel's recovery
      // transaction before restoring delivery. This does not confer live authority.
      for (const row of (await this.rows(context)).outbox.filter(row => ["pending", "sending"].includes(row.status))) {
        const recovery = await this.request(context, "recover-attempt", { operationId: row.operation_id }) as AttemptRecovery;
        workspaceAccess.assertReadable(context.ticket);
        if (recovery.original.scope !== context.scope || recovery.original.operation_id !== row.operation_id ||
            recovery.original.operation !== row.operation || recovery.original.generation !== row.generation)
          throw new RetryFailure("Device recovery did not confirm the saved operation identity. Keep local work and export recovery evidence.", "storage");
      }
      workspaceAccess.assertReadable(context.ticket);
      if (context.incarnation !== this.incarnation) throw cancelled();
      if (this.entry(context).snapshot.serverGeneration !== generation) throw cancelled();
      if (this.retries.recover(context.scope, "storage", token, "local")) {
        if (this.localStorageFailures.get(context.scope) === token) this.localStorageFailures.delete(context.scope);
        this.publish(context, { storageRecovery: this.localStorageFailures.has(context.scope) });
      }
    }
  }
  private observeLocalStorage(context: Context) {
    const token = this.retries.reasonToken(context.scope, "storage", "local");
    if (token === undefined) {
      if (this.localStorageFailures.delete(context.scope)) this.publish(context, { storageRecovery: false });
      return;
    }
    if (this.localStorageFailures.get(context.scope) === token) return;
    this.localStorageFailures.set(context.scope, token);
    this.publish(context, { storageRecovery: true, error: "Device storage needs explicit verification. Saved work remains on this device." });
  }
  private observeStorage(context: Context) {
    this.observeLocalStorage(context);
    this.observeServerStorage(context);
  }
  private observeServerStorage(context: Context) {
    const token = this.retries.reasonToken(context.scope, "storage", "server");
    if (token === undefined || this.serverStorageFailures.get(context.scope)?.token === token) return;
    this.serverStorageFailures.set(context.scope, { token, generation: this.entry(context).snapshot.serverGeneration });
    this.entry(context).recoveryReadOnly = true;
    this.publish(context, { serverStorageRecovery: true, error: "Server storage needs explicit verification. Saved work remains on this device." });
    const access = workspaceAccess.getSnapshot();
    if (access.canWrite || access.onlineAdmission) workspaceAccess.fail("Server storage needs verification. Saved records and drafts remain available.");
  }
  requiresReadOnlyRecovery(profile: string) {
    try { const context = this.context(profile); return this.retries.has(context.scope, "history") || this.retries.has(context.scope, "storage"); }
    catch { return false; }
  }
  requiresExplicitAdmission(profile: string) {
    try { return Boolean(this.entry(this.context(profile)).recoveryReadOnly); } catch { return false; }
  }
  completeExplicitAdmission(profile: string) {
    const context = this.context(profile), access = workspaceAccess.assertReadable(context.ticket);
    if (!access.onlineAdmission || this.retries.inspect(context.scope).paused) throw Error("Resolve the saved recovery pause before returning to ordinary admission.");
    const entry = this.entry(context); entry.recoveryReadOnly = false; entry.verification = undefined;
    this.publish(context, { verificationReady: false });
  }
  private assertVerification(context: Context, generation?: string) {
    this.requireNetwork(context);
    workspaceAccess.assertReadable(context.ticket);
    const scope = workspaceAccess.readScope(context.profile);
    if (!scope || scope.readEpoch !== context.deviceEpoch.readEpoch || scope.draftEpoch !== context.deviceEpoch.draftEpoch ||
        context.sessionVersion !== this.sessionVersion() || this.entry(context).snapshot.serverGeneration !== generation) throw cancelled();
  }
  private hasVerification(context: Context) {
    const proof = this.entry(context).verification;
    if (!proof || proof.context.ticket.epoch !== context.ticket.epoch) return false;
    try { this.assertVerification(proof.context, proof.generation); return true; } catch { return false; }
  }
  private async verificationPipeline(profile: string, purpose: "admission" | "storage", task: (context: Context, generation?: string) => Promise<void>, signal?: AbortSignal) {
    this.requireNetwork();
    const context = this.context(profile), entry = this.entry(context);
    while (entry.preparing || entry.syncing || entry.reviewing || entry.verifying) await (entry.preparing ?? entry.syncing ?? entry.reviewing ?? entry.verifying);
    this.requireNetwork(context); workspaceAccess.assertReadable(context.ticket);
    if (signal?.aborted) throw cancelled();
    const attempt = this.retries.verify(context.scope, purpose), controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
    this.requests.add(controller); context.ownerSignal = controller.signal; context.callerSignal = signal; context.verification = attempt;
    entry.recoveryReadOnly = true;
    const generation = entry.snapshot.serverGeneration;
    const pending = (async () => {
      this.publish(context, { verifying: true, verificationReady: false });
      try {
        const session = await this.renewSession(context, attempt);
        this.assertVerification(context, generation);
        if (session.installationId !== context.ticket.installationId || session.variant !== context.ticket.variant || !session.profiles.includes(profile))
          throw new RetryFailure("The verification session does not admit this saved workspace.", "auth");
        await task(context, generation);
        this.assertVerification(context, generation);
        entry.verification = { context, generation };
        this.publish(context, { verificationReady: true });
      } catch (error) {
        if (context.incarnation === this.incarnation && context.ticket.epoch === workspaceAccess.getSnapshot().epoch && retryReason(error) !== "cancelled") {
          this.retries.fail(context.scope, error); this.observeServerStorage(context);
          try { this.publish(context, { error: (error as Error).message, historyChanged: retryReason(error) === "history" || entry.snapshot.historyChanged }); } catch { /* Retired authority. */ }
        }
        throw error;
      } finally {
        this.requests.delete(controller); signal?.removeEventListener("abort", abort); this.retries.finish(attempt, false); entry.verifying = undefined;
        if (context.incarnation === this.incarnation) try { this.publish(context, { verifying: false }); } catch { /* Retired authority. */ }
      }
    })();
    entry.verifying = pending;
    return pending;
  }
  verifyAdmission(profile: string, signal?: AbortSignal) {
    // The private ticket authorizes history/recovery GETs only. It never enters
    // WorkspaceAccess or ProfileCache's normal live-read admission path.
    return this.verificationPipeline(profile, "admission", async () => {}, signal);
  }
  verifyServerStorage(profile: string) {
    const context = this.context(profile), failure = this.serverStorageFailures.get(context.scope);
    if (!failure) return Promise.reject(Error("There is no captured server-storage failure to verify."));
    return this.verificationPipeline(profile, "storage", async (current, generation) => {
      if (this.retries.reasonToken(current.scope, "storage", "server") !== failure.token) throw cancelled();
      const state = await this.json(current, `/api/${profile.toLowerCase()}/state?view=replica`) as State;
      this.assertVerification(current, generation);
      if (this.retries.reasonToken(current.scope, "storage", "server") !== failure.token) throw cancelled();
      if (!state || state.profile !== profile || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
          typeof state.syncGeneration !== "string" || !state.syncGeneration ||
          ![state.goals, state.tasks, state.recommendations, state.events].every(Array.isArray))
        throw new RetryFailure("The server-storage verification response is invalid.", "validation");
      if (generation && state.syncGeneration !== generation)
        throw new RetryFailure("Server history changed. Review saved work before adopting it.", "history", undefined, "history-changed");
      if (!this.retries.recover(current.scope, "storage", failure.token, "server")) throw cancelled();
      if (this.serverStorageFailures.get(current.scope)?.token === failure.token) this.serverStorageFailures.delete(current.scope);
      this.publish(current, { serverStorageRecovery: this.serverStorageFailures.has(current.scope) });
    });
  }
  private async failure(context: Context, error: unknown, notify: boolean): Promise<State | undefined> {
    if (context.incarnation !== this.incarnation || context.ticket.epoch !== workspaceAccess.getSnapshot().epoch || retryReason(error) === "cancelled") return;
    this.retries.fail(context.scope, error);
    if (retryReason(error) === "auth") this.authEpochs.set(context.scope, context.ticket.epoch);
    if (retryReason(error) === "storage" && !(error instanceof RetryFailure)) this.localStorageFailures.set(context.scope, this.retries.reasonToken(context.scope, "storage", "local")!);
    this.observeServerStorage(context);
    if (context.ticket.epoch !== workspaceAccess.getSnapshot().epoch) return;
    let saved: State | undefined;
    let storageAvailable = true;
    try { saved = await this.refresh(context, notify); }
    catch { storageAvailable = false; }
    try {
      this.publish(context, { ...(!storageAvailable ? { ready: false } : {}),
        storageRecovery: this.localStorageFailures.has(context.scope),
        serverStorageRecovery: this.serverStorageFailures.has(context.scope),
        error: error instanceof Error ? error.message : "Device synchronization needs attention.",
        historyChanged: (error as { code?: string } | null)?.code === "history-changed" || this.entry(context).snapshot.historyChanged });
    } catch { /* The original workspace is no longer readable. */ }
    return saved;
  }
  overlay(profile: string, remote: State): State {
    const local = this.getSnapshot(profile);
    return local.pending && local.state ? { ...remote, tasks: local.state.tasks, goals: local.state.goals, ideas: local.state.ideas,
      revision: local.state.revision } : remote;
  }
  private async pull(context: Context): Promise<void> {
    const entry = this.entry(context);
    while (entry.pulling) await entry.pulling;
    workspaceAccess.assertReadable(context.ticket);
    entry.pulling = this.download(context).finally(() => { entry.pulling = undefined; });
    return entry.pulling;
  }
  private async download(context: Context) {
    let boundary: { head: number; generation: string } | undefined;
    for (let page = 0; page < 100; page++) {
      workspaceAccess.assertReadable(context.ticket);
      const current = await this.rows(context), after = current.metadata?.cursor ?? 0;
      if (!boundary) {
        const source = current.stagedMetadata ?? current.metadata;
        const cursor = source ? (JSON.parse(source.body) as State).syncCursor : undefined;
        if (typeof cursor === "number" && cursor >= after && source?.generation)
          boundary = { head: cursor, generation: source.generation };
      }
      const query = new URLSearchParams({ after: String(after) });
      if (boundary) { query.set("head", String(boundary.head)); query.set("generation", boundary.generation); }
      const feed = await this.json(context, `/api/${context.profile.toLowerCase()}/changes?${query}`) as RemoteFeed & { more: boolean };
      workspaceAccess.assertReadable(context.ticket);
      if (boundary && feed.generation !== boundary.generation)
        throw Object.assign(Error("Server history changed. Review saved local changes before reconnecting."), { code: "history-changed" });
      if (boundary && (feed.head ?? feed.cursor) !== boundary.head)
        throw new RetryFailure("The record download changed its boundary. Saved work remains on this device.", "validation");
      await this.request(context, "pull", { after, feed });
      boundary ??= { head: feed.head ?? feed.cursor, generation: feed.generation };
      if (!feed.more) return;
    }
    throw Error("Offline preparation paused. Reconnect to continue the remaining download.");
  }
  async ingest(profile: string, state: State): Promise<State | undefined> {
    let context: Context;
    try { context = this.context(profile); } catch { return; }
    const entry = this.entry(context);
    if (entry.recoveryReadOnly) return this.refresh(context, false);
    while (entry.preparing || entry.syncing || entry.reviewing || entry.verifying) await (entry.preparing ?? entry.syncing ?? entry.reviewing ?? entry.verifying);
    workspaceAccess.assertReadable(context.ticket);
    try { context.retryVersion = this.retries.begin(context.scope).revision; } catch { return this.refresh(context, false); }
    entry.preparing = (async () => {
      try {
        await this.request(context, "configure", { profile, state });
        workspaceAccess.assertReadable(context.ticket);
        await this.pull(context);
        const current = await this.refresh(context, false);
        this.publish(context, { historyChanged: false });
        return current;
      } catch (error) {
        return this.failure(context, error, false);
      } finally { entry.preparing = undefined; }
    })();
    return entry.preparing;
  }
  async enqueue(profile: string, operation: SyncOperation, title: string, record: unknown, baselineVersion?: number,
    expectedGeneration = this.getSnapshot(profile).state?.syncGeneration) {
    const context = this.context(profile);
    if (!this.canEdit(profile)) throw Error("Persistent offline editing is not ready. Keep your draft open and retry.");
    let result;
    try {
      result = await this.request(context, "enqueue", { operationId: operation.operationId,
        kind: operation.kind, id: operation.id, title, operation, record, baselineVersion, expectedGeneration });
    } catch (error) {
      // Recover queue visibility even when the caller still needs to resolve
      // its interrupted confirmation using the original operation identity.
      await this.failure(context, error, true);
      throw error;
    }
    try { await this.refresh(context, true); await this.recoverLocalStorage(context); }
    catch (error) { await this.failure(context, error, true); }
    void this.synchronize(profile);
    return result;
  }
  async resolve(profile: string, operationId: string, choice: "server" | "local", review: ResolutionReview) {
    const context = this.context(profile);
    if (!this.canEdit(profile)) throw Error("Restore device storage before resolving saved changes.");
    try { await this.request(context, "resolve", { operationId, choice, resolutionId: crypto.randomUUID(), review }); }
    catch (error) {
      try { await this.refresh(context, true); } catch { /* Scope or storage changed. */ }
      throw error;
    }
    await this.refresh(context, true);
    this.retries.recover(context.scope, "validation");
    void this.synchronize(profile);
  }
  async recoverAttempt(profile: string, operationId: string): Promise<AttemptRecovery> {
    const context = this.context(profile);
    const result = await this.request(context, "recover-attempt", { operationId }) as AttemptRecovery;
    workspaceAccess.assertReadable(context.ticket);
    return result;
  }
  async recordIdentity(profile: string, kind: string, id: string, generation: string, review?: IdentityReview): Promise<{ id: string; generation: string }> {
    const context = this.context(profile);
    const result = await this.request(context, review ? "review-record-identity" : "record-identity", { kind, id, generation, ...(review ? { review } : {}) }) as { id: string; generation: string };
    workspaceAccess.assertReadable(context.ticket);
    return result;
  }
  private async historySession(context: Context, attempt: ReturnType<RetryGate["begin"]>) {
    this.requireNetwork();
    this.assertHistoryAccess(context);
    const session = await this.renewSession(context, attempt);
    if (session.installationId !== context.ticket.installationId || session.variant !== context.ticket.variant || !session.profiles.includes(context.profile))
      throw Error("The renewed session no longer admits this saved workspace. Reconnect before reviewing restored history.");
    this.entry(context).verification = { context: { ...context }, generation: this.entry(context).snapshot.serverGeneration };
    this.assertHistoryAccess(context);
  }
  private assertHistoryAccess(context: Context) {
    const access = workspaceAccess.assertReadable(context.ticket);
    // A restored model cannot establish ordinary command authority before
    // adoption. Fresh session admission can authorize this local review only.
    if ((!access.onlineAdmission && !this.hasVerification(context)) || access.profile !== context.profile)
      throw Error("Reconnect to this workspace before reviewing restored history. Saved records and drafts remain on this device.");
  }
  /** One foreground pipeline per admitted scope. The durable worker marker is
   * the invariant; these promises only avoid overlapping network requests. */
  private async historyPipeline<T>(profile: string, task: (context: Context) => Promise<T>): Promise<T> {
    this.requireNetwork();
    const context = this.context(profile), entry = this.entry(context);
    while (entry.preparing || entry.syncing || entry.reviewing || entry.verifying) await (entry.preparing ?? entry.syncing ?? entry.reviewing ?? entry.verifying);
    this.assertHistoryAccess(context);
    const attempt = this.retries.verify(context.scope, "history");
    context.retryVersion = attempt.revision; context.historyReview = true; context.verification = attempt;
    const pending = (async () => {
      this.publish(context, { reviewing: true });
      try { await this.historySession(context, attempt); return await task(context); }
      catch (error) { await this.failure(context, error, true); throw error; }
      finally {
        this.retries.finish(attempt, false);
        try { await this.refresh(context, true); this.publish(context, { reviewing: false }); }
        catch { /* Never publish into another installation after a scope change. */ }
        entry.reviewing = undefined;
      }
    })();
    entry.reviewing = pending;
    return pending;
  }
  async reviewHistory(profile: string, restart = false): Promise<HistoryComparison> {
    return this.historyPipeline(profile, async context => {
      let review = (await this.rows(context)).historyReview;
      if (!review || restart) {
        const state = await this.json(context, `/api/${profile.toLowerCase()}/state?view=replica`) as State;
        this.assertHistoryAccess(context);
        await this.request(context, "begin-history-review", { profile, state, reviewId: crypto.randomUUID(), ...(restart && review ? { replaceReviewId: review.review_id } : {}) });
        review = (await this.rows(context)).historyReview;
      }
      if (!review) throw Error("Restored-history preparation did not confirm its identity. Keep local work and retry.");
      for (let page = 0; page < 100 && review.cursor < review.head; page++) {
        this.assertHistoryAccess(context);
        const query = new URLSearchParams({ after: String(review.cursor), head: String(review.head), generation: review.generation });
        const feed = await this.json(context, `/api/${profile.toLowerCase()}/changes?${query}`) as RemoteFeed;
        this.assertHistoryAccess(context);
        await this.request(context, "pull-history-review", { reviewId: review.review_id, after: review.cursor, feed });
        review = (await this.rows(context)).historyReview;
        if (!review) throw Error("Restored-history review changed in another form. Reopen the comparison.");
      }
      return await this.request(context, "compare-history", { reviewId: review.review_id }) as HistoryComparison;
    });
  }
  async adoptHistory(profile: string, comparison: HistoryComparison, adoptionId: string) {
    return this.historyPipeline(profile, async context => {
      // Retry the exact receipt after a lost confirmation before comparing the
      // current server. A historical receipt cannot switch today's history.
      const prior = await this.request(context, "history-adoption", { adoptionId }) as ReturnType<LocalReplica["historyAdoption"]>;
      if (prior) {
        // Replay through the kernel still verifies the immutable comparison.
        const result = await this.request(context, "adopt-history", { adoptionId, reviewId: comparison.review.review_id,
          comparison: comparison.comparison, verifiedGeneration: comparison.review.generation });
        this.assertHistoryAccess(context); this.retries.recover(context.scope, "history");
        return result;
      }
      const state = await this.json(context, `/api/${profile.toLowerCase()}/state?view=replica`) as State;
      this.assertHistoryAccess(context);
      if (state.profile !== profile) throw Error("The restored-history confirmation belongs to another workspace.");
      const payload = { adoptionId, reviewId: comparison.review.review_id, comparison: comparison.comparison, verifiedGeneration: state.syncGeneration };
      let result: unknown;
      try { result = await this.request(context, "adopt-history", payload); }
      catch (error) {
        const committed = await this.request(context, "history-adoption", { adoptionId }) as ReturnType<LocalReplica["historyAdoption"]>;
        if (!committed) throw error;
        result = await this.request(context, "adopt-history", payload);
      }
      this.assertHistoryAccess(context);
      const current = await this.rows(context);
      if (current.metadata?.generation === state.syncGeneration && !current.historyReview) {
        this.retries.recover(context.scope, "history"); workspaceAccess.confirmLive(context.ticket);
      }
      return result;
    });
  }
  async retry(profile: string, operationId: string) {
    const context = this.context(profile);
    const row = (await this.rows(context)).outbox.find(row => row.operation_id === operationId);
    if (!row || row.status !== "pending") throw Error("This saved change requires reconnection or correction before retrying.");
    await this.synchronize(profile, true);
  }
  async synchronize(profile: string, explicit = false): Promise<void> {
    try { this.requireNetwork(); } catch (error) { if (explicit) throw error; return; }
    let context: Context;
    try { context = this.context(profile); workspaceAccess.assertLive(context.ticket); } catch (error) { if (explicit) throw error; return; }
    const entry = this.entry(context);
    if (entry.recoveryReadOnly) { if (explicit) throw Error("Reconnect explicitly after read-only recovery before sending saved changes."); return; }
    if (entry.snapshot.historyChanged && explicit) throw new RetryDeferred(Infinity, "history");
    if (entry.syncing || entry.snapshot.historyChanged || entry.reviewing || entry.verifying) return entry.syncing;
    try {
      while (entry.preparing) await entry.preparing;
      workspaceAccess.assertLive(context.ticket);
    } catch { return; }
    if (entry.syncing || entry.snapshot.historyChanged || entry.reviewing || entry.verifying) return entry.syncing;
    let attempt: ReturnType<RetryGate["begin"]>;
    const freshAdmission = this.retries.inspect(context.scope).paused === "auth" && this.authEpochs.has(context.scope) && this.authEpochs.get(context.scope) !== context.ticket.epoch;
    try { attempt = this.retries.begin(context.scope, explicit, freshAdmission); } catch (error) { if (explicit) throw error; return; }
    context.retryVersion = attempt.revision;
    entry.syncContext = context;
    entry.syncing = (async () => {
      this.publish(context, { syncing: true });
      try {
        this.requireNetwork();
        const session = await this.renewSession(context, attempt);
        workspaceAccess.assertLive(context.ticket);
        const access = workspaceAccess.getSnapshot();
        if (session.installationId !== access.installationId || session.variant !== access.variant || !session.profiles.includes(profile)) {
          this.retries.fail(context.scope, new RetryFailure("The renewed session belongs to another installation or workspace.", "validation"));
          workspaceAccess.fail("The renewed session no longer admits this workspace. Its pending work remains saved in the original scope.", true);
          throw Error("The renewed session belongs to another installation or workspace. Pending work remains saved.");
        }
        if (freshAdmission) {
          const version = this.retries.version(context.scope);
          this.retries.recover(context.scope, "auth"); this.authEpochs.delete(context.scope);
          if (version === attempt.revision) { attempt.revision = this.retries.version(context.scope); context.retryVersion = attempt.revision; }
        }
        if (!entry.snapshot.ready) {
          await this.configureFromServer(context);
          await this.pull(context);
          await this.refresh(context, false);
          if (!entry.snapshot.ready) throw Error("Device records are still downloading. Retry synchronization to continue; local changes remain saved.");
        }
        for (const row of (await this.rows(context)).outbox.filter(row => row.status === "auth-required"))
          await this.request(context, "mark", { operationId: row.operation_id, status: "pending" });
        for (let count = 0; count < 200; count++) {
          workspaceAccess.assertLive(context.ticket);
          const row = await this.request(context, "next") as QueueRow | null;
          if (!row) break;
          await this.request(context, "mark", { operationId: row.operation_id, status: "sending" });
          await this.refresh(context, false);
          try {
            workspaceAccess.assertLive(context.ticket);
            const receipt = await this.json(context, `/api/${profile.toLowerCase()}/sync`, { method: "POST",
              headers: { "Content-Type": "application/json", "X-Vorton-Session": session.token },
              body: JSON.stringify({ protocol: SYNC_PROTOCOL, generation: row.generation, operation: JSON.parse(row.operation) }) });
            // Record a confirmed reply in its original scope even if the tab
            // switched workspaces while the server was committing it.
            await this.request(context, "reconcile", { receipt });
          } catch (error) {
            const reason = retryReason(error);
            const status = reason === "auth" ? "auth-required" : reason === "validation" && !policyFailure((error as RetryFailure).code) ? "failed" : "pending";
            await this.request(context, "mark", { operationId: row.operation_id, status, error: (error as Error).message.slice(0, 2000) });
            if (status !== "failed") throw error;
            this.retries.fail(context.scope, error);
            context.retryVersion = this.retries.version(context.scope); // Independent records may continue after this confirmed validation rejection.
          }
          await this.refresh(context, true);
        }
        workspaceAccess.assertLive(context.ticket);
        await this.configureFromServer(context);
        await this.pull(context);
        await this.refresh(context, true);
        this.retries.finish(attempt, true);
      } catch (error) {
        await this.failure(context, error, true);
      } finally {
        this.retries.finish(attempt, false);
        entry.syncing = undefined;
        entry.syncContext = undefined;
        entry.snapshot = { ...entry.snapshot, syncing: false };
        this.listeners.get(profile)?.forEach(listener => listener());
      }
    })();
    return entry.syncing;
  }
  private async configureFromServer(context: Context) {
    workspaceAccess.assertLive(context.ticket);
    const state = await this.json(context, `/api/${context.profile.toLowerCase()}/state?view=replica`) as State;
    workspaceAccess.assertLive(context.ticket);
    if (state.profile !== context.profile) throw Error("Workspace identity changed while refreshing.");
    await this.request(context, "configure", { profile: context.profile, state });
  }
}
