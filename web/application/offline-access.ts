import type { OfflineScope, OfflineVariant, SavedAdmission, OfflineStoreChange } from "./offline-store.ts";

export type WorkspaceAccessSnapshot = {
  managed: boolean; installationId: string | null; variant: OfflineVariant;
  onlineAdmission: boolean;
  profile: string | null; admittedProfiles: readonly string[]; canWrite: boolean;
  verifiedAt: number | null; epoch: number; scope?: OfflineScope;
  status: "loading" | "saved" | "reconciling" | "live" | "cleared" | "forgotten";
  message?: string;
};
export type WorkspaceAccessTicket = Pick<WorkspaceAccessSnapshot, "installationId" | "variant" | "profile" | "epoch">;

/** Saved admission is a read boundary, never a substitute for live authority.
 * The managed flag is sticky so a failed managed app cannot become legacy.
 */
export class WorkspaceAccess {
  private snapshot: WorkspaceAccessSnapshot = Object.freeze({ managed: false, onlineAdmission: false, installationId: null, variant: "portable", profile: null, admittedProfiles: Object.freeze([]), canWrite: false, verifiedAt: null, epoch: 0, status: "loading" });
  private listeners = new Set<() => void>();
  private onlineAdmission = false;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<WorkspaceAccessSnapshot>) {
    this.snapshot = Object.freeze({ ...this.snapshot, ...update, onlineAdmission: this.onlineAdmission, admittedProfiles: update.admittedProfiles ? Object.freeze([...update.admittedProfiles]) : this.snapshot.admittedProfiles, scope: "scope" in update ? update.scope ? Object.freeze({ ...update.scope }) : undefined : this.snapshot.scope });
    this.listeners.forEach(listener => listener());
  }
  manage(variant: OfflineVariant) {
    this.onlineAdmission = false;
    this.publish({ managed: true, variant, installationId: null, profile: null, admittedProfiles: [], scope: undefined, verifiedAt: null, canWrite: false, status: "loading", epoch: this.snapshot.epoch + 1, message: undefined });
  }
  restore(admission: SavedAdmission, scope: OfflineScope) {
    if (!this.snapshot.managed || ["cleared", "forgotten"].includes(this.snapshot.status) || admission.variant !== this.snapshot.variant || scope.variant !== admission.variant || scope.installationId !== admission.installationId || this.onlineAdmission) return;
    this.publish({ installationId: admission.installationId, admittedProfiles: admission.profiles, verifiedAt: admission.verifiedAt, scope, status: "saved", canWrite: false, epoch: this.snapshot.epoch + 1 });
  }
  beginReconcile(explicit = false): boolean {
    if (!explicit && ["cleared", "forgotten"].includes(this.snapshot.status)) return false;
    this.onlineAdmission = false;
    this.publish({ canWrite: false, status: "reconciling", epoch: this.snapshot.epoch + 1, message: undefined });
    return true;
  }
  admitOnline(admission: SavedAdmission, scope?: OfflineScope, ready = true) {
    if (admission.variant !== this.snapshot.variant) throw new Error("Installation variant changed. Reopen this application.");
    if (scope && (scope.variant !== admission.variant || scope.installationId !== admission.installationId)) throw new Error("Saved storage belongs to another installation.");
    this.onlineAdmission = ready;
    const sameIdentity = admission.installationId === this.snapshot.installationId;
    const readableScope = !ready && sameIdentity && !scope ? this.snapshot.scope : scope;
    this.publish({ installationId: admission.installationId, admittedProfiles: admission.profiles, scope: readableScope, verifiedAt: admission.verifiedAt, canWrite: false, status: "reconciling", profile: sameIdentity && this.snapshot.profile && admission.profiles.includes(this.snapshot.profile) ? this.snapshot.profile : null, epoch: this.snapshot.epoch + 1, message: sameIdentity ? undefined : this.snapshot.installationId ? "The installation changed. Previous saved records are hidden; drafts remain in their original installation." : undefined });
  }
  setProfile(profile: string | null) {
    if (profile === this.snapshot.profile) return;
    this.publish({ profile, canWrite: false, epoch: this.snapshot.epoch + 1 });
  }
  fail(message: string, rejected = false) {
    this.onlineAdmission = false;
    this.publish({ canWrite: false, status: "saved", message, ...(rejected ? { admittedProfiles: [], profile: null, scope: undefined } : {}), epoch: this.snapshot.epoch + 1 });
  }
  assertReadable(ticket: WorkspaceAccessTicket): WorkspaceAccessSnapshot {
    const value = this.snapshot;
    if (!value.managed || !value.installationId || ticket.installationId !== value.installationId || ticket.variant !== value.variant || ticket.epoch !== value.epoch || !ticket.profile || !value.admittedProfiles.includes(ticket.profile) || ["cleared", "forgotten"].includes(value.status)) throw new Error("This saved read belongs to an unavailable installation or an older connection.");
    return value;
  }
  assertLive(ticket: WorkspaceAccessTicket): WorkspaceAccessSnapshot {
    const value = this.assertReadable(ticket);
    if (!value.canWrite || value.profile !== ticket.profile || !this.onlineAdmission) throw new Error("Reconnect and refresh this workspace before submitting. Your draft remains on this device.");
    return value;
  }
  confirmLive(ticket: WorkspaceAccessTicket): boolean {
    try { this.assertReadable(ticket); } catch { return false; }
    if (!this.onlineAdmission || ticket.profile !== this.snapshot.profile) return false;
    this.publish({ canWrite: true, status: "live", message: undefined });
    return true;
  }
  readScope(profile: string): OfflineScope | undefined {
    const value = this.snapshot;
    return value.managed && value.admittedProfiles.includes(profile) && !["cleared", "forgotten"].includes(value.status) ? value.scope : undefined;
  }
  storageChanged(change: OfflineStoreChange) {
    const value = this.snapshot;
    if (change.installationId !== value.installationId || change.variant !== value.variant) return;
    if (value.scope && change.readEpoch <= value.scope.readEpoch && change.draftEpoch <= value.scope.draftEpoch) return;
    this.onlineAdmission = false;
    this.publish({ canWrite: false, status: change.type === "FORGOTTEN" ? "forgotten" : "cleared", scope: change.type === "FORGOTTEN" ? undefined : { installationId: change.installationId, variant: change.variant, readEpoch: change.readEpoch, draftEpoch: change.draftEpoch }, ...(change.type === "FORGOTTEN" ? { admittedProfiles: [], profile: null } : {}), epoch: value.epoch + 1, message: change.type === "FORGOTTEN" ? "Local installation data was forgotten. Reconnect explicitly to enable saving again." : "Saved reads were cleared. Reconnect explicitly to save fresh records." });
  }
}

export const workspaceAccess = new WorkspaceAccess();
