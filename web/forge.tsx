import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { forgeIndex, filterForge } from "./forge-data";
import { fieldsFor, kindOfRecommendation, type ForgeActions } from "./forge-shared";
import { TaskBoard } from "./forge-tasks-board";
import { GoalsRail, GoalsView } from "./forge-goals";
import { IdeasRail, IdeasView } from "./forge-ideas";
import "./forge-shared.css";
import { NAVIGATION_EVENT } from "./application/browser-router";
import { forgeNavigation } from "./application/forge-navigation";
import { WorkspaceNavigation } from "./design/workspace-navigation";
import { DraftStatus, RetainedEditorDrafts, rawDraftFields, useForgeDraft } from "./forge-drafts";
import { ForgeCapture } from "./idea-capture-form";
import "./idea-capture.css";
import { CaptureButton } from "./capture-button";
import { useWorkspaceAccess, workspaceAccess } from "./application/offline-context";
import type { DraftAct, DraftPreconditions, DraftSubmitResult } from "./forge-draft-submit";
import { profileCache } from "./application/profile-cache";
import { useReplica } from "./application/use-replica";
import type {
  State,
  Idea,
  IdeaFields,
  TaskFields,
  Recommendation,
  Task,
  Goal,
} from "./types";
import "./forge.css";
export { workspaceSections, workspaceLinks } from "./application/workspace-navigation";

export const forgeViews = ["tasks", "goals", "ideas"] as const;
const bands = ["unknown", "low", "medium", "high"];
const stages = [
  "inbox",
  "exploring",
  "ready",
  "parked",
  "graduated",
  "archived",
];
const assessments = {
  value: "Potential value",
  complexity: "Complexity",
  effort: "Initial effort",
  upkeep: "Ongoing upkeep",
  confidence: "Confidence",
  pull: "Personal pull",
} as const;
const split = (value: FormDataEntryValue | null) => [
  ...new Set(
    String(value ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
const emptyIdea: IdeaFields = {
  title: "",
  description: "",
  owner: "Owner",
  status: "inbox",
  projects: [],
  tags: [],
  goalIds: [],
  value: "unknown",
  complexity: "unknown",
  effort: "unknown",
  upkeep: "unknown",
  confidence: "unknown",
  pull: "unknown",
  startCondition: "",
  experiment: "",
  reviewOn: "",
  evidence: "",
};
type Act = (action: string, payload: unknown) => Promise<boolean | undefined>;
export function OrganizationInputs({
  value,
  state,
}: {
  value: { projects?: string[] | string; tags?: string[] | string };
  state: State;
}) {
  const records = [...state.goals, ...state.tasks, ...(state.ideas ?? [])];
  return (
    <div className="form-grid">
      {(["projects", "tags"] as const).map((key) => (
        <label key={key}>
          {key === "projects" ? "Projects" : "Tags"}
          <input
            name={key}
            defaultValue={typeof value[key] === "string" ? value[key] as string : (value[key] as string[] | undefined)?.join(", ")}
            list={`forge-${key}`}
            placeholder="Separate with commas"
          />
          <datalist id={`forge-${key}`}>
            {[...new Set(records.flatMap((r) => r[key] ?? []))]
              .sort()
              .map((v) => (
                <option key={v} value={v} />
              ))}
          </datalist>
        </label>
      ))}
    </div>
  );
}
export function RecordLabels({
  record,
}: {
  record: { projects?: string[]; tags?: string[] };
}) {
  return (
    <div className="forge-labels">
      {record.projects?.map((p) => (
        <span className="badge" key={`p:${p}`}>
          {p}
        </span>
      ))}
      {record.tags?.map((t) => (
        <span className="quiet" key={`t:${t}`}>
          #{t}
        </span>
      ))}
    </div>
  );
}
export function CouncilOrigin({ state, id }: { state: State; id: string }) {
  const proposal = [...state.recommendations]
    .reverse()
    .find((r) => r.status === "accepted" && r.resultId === id);
  return proposal ? (
    <p>
      <a
        href={`/${state.profile.toLowerCase()}/council#recommendation-${proposal.id}`}
      >
        Council recommendation
      </a>
    </p>
  ) : null;
}
export type ForgeEditorRequest =
  | { kind: "task" | "goal"; entity?: Task | Goal; draft?: Partial<TaskFields>; recommendation?: Recommendation };

export function Forge({
  state,
  view,
  busy,
  error,
  act,
  submitDraft,
  openEditor,
  editIdeaSuggestion,
  draftTask,
  onNavigate,
}: {
  state: State;
  view: string;
  busy: boolean;
  error: string;
  act: Act;
  submitDraft: DraftAct;
  /** Opens the workspace's task or goal editor, including edit-then-accept for a suggestion. */
  openEditor: (request: ForgeEditorRequest) => void;
  /** Opens the idea editor that accepts a Council idea suggestion with edits. */
  editIdeaSuggestion: (recommendation: Recommendation) => void;
  draftTask: (fields: TaskFields) => void;
  onNavigate?: React.MouseEventHandler<HTMLAnchorElement>;
}) {
  const shellAccess = useWorkspaceAccess();
  const selected = forgeViews.includes(view as (typeof forgeViews)[number])
    ? view
    : "tasks";
  const [query, setQuery] = useState(
    () => new URLSearchParams(location.search).get("q") ?? "",
  );
  const [project, setProject] = useState(
    () => new URLSearchParams(location.search).get("project") ?? "",
  );
  const [tag, setTag] = useState(
    () => new URLSearchParams(location.search).get("tag") ?? "",
  );
  // Each view's rail selection: a goal id, or an idea list such as "ready".
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [taskRail, setTaskRail] = useState<HTMLDivElement | null>(null);
  const [focusId, setFocusId] = useState(() => location.hash.slice(1));
  const [editing, setEditing] = useState<Idea | null | undefined>();
  const [graduate, setGraduate] = useState<Idea | null>(null);
  const [notice, setNotice] = useState("");
  // A save whose outcome is unknown blocks every Forge change until current
  // records are reviewed. Nothing is ever replayed.
  const [unknownSave, setUnknownSave] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const base = `/${state.profile.toLowerCase()}/forge`;
  useEffect(() => {
    const restoreFilters = () => {
      if (location.pathname !== base && !location.pathname.startsWith(`${base}/`)) return;
      const params = new URLSearchParams(location.search);
      setQuery(params.get("q") ?? "");
      setProject(params.get("project") ?? "");
      setTag(params.get("tag") ?? "");
    };
    window.addEventListener("popstate", restoreFilters);
    window.addEventListener(NAVIGATION_EVENT, restoreFilters);
    return () => {
      window.removeEventListener("popstate", restoreFilters);
      window.removeEventListener(NAVIGATION_EVENT, restoreFilters);
    };
  }, [base]);
  useEffect(() => {
    setEditing(undefined);
    setGraduate(null);
  }, [selected]);
  useEffect(() => {
    const key = `vorton:forge:${state.profile}`;
    try {
      localStorage.setItem(key, selected);
    } catch {
      /* Storage can be disabled; explicit navigation still works. */
    }
  }, [state.profile, selected, view, base]);
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (project) params.set("project", project);
  if (tag) params.set("tag", tag);
  const suffix = params.size ? `?${params}` : "";
  useEffect(() => {
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${suffix}${location.hash}`,
    );
  }, [suffix]);
  const index = useMemo(
    () => forgeIndex(state),
    [state.goals, state.tasks, state.ideas, state.recommendations],
  );
  const filtered = useMemo(
    () => filterForge(state, index, query, project, tag),
    [state, index, query, project, tag],
  );
  useEffect(() => {
    // A direct record link must still open when a saved filter excludes it.
    const openFragment = () => {
      const fragment = location.hash.slice(1);
      setFocusId(fragment);
      if (!/^(task|goal|idea)-/.test(fragment)) return;
      setQuery("");
      setProject("");
      setTag("");
    };
    openFragment();
    window.addEventListener("hashchange", openFragment);
    return () => window.removeEventListener("hashchange", openFragment);
  }, [state.profile]);
  useEffect(() => {
    if (!focusId) return;
    const frame = requestAnimationFrame(() => document.getElementById(focusId)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [focusId, selected]);

  const replica = useReplica(state.profile);
  const online = shellAccess.managed
    ? shellAccess.canWrite && shellAccess.profile === state.profile
    : navigator.onLine !== false;
  const canWrite = (online || replica.ready && !replica.historyChanged) && !unknownSave && !reviewing;
  const recordsLabel = selected === "tasks" ? "task records" : "records";
  async function reviewRecords() {
    if (!online || busy || reviewing) return;
    const ticket = workspaceAccess.getSnapshot();
    setReviewing(true);
    try {
      if (ticket.managed) workspaceAccess.assertLive(ticket);
      // A forced managed load can still join an older in-flight GET. Wait for
      // that read to settle before requesting evidence after the unknown POST.
      if (profileCache.read(state.profile).loading) await profileCache.load(state.profile).catch(() => undefined);
      if (ticket.managed) workspaceAccess.assertLive(ticket);
      await profileCache.load(state.profile, true);
      if (ticket.managed) workspaceAccess.assertLive(ticket);
      setUnknownSave(false);
      setNotice(`Current ${recordsLabel} loaded. Review their status before another action.`);
    } catch (cause) {
      setNotice((cause as Error).message);
    } finally {
      setReviewing(false);
    }
  }
  const actions: ForgeActions = {
    busy,
    canWrite,
    local: replica.ready && !replica.historyChanged,
    async update(kind, record, patch) {
      const result = await submitDraft(`${kind}.update`, { id: record.id, fields: fieldsFor(kind, record, patch) },
        { basedOnRevision: state.revision, syncGeneration: state.syncGeneration, entityVersion: record.version });
      if (result.status === "unknown") {
        setUnknownSave(true);
        setNotice("A save may already have reached the server. Changes are blocked until you review current records. No action will be replayed.");
      }
      if (result.status === "locally-saved") setNotice(result.message);
      return result.status === "saved" || result.status === "locally-saved";
    },
    async resolve(recommendation, decision) {
      const okay = await act("recommendation.resolve", { id: recommendation.id, decision });
      if (okay) setNotice(decision === "accepted" ? `Confirmed: ${recommendation.proposal.title}.`
        : decision === "deferred" ? "Snoozed. It stays in Council review." : "Declined. Council will see your decision.");
      return Boolean(okay);
    },
    editSuggestion(recommendation) {
      const kind = kindOfRecommendation(recommendation);
      if (kind === "idea") editIdeaSuggestion(recommendation);
      else openEditor({ kind, recommendation });
    },
    open(kind, record, draft) {
      if (kind === "idea") setEditing((record as Idea | undefined) ?? null);
      else openEditor({ kind, entity: record as Task | Goal | undefined, draft });
    },
    graduate: setGraduate,
    notify: setNotice,
  };
  const managedAubos = state.profile === "AubOS" && shellAccess.managed;
  const capture = managedAubos ? null : <ForgeCapture key={state.profile} busy={busy} state={state} submitDraft={submitDraft} owner={state.settings?.defaultOwner ?? "Owner"} project={project} tag={tag} saved={setNotice}/>;
  const viewProps = {
    state: filtered,
    full: state,
    actions,
    selection: selection[selected] ?? "",
    select: (value: string) => setSelection((current) => ({ ...current, [selected]: value })),
    focusId,
    draftTask,
    capture,
  };
  return (
    <div className="forge">
      <div className="section-nav-bar">
        <WorkspaceNavigation profile="Forge" label="Forge views" level="secondary" page={selected} controls="forge-content" links={forgeNavigation(state.profile, selected, suffix).links.map(link => ({ ...link, onClick: onNavigate }))}/>
      </div>
      <aside className="forge-rail" aria-label="Forge lists and filters">
        {selected === "tasks" && <div ref={setTaskRail} />}
        {selected === "goals" && <GoalsRail {...viewProps} />}
        {selected === "ideas" && <IdeasRail {...viewProps} />}
        <p>Filters</p>
        <div className="forge-filters" data-vorton-view-control>
          <label>
            Search
            <input
              type="search"
              aria-label="Search Forge"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ideas, goals or tasks"
            />
          </label>
          {(["project", "tag"] as const).map((key) => (
            <label key={key}>
              {key === "project" ? "Project" : "Tag"}
              <select
                value={key === "project" ? project : tag}
                onChange={(e) =>
                  (key === "project" ? setProject : setTag)(e.target.value)
                }
              >
                <option value="">All {key}s</option>
                {index.facets[key].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          ))}
          {(query || project || tag) && (
            <button
              type="button"
              className="forge-clear-filters"
              onClick={() => {
                setQuery("");
                setProject("");
                setTag("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </aside>
      <div className="forge-content" id="forge-content">
        {notice && <p role="status" className="forge-notice">{notice}</p>}
        {unknownSave && <p className="forge-notice"><button type="button" disabled={!online || busy || reviewing} onClick={() => void reviewRecords()}>Review current {recordsLabel}</button></p>}
        {selected === "tasks" && <TaskBoard key={state.profile} {...viewProps} rail={taskRail} />}
        {selected === "goals" && <GoalsView {...viewProps} />}
        {selected === "ideas" && <IdeasView {...viewProps} />}
      </div>
      <div className="aubos-capture forge-create">
        <CaptureButton aria-haspopup="dialog" label={`New ${selected === "ideas" ? "idea" : selected === "goals" ? "goal" : "task"}`}
          onClick={() => actions.open(selected === "ideas" ? "idea" : selected === "goals" ? "goal" : "task")} />
      </div>
      {editing !== undefined && (
        <IdeaEditor
          key={editing?.id ?? "new"}
          state={state}
          idea={editing ?? undefined}
          busy={busy}
          error={error}
          close={() => setEditing(undefined)}
          save={async (fields, preconditions, unknownRequestId, prepareAttempt) => {
            return submitDraft(`idea.${editing ? "update" : "create"}`, {
                id: editing?.id,
                fields,
              }, preconditions!, unknownRequestId, prepareAttempt);
          }}
        />
      )}
      {graduate && (
        <GraduateIdea
          state={state}
          idea={graduate}
          busy={busy}
          error={error}
          act={act}
          close={() => setGraduate(null)}
        />
      )}
    </div>
  );
}

export function IdeaEditor({
  state,
  idea,
  recommendation,
  busy,
  error,
  close,
  save,
}: {
  state: State;
  idea?: Idea;
  recommendation?: Recommendation;
  busy: boolean;
  error: string;
  close: () => void;
  save: (fields: IdeaFields, preconditions?: DraftPreconditions, unknownRequestId?: string, prepareAttempt?: (requestId: string) => Promise<boolean>) => Promise<DraftSubmitResult | void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const value = {
    ...emptyIdea,
    ...(recommendation?.proposal ?? idea),
  } as IdeaFields;
  const draft = useForgeDraft({ profile: state.profile, kind: "idea-editor-v1", targetId: idea?.id ?? "new",
    enabled: !recommendation,
    fields: Object.fromEntries(Object.keys(emptyIdea).filter(key => key !== "goalIds").map(key => {
      const field = value[key as keyof IdeaFields];
      return [key, Array.isArray(field) ? field.join(", ") : String(field ?? "")];
    })),
    baseline: { revision: state.revision, ...(state.syncGeneration ? { syncGeneration: state.syncGeneration } : {}), ...(idea ? { version: idea.version } : {}), relations: { goalIds: value.goalIds ?? [] } } });
  const formValue = !recommendation ? { ...value, ...draft.fields } : value;
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.showModal();
    ref.current
      ?.querySelector<HTMLInputElement>('input[name="title"]')
      ?.focus();
    return () => {
      const target = opener instanceof HTMLElement && opener.isConnected
        ? opener : document.getElementById("forge-capture") ?? document.getElementById("workspace-main");
      target?.focus({ preventScroll: true });
    };
  }, [draft.loading]);
  useEffect(() => {
    if (!draft.loading) ref.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
  }, [draft.renderKey]);
  if (!recommendation && draft.loading) return <p role="status">Restoring local idea draft…</p>;
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else close();
      }}
      aria-labelledby="idea-editor-heading"
    >
      <form
        data-vorton-unsaved={!draft.pristine}
        key={draft.renderKey}
        onChange={!recommendation ? event => draft.update(rawDraftFields(event.currentTarget)) : undefined}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!recommendation && (!draft.canSubmit || draft.blockedUnknown)) return;
          const data = new FormData(e.currentTarget);
          const fields = { ...value };
          for (const key of Object.keys(value) as (keyof IdeaFields)[]) {
            if (["projects", "tags"].includes(key)) continue;
            if (data.has(key))
              Object.assign(fields, { [key]: String(data.get(key)) });
          }
          fields.projects = split(data.get("projects"));
          fields.tags = split(data.get("tags"));
          if (!recommendation) fields.goalIds = draft.baseline.relations?.goalIds ?? value.goalIds;
          const clean = Object.fromEntries(
            Object.keys(emptyIdea).map((k) => [
              k,
              fields[k as keyof IdeaFields],
            ]),
          ) as IdeaFields;
          if (recommendation) { await save(clean); return; }
          const submitted = await draft.beginSubmit();
          const result = await save(clean, { basedOnRevision: draft.baseline.revision ?? -1, syncGeneration: draft.baseline.syncGeneration, entityVersion: draft.baseline.version, localRecordId: draft.localRecordId }, draft.unknownRequestId,
            requestId => draft.prepareAttempt(requestId, submitted));
          if (result && await draft.finishSubmit(result, submitted)) close();
        }}
      >
        <div className="dialog-heading">
          <h2 id="idea-editor-heading">
            {recommendation
              ? "Edit and accept idea"
              : idea
                ? "Edit idea"
                : "New idea"}
          </h2>
          <button
            type="button"
            disabled={busy}
            onClick={close}
            aria-label="Close editor"
          >
            ×
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!recommendation && <RetainedEditorDrafts draft={draft} profile={state.profile}/>}
        <label>
          Title
          <input
            name="title"
            defaultValue={String(formValue.title ?? "")}
            required
            maxLength={180}
          />
        </label>
        <label>
          Description
          <textarea
            name="description"
            defaultValue={String(formValue.description ?? "")}
            maxLength={8000}
            rows={4}
          />
        </label>
        <OrganizationInputs value={recommendation ? value : {
          projects: String(draft.fields.projects ?? ""), tags: String(draft.fields.tags ?? ""),
        }} state={state} />
        <div className="form-grid">
          <label>
            Owner
            <input
              name="owner"
              defaultValue={String(formValue.owner ?? "")}
              required
              maxLength={120}
            />
          </label>
          <label>
            Readiness
            <select name="status" defaultValue={String(formValue.status ?? "inbox")}>
              {(value.status === "graduated"
                ? ["graduated"]
                : stages.filter((s) => s !== "graduated")
              ).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="quiet">
          Estimates are optional. Unknown is useful information.
        </p>
        <div className="form-grid">
          {Object.entries(assessments).map(([key, label]) => (
            <label key={key}>
              {label}
              <select
                name={key}
                defaultValue={String(formValue[key as keyof IdeaFields])}
              >
                {bands.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <label>
          Start when
          <textarea
            name="startCondition"
            defaultValue={String(formValue.startCondition ?? "")}
            maxLength={4000}
            placeholder="What needs to become true before you begin?"
          />
        </label>
        <label>
          Smallest useful test
          <textarea
            name="experiment"
            defaultValue={String(formValue.experiment ?? "")}
            maxLength={4000}
          />
        </label>
        <label>
          Review on
          <input name="reviewOn" type="date" defaultValue={String(formValue.reviewOn ?? "")} />
        </label>
        <label>
          Evidence and value notes
          <textarea
            name="evidence"
            defaultValue={String(formValue.evidence ?? "")}
            maxLength={12000}
          />
        </label>
        {idea && (
          <details>
            <summary>Original capture and history</summary>
            <p className="prose">{idea.original}</p>
            {idea.legacy && <pre>{JSON.stringify(idea.legacy, null, 2)}</pre>}
            {idea.history.map((h) => (
              <details key={h.version}>
                <summary>Version {h.version}</summary>
                <pre>{JSON.stringify(h.fields, null, 2)}</pre>
              </details>
            ))}
          </details>
        )}
        <div className="actions">
          <button className="primary" disabled={busy || (!recommendation && (!draft.canSubmit || draft.blockedUnknown))}>
            {recommendation ? "Accept edited idea" : "Save idea"}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
        {!recommendation && <DraftStatus draft={draft} state={state} kind="idea" targetId={idea?.id ?? "new"} onDiscard={close} />}
      </form>
    </dialog>
  );
}

function GraduateIdea({
  state,
  idea,
  busy,
  error,
  act,
  close,
}: {
  state: State;
  idea: Idea;
  busy: boolean;
  error: string;
  act: Act;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [existing, setExisting] = useState("");
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.showModal();
    return () => {
      const target = opener instanceof HTMLElement && opener.isConnected
        ? opener : document.getElementById("forge-capture") ?? document.getElementById("workspace-main");
      target?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else close();
      }}
      aria-labelledby="graduate-heading"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const get = (k: string) => String(f.get(k) ?? "");
          if (
            await act("idea.graduate", {
              id: idea.id,
              targetVersion: idea.version,
              ...(existing
                ? { goalId: existing }
                : {
                    fields: {
                      title: get("title"),
                      intent: get("intent"),
                      successCriteria: get("successCriteria"),
                      owner: idea.owner,
                      status: "active",
                      projects: idea.projects,
                      tags: idea.tags,
                      evidence: idea.evidence,
                      milestones: get("milestone")
                        ? [{ title: get("milestone"), done: false }]
                        : [],
                    },
                  }),
            })
          )
            close();
        }}
      >
        <h2 id="graduate-heading">Graduate to goal</h2>
        <p>{idea.title}</p>
        <p>
          Keep this idea and its history connected to the outcome you choose to
          pursue.
        </p>
        {error && <p role="alert">{error}</p>}
        <label>
          Destination
          <select
            value={existing}
            onChange={(e) => setExisting(e.target.value)}
          >
            <option value="">Create a new goal</option>
            {state.goals
              .filter((g) => ["active", "paused"].includes(g.status))
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
          </select>
        </label>
        {!existing && (
          <>
            <label>
              Goal title
              <input
                name="title"
                required
                maxLength={180}
                defaultValue={idea.title}
              />
            </label>
            <label>
              Desired outcome
              <textarea
                name="intent"
                defaultValue={idea.description}
                maxLength={4000}
              />
            </label>
            <label>
              Success criteria
              <textarea
                name="successCriteria"
                required
                maxLength={4000}
                placeholder="What observable result will mean this succeeded?"
              />
            </label>
            <label>
              First milestone
              <input name="milestone" maxLength={240} />
            </label>
          </>
        )}
        <p className="quiet">
          Consider the time this needs and what current work it would displace.
        </p>
        <div className="actions">
          <button className="primary" disabled={busy}>
            Graduate idea
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
