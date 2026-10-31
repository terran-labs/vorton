import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useWorkspaceAccess, workspaceAccess } from "./application/offline-context";
import { readDraft, readDrafts, saveDraft, removeDraft, isOfflineScopeCurrent, type DraftKey, type SavedDraft, type OfflineScope } from "./application/offline-store";
import { profileCache, profileReplica } from "./application/profile-cache";
import { editorRecordKind, findRetainedDrafts, verifyRetainedDraft, sameDraftKey, type RetainedDraft, type DraftTarget } from "./application/draft-recovery";
import { downloadLocalChanges } from "./application/replica-export";
import type { State, Idea, Goal } from "./types";
import type { DraftSubmitResult } from "./forge-draft-submit";
import { canonicalJson } from "../shared/sync-contract";
import { trackDraftWrite } from "./application/update-safety";

type Fields = SavedDraft["fields"];
const UNKNOWN = "__vortonUnknownRequest";
const ATTEMPT_TITLE = "__vortonAttemptTitle";
const CONFIRMED = "__vortonConfirmedRequest";
const LOCAL_RECORD = "__vortonLocalRecord";
export function rawDraftFields(form: HTMLFormElement): Fields {
  return Object.fromEntries([...new FormData(form)].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** A local form snapshot, never a queued mutation. */
export function useForgeDraft({ profile, kind, targetId, fields, baseline, enabled = true }: {
  profile: string; kind: DraftKey["kind"]; targetId: string;
  fields: Fields; baseline: NonNullable<SavedDraft["baseline"]>; enabled?: boolean;
}) {
  const access = useWorkspaceAccess();
  const replica = useSyncExternalStore(listener => profileReplica.subscribe(profile, listener), () => profileReplica.getSnapshot(profile));
  const scopeAvailable = !!workspaceAccess.readScope(profile);
  const recoveryNamespace = JSON.stringify([access.variant, access.installationId, profile, kind, targetId, access.scope?.draftEpoch]);
  const [display, setDisplay] = useState({ loading: enabled, fields, baseline,
    savedAt: undefined as number | undefined, message: "", renderKey: 0, needsReview: false, storageConflict: false });
  const [recoveryState, setRecovery] = useState({ namespace: recoveryNamespace, candidates: [] as RetainedDraft[], ambiguous: false, checking: true, error: "" });
  const recovery = recoveryState.namespace === recoveryNamespace ? recoveryState
    : { namespace: recoveryNamespace, candidates: [] as RetainedDraft[], ambiguous: false, checking: true, error: "" };
  const [recoveryCheck, setRecoveryCheck] = useState(0);
  const live = useRef({ fields, baseline, viewTarget: targetId, generation: 0, dirty: false, conflicted: false, savedAt: undefined as number | undefined,
    scope: undefined as OfflineScope | undefined, key: { profile, schema: 1, kind, targetId } as DraftKey });
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSave = useRef<{ value: typeof live.current; generation: number; task: Promise<number | undefined> } | undefined>(undefined);
  const publish = (update: Partial<typeof display>) => {
    if (mounted.current) setDisplay(value => ({ ...value, ...update }));
  };
  const flush = (value = live.current) => {
    clearTimeout(timer.current);
    if (!enabled || !value.scope || value.conflicted) return Promise.resolve(undefined);
    if (!value.dirty) return Promise.resolve(value.savedAt);
    const { fields, baseline, generation, scope, key } = value;
    if (pendingSave.current?.value === value && pendingSave.current.generation === generation) return pendingSave.current.task;
    const pending = trackDraftWrite(chain.current.then(async () => {
      const result = await saveDraft(scope, { key, fields, baseline }, { expectedSavedAt: value.savedAt ?? null });
      if (result.ok) {
        // Every successful serialized write advances the CAS timestamp, even
        // when newer typing has already advanced the local form generation.
        value.savedAt = result.value.savedAt;
        if (value.generation === generation) value.dirty = false;
        if (live.current === value) publish({ savedAt: result.value.savedAt,
          ...(value.generation === generation ? { message: "" } : {}) });
      } else {
        if (result.reason === "obsolete") value.conflicted = true;
        if (live.current === value) publish({ storageConflict: value.conflicted, message: value.conflicted
          ? "Another form changed this saved draft. Your unsaved text remains here. Copy it before closing; reopen to review the saved draft."
          : "This draft could not be saved on this device. Keep this page open or copy your text." });
      }
      return result.ok ? result.value.savedAt : undefined;
    }));
    chain.current = pending.catch(() => undefined);
    pendingSave.current = { value, generation, task: pending };
    return pending;
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void flush(); };
  }, []);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") void flush(); };
    const pagehide = () => { void flush(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", pagehide);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", pagehide); };
  });
  useEffect(() => {
    if (!enabled) { publish({ loading: false }); return; }
    const scope = workspaceAccess.readScope(profile);
    if (!scope) {
      if (access.status === "cleared" && live.current.scope?.installationId === access.installationId && access.admittedProfiles.includes(profile)) {
        publish({ loading: false, message: "Saved reads cleared. This local draft remains available." }); return;
      }
      publish({ loading: false, message: "Local draft storage is unavailable. Changes are not saved on this device." });
      return;
    }
    const previous = live.current;
    if (previous.scope && (previous.scope.installationId !== scope.installationId ||
        previous.scope.variant !== scope.variant || previous.scope.draftEpoch !== scope.draftEpoch ||
        previous.key.profile !== profile || previous.key.kind !== kind || previous.viewTarget !== targetId)) {
      void flush(previous);
      live.current = { fields, baseline, viewTarget: targetId, generation: 0, dirty: false, conflicted: false, savedAt: undefined, scope, key: { profile, schema: 1, kind, targetId } };
      publish({ fields, baseline, savedAt: undefined, storageConflict: false, renderKey: display.renderKey + 1 });
    }
    const value = live.current;
    let cancelled = false;
    value.scope = scope;
    const generation = value.generation;
    // Keep a late read from replacing anything already typed in this form.
    if (!generation) publish({ loading: true });
    void readDraft(scope, value.key).then(async result => {
      if (cancelled || live.current !== value) return;
      if (result.ok && result.value && generation === value.generation && generation === 0) {
        const bound = result.value.fields[LOCAL_RECORD], recordKind = editorRecordKind(kind);
        const sourceId = typeof bound === "string" ? bound : value.key.targetId;
        const identity = targetId !== "new" && recordKind && result.value.baseline?.syncGeneration
          ? await profileReplica.recordIdentity(profile, recordKind, sourceId, result.value.baseline.syncGeneration) : undefined;
        if (cancelled || live.current !== value) return;
        if (value.generation !== generation) { publish({ loading: false }); void flush(value); return; }
        if (targetId !== "new" && recordKind && (sourceId !== targetId || identity && identity.id !== targetId)) {
          // This slot is intentionally retained under its original key after
          // recovery. A restored original must never load its copy's draft.
          value.conflicted = true;
          publish({ loading: false, storageConflict: true, message:
            "This saved draft belongs to a recovery copy. Open that copy to finish or discard the draft, then reopen this record. Your text remains saved." });
          return;
        }
        value.fields = result.value.fields;
        value.baseline = result.value.baseline ?? {};
        value.savedAt = result.value.savedAt;
        publish({ fields: value.fields, baseline: value.baseline, savedAt: value.savedAt,
          loading: false, renderKey: display.renderKey + 1, message: "" });
      } else {
        publish({ loading: false, message: result.ok ? "" : "Local draft storage is unavailable. Your fields remain in this page." });
        if (value.generation && result.ok) void flush();
      }
    }).catch(() => { if (!cancelled && live.current === value) publish({ loading: false, message: "Local draft storage is unavailable. Your fields remain in this page." }); });
    return () => { cancelled = true; };
  }, [enabled, access.installationId, access.variant, access.scope?.draftEpoch, scopeAvailable, profile, kind, targetId]);

  const recordKind = editorRecordKind(kind);
  const targetRow = recordKind ? replica.rows.find(row => row.kind === recordKind && row.id === targetId && row.body !== "null") : undefined;
  useEffect(() => {
    if (!enabled || !recordKind || targetId === "new") {
      setRecovery({ namespace: recoveryNamespace, candidates: [], ambiguous: false, checking: false, error: "" }); return;
    }
    const scope = workspaceAccess.readScope(profile), value = live.current, storageKey = value.key;
    if (!scope || !replica.ready || !replica.state?.syncGeneration || !targetRow || baseline.version === undefined) {
      setRecovery(previous => previous.namespace === recoveryNamespace ? { ...previous, checking: false }
        : { namespace: recoveryNamespace, candidates: [], ambiguous: false, checking: false, error: "" }); return;
    }
    const target: DraftTarget = { profile, kind, id: targetId, generation: replica.state.syncGeneration,
      localRevision: targetRow.revision, version: baseline.version };
    let cancelled = false;
    setRecovery(previous => ({ ...(previous.namespace === recoveryNamespace ? previous : { candidates: [], ambiguous: false }), namespace: recoveryNamespace, checking: true, error: "" }));
    void (async () => {
      const saved = await readDrafts(scope);
      if (!saved.ok) throw Error("Retained drafts could not be checked. Keep your text and retry device storage.");
      const found = await findRetainedDrafts(saved.value, target, storageKey,
        (recordKind, id, generation, review) => profileReplica.recordIdentity(profile, recordKind, id, generation, review));
      const current = await isOfflineScopeCurrent(scope);
      if (!current.ok || !current.value) throw Error("Device storage changed while checking retained drafts. Reconnect and retry.");
      if (!cancelled && live.current === value && sameDraftKey(value.key, storageKey))
        setRecovery({ namespace: recoveryNamespace, candidates: found.candidates, ambiguous: found.ambiguous, checking: false, error: "" });
    })().catch(cause => {
      if (!cancelled) setRecovery(previous => ({ ...(previous.namespace === recoveryNamespace ? previous : { candidates: [], ambiguous: false }),
        namespace: recoveryNamespace, checking: false, error: (cause as Error).message }));
    });
    return () => { cancelled = true; };
  }, [enabled, recordKind, profile, kind, targetId, scopeAvailable, access.installationId, access.variant, access.scope?.draftEpoch,
    access.epoch, replica.ready, replica.state?.syncGeneration, targetRow?.revision, baseline.version, display.renderKey, recoveryCheck]);

  async function verifyRecovery(candidate: RetainedDraft, selecting: boolean) {
    const value = live.current, generation = value.generation, key = value.key;
    const ticket = workspaceAccess.getSnapshot(), scope = value.scope;
    workspaceAccess.assertReadable(ticket);
    if (!scope || ticket.profile !== profile || value.key.profile !== profile || value.key.kind !== kind ||
        value.viewTarget !== candidate.target.id || profile !== candidate.target.profile || kind !== candidate.target.kind)
      throw Error("This retained draft belongs to another editor.");
    const source = await verifyRetainedDraft(candidate, key, async () => {
      const read = await readDrafts(scope);
      if (!read.ok) throw Error("Saved drafts could not be read. Keep all text before proceeding.");
      return read.value;
    }, (recordKind, id, history, review) => profileReplica.recordIdentity(profile, recordKind, id, history, review), selecting);
    const current = await isOfflineScopeCurrent(scope);
    workspaceAccess.assertReadable(ticket);
    if (!mounted.current || live.current !== value || value.generation !== generation || !sameDraftKey(value.key, key) || !current.ok || !current.value)
      throw Error("This editor or device storage changed during review. Your fields were kept; review again.");
    return { value, source, scope };
  }
  const restoreRetainedDraft = async (candidate: RetainedDraft) => {
    const value = live.current;
    if (value.generation || value.savedAt !== undefined)
      throw Error("Copy or discard the current local draft before loading another. Both drafts remain saved.");
    const verified = await verifyRecovery(candidate, true);
    const unresolved = Boolean(verified.source.fields[UNKNOWN] || verified.source.fields[CONFIRMED]);
    // Keep the original IndexedDB slot and its CAS timestamp. Only the command
    // target changes; no cross-store move or implicit server submission occurs.
    verified.value.key = verified.source.key;
    verified.value.fields = { ...verified.source.fields, [LOCAL_RECORD]: candidate.target.id };
    verified.value.baseline = { ...verified.source.baseline, ...(!unresolved ? { syncGeneration: candidate.target.generation,
      version: candidate.target.version, revision: replica.state?.revision, ...(baseline.relations ? { relations: baseline.relations } : {}) } : {}) };
    verified.value.savedAt = verified.source.savedAt;
    verified.value.generation++; verified.value.dirty = true;
    setRecovery({ namespace: recoveryNamespace, candidates: [], ambiguous: false, checking: false, error: "" });
    publish({ fields: verified.value.fields, baseline: verified.value.baseline, savedAt: verified.value.savedAt,
      renderKey: display.renderKey + 1, needsReview: unresolved, message: unresolved
        ? "Retained draft opened. Check its earlier save before submitting another edit."
        : "Retained draft reviewed against this copy. Saving still requires an explicit submit." });
    await flush(verified.value);
  };
  const discardRetainedDraft = async (candidate: RetainedDraft) => {
    const { scope, source } = await verifyRecovery(candidate, false);
    const removed = await removeDraft(scope, source.key, source.savedAt);
    if (!removed.ok || !removed.value) throw Error("The retained draft changed. It was not removed; refresh and review again.");
    setRecoveryCheck(value => value + 1);
  };

  const update = (next: Fields, initialBaseline?: typeof baseline) => {
    const value = live.current;
    if (!value.generation && value.savedAt === undefined && initialBaseline) value.baseline = initialBaseline;
    value.fields = { ...next, ...(value.fields[UNKNOWN] ? { [UNKNOWN]: value.fields[UNKNOWN], [ATTEMPT_TITLE]: value.fields[ATTEMPT_TITLE] ?? "" } : {}),
      ...(value.fields[LOCAL_RECORD] ? { [LOCAL_RECORD]: value.fields[LOCAL_RECORD] } : {}),
      ...(value.fields[CONFIRMED] ? { [CONFIRMED]: value.fields[CONFIRMED] } : {}) };
    value.generation++;
    value.dirty = true;
    publish({ fields: value.fields, baseline: value.baseline, message: value.conflicted
      ? "Another form changed this saved draft. Your unsaved text remains here. Copy it before closing; reopen to review the saved draft."
      : value.scope ? "" : "Changes are not saved on this device." });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 200);
  };
  const beginSubmit = async () => {
    const value = live.current;
    const generation = value.generation;
    const title = value.fields.title;
    const savedAt = await flush(value);
    return { value, generation, savedAt, title, requestId: undefined as string | undefined };
  };
  const prepareAttempt = async (requestId: string, submitted: Awaited<ReturnType<typeof beginSubmit>>) => {
    const value = submitted.value;
    const unchanged = value.generation === submitted.generation;
    submitted.requestId = requestId;
    value.fields = { ...value.fields, [UNKNOWN]: requestId, [ATTEMPT_TITLE]: submitted.title ?? "" };
    value.generation++; value.dirty = true;
    if (unchanged) submitted.generation = value.generation;
    if (live.current === value) publish({ fields: value.fields, message: value.scope
      ? ""
      : "Local draft storage is unavailable. This save is tracked only in this page; recovery after closing or process loss is unavailable." });
    submitted.savedAt = await flush(value);
    return !value.scope || submitted.savedAt !== undefined;
  };
  const clearAttempt = (value: typeof live.current, requestId?: string) => {
    if (!requestId || value.fields[UNKNOWN] !== requestId) return;
    const next = { ...value.fields }; delete next[UNKNOWN]; delete next[ATTEMPT_TITLE];
    value.fields = next; value.generation++; value.dirty = true;
    if (live.current === value) publish({ fields: next });
  };
  const finishSubmit = async (result: DraftSubmitResult, submitted: Awaited<ReturnType<typeof beginSubmit>>) => {
    const value = submitted.value;
    if (result.status === "unknown") {
      if (value.fields[UNKNOWN] !== result.requestId) {
        value.fields = { ...value.fields, [UNKNOWN]: result.requestId, [ATTEMPT_TITLE]: submitted.title ?? "" };
        value.generation++; value.dirty = true;
      }
      await flush(value);
      if (live.current === value) publish({ fields: value.fields, message: result.message });
    } else if (result.status !== "saved" && result.status !== "locally-saved") {
      clearAttempt(value, submitted.requestId);
      await flush(value);
      if (live.current === value) publish({ message: result.message, ...(result.status === "conflict" ? { needsReview: true } : {}) });
    }
    else {
      if (live.current === value && value.generation === submitted.generation && !(result.status === "locally-saved" && result.retainedEdits)) {
        if (value.scope && submitted.savedAt !== undefined) {
          const cleanup = chain.current.then(async () => {
            const removed = await removeDraft(value.scope!, value.key, submitted.savedAt!);
            if (removed.ok && removed.value) value.savedAt = undefined;
            return removed;
          });
          chain.current = cleanup.catch(() => undefined);
          const removed = await cleanup;
          if (!removed.ok || !removed.value) {
            // A confirmed canonical save must never be replayed just because
            // local cleanup failed. Keep the observed CAS timestamp intact.
            clearAttempt(value, submitted.requestId);
            value.fields = { ...value.fields, [CONFIRMED]: submitted.requestId ?? "saved" };
            value.generation++; value.dirty = true;
            if ((removed.ok && !removed.value) || (!removed.ok && removed.reason === "obsolete")) value.conflicted = true;
            const persisted = await flush(value);
            if (live.current === value) publish({ fields: value.fields, savedAt: value.savedAt,
              storageConflict: value.conflicted, message: value.conflicted
                ? "Record saved. Another form changed the local draft; it was not removed. Reopen to review that draft. No save will be replayed here."
                : "Record saved; local cleanup failed. When storage recovers, you can discard the local draft and any unsent edits. No save will be replayed here." +
                  (persisted === undefined ? " Confirmation could not be saved on this device. If this page closes, review current records before any new save." : "") });
            return false;
          }
        }
        if (live.current === value && value.generation === submitted.generation) {
          // Do not recreate the submitted draft in the unmount/pagehide flush.
          value.dirty = false;
          value.savedAt = undefined;
          clearTimeout(timer.current);
          return true;
        }
      }
      clearAttempt(value, submitted.requestId);
      if (result.status === "locally-saved") {
        // Keep retained text bound to its reviewed record, including when
        // recovery created a copy with a different identity.
        if (targetId === "new" || result.recordId !== targetId) value.fields = { ...value.fields, [LOCAL_RECORD]: result.recordId };
        value.baseline = { ...value.baseline, ...(result.version === undefined ? {} : { version: result.version }) };
        value.generation++; value.dirty = true;
      }
      await flush(value);
      if (live.current === value) publish({ fields: value.fields, baseline: value.baseline,
        message: "The submitted version was saved. Newer edits remain a local draft." });
    }
    return false;
  };
  const adoptReviewedModel = (state: State, reviewedId?: string) => {
    const value = live.current;
    if (String(value.fields[UNKNOWN] ?? "").startsWith("local:")) {
      publish({ message: "Save again to resolve the original local attempt before reviewing a new version. Your newer text remains here." });
      return;
    }
    const collection = kind === "idea-editor-v1" ? state.ideas : kind === "goal-editor-v1" ? state.goals : state.tasks;
    const recordId = reviewedId ?? (typeof value.fields[LOCAL_RECORD] === "string" ? value.fields[LOCAL_RECORD] : targetId);
    const entity = recordId === "new" ? undefined : collection?.find(record => record.id === recordId);
    const next = { ...value.fields }; delete next[UNKNOWN]; delete next[ATTEMPT_TITLE];
    if (entity && reviewedId) next[LOCAL_RECORD] = entity.id;
    value.fields = next;
    const relations = entity ? kind === "idea-editor-v1"
      ? { goalIds: [...((entity as Idea).goalIds ?? [])] }
      : { ideaIds: [...((entity as Goal).ideaIds ?? [])] } : value.baseline.relations;
    value.baseline = { ...value.baseline, revision: state.revision, ...(state.syncGeneration ? { syncGeneration: state.syncGeneration } : {}), ...(entity ? { version: entity.version } : {}), ...(relations ? { relations } : {}) };
    value.generation++;
    value.dirty = true;
    publish({ fields: next, baseline: value.baseline, needsReview: false, message: "Current records reviewed. Saving still requires an explicit submit." });
    void flush();
  };
  const startNew = (next: Fields, revision: number) => {
    const value = live.current;
    const syncGeneration = replica.state?.syncGeneration ?? baseline.syncGeneration;
    live.current = { ...value, fields: next, baseline: { revision, ...(syncGeneration ? { syncGeneration } : {}) }, generation: 0, dirty: false, conflicted: false, savedAt: undefined };
    publish({ fields: next, baseline: live.current.baseline, savedAt: undefined, message: "", needsReview: false, storageConflict: false });
  };
  const discard = async () => {
    const value = live.current;
    const generation = value.generation;
    const savedAt = await flush(value);
    if (!value.scope || savedAt === undefined) {
      publish({ message: "A saved local draft could not be removed. No saved data was discarded." }); return false;
    }
    const result = await removeDraft(value.scope, value.key, savedAt);
    if (live.current !== value || value.generation !== generation || !result.ok || !result.value) {
      publish({ message: "The local draft changed or storage is unavailable. Review it before discarding." }); return false;
    }
    value.dirty = false; value.savedAt = undefined; clearTimeout(timer.current);
    return true;
  };
  return { ...display, access, update, flush, beginSubmit, prepareAttempt, finishSubmit, adoptReviewedModel, startNew, discard,
    currentFields: fields,
    recovery, restoreRetainedDraft, discardRetainedDraft, retryRecovery: () => setRecoveryCheck(value => value + 1),
    requiresHistoryReview: Boolean(replica.state?.syncGeneration && display.baseline.syncGeneration === undefined),
    pristine: !live.current.generation && live.current.savedAt === undefined,
    canSubmit: !display.loading && !display.storageConflict && !display.fields[CONFIRMED] && !recovery.checking && !recovery.error && !recovery.candidates.length && (access.managed ? (access.canWrite || replica.ready && !replica.historyChanged) && !!access.installationId && access.profile === profile : typeof navigator === "undefined" || navigator.onLine !== false),
    cleanupPending: !!display.fields[CONFIRMED],
    localRecordId: typeof display.fields[LOCAL_RECORD] === "string" ? display.fields[LOCAL_RECORD] as string : undefined,
    blockedUnknown: !!display.fields[UNKNOWN] && !String(display.fields[UNKNOWN]).startsWith("local:"),
    unknownRequestId: typeof display.fields[UNKNOWN] === "string" ? display.fields[UNKNOWN] as string : undefined };
}

export function RetainedEditorDrafts({ draft, profile }: { draft: ReturnType<typeof useForgeDraft>; profile: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [discard, setDiscard] = useState<RetainedDraft>();
  const recovery = draft.recovery;
  if (!recovery.checking && !recovery.error && !recovery.candidates.length) return null;
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); setDiscard(undefined); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  const format = (value: unknown): string => value === undefined || value === null || value === "" ? "None"
    : Array.isArray(value) ? value.map(format).join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
  const discardCurrent = discard && recovery.candidates.some(candidate => sameDraftKey(candidate.draft.key, discard.draft.key) &&
    candidate.draft.savedAt === discard.draft.savedAt && candidate.target.localRevision === discard.target.localRevision &&
    candidate.target.version === discard.target.version && candidate.target.generation === discard.target.generation);
  return <section aria-label="Retained editor drafts" aria-busy={busy || recovery.checking}>
    {recovery.checking && <p role="status">Checking retained drafts…</p>}
    {recovery.error && <p role="alert">{recovery.error}</p>}
    {recovery.candidates.length > 0 && <>
      <h3>Retained draft available</h3>
      <p>A separate saved draft belongs to this record. Review it before replacing this editor’s fields. Finding it sends nothing.</p>
      {recovery.ambiguous && <p role="status">Multiple drafts need review. Keep or discard the current local draft before loading another; no fields will be merged.</p>}
      <ol style={{ paddingInlineStart: 20, maxHeight: "min(40dvh, 320px)", overflow: "auto", overflowWrap: "anywhere" }} aria-label="Retained drafts for this record" tabIndex={0}>
        {recovery.candidates.map(candidate => <li key={`${candidate.draft.key.kind}/${candidate.draft.key.targetId}`}>
          <strong>{String(candidate.draft.fields.title ?? "Untitled draft")}</strong>
          <p>Saved {new Date(candidate.draft.savedAt).toLocaleString()}</p>
          <details><summary>Compare retained fields</summary><dl>
            {Object.entries(candidate.draft.fields).filter(([field]) => !field.startsWith("__vorton") && field !== "kind").map(([field, value]) => <div key={field}>
              <dt>{field.replace(/([A-Z])/g, " $1").replace(/^./, letter => letter.toUpperCase())}</dt>
              <dd>Saved: {format(value)}</dd><dd>Current record: {format(draft.currentFields[field])}</dd>
            </div>)}
          </dl></details>
          <div className="actions">
            <button type="button" disabled={busy || recovery.checking || recovery.ambiguous} onClick={() => void run(() => draft.restoreRetainedDraft(candidate))}>Use retained draft</button>
            <button type="button" disabled={busy || recovery.checking} onClick={() => setDiscard(candidate)}>Discard this retained draft</button>
          </div>
        </li>)}
      </ol>
    </>}
    {discard && <div role="group" aria-label="Confirm discarding retained draft">
      <p>This removes only “{String(discard.draft.fields.title ?? "Untitled draft")}” from this device. Copy its text or export local changes first if you want to keep it. Saved records remain intact.</p>
      {!discardCurrent && <p role="status">The comparison changed. Cancel and review the latest draft before discarding.</p>}
      <button type="button" disabled={busy || !discardCurrent} onClick={() => void run(() => draft.discardRetainedDraft(discard))}>Confirm discarding this draft</button>
      <button type="button" disabled={busy} onClick={() => setDiscard(undefined)}>Cancel</button>
    </div>}
    {error && <p role="alert">{error}</p>}
    <div className="actions">
      <button type="button" disabled={busy || recovery.checking} onClick={draft.retryRecovery}>Refresh retained drafts</button>
      <button type="button" disabled={busy} onClick={() => void run(() => downloadLocalChanges(profile))}>Export local recovery data</button>
    </div>
  </section>;
}

export function DraftStatus({ draft, state, kind, targetId, onDiscard }: {
  draft: ReturnType<typeof useForgeDraft>; state: State; kind: "idea" | "goal" | "task"; targetId: string;
  onDiscard?: () => void;
}) {
  const [review, setReview] = useState<State | undefined>();
  const [reviewedId, setReviewedId] = useState<string | undefined>();
  const reviewFields = useRef("");
  const reviewTicket = useRef<{ installationId: string; variant: "private" | "portable"; profile: string; epoch: number } | undefined>(undefined);
  const [error, setError] = useState("");
  const access = draft.access;
  const conflict = draft.needsReview || draft.requiresHistoryReview || draft.baseline.revision !== state.revision ||
    draft.baseline.syncGeneration !== undefined && draft.baseline.syncGeneration !== state.syncGeneration;
  const records = review && (kind === "idea" ? review.ideas : kind === "goal" ? review.goals : review.tasks);
  const recordId = reviewedId ?? draft.localRecordId ?? targetId;
  const current = records?.filter(record => recordId === "new" ? record.title === (draft.unknownRequestId ? draft.fields[ATTEMPT_TITLE] : draft.fields.title) : record.id === recordId);
  async function loadReview() {
    setError(""); setReview(undefined); setReviewedId(undefined);
    try {
      const fields = canonicalJson(draft.fields);
      const ticket = workspaceAccess.getSnapshot();
      if (!ticket.installationId || ticket.profile !== state.profile) throw Error("Online workspace authority is required.");
      const expected = { installationId: ticket.installationId, variant: ticket.variant, profile: state.profile, epoch: ticket.epoch };
      workspaceAccess.assertLive(expected);
      const model = await profileCache.load(state.profile, true);
      workspaceAccess.assertLive(expected);
      let id = draft.localRecordId ?? targetId;
      if (id !== "new" && draft.baseline.syncGeneration && !draft.unknownRequestId?.startsWith("local:")) {
        const identity = await profileReplica.recordIdentity(state.profile, kind, id, draft.baseline.syncGeneration);
        workspaceAccess.assertLive(expected);
        if (identity.generation === model.syncGeneration) id = identity.id;
      }
      reviewFields.current = fields;
      reviewTicket.current = expected;
      setReviewedId(id);
      setReview(model);
    } catch (cause) { setError((cause as Error).message); }
  }
  return <div role="status">
    {draft.message && <p>{draft.message}</p>}
    {draft.storageConflict && <button type="button" onClick={() => void downloadLocalChanges(state.profile).catch(cause => setError((cause as Error).message))}>Export local recovery data</button>}
    {draft.savedAt !== undefined && onDiscard && <button type="button" onClick={() => {
      void draft.discard().then(removed => { if (removed) onDiscard(); });
    }}>{draft.cleanupPending ? "Discard local draft and unsent edits" : "Discard local draft"}</button>}
    {draft.cleanupPending && <p>This record was saved. Another canonical save is blocked. Discarding removes the local draft and any unsent edits; saved records remain intact.</p>}
    {access.managed && !access.canWrite && <p>{draft.canSubmit ? "Offline saves stay on this device until the server accepts them." : "Keep editing your draft. Persistent record storage is not ready."}</p>}
    {draft.unknownRequestId && <p>{draft.blockedUnknown ? "We couldn’t confirm the save. Check current records before trying again so you don’t create a duplicate." : "Local save confirmation was interrupted. Save again to check the same attempt safely."}</p>}
    {(conflict || draft.blockedUnknown) && <>
      {conflict && <p>Records changed since this draft began. Your draft has not been rebased.</p>}
      <button type="button" disabled={!access.canWrite} onClick={() => void loadReview()}>Review current records</button>
      {review && <>
        <details><summary>Current {recordId === "new" ? "records with this title" : "record"}</summary>
          <pre>{current?.length ? JSON.stringify(current, null, 2) : "No matching record found."}</pre>
        </details>
        <button type="button" disabled={!access.canWrite || (recordId !== "new" && !current?.length)} onClick={() => {
          try {
            if (!reviewTicket.current) throw Error("Review authority unavailable");
            workspaceAccess.assertLive(reviewTicket.current);
            const currentModel = profileCache.read(state.profile).state;
            if (currentModel?.revision !== review.revision || currentModel?.syncGeneration !== review.syncGeneration ||
                canonicalJson(draft.fields) !== reviewFields.current) throw Error("Records or draft changed");
          } catch {
            setReview(undefined); setError("Records or authority changed. Review them again."); return;
          }
          draft.adoptReviewedModel(review, reviewedId); setReview(undefined); setReviewedId(undefined);
        }}>{draft.unknownRequestId ? "Not already saved; allow another attempt" : "Use reviewed revision for this draft"}</button>
      </>}
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
