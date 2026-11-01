import React, { useLayoutEffect, useRef, useState } from "react";
import type { State } from "./types";
import type { DraftAct } from "./forge-draft-submit";
import { DraftStatus, useForgeDraft } from "./forge-drafts";
import { profileCache } from "./application/profile-cache";
import { useProfileState } from "./application/use-profile-state";
import { useWorkspaceCommand } from "./use-workspace-command";

type CaptureKind = "task" | "goal" | "idea";
const kinds = ["task", "goal", "idea"] as const;
const labels = (value: unknown) => String(value ?? "").split(",").map(label => label.trim()).filter(Boolean);
const routineDraftMessages = new Set(["Saving draft on this device…", "Draft saved on this device.",
  "Draft restored from this device.", "Preparing save. Its outcome requires confirmation.",
  "Current records reviewed. Saving still requires an explicit submit."]);

export default function IdeaCaptureForm({ profile, onSaved }: { profile: "AubOS"; onSaved: () => void }) {
  const snapshot = useProfileState(profile);
  const [kind, setKind] = useState<CaptureKind>("task");
  const { busy } = useWorkspaceCommand(profile);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const typeRow = useRef<HTMLFieldSetElement>(null);
  const beginSubmission = () => {
    if (submission.current || busy) return false;
    submission.current = true;
    // Disable native radios before the first persistence await, not just after
    // React commits its state update or the shared command lock begins.
    if (typeRow.current) typeRow.current.disabled = true;
    setSubmitting(true);
    return true;
  };
  const endSubmission = () => { submission.current = false; setSubmitting(false); };
  if (!snapshot.state) return <div role="status">
    {snapshot.error ? <><p>{snapshot.error}</p><button type="button" onClick={() => { void profileCache.load(profile, true).catch(() => {}); }}>Retry reading records</button></> : "Reading records…"}
  </div>;
  return <>
    <fieldset ref={typeRow} disabled={busy || submitting} className="capture-kinds"><legend>Capture type</legend>
      {kinds.map(value => <label key={value}><input type="radio" name="capture-kind" value={value} disabled={busy || submitting} checked={kind === value}
        onChange={() => { if (!submission.current && !busy) setKind(value); }}/>{value[0].toUpperCase() + value.slice(1)}</label>)}
    </fieldset>
    <CaptureRecord key={kind} state={snapshot.state} kind={kind} submitting={submitting}
      beginSubmission={beginSubmission} endSubmission={endSubmission} onSaved={onSaved}/>
  </>;
}

function CaptureRecord({ state, kind, submitting, beginSubmission, endSubmission, onSaved }: {
  state: State; kind: CaptureKind; submitting: boolean;
  beginSubmission: () => boolean; endSubmission: () => void; onSaved: () => void;
}) {
  const { explicitCommand, busy: commandBusy } = useWorkspaceCommand(state.profile);
  const busy = commandBusy || submitting;
  const mounted = useRef(true);
  // Fence completions during the unmount commit, before another browser task.
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const complete = () => { if (mounted.current) onSaved(); };
  const [issue, setIssue] = useState("");
  const owner = state.settings?.defaultOwner ?? "Owner";
  const defaults: Record<string, string> = kind === "idea" ? { title: "", owner, projects: "", tags: "" }
    : kind === "task" ? { title: "", notes: "", owner, projects: "", tags: "", goalId: "", dueOn: "", status: "todo", priority: "normal" }
    : { title: "", intent: "", successCriteria: "", owner, projects: "", tags: "", horizon: "", parentId: "", reviewOn: "", milestones: "", evidence: "", progress: "0", status: "active", priority: "normal" };
  const draft = useForgeDraft({ profile: state.profile, kind: kind === "idea" ? "forge-capture-v1" : kind === "task" ? "task-editor-v1" : "goal-editor-v1",
    targetId: "new", fields: defaults, baseline: { revision: state.revision, ...(state.syncGeneration ? { syncGeneration: state.syncGeneration } : {}) } });
  const fields = draft.fields;
  const detail = kind === "task" ? fields.notes : kind === "goal" ? fields.intent : fields.description;
  const text = typeof fields.captureText === "string" ? fields.captureText
    : [fields.title, detail && detail !== fields.title ? detail : ""].filter(Boolean).join("\n");
  const storageWarning = routineDraftMessages.has(draft.message) ? "" : draft.message;
  const failed = !busy && (issue || storageWarning || draft.unknownRequestId || draft.cleanupPending || draft.storageConflict);
  if (draft.loading) return <p role="status">Opening capture…</p>;
  return <form className="capture-record" data-vorton-unsaved={!draft.pristine} onSubmit={async event => {
    event.preventDefault();
    if (busy || !text.trim() || !draft.canSubmit || draft.blockedUnknown || !beginSubmission()) return;
    try {
      setIssue("");
      const title = text.trim().split("\n")[0].slice(0, 180);
      const common = { title, owner: String(fields.owner ?? owner), projects: labels(fields.projects), tags: labels(fields.tags) };
      // Existing Forge captures treat a project/tag as one literal label.
      const payload = kind === "idea" ? { ...common, description: text,
          projects: fields.projects ? [String(fields.projects)] : [], tags: fields.tags ? [String(fields.tags)] : [] }
        : kind === "task" ? { ...common, notes: text, goalId: String(fields.goalId ?? ""), dueOn: String(fields.dueOn ?? ""),
            status: String(fields.status ?? "todo"), priority: String(fields.priority ?? "normal"), ideaIds: draft.baseline.relations?.ideaIds ?? [] }
        : { ...common, intent: text, successCriteria: String(fields.successCriteria ?? ""), horizon: String(fields.horizon ?? ""),
            parentId: String(fields.parentId ?? ""), reviewOn: String(fields.reviewOn ?? ""), evidence: String(fields.evidence ?? ""),
            priority: String(fields.priority ?? "normal"), status: String(fields.status ?? "active"), progress: Number(fields.progress ?? 0),
            milestones: String(fields.milestones ?? "").split("\n").filter(line => line.trim()).map(line => ({ title: line.replace(/^\[[ x]\]\s*/, ""), done: line.startsWith("[x]") })),
            ideaIds: draft.baseline.relations?.ideaIds ?? [] };
      const submitted = await draft.beginSubmit();
      const result = await explicitCommand(kind + ".create", { fields: payload }, { basedOnRevision: draft.baseline.revision ?? -1, syncGeneration: draft.baseline.syncGeneration, localRecordId: draft.localRecordId, entityVersion: draft.baseline.version },
        draft.unknownRequestId, requestId => draft.prepareAttempt(requestId, submitted));
      if (await draft.finishSubmit(result, submitted)) { complete(); return; }
      setIssue(result.status === "saved" ? "Saved. Local draft cleanup needs attention." : result.message);
    } finally { endSubmission(); }
  }}>
    <label className="capture-input-label" htmlFor="capture-text">{kind[0].toUpperCase() + kind.slice(1)}</label>
    <textarea id="capture-text" autoFocus value={text} required readOnly={busy} maxLength={4000} rows={7}
      placeholder={kind === "task" ? "What needs doing?" : kind === "goal" ? "What do you want to achieve?" : "What’s the idea?"}
      onChange={event => {
        const value = event.target.value;
        draft.update({ ...fields, captureText: value, title: value.trim().split("\n")[0].slice(0, 180),
          [kind === "task" ? "notes" : kind === "goal" ? "intent" : "description"]: value },
          draft.pristine ? { revision: state.revision, ...(state.syncGeneration ? { syncGeneration: state.syncGeneration } : {}) } : undefined);
      }}/>
    <button className="capture-save" disabled={busy || !text.trim() || !draft.canSubmit || draft.blockedUnknown}>Save</button>
    {!failed && draft.savedAt !== undefined && <div><button type="button" disabled={busy} onClick={async () => {
      if (!beginSubmission()) return;
      try {
        if (await draft.discard()) complete();
        else setIssue("The local draft could not be discarded. Keep this page open and review it.");
      } finally { endSubmission(); }
    }}>Discard local draft</button></div>}
    {failed && <div className="capture-failure">
      <p role="alert">{issue || storageWarning || (draft.unknownRequestId ? "Save not confirmed. Review current records before trying again." : draft.cleanupPending ? "Saved. Local draft cleanup needs attention." : "Local draft changed elsewhere. Copy your text before reopening.")}</p>
      <DraftStatus draft={{ ...draft, message: "" }} state={state} kind={kind} targetId="new" onDiscard={complete}/>
    </div>}
  </form>;
}

export function ForgeCapture({
  busy,
  state,
  submitDraft,
  owner,
  project,
  tag,
  saved,
  autoFocus = false,
}: {
  busy: boolean;
  state: State;
  submitDraft: DraftAct;
  owner: string;
  project: string;
  tag: string;
  saved: (notice: string) => void;
  autoFocus?: boolean;
}) {
  const draft = useForgeDraft({ profile: state.profile, kind: "forge-capture-v1", targetId: "new",
    fields: { title: "", owner, projects: project, tags: tag }, baseline: { revision: state.revision, ...(state.syncGeneration ? { syncGeneration: state.syncGeneration } : {}) } });
  const capture = String(draft.fields.title ?? "");
  if (draft.loading) return <p role="status">Restoring local capture…</p>;
  return (
    <form
      className="forge-capture"
      data-vorton-unsaved={!draft.pristine}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!draft.canSubmit || draft.blockedUnknown) return;
        const submitted = await draft.beginSubmit();
        const result = await submitDraft("idea.create", {
            fields: {
              title: capture,
              owner: String(draft.fields.owner ?? owner),
              projects: draft.fields.projects ? [String(draft.fields.projects)] : [],
              tags: draft.fields.tags ? [String(draft.fields.tags)] : [],
            },
          }, { basedOnRevision: draft.baseline.revision ?? -1, syncGeneration: draft.baseline.syncGeneration, localRecordId: draft.localRecordId, entityVersion: draft.baseline.version }, draft.unknownRequestId,
          requestId => draft.prepareAttempt(requestId, submitted));
        if (await draft.finishSubmit(result, submitted)) {
          draft.startNew({ title: "", owner, projects: project, tags: tag }, profileCache.read(state.profile).state?.revision ?? state.revision);
          saved(result.status === "locally-saved" ? result.message : "Idea saved to Inbox.");
        }
      }}
    >
      <label htmlFor="forge-capture">Capture an idea</label>
      <div>
        <input
          id="forge-capture"
          autoFocus={autoFocus}
          value={capture}
          onChange={(event) => draft.update({ ...(draft.pristine ? { owner, projects: project, tags: tag } : draft.fields),
            title: event.target.value }, draft.pristine ? { revision: state.revision, ...(state.syncGeneration ? { syncGeneration: state.syncGeneration } : {}) } : undefined)}
          required
          maxLength={180}
          placeholder="A thought is enough. You can shape it later."
        />
        <button disabled={busy || !capture.trim() || !draft.canSubmit || draft.blockedUnknown}>Save idea</button>
      </div>
      <DraftStatus draft={draft} state={state} kind="idea" targetId="new" onDiscard={() => draft.startNew({ title: "", owner, projects: project, tags: tag }, state.revision)} />
    </form>
  );
}
