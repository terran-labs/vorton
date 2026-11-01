"use client";
import "./workspace.css";
import {Opportunities,Finance,WorkspacePreferences} from './business-pages';
import { Forge, IdeaEditor, OrganizationInputs, RecordLabels, CouncilOrigin } from './forge';
import { recommendationResultKind } from './types';
import { OperationsOverview, OrganizationOverview } from "./workspace-overview";
import { CouncilDecisions } from "./council-decisions";
import { LoadingIndicator } from "./loading-indicator";
import { AdminPage, type AdminDestination } from "./admin-page";
import { loadSession, profileCache } from "./application/profile-cache";
import { useProfileState } from "./application/use-profile-state";
import { useReplica } from "./application/use-replica";
import { useWorkspaceAccess, workspaceAccess } from "./application/offline-context";
import { type DraftPreconditions, type DraftSubmitResult } from "./forge-draft-submit";
import { useWorkspaceCommand } from "./use-workspace-command";
import { DraftStatus, RetainedEditorDrafts, rawDraftFields, useForgeDraft } from "./forge-drafts";
// Selected reviewed component; provenance is recorded in design/SOURCE.md.
import { PageHeading } from "./design/page-heading";
import { SectionNavigator } from "./design/section-navigator";

import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  Profile,
  Role,
  State,
  Goal,
  Task,
  GoalFields,
  TaskFields,
  Recommendation,
} from "./types";

const CouncilHistory = lazy(() => import("./council-report").then((module) => ({ default: module.CouncilHistory })));
const RoundtableBriefing = lazy(() => import("./council-views").then((module) => ({ default: module.RoundtableBriefing })));
const councilSections = [
  { id: "council-timeline", label: "Timeline" },
  { id: "council-roundtable", label: "Roundtable" },
  { id: "council-session-record", label: "Report" },
  { id: "recommendations", label: "Review" },
];

const pages = [
  {id:'forge',label:'Forge'},
  {id:'opportunities',label:'Opportunities'},
  {id:'finance',label:'Finance'},
  { id: "guestbook", label: "Organization" },
  { id: "bridge", label: "Bridge" },
  { id: "council", label: "Council" },
  { id: "recommendations", label: "Recommendations" },
  { id: "goals", label: "Goals" },
  { id: "tasks", label: "Tasks" },
  { id: "factory", label: "Factory" },
  { id: "tools", label: "Tools" },
  { id: "admin", label: "Admin" },
];
const pretty = (s: string) => s.replaceAll(".", " ").replaceAll("-", " ");
const roleName = (state: State, role: Role) => state.council?.identities.find(x => x.id === role)?.name ?? role;
const formatDate = (s: string) =>
  new Date(s).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
export type PlanningControls = {
  state: State;
  addGoal: () => void;
  editGoal: (goal: Goal) => void;
  addTask: () => void;
  editTask: (task: Task) => void;
};
export function WorkspaceApp({
  profile,
  page,
  renderPlanning,
  renderGoalPrompt,
  renderRecommendationPrompt,
  embedded = false,
  renderFactory,
  renderTools,
  showDecisionHistory = false,
  adminSection = "",
  forgeView = "",
  adminDestinations = [],
}: {
  profile: Profile;
  page: string;
  adminSection?: string;
  forgeView?: string;
  adminDestinations?: AdminDestination[];
  renderPlanning?: (controls: PlanningControls) => ReactNode;
  renderGoalPrompt?: (goal: Goal, state: State) => ReactNode;
  renderRecommendationPrompt?: (recommendation: Recommendation) => ReactNode;
  embedded?: boolean;
  renderFactory?: () => ReactNode;
  renderTools?: (controls:{draftTask:(draft:TaskFields)=>void}) => ReactNode;
  showDecisionHistory?: boolean;
}) {
  const snapshot = useProfileState(profile);
  const state = snapshot.state;
  const access = useWorkspaceAccess();
  const activeProfile = useRef(profile);
  activeProfile.current = profile;
  const [readError, setReadError] = useState("");
  const { explicitCommand, command, busy, error, clearError } = useWorkspaceCommand(profile, setReadError);
  const displayError = error || readError;
  const [token, setToken] = useState("");
  const [ideaRecommendation, setIdeaRecommendation] = useState<Recommendation | null>(null);
  const [loadSteps, setLoadSteps] = useState(0);
  const [loadDetail, setLoadDetail] = useState("Connecting to your workspace");
  const loadGeneration = useRef(0);
  const [editor, setEditor] = useState<{
    kind: "goal" | "task";
    entity?: Goal | Task;
    recommendation?: Recommendation;
    draft?: TaskFields;
  } | null>(null);
  const draftTask = useCallback((draft: TaskFields) => setEditor({kind:"task",draft}), []);
  useEffect(() => {
    setEditor(null);
    setIdeaRecommendation(null);
    clearError();
  }, [profile, page, forgeView, adminSection, clearError]);
  async function load(signal?: AbortSignal) {
    const generation = ++loadGeneration.current;
    setReadError("");
    setLoadSteps(0);
    setLoadDetail("Connecting to your workspace");
    const completed = <T,>(value: T, remaining: string) => {
      if (!signal?.aborted && generation === loadGeneration.current) {
        setLoadSteps((count) => count + 1);
        setLoadDetail(remaining);
      }
      return value;
    };
    const [session, snapshot] = await Promise.all([
      (!workspaceAccess.getSnapshot().managed ? loadSession(!signal) : Promise.resolve(null))
        .then((value) => completed(value, `Reading ${profile} records`)),
      profileCache.load(profile, !signal).then((value) => completed(value, "Connecting your workspace session")),
    ]);
    if (signal?.aborted || generation !== loadGeneration.current) return;
    if (snapshot.profile !== profile)
      throw new Error("Installation mismatch. Refusing to display records.");
    if (session) setToken(session.token);
  }
  useEffect(() => {
    const controller = new AbortController();
    const request = load(controller.signal);
    const generation = loadGeneration.current;
    request.catch((e) => {
      if (!controller.signal.aborted && generation === loadGeneration.current && e.name !== "AbortError") setReadError(e.message);
    });
    return () => controller.abort();
  }, [profile, access.canWrite, access.epoch]);
  useEffect(() => { setReadError(snapshot.error ?? ""); }, [snapshot.error, snapshot.verifiedAt]);
  useEffect(() => {
    if (!access.managed) return;
    setToken("");
    // Session tokens serve live admin adapters only. They never gate saved
    // workspace reads, and mutations obtain their own scoped live ticket.
    if (page !== "admin" || !access.canWrite) return;
    let active = true;
    const ticket = workspaceAccess.getSnapshot();
    void loadSession().then(session => {
      workspaceAccess.assertLive(ticket);
      if (active && session.installationId === ticket.installationId && session.variant === ticket.variant && session.profiles.includes(profile)) setToken(session.token);
    }).catch(() => {});
    return () => { active = false; };
  }, [profile, page, access.managed, access.canWrite, access.epoch]);
  useEffect(() => {
    if (!state || !['goals', 'tasks', 'forge'].includes(page)) return;
    // Records arrive after the browser's initial fragment navigation.
    const target = document.getElementById(location.hash.slice(1));
    target?.scrollIntoView({block: 'center'});
  }, [Boolean(state), page]);
  return (
    <div className={renderPlanning ? "vorton-planning" : "vorton-workspace"}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <section id="main" aria-busy={busy || (!state && !displayError)}>
        {displayError && (
          <div role="alert" className="error">
            <strong>{error ? "Could not complete that action." : "Could not load records."}</strong>
            <p>{displayError}</p>
            <button
              onClick={() => {
                // Acknowledging an old action error does not retry its mutation.
                // Clear before the read so a later action failure remains visible.
                clearError();
                void load().catch((e) => { if (activeProfile.current === profile) setReadError(e.message); });
              }}
            >
              Refresh records
            </button>
          </div>
        )}
        {!pages.some((p) => p.id === page) ? (
          <h1>Page not found</h1>
        ) : !state ? (
          displayError ? null : <LoadingIndicator label={`Loading ${profile} records`} detail={loadDetail} progress={{ completed: loadSteps, total: 2 }} />
        ) : renderPlanning && !state.canonical ? (
          <p role="alert">
            The authoritative planning service is starting. Refresh before
            editing.
          </p>
        ) : renderPlanning ? (
          renderPlanning({
            state,
            addGoal: () => setEditor({ kind: "goal" }),
            editGoal: (entity) => setEditor({ kind: "goal", entity }),
            addTask: () => setEditor({ kind: "task" }),
            editTask: (entity) => setEditor({ kind: "task", entity }),
          })
        ) : (
          <>
            {page === "forge" && <Forge state={state} view={forgeView} busy={busy} error={error} act={command} submitDraft={explicitCommand} openEditor={request=>setEditor(request as never)} editIdeaSuggestion={setIdeaRecommendation} draftTask={draftTask}/>}
            {page === 'opportunities' && <Opportunities state={state} busy={busy} error={error} act={command} draftTask={draft=>setEditor({kind:'task',draft})}/>}
            {page === 'finance' && <Finance state={state} busy={busy} error={error} act={command}/>}
            {page === "guestbook" && <OrganizationOverview state={state}/>}
            {page === "goals" && (
              <Goals
                state={state}
                open={(entity) => setEditor({ kind: "goal", entity })}
                add={() => setEditor({ kind: "goal" })}
              />
            )}
            {page === "tasks" && (
              <Tasks
                state={state}
                open={(entity) => setEditor({ kind: "task", entity })}
                add={() => setEditor({ kind: "task" })}
              />
            )}
            {["bridge", "council", "recommendations"].includes(page) && (
                <Command
                  view={page === "recommendations" ? "council" : page}
                  state={state}
                  busy={busy}
                  act={command}
                  renderRecommendationPrompt={renderRecommendationPrompt}
                  renderGoalPrompt={renderGoalPrompt}
                  edit={(r) => ["idea", "idea-review"].includes(r.kind) ? setIdeaRecommendation(r) :
                    setEditor({
                      kind: r.kind.startsWith("goal") || r.kind === "idea-graduate" ? "goal" : "task",
                      recommendation: r,
                    })
                  }
                />
              )}
            {page === "tools" && (renderTools ? renderTools({draftTask:draft=>setEditor({kind:'task',draft})}) : !embedded && <Heading title="Tools" description="Tools available in this workspace." />)}
            {page === "tools" && renderFactory && <p><a href={`/${profile.toLowerCase()}/factory`}>Open Factory</a></p>}
            {page === "factory" && renderFactory?.()}
            {page === "admin" && <AdminPage state={state} section={adminSection} destinations={adminDestinations} token={token} preferences={state.settings ? <WorkspacePreferences state={state} busy={busy} error={error} act={command}/> : undefined} activity={<Activity state={state}/>} decisions={showDecisionHistory ? <Decisions state={state}/> : undefined}/>}
          </>
        )}
      </section>
      {ideaRecommendation && state && <IdeaEditor state={state} recommendation={ideaRecommendation} busy={busy} error={error} close={()=>setIdeaRecommendation(null)} save={async fields=>{if(await command("recommendation.resolve",{id:ideaRecommendation.id,decision:"accepted",fields}))setIdeaRecommendation(null);}}/>}
      {editor && state && (
        <div className="vorton-workspace">
          <Editor
            key={editor.entity?.id || editor.recommendation?.id || editor.kind}
            {...editor}
            state={state}
            busy={busy}
            error={error}
            close={() => setEditor(null)}
            save={async (fields, preconditions, unknownRequestId, prepareAttempt) => {
              if (editor.recommendation) {
                const okay = await command("recommendation.resolve", {
                    id: editor.recommendation.id,
                    decision: "accepted",
                    fields,
                  });
                if (okay) setEditor(null);
                return;
              }
              return explicitCommand(
                    `${editor.kind}.${editor.entity ? "update" : "create"}`,
                    { id: editor.entity?.id, fields },
                    preconditions, unknownRequestId, prepareAttempt,
                  );
            }}
          />
        </div>
      )}
    </div>
  );
}
function Heading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return <PageHeading title={title} description={description} actions={children}/>;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
function Goals({
  state,
  open,
  add,
  intro,
}: {
  state: State;
  open: (g: Goal) => void;
  add: () => void;
  intro?: ReactNode;
}) {
  const [status, setStatus] = useState(location.hash.startsWith("#goal-") ? "all" : "active");
  const goals = state.goals.filter(g => status === "all" || g.status === status);
  return (
    <>
      <PageHeading title="Goals" actions={
        <button className="primary" onClick={add}>
          New goal
        </button>
      }/>
      {intro}
      <div className="filters">
        <label>
          Status
          <select data-vorton-view-control value={status} onChange={(e) => setStatus(e.target.value)}>
            {["active", "paused", "achieved", "retired", "all"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <span>{goals.length} goals</span>
      </div>
      {!goals.length ? (
        <Empty
          title={
            state.goals.length
              ? "No matching goals"
              : "Start with a goal worth pursuing"
          }
        >
          Add an outcome, its success criteria, and the next milestone. Existing
          strategic records outside this core remain unchanged.
        </Empty>
      ) : (
        <div className="goal-list forge-grid">
          {goals.map((g) => (
            <article className="panel goal forge-card" key={g.id} id={`goal-${g.id}`}>
              <div className="record-heading">
                <div>
                  {g.parentId && (
                    <p className="parent-goal">
                      Part of{" "}
                      {state.goals.find((p) => p.id === g.parentId)?.title}
                    </p>
                  )}
                  <h2>
                    <button className="title-button" onClick={() => open(g)}>
                      {g.title}
                    </button>
                  </h2>
                  <p>
                    {g.owner}
                    {g.horizon && ` · ${g.horizon}`}
                  </p>
                </div>
                <span className={`badge ${g.status}`}>{g.status}</span>
              </div>
              <p className="prose">
                {g.intent || "Intent has not been recorded."}
              </p>
              <p className="quiet">{g.progress}% complete{g.reviewOn ? ` · Review ${g.reviewOn}` : ""}</p>
              <button className="forge-edit-idea" onClick={() => open(g)}>Edit goal</button>
              <details><summary>Success, progress and evidence</summary>
              <RecordLabels record={g}/><CouncilOrigin state={state} id={g.id}/>
              {(g.ideaIds ?? []).map(id => <p key={id}><a href={`/${state.profile.toLowerCase()}/forge/ideas#idea-${id}`}>{state.ideas?.find(idea => idea.id === id)?.title ?? "Source idea"}</a></p>)}
              <div className="goal-columns">
                <div>
                  <h3>Success looks like</h3>
                  <p className="prose">
                    {g.successCriteria || "Add a concrete success criterion."}
                  </p>
                  {g.milestones.length > 0 && (
                    <ul className="milestones">
                      {g.milestones.map((m, i) => (
                        <li key={i} data-done={m.done}>
                          <span
                            aria-label={m.done ? "Completed" : "Not complete"}
                          >
                            {m.done ? "✓" : "○"}
                          </span>
                          {m.title}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3>Progress</h3>
                  <p className="quiet">Owner estimate. Task completion does not establish the outcome.</p>
                  <div className="progress-label">
                    <span>{g.progress}%</span>
                    <span>
                      {
                        state.tasks.filter(
                          (t) => t.goalId === g.id && t.status === "done",
                        ).length
                      }{" "}
                      of {state.tasks.filter((t) => t.goalId === g.id).length}{" "}
                      tasks done
                    </span>
                  </div>
                  <progress max="100" value={g.progress} />
                  {g.reviewOn && <p>Next review: {g.reviewOn}</p>}
                  {g.evidence && (
                    <details>
                      <summary>Evidence</summary>
                      <p className="prose">{g.evidence}</p>
                    </details>
                  )}
                </div>
              </div>
              </details>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
function Tasks({
  state,
  open,
  add,
  intro,
}: {
  state: State;
  open: (t: Task) => void;
  add: () => void;
  intro?: ReactNode;
}) {
  const access = useWorkspaceAccess();
  const { explicitCommand, busy } = useWorkspaceCommand(state.profile);
  const [unknown, setUnknown] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  const filterControl = useRef<HTMLSelectElement>(null);
  const replica = useReplica(state.profile);
  const canWrite = access.managed
    ? (access.canWrite || replica.ready && !replica.historyChanged) && access.profile === state.profile
    : navigator.onLine !== false;
  async function toggleTask(task: Task, opener: HTMLButtonElement) {
    if (!canWrite || busy || checking || unknown) return;
    const reopen = ["done", "cancelled"].includes(task.status);
    const fields: TaskFields = {
      title: task.title, notes: task.notes, goalId: task.goalId, owner: task.owner,
      dueOn: task.dueOn, priority: task.priority, status: reopen ? "todo" : "done",
      ...(task.projects !== undefined ? { projects: task.projects } : {}),
      ...(task.tags !== undefined ? { tags: task.tags } : {}),
      ...(task.ideaIds !== undefined ? { ideaIds: task.ideaIds } : {}),
    };
    const result = await explicitCommand("task.update", { id: task.id, fields },
      { basedOnRevision: state.revision, syncGeneration: state.syncGeneration, entityVersion: task.version });
    if (result.status === "unknown") setUnknown(true);
    setNotice(result.status === "saved" ? reopen ? "Task reopened." : "Task completed." : result.message);
    if (result.status === "saved" || result.status === "locally-saved") requestAnimationFrame(() => {
      if (!opener.isConnected) filterControl.current?.focus({ preventScroll: true });
    });
  }
  async function reviewTasks() {
    if (!canWrite || busy || checking) return;
    const ticket = workspaceAccess.getSnapshot();
    setChecking(true);
    try {
      if (ticket.managed) workspaceAccess.assertLive(ticket);
      // A forced managed load can still join an older in-flight GET. Wait for
      // that read to settle before requesting evidence after the unknown POST.
      if (profileCache.read(state.profile).loading) await profileCache.load(state.profile).catch(() => undefined);
      if (ticket.managed) workspaceAccess.assertLive(ticket);
      await profileCache.load(state.profile, true);
      if (ticket.managed) workspaceAccess.assertLive(ticket);
      setUnknown(false);
      setNotice("Current task records loaded. Review their status before another action.");
    } catch (cause) { setNotice((cause as Error).message); }
    finally { setChecking(false); }
  }
  const [filter, setFilter] = useState(location.hash.startsWith("#task-") ? "all" : "open");
  const tasks = state.tasks.filter(
    (t) =>
      filter === "all" ||
      (filter === "open"
        ? !["done", "cancelled"].includes(t.status)
        : t.status === filter),
  );
  return (
    <>
      <PageHeading title="Tasks" actions={
        <button className="primary" onClick={add}>
          New task
        </button>
      }/>
      {intro}
      <div className="filters">
        <label>
          Show
          <select data-vorton-view-control ref={filterControl} value={filter} onChange={(e) => setFilter(e.target.value)}>
            {[
              "open",
              "todo",
              "doing",
              "blocked",
              "done",
              "cancelled",
              "all",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <span>{tasks.length} tasks</span>
      </div>
      {notice && <p role="status">{notice}</p>}
      {unknown && <p>A save may already have reached the server. Task actions are blocked until you review current records. No action will be replayed. <button disabled={!canWrite || busy || checking} onClick={() => void reviewTasks()}>Review current task records</button></p>}
      {!tasks.length ? (
        <Empty title="No tasks in this view">
          Create a task or review an executive recommendation. A task records
          intent; it does not authorize a coding worker to run.
        </Empty>
      ) : (
        <div className="panel task-list">
          {tasks.map((t) => (
            <article key={t.id} id={`task-${t.id}`} className="task-row">
              <button type="button" className="task-check" role="checkbox" aria-checked={t.status === "done"} aria-label={`${["done", "cancelled"].includes(t.status) ? "Reopen" : "Complete"} task: ${t.title}`}
                disabled={!canWrite || busy || checking || unknown || Boolean(state.canonical && t.status === "done")}
                onClick={event => void toggleTask(t, event.currentTarget)}>{t.status === "done" ? "✓" : ""}</button>
              <div className="task-line">
                <h2><button className="title-button" onClick={() => open(t)}>{t.title}</button></h2>
                <span className="task-meta">{[t.status !== "todo" && pretty(t.status), t.dueOn && `Due ${t.dueOn}`, t.goalId && state.goals.find(g => g.id === t.goalId)?.title].filter(Boolean).join(" · ")}</span>
                {(t.notes || state.canonical || (t.ideaIds?.length ?? 0) > 0) && <details className="task-details"><summary>Details</summary>
                  {t.notes && <p className="prose">{t.notes}</p>}
                  <p className="quiet">{t.owner}</p><RecordLabels record={t}/><CouncilOrigin state={state} id={t.id}/>
                  {(t.ideaIds ?? []).map(id => <p key={id}><a href={`/${state.profile.toLowerCase()}/forge/ideas#idea-${id}`}>{state.ideas?.find(i => i.id === id)?.title ?? "Source idea"}</a></p>)}
                  {state.canonical && t.status !== "done" && <p>Record completion evidence in Notes before completing this task.</p>}
                  {state.canonical && t.status === "done" && <><p>Completed outcomes stay recorded. Create a follow-up for new work.</p><button type="button" disabled={busy} onClick={add}>Create follow-up task</button></>}
                </details>}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
function Command({
  view,
  state,
  busy,
  act,
  edit,
  renderGoalPrompt,
  renderRecommendationPrompt,
}: {
  view: string;
  state: State;
  busy: boolean;
  act: (a: string, p: unknown) => Promise<boolean | undefined>;
  edit: (r: Recommendation) => void;
  renderGoalPrompt?: (goal: Goal, state: State) => ReactNode;
  renderRecommendationPrompt?: (recommendation: Recommendation) => ReactNode;
}) {
  const [importText, setImportText] = useState("");
  // Undefined follows the latest receipt, while an explicit empty selection
  // means imported recommendations. Keep both panes on the same valid date.
  const [chosenSessionId, setSessionId] = useState<string | undefined>();
  const latestSessionId = [...(state.councilSessions ?? [])].sort((a,b) => a.publishedAt.localeCompare(b.publishedAt)).at(-1)?.id ?? "";
  const sessionId = chosenSessionId === "" ? "" : state.councilSessions?.some(session => session.id === chosenSessionId) ? chosenSessionId : latestSessionId;
  const [notice, setNotice] = useState("");
  const councilPage = useRef<HTMLDivElement>(null);
  const identities = state.council?.identities ?? [];
  useEffect(() => {
    const page = councilPage.current;
    if (view !== "council" || !page) return;
    let appliedHash = "";
    let frame = 0;
    const followSectionHash = () => {
      const hash = location.hash;
      const id = hash.slice(1);
      if (hash === appliedHash || !(councilSections.some(section => section.id === id) || (state.profile === "AubOS" && id === "council-tuning") || id.startsWith('recommendation-'))) return;
      // The report and timeline arrive through a lazy module. Wait for that
      // content before positioning any section below it, including Review.
      if (!page.querySelector("#council-timeline")) return;
      const target = document.getElementById(id);
      if (!target || !page.contains(target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (location.hash !== hash || !target.isConnected) return;
        target.scrollIntoView({ block: "start", behavior: "instant" });
        appliedHash = hash;
      });
    };
    const onHashChange = () => { appliedHash = ""; followSectionHash(); };
    const observer = new MutationObserver(followSectionHash);
    observer.observe(page, { childList: true, subtree: true });
    window.addEventListener("hashchange", onHashChange);
    followSectionHash();
    return () => {
      observer.disconnect();
      window.removeEventListener("hashchange", onHashChange);
      cancelAnimationFrame(frame);
    };
  }, [view, state.profile]);
  return (
    <>
      {view !== "council" && <Heading
        title={
          view === "recommendations"
              ? "Recommendations"
              : "Bridge"
        }
        description={
          view === "recommendations"
              ? "Turn council judgment into accepted work."
              : "The objective, the work, and what needs your attention."
        }
      />}
      {view === "bridge" && <>
        <OperationsOverview state={state}/>
        <Suspense fallback={<LoadingIndicator compact label="Loading council briefing"/>}><RoundtableBriefing state={state}/></Suspense>
      </>}
      {view === "council" && (
        <div ref={councilPage} className="council-page-navigation"><Suspense fallback={<LoadingIndicator label="Loading council history" />}><SectionNavigator label="Council page sections" pageWidth="contained" items={state.profile === "AubOS" ? [...councilSections, {id:"council-tuning",label:"Tuning"}] : councilSections}>
          <CouncilHistory state={state} sessionId={sessionId} onSessionChange={setSessionId}/>
          <CouncilDecisions state={state} sessionId={sessionId} onSessionChange={setSessionId} busy={busy} act={act} edit={edit} renderRecommendationPrompt={renderRecommendationPrompt}/>
          <section className="panel" aria-label="Council identities">
            <h2>{state.profile} council identities</h2>
            <p>{state.council?.behavior.focus}</p>
            <p>{state.council?.behavior.decisionCriteria}</p>
            <div className="record-list">{identities.map(identity => <details key={identity.id}>
              <summary>{identity.name} · {identity.title}</summary>
              <p>{identity.mandate}</p><p>{identity.voice}</p>
              <p><strong>Expertise:</strong> {identity.expertise}</p>
              <p><strong>Blind spot:</strong> {identity.blindSpot}</p>
              <p><strong>Challenge:</strong> {identity.challenge}</p>
              <p className="quiet">{identity.inherited ? "Inherited from Vorton core." : "Added by this organization."}</p>
            </details>)}</div>
          </section>
          <section id="council" className="panel">
            <h2>Executive council</h2>
            {notice && <p role="status">{notice}</p>}
            <details className="import-panel">
              <summary>Import executive recommendations</summary>
              <p>
                Paste reviewed JSON produced using the canonical Council review API.
                Import creates proposals only. Stale or foreign-installation
                packets are rejected.
              </p>
              <textarea
                aria-label="Recommendations JSON"
                data-vorton-unsaved={Boolean(importText)}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={8}
                placeholder="Paste the agent's JSON response"
              />
              <button
                disabled={busy || !importText.trim()}
                onClick={async () => {
                  try {
                    const body = JSON.parse(importText);
                    if (
                      await act(
                        body.contract === "vorton-local.council-session.v1"
                          ? "council.publish"
                          : "recommendations.import",
                        body,
                      )
                    ) {
                      setImportText("");
                      setNotice(
                        "Recommendations added to your inbox. Nothing was automatically accepted.",
                      );
                    }
                  } catch {
                    setNotice("That response is not valid JSON.");
                  }
                }}
              >
                Import recommendations
              </button>
            </details>
          </section>
          {state.profile === "AubOS" && <section id="council-tuning" className="panel" aria-labelledby="council-tuning-heading">
            <h2 id="council-tuning-heading">Tuning</h2>
            <p>Further Council tuning is available in the admin interface. Compare retained reports and instructions, save tuning drafts, and explicitly request private model previews.</p>
            <p><a href="/aubos/admin/council-tuning">Open Council Tuning in Admin ↗</a></p>
            <p className="quiet">Saving a draft or running a preview does not change the production Council. Promotion requires a separate reviewed deployment.</p>
          </section>}
        </SectionNavigator></Suspense></div>
      )}
    </>
  );
}
function Decisions({ state }: { state: State }) {
  return (
    <section id="decisions" className="panel">
      <h2>Decisions</h2>
      {state.recommendations.filter((r) =>
        ["accepted", "rejected"].includes(r.status),
      ).length ? (
        state.recommendations
          .filter((r) => ["accepted", "rejected"].includes(r.status))
          .slice()
          .reverse()
          .map((r) => (
            <article
              key={r.id}
              className="task-row"
              id={`recommendation-${r.id}`}
            >
              <div>
                <span className="badge">{r.status}</span>
                <h3>{r.proposal.title}</h3>
                <p>
                  {roleName(state, r.role)} · {pretty(r.kind)}
                </p>
                {r.ownerNote && <p>{r.ownerNote}</p>}
                <details>
                  <summary>Recommendation evidence</summary>
                  <p className="prose">{r.rationale}</p>
                  <p className="prose">
                    {r.evidence || "No evidence supplied."}
                  </p>
                </details>
              </div>
              {r.resultId && (
                <a
                  href={`/${state.profile.toLowerCase()}/forge/${recommendationResultKind(r.kind)}s#${recommendationResultKind(r.kind)}-${r.resultId}`}
                >
                  Open resulting {recommendationResultKind(r.kind)}
                </a>
              )}
            </article>
          ))
      ) : (
        <p>No recommendations have been accepted or rejected yet.</p>
      )}
    </section>
  );
}
function Activity({ state }: { state: State }) {
  return state.events.length ? (
    <ol className="activity-list">
      {state.events
        .slice(-50)
        .reverse()
        .map((e) => (
          <li key={e.id}>
            <div>
              <strong>{pretty(e.action)}</strong>
              {e.detail && <p>{e.detail}</p>}
            </div>
            <time dateTime={e.at}>{formatDate(e.at)}</time>
          </li>
        ))}
    </ol>
  ) : (
    <p>No changes have been recorded yet.</p>
  );
}
function Editor({
  kind,
  entity,
  draft,
  recommendation,
  state,
  busy,
  error,
  close,
  save,
}: {
  kind: "goal" | "task";
  entity?: Goal | Task;
  draft?: TaskFields;
  recommendation?: Recommendation;
  state: State;
  busy: boolean;
  error: string;
  close: () => void;
  save: (fields: GoalFields | TaskFields, preconditions?: DraftPreconditions, unknownRequestId?: string, prepareAttempt?: (requestId: string) => Promise<boolean>) => Promise<DraftSubmitResult | void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const value = (recommendation?.proposal ?? entity ?? draft ?? {}) as Partial<
    GoalFields & TaskFields
  >;
  const localDraft = useForgeDraft({ profile: state.profile,
    kind: kind === "goal" ? "goal-editor-v1" : "task-editor-v1", targetId: entity?.id ?? "new", enabled: !recommendation,
    fields: {
      ...Object.fromEntries(["title", "intent", "successCriteria", "horizon", "parentId", "reviewOn", "evidence", "notes", "goalId", "dueOn"].map(key =>
        [key, String(value[key as keyof typeof value] ?? "")])),
      owner: value.owner || state.settings?.defaultOwner || "Owner", priority: value.priority ?? "normal",
      status: value.status ?? (kind === "goal" ? "active" : "todo"), progress: String(value.progress ?? 0),
      projects: value.projects?.join(", ") ?? "", tags: value.tags?.join(", ") ?? "",
      milestones: value.milestones?.map(m => `[${m.done ? "x" : " "}] ${m.title}`).join("\n") ?? "",
    }, baseline: { revision: state.revision, ...(state.syncGeneration ? { syncGeneration: state.syncGeneration } : {}), ...(entity ? { version: entity.version } : {}), relations: { ideaIds: value.ideaIds ?? [] } } });
  const formValue = recommendation ? value : localDraft.fields;
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current
      ?.querySelector<HTMLInputElement>('input[name="title"]')
      ?.focus();
  }, [localDraft.loading, localDraft.renderKey]);
  if (!recommendation && localDraft.loading) return <p role="status">Restoring local {kind} draft…</p>;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recommendation && (!localDraft.canSubmit || localDraft.blockedUnknown)) return;
    const data = new FormData(event.currentTarget);
    const string = (key: string) => String(data.get(key) ?? "");
    const shared = {
      title: string("title"),
      owner: string("owner"),
      priority: string("priority"),
      status: string("status"),
      projects: string("projects").split(",").map(v=>v.trim()).filter(Boolean),
      tags: string("tags").split(",").map(v=>v.trim()).filter(Boolean),
      ideaIds: recommendation ? value.ideaIds ?? [] : localDraft.baseline.relations?.ideaIds ?? value.ideaIds ?? [],
    };
    const fields =
      kind === "goal"
        ? {
            ...shared,
            intent: string("intent"),
            successCriteria: string("successCriteria"),
            horizon: string("horizon"),
            parentId: string("parentId"),
            reviewOn: string("reviewOn"),
            evidence: string("evidence"),
            progress: Number(string("progress")),
            milestones: string("milestones")
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => ({
                title: l.replace(/^\s*\[[ xX]\]\s*/, "").trim(),
                done: /^\s*\[[xX]\]/.test(l),
              })),
          }
        : {
            ...shared,
            notes: string("notes"),
            goalId: string("goalId"),
            dueOn: string("dueOn"),
          };
    if (recommendation) { await save(fields); return; }
    const submitted = await localDraft.beginSubmit();
    const result = await save(fields, { basedOnRevision: localDraft.baseline.revision ?? -1, syncGeneration: localDraft.baseline.syncGeneration, entityVersion: localDraft.baseline.version, localRecordId: localDraft.localRecordId }, localDraft.unknownRequestId,
      requestId => localDraft.prepareAttempt(requestId, submitted));
    if (result && await localDraft.finishSubmit(result, submitted)) close();
  }
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else close();
      }}
      aria-labelledby="editor-heading"
    >
      <form key={localDraft.renderKey} data-vorton-unsaved={!localDraft.pristine} onSubmit={submit}
        onChange={!recommendation ? event => localDraft.update(rawDraftFields(event.currentTarget)) : undefined}>
        <div className="dialog-heading">
          <h2 id="editor-heading">
            {recommendation ? "Edit and accept" : entity ? "Edit" : "New"}{" "}
            {kind}
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="Close editor"
          >
            ×
          </button>
        </div>
        {error && (
          <p role="alert" className="error">
            {error} Your unsaved fields remain here. Close this editor and
            refresh records if the view is stale.
          </p>
        )}
        {!recommendation && <RetainedEditorDrafts draft={localDraft} profile={state.profile}/>}
        <label>
          Title
          <input
            name="title"
            defaultValue={String(formValue.title ?? "")}
            required
            maxLength={180}
            autoFocus
          />
        </label>
        <div className="form-grid">
          <label>
            Owner
            <input
              name="owner"
              defaultValue={String(formValue.owner || state.settings?.defaultOwner || "Owner")}
              required
              maxLength={120}
            />
          </label>
          <label>
            Priority
            <select name="priority" defaultValue={String(formValue.priority ?? "normal")}>
              {["high", "normal", "low"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select
              name="status"
              defaultValue={
                String(formValue.status ?? (kind === "goal" ? "active" : "todo"))
              }
            >
              {(kind === "goal"
                ? ["active", "paused", "achieved", "retired"]
                : ["todo", "doing", "blocked", "done", "cancelled"]
              ).map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            {kind === "goal" ? "Parent goal" : "Linked goal"}
            <select
              name={kind === "goal" ? "parentId" : "goalId"}
              defaultValue={String((kind === "goal" ? formValue.parentId : formValue.goalId) ?? "")}
            >
              <option value="">None</option>
              {state.goals
                .filter((g) => g.id !== entity?.id)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <OrganizationInputs value={recommendation ? value : {
          projects: String(localDraft.fields.projects ?? ""), tags: String(localDraft.fields.tags ?? ""),
        }} state={state}/>
        {kind === "goal" ? (
          <>
            <label>
              Intent
              <textarea
                name="intent"
                defaultValue={String(formValue.intent ?? "")}
                rows={3}
                maxLength={4000}
              />
            </label>
            <label>
              Success criteria
              <textarea
                name="successCriteria"
                defaultValue={String(formValue.successCriteria ?? "")}
                rows={3}
                maxLength={4000}
              />
            </label>
            <div className="form-grid">
              <label>
                Horizon
                <input
                  name="horizon"
                  defaultValue={String(formValue.horizon ?? "")}
                  placeholder="This month, this year…"
                  maxLength={160}
                />
              </label>
              <label>
                Review on
                <input
                  type="date"
                  name="reviewOn"
                  defaultValue={String(formValue.reviewOn ?? "")}
                />
              </label>
              <label>
                Progress (%)
                <input
                  type="number"
                  name="progress"
                  defaultValue={String(formValue.progress ?? 0)}
                  min={0}
                  max={100}
                  step={1}
                  required
                />
              </label>
            </div>
            <label>
              Milestones
              <textarea
                name="milestones"
                rows={4}
                defaultValue={recommendation ? value.milestones?.map(m => `[${m.done ? "x" : " "}] ${m.title}`).join("\n") : String(localDraft.fields.milestones ?? "")}
                placeholder="One per line. Start a completed milestone with [x]."
              />
            </label>
            <label>
              Evidence and progress notes
              <textarea
                name="evidence"
                rows={3}
                defaultValue={String(formValue.evidence ?? "")}
                maxLength={12000}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Due on
              <input type="date" name="dueOn" defaultValue={String(formValue.dueOn ?? "")} />
            </label>
            <label>
              Notes and completion evidence
              <textarea
                name="notes"
                defaultValue={String(formValue.notes ?? "")}
                rows={5}
                maxLength={8000}
              />
            </label>
          </>
        )}
        {entity?.history.length ? (
          <details>
            <summary>Previous versions ({entity.history.length})</summary>
            {entity.history
              .slice()
              .reverse()
              .map((h) => (
                <div key={h.version}>
                  <h3>Version {h.version}</h3>
                  <p>{formatDate(h.at)}</p>
                  <pre>{JSON.stringify(h.fields, null, 2)}</pre>
                </div>
              ))}
          </details>
        ) : null}
        <p className="quiet">
          Saving this record does not authorize external action or factory
          execution.
        </p>
        <div className="actions">
          <button className="primary" disabled={busy || (!recommendation && (!localDraft.canSubmit || localDraft.blockedUnknown))}>
            {busy
              ? "Saving…"
              : recommendation
                ? "Accept edited recommendation"
                : `Save ${kind}`}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
        {!recommendation && <DraftStatus draft={localDraft} state={state} kind={kind} targetId={entity?.id ?? "new"} onDiscard={close} />}
      </form>
    </dialog>
  );
}
