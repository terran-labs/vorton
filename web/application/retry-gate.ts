export type RetryReason = "transient" | "auth" | "history" | "storage" | "validation" | "cancelled";
export type StorageOrigin = "local" | "server";
export type RetryAttempt = { key: string; revision: number; id: number; verification?: "admission" | "history" | "storage" };
export const policyFailure = (code?: string) => code === "http-policy-changed" || code === "http-policy-unsupported";
export class RetryFailure extends Error {
  readonly reason: RetryReason;
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, reason: RetryReason, status?: number, code?: string) { super(message); this.reason = reason; this.status = status; this.code = code; }
}
export class RetryDeferred extends Error {
  readonly remaining: number;
  readonly reason?: RetryReason;
  constructor(remaining: number, reason?: RetryReason) { super(reason ? `Synchronization paused: ${reason}.` : "Waiting before retrying the saved attempt."); this.remaining = remaining; this.reason = reason; }
}
export function retryReason(error: unknown): RetryReason {
  if (error instanceof RetryFailure) return error.reason;
  if (error instanceof RetryDeferred || (error as { name?: string })?.name === "AbortError") return "cancelled";
  const code = (error as { code?: string })?.code;
  if (code === "history-changed") return "history";
  if (policyFailure(code)) return "validation";
  if (["storage-corrupt", "migration-required", "storage-unavailable"].includes(code ?? "")) return "storage";
  // Unclassified errors outside the transport boundary are local failures.
  return "storage";
}
export const cancelled = () => new RetryFailure("The request owner is no longer active. Saved changes remain on this device.", "cancelled");
export const transient = (error: unknown) => error instanceof RetryFailure ? error : new RetryFailure(error instanceof Error ? error.message : "Connection unavailable", "transient");

/** One timing policy for admission, reads and delivery in the same saved scope.
 * Access/device epochs fence work, but never erase a scope's retry deadline. */
export class RetryGate {
  private states = new Map<string, { failures: number; until: number; pauses: Map<RetryReason, string | undefined>; tokens: Map<RetryReason, number>; storage: Map<StorageOrigin, number>; revision: number; bypass?: number; seen: WeakSet<object> }>();
  private sequence = 0;
  private listeners = new Set<() => void>();
  private now: () => number;
  private random: () => number;
  constructor(now = () => Date.now(), random = () => Math.random()) { this.now = now; this.random = random; }
  private state(key: string) {
    let state = this.states.get(key);
    if (!state) { state = { failures: 0, until: 0, pauses: new Map(), tokens: new Map(), storage: new Map(), revision: 0, seen: new WeakSet() }; this.states.set(key, state); }
    return state;
  }
  inspect(key: string) { const s = this.state(key); return { failures: s.failures, remaining: Math.max(0, s.until - this.now()), paused: Array.from(s.pauses.keys()).at(-1) }; }
  version(key: string) { return this.state(key).revision; }
  has(key: string, reason: RetryReason) { return this.state(key).pauses.has(reason); }
  reasonToken(key: string, reason: RetryReason, origin?: StorageOrigin) { const s = this.state(key); return reason === "storage" && origin ? s.storage.get(origin) : s.tokens.get(reason); }
  begin(key: string, explicit = false, admission = false, historyReview = false): RetryAttempt {
    return this.open(key, explicit, reason => admission && reason === "auth" || historyReview && reason === "history");
  }
  /** These tickets authorize GET-only recovery, never ordinary delivery. */
  verify(key: string, purpose: NonNullable<RetryAttempt["verification"]>): RetryAttempt {
    return { ...this.open(key, true, reason => ["auth", "history", "storage"].includes(reason)), verification: purpose };
  }
  revalidate(ticket: RetryAttempt) {
    if (ticket.revision !== this.version(ticket.key)) this.open(ticket.key, false, reason => Boolean(ticket.verification) && ["auth", "history", "storage"].includes(reason));
  }
  private open(key: string, explicit: boolean, allowed: (reason: RetryReason) => boolean) {
    const s = this.state(key);
    const id = ++this.sequence;
    for (const reason of s.pauses.keys()) if (!allowed(reason)) throw new RetryDeferred(Infinity, reason);
    if (s.until > this.now()) {
      if (!explicit || s.bypass) throw new RetryDeferred(s.until - this.now());
      s.bypass = id;
    }
    return { key, revision: s.revision, id };
  }
  finish(ticket: RetryAttempt, success: boolean) {
    const s = this.state(ticket.key);
    if (s.bypass === ticket.id) s.bypass = undefined;
    if (success && !ticket.verification && ticket.revision === s.revision && !s.pauses.size) { s.failures = 0; s.until = 0; this.emit(); }
  }
  fail(key: string, error: unknown, origin?: StorageOrigin) {
    const reason = retryReason(error), s = this.state(key);
    if (reason === "cancelled") return;
    if (error && typeof error === "object") { if (s.seen.has(error)) return; s.seen.add(error); }
    s.revision++;
    if (reason !== "transient") {
      const code = (error as { code?: string })?.code;
      const token = ++this.sequence;
      s.tokens.set(reason, token);
      if (reason === "storage") s.storage.set(origin ?? (error instanceof RetryFailure && ["storage-corrupt", "migration-required", "storage-unavailable"].includes(code ?? "") ? "server" : "local"), token);
      if (!policyFailure(s.pauses.get(reason))) s.pauses.set(reason, code);
    }
    else {
      const ceiling = Math.min(60_000, 2000 * 2 ** Math.min(s.failures++, 5));
      s.until = this.now() + ceiling / 2 + this.random() * ceiling / 2;
    }
    this.emit();
  }
  recover(key: string, reason: RetryReason, token?: number, origin?: StorageOrigin) {
    const s = this.state(key);
    if (reason === "validation" && policyFailure(s.pauses.get(reason))) return false;
    if (reason === "storage") {
      if (!origin || token === undefined || s.storage.get(origin) !== token) return false;
      s.storage.delete(origin);
      if (!s.storage.size) { s.pauses.delete(reason); s.tokens.delete(reason); }
      s.revision++; this.emit(); return true;
    }
    if (s.pauses.has(reason) && (token === undefined || token === s.tokens.get(reason))) { s.pauses.delete(reason); s.tokens.delete(reason); s.revision++; this.emit(); return true; }
    return false;
  }
  inherit(from: string, to: string) {
    if (from === to) return;
    const source = this.state(from), target = this.state(to);
    target.failures = Math.max(source.failures, target.failures);
    target.until = Math.max(source.until, target.until);
    for (const [reason, code] of source.pauses) if (!target.pauses.has(reason) || policyFailure(code)) target.pauses.set(reason, code);
    for (const [reason, token] of source.tokens) if (token > (target.tokens.get(reason) ?? 0)) target.tokens.set(reason, token);
    for (const [origin, token] of source.storage) if (token > (target.storage.get(origin) ?? 0)) target.storage.set(origin, token);
    target.revision++;
    this.emit();
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(); }
}
export const retryGate = new RetryGate();
export function retryScope(access: { variant: string; installationId: string | null; profile?: string | null }, profile = access.profile ?? "admission") {
  return `${access.variant}/${access.installationId ?? "unadmitted"}/${profile}/owner`;
}

/** Inspect status even when a proxy returns HTML or an empty auth response. */
export async function responseValue(response: Response): Promise<unknown> {
  let value: { error?: unknown; code?: unknown } | undefined;
  try { value = await response.json(); }
  catch (error) {
    if (response.ok) throw error instanceof SyntaxError
      ? new RetryFailure("Invalid server response. Saved changes need review.", "validation") : transient(error);
  }
  if (!response.ok) {
    const code = typeof value?.code === "string" ? value.code : undefined;
    const reason: RetryReason = response.status === 401 || response.status === 403 ? "auth" : code === "history-changed" ? "history"
      : ["storage-corrupt", "migration-required", "storage-unavailable"].includes(code ?? "") ? "storage" : policyFailure(code) ? "validation" : response.status >= 500 ? "transient" : "validation";
    throw new RetryFailure(typeof value?.error === "string" ? value.error.slice(0, 2000) : `Request failed (${response.status})`, reason, response.status, code);
  }
  return value;
}
