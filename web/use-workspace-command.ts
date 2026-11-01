import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Profile } from "./types";
import { loadSession, profileCache, profileReplica } from "./application/profile-cache";
import { localCommand, recoveredLocalCommand, supportsLocalCommand } from "./application/local-command";
import { workspaceAccess } from "./application/offline-context";
import { captureReadTicket, isOfflineScopeCurrent, saveVerifiedModel } from "./application/offline-store";
import { submitExplicitCommand, type DraftPreconditions, type DraftSubmitResult } from "./forge-draft-submit";

// Share the foreground lock between the page editor and shell capture. Canonical
// revision checks still decide conflicts; this lock never queues or replays work.
const pending = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export function useWorkspaceCommand(profile: Profile, onReadError?: (message: string) => void) {
  const activeProfile = useRef(profile);
  activeProfile.current = profile;
  const [error, setError] = useState("");
  const clearError = useCallback(() => setError(""), []);
  useEffect(() => { setError(""); }, [profile]);
  const busy = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => pending.has(profile));
  async function explicitCommand(action: string, payload: unknown, preconditions?: DraftPreconditions,
    unknownRequestId?: string, prepareAttempt?: (requestId: string) => Promise<boolean>): Promise<DraftSubmitResult> {
    if (pending.has(profile)) return { status: "blocked", message: "Another save is in progress." };
    const ticket = workspaceAccess.getSnapshot();
    if (ticket.managed && supportsLocalCommand(action) && profileReplica.canEdit(profile)) {
      if (unknownRequestId && !unknownRequestId.startsWith("local:"))
        return { status: "unknown", requestId: unknownRequestId, message: "Review the earlier server attempt before saving again." };
      const operationId = unknownRequestId?.slice(6) ?? crypto.randomUUID();
      const requestId = `local:${operationId}`;
      pending.add(profile); notify(); setError("");
      let prepared = false;
      try {
        workspaceAccess.assertReadable(ticket);
        if (unknownRequestId) await profileReplica.hydrate(profile);
        workspaceAccess.assertReadable(ticket);
        const localId = preconditions?.localRecordId;
        const localAction = localId && action.endsWith(".create") ? action.replace(/\.create$/, ".update") : action;
        const localPayload = localId ? { ...(payload as object), id: localId } : payload;
        const recovery = unknownRequestId ? await profileReplica.recoverAttempt(profile, operationId) : undefined;
        workspaceAccess.assertReadable(ticket);
        const intent = recovery ? recoveredLocalCommand(profileReplica.getSnapshot(profile), localAction, localPayload, operationId, recovery)
          : localCommand(profileReplica.getSnapshot(profile), localAction, localPayload, operationId, preconditions?.entityVersion,
            preconditions ? preconditions.syncGeneration ?? null : profileReplica.getSnapshot(profile).state?.syncGeneration);
        if (prepareAttempt && !await prepareAttempt(requestId))
          return { status: "blocked", message: "The attempt could not be saved safely. Keep your draft open." };
        prepared = true;
        workspaceAccess.assertReadable(ticket);
        if (activeProfile.current !== profile) throw Error("The active workspace changed. Your draft remains saved.");
        if (!intent.alreadySaved) await profileReplica.enqueue(profile, intent.operation, intent.title, intent.record, intent.baselineVersion, intent.generation);
        const serverAccepted = intent.serverAccepted && intent.generation === profileReplica.getSnapshot(profile).state?.syncGeneration;
        return { status: "locally-saved", operationId, recordId: intent.recordId,
          version: intent.savedVersion, retainedEdits: intent.retainedEdits, serverAccepted,
          message: serverAccepted ? intent.operation.operationId !== operationId ? "The server accepted the reviewed recovery version." : "The server accepted this saved attempt." : "Saved on this device. Waiting for server acceptance." };
      } catch (cause) {
        const message = (cause as Error).message; setError(message);
        return prepared ? { status: "unknown", requestId, message: `${message} Retry this saved attempt to confirm its local outcome.` }
          : { status: "blocked", message };
      } finally { pending.delete(profile); notify(); }
    }
    if (preconditions?.localRecordId || unknownRequestId?.startsWith("local:"))
      return { status: "blocked", message: "This draft belongs to a local record. Restore device storage before saving so its identity is preserved." };
    const replica = profileReplica.getSnapshot(profile);
    if (replica.pending || replica.historyChanged)
      return { status: "blocked", message: "Resolve pending local changes before performing this online action." };
    if (ticket.managed && (!ticket.installationId || ticket.profile !== profile || !ticket.canWrite))
      return { status: "blocked", message: "Saving requires a current online session for this workspace." };
    const assertTicket = () => {
      if (activeProfile.current !== profile) throw Error("The active workspace changed.");
      if (ticket.managed) workspaceAccess.assertLive(ticket);
      else if (workspaceAccess.getSnapshot().managed || workspaceAccess.getSnapshot().epoch !== ticket.epoch)
        throw Error("Workspace authority changed. Review current records before saving.");
    };
    pending.add(profile);
    notify();
    setError("");
    try {
      assertTicket();
      const session = await loadSession(!ticket.managed);
      assertTicket();
      const sessionId = (session as { installationId?: string }).installationId;
      if ((ticket.managed && (sessionId !== ticket.installationId || session.variant !== ticket.variant)) || !session.profiles.includes(profile))
        return { status: "blocked", message: "Online session admission does not match this installation and workspace." };
      const installationId = ticket.managed ? ticket.installationId! : sessionId ?? "legacy-current-session";
      const model = () => profileCache.read(profile).state;
      const scope = ticket.scope;
      const key = scope && { installationId: scope.installationId, variant: scope.variant, profile,
        schema: 1, kind: "workspace" as const, id: "current" };
      const readTicket = scope && key ? await captureReadTicket(scope, key) : undefined;
      assertTicket();
      if (readTicket && !readTicket.ok && ["obsolete", "invalid"].includes(readTicket.reason))
        return { status: "blocked", message: "Saved workspace scope changed. Reconnect and review before saving." };
      const expectedModel = model();
      const refreshAfterSaved = async () => {
        try {
          // Wait out a read that began before the POST, then request fresh
          // evidence. A refresh failure cannot undo a confirmed canonical save.
          if (profileCache.read(profile).loading) await profileCache.load(profile).catch(() => undefined);
          assertTicket();
          await profileCache.load(profile, true);
        } catch (cause) {
          if (activeProfile.current === profile) onReadError?.((cause as Error).message);
        }
      };
      const result = await submitExplicitCommand({
        installationId, variant: ticket.variant, profile, action, payload, token: session.token,
        preconditions, unknownRequestId, prepareAttempt, model,
        authority: () => ticket.managed ? workspaceAccess.getSnapshot() : {
          installationId, variant: ticket.variant, profile: activeProfile.current,
          canWrite: !workspaceAccess.getSnapshot().managed && workspaceAccess.getSnapshot().epoch === ticket.epoch,
        },
        assertLive: assertTicket,
        entityVersion: () => {
          const current = model();
          const records = action.startsWith("idea.") ? current?.ideas : action.startsWith("goal.") ? current?.goals : current?.tasks;
          return records?.find(record => record.id === (payload as { id?: string })?.id)?.version;
        },
        scopeCurrent: async () => {
          if (!ticket.scope) return true;
          // Drafts survive a read clear, but the old live read admission must
          // not authorize a POST or publish its response before reconciliation.
          const current = await isOfflineScopeCurrent(ticket.scope);
          return current.ok && current.value;
        },
        commit: async current => {
          assertTicket();
          if (model() !== expectedModel) { await refreshAfterSaved(); return; }
          if (scope && key && readTicket?.ok) {
            const saved = await saveVerifiedModel(scope, { key, verifiedAt: Date.now(), value: current }, readTicket.value);
            assertTicket();
            if ((!saved.ok && ["obsolete", "invalid"].includes(saved.reason)) || model() !== expectedModel) {
              await refreshAfterSaved(); return;
            }
          }
          assertTicket();
          profileCache.write(profile, current, false);
        },
      });
      if (result.status !== "saved") setError(result.message);
      return result;
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      return { status: "blocked", message };
    } finally {
      pending.delete(profile);
      notify();
    }
  }
  async function command(action: string, payload: unknown) {
    const result = await explicitCommand(action, payload);
    return result.status === "saved" || result.status === "locally-saved";
  }
  return { explicitCommand, command, busy, error, clearError };
}
