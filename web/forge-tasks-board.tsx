// Shared task actions across grouped List and Board views.
// Board provenance: docs/mockups/forge/concept-board.js. Every view opens the
// existing editor and uses the same guarded writer.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ViewportRail } from "./design/viewport-rail";
import {
  Avatar, DueChip, Provenance, SuggestionActions, hueFor, isRevision, suggestionKeys, suggestions, taskStageLabels,
  todayIso, type ForgeActions, type ForgeViewProps,
} from "./forge-shared";
import type { Goal, Recommendation, State, Task, TaskFields } from "./types";
import "./forge-tasks-board.css";

type Column = "suggested" | "todo" | "doing" | "blocked" | "done";
const VIEWS = ["list", "board"] as const;
type TaskView = typeof VIEWS[number];
const VIEW_LABEL: Record<TaskView, string> = { list: "List", board: "Board" };
const FLOW = ["todo", "doing", "blocked", "done"] as const;
type Flow = (typeof FLOW)[number];
const LABEL: Record<Column, string> = { suggested: "Suggested", todo: "To do", doing: "In progress", blocked: "Blocked", done: "Done" };
const EMPTY: Record<Flow, string> = {
  todo: "Nothing waiting. Drag a card here or add a task.",
  doing: "Nothing in progress.",
  blocked: "Nothing blocked.",
  done: "Nothing finished in the last two weeks.",
};
const RECENT_MS = 14 * 86_400_000;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, critical: 0, high: 1, normal: 2, medium: 2, low: 3 };
const isHigh = (priority: string) => ["high", "urgent", "critical"].includes(String(priority).toLowerCase());
const shortDate = (iso: string) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "none";

/** The column a task lives in. Cancelled tasks sit at the foot of Done. */
const columnOf = (task: Task): Flow | "cancelled" =>
  task.status === "cancelled" ? "cancelled" : (FLOW as readonly string[]).includes(task.status) ? task.status as Flow : "todo";

function sortOpen(a: Task, b: Task) {
  const rank = (t: Task) => PRIORITY_RANK[String(t.priority).toLowerCase()] ?? 2;
  return rank(a) - rank(b) || (a.dueOn || "9999").localeCompare(b.dueOn || "9999") || a.title.localeCompare(b.title);
}
const byRecent = (a: Task, b: Task) => (b.updatedAt || "").localeCompare(a.updatedAt || "");

type Drag = { kind: "task"; task: Task; from: Flow | "cancelled" } | { kind: "suggestion"; recommendation: Recommendation; to: Flow };

function StageIcon({ stage }: { stage: Column }) {
  const ring = <circle cx="8" cy="8" r="5.75" />;
  const body = {
    suggested: <path d="M8 1.8 9.3 6.7 14.2 8l-4.9 1.3L8 14.2 6.7 9.3 1.8 8l4.9-1.3z" fill="currentColor" stroke="none" />,
    todo: ring,
    doing: <>{ring}<path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor" stroke="none" /></>,
    blocked: <>{ring}<path d="M6.5 5.6v4.8M9.5 5.6v4.8" /></>,
    done: <><circle cx="8" cy="8" r="6.25" fill="currentColor" stroke="none" /><path d="m5.3 8.2 1.8 1.8 3.6-3.8" stroke="var(--ftb-on-fill)" strokeWidth="1.6" /></>,
  }[stage];
  return (
    <svg className={`ftb-stage st-${stage}`} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {body}
    </svg>
  );
}

/** Spread goal hues around the wheel; similar ids such as g1 and g2 otherwise land on neighbouring hues. */
const goalHue = (goal: Goal) => Math.round((hueFor(goal.id) * 137.508) % 360);

function GoalPill({ goal, suggested = false }: { goal?: Goal; suggested?: boolean }) {
  if (!goal) return null;
  return (
    <span className={`ftb-goal${suggested ? " is-suggested-goal" : ""}`} style={{ "--g": goalHue(goal) } as React.CSSProperties} title={`Goal: ${goal.title}`}>
      <i aria-hidden="true" /><span>{goal.title}</span>
    </span>
  );
}

/** What a revision suggestion would change on its existing task. */
function revisionChanges(full: State, target: Task, proposal: TaskFields) {
  const changes: string[] = [];
  const goalTitle = (id: string) => full.goals.find((g) => g.id === id)?.title ?? "no goal";
  if (proposal.title !== undefined && proposal.title !== target.title) changes.push(`Title: ${proposal.title}`);
  if (proposal.dueOn !== undefined && proposal.dueOn !== target.dueOn) changes.push(`Due ${shortDate(target.dueOn)} → ${shortDate(proposal.dueOn)}`);
  if (proposal.status !== undefined && proposal.status !== target.status)
    changes.push(`Stage ${taskStageLabels[target.status] ?? target.status} → ${taskStageLabels[proposal.status] ?? proposal.status}`);
  if (proposal.owner !== undefined && proposal.owner !== target.owner) changes.push(`Owner ${target.owner || "nobody"} → ${proposal.owner || "nobody"}`);
  if (proposal.priority !== undefined && proposal.priority !== target.priority) changes.push(`Priority ${target.priority} → ${proposal.priority}`);
  if (proposal.goalId !== undefined && proposal.goalId !== target.goalId) changes.push(`Goal: ${goalTitle(proposal.goalId)}`);
  if (proposal.notes !== undefined && proposal.notes !== target.notes) changes.push("Notes updated");
  return changes;
}

function SuggestionCard({ recommendation, props, onDragStart, onDragEnd }: {
  recommendation: Recommendation; props: ForgeViewProps;
  onDragStart?: (event: React.DragEvent) => void; onDragEnd?: () => void;
}) {
  const { full, actions } = props;
  const proposal = recommendation.proposal as TaskFields;
  const revision = isRevision(recommendation);
  const target = revision ? full.tasks.find((t) => t.id === recommendation.targetId) : undefined;
  const changes = target ? revisionChanges(full, target, proposal) : [];
  const goal = full.goals.find((g) => g.id === proposal.goalId);
  return (
    <article className="ftb-card is-suggested" tabIndex={0} draggable={Boolean(onDragStart)} onDragStart={onDragStart} onDragEnd={onDragEnd}
      onKeyDown={suggestionKeys(recommendation, actions)}
      aria-label={`${revision ? "Suggested change to" : "Suggested task"}: ${target?.title ?? proposal.title}. Y confirm, E edit, N later, X decline.`}>
      <span className="forge-unconfirmed">{revision ? "Suggested change" : "Unconfirmed"}</span>
      {revision ? (
        <>
          <button type="button" className="ftb-title" onClick={() => actions.editSuggestion(recommendation)}>
            <span className="ftb-change-label">Change to: </span>{target?.title ?? proposal.title}
          </button>
          {changes.length > 0 && <ul className="ftb-changes">{changes.map((change) => <li key={change}>{change}</li>)}</ul>}
        </>
      ) : (
        <>
          <button type="button" className="ftb-title" onClick={() => actions.editSuggestion(recommendation)}>{proposal.title}</button>
          {(goal || proposal.dueOn) && <div className="ftb-meta"><GoalPill goal={goal} suggested /><DueChip dueOn={proposal.dueOn} /></div>}
        </>
      )}
      <Provenance state={full} recommendation={recommendation} />
      <SuggestionActions recommendation={recommendation} actions={actions} compact />
    </article>
  );
}

function TaskCard({ task, goal, focused, draggable, saving, dragging, onDragStart, onDragEnd, onMove, open, toggle, toggleDisabled, canonical, followUp }: {
  task: Task; goal?: Goal; focused: boolean; draggable: boolean; saving: boolean; dragging: boolean;
  onDragStart: (event: React.DragEvent) => void; onDragEnd: () => void;
  onMove: (direction: -1 | 1) => void; open: () => void; toggle: () => void; toggleDisabled: boolean;
  /** Governed records: completion needs evidence, and completed outcomes stay recorded. */
  canonical: boolean; followUp: () => void;
}) {
  const closed = task.status === "done" || task.status === "cancelled";
  const done = task.status === "done";
  return (
    <article id={`task-${task.id}`} tabIndex={0} draggable={draggable} aria-describedby="ftb-card-help"
      aria-label={`${task.title}. ${taskStageLabels[task.status] ?? task.status}.`}
      className={`ftb-card st-${task.status}${focused ? " is-focused" : ""}${saving ? " is-saving" : ""}${dragging ? " is-dragging" : ""}${draggable ? " can-drag" : ""}`}
      style={goal ? { "--g": goalHue(goal) } as React.CSSProperties : undefined}
      onDragStart={onDragStart} onDragEnd={onDragEnd}
      onClick={(event) => { if (!(event.target as HTMLElement).closest("button, a, details")) open(); }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
        else if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); onMove(event.key === "ArrowRight" ? 1 : -1); }
      }}>
      <div className="ftb-card-head">
        {task.status !== "cancelled" && (
          <button type="button" role="checkbox" aria-checked={done} className={`ftb-check${done ? " is-done" : ""}`}
            aria-label={`${done ? "Reopen" : "Complete"} task: ${task.title}`} disabled={toggleDisabled} onClick={toggle}>
            {done ? "✓" : ""}
          </button>
        )}
        <button type="button" className="ftb-title" tabIndex={-1} onClick={open}>{task.title}</button>
        {isHigh(task.priority) && !closed && <span className="forge-prio high" title={`${task.priority} priority`}>!!<span className="ftb-sr"> High priority</span></span>}
        {task.owner && <span className="ftb-owner" title={`Owner: ${task.owner}`}><Avatar name={task.owner} size="sm" /><span className="ftb-sr">Owner: {task.owner}</span></span>}
      </div>
      {(goal || task.dueOn) && (
        <div className="ftb-meta">
          <GoalPill goal={goal} />
          <DueChip dueOn={task.dueOn} open={!closed} />
        </div>
      )}
      {canonical && task.status !== "cancelled" && (
        <details className="ftb-governed">
          <summary>Details</summary>
          {done ? <>
            <p>Completed outcomes stay recorded. Create a follow-up for new work.</p>
            <button type="button" onClick={followUp}>Create follow-up task</button>
          </> : <p>Record completion evidence in Notes before completing this task.</p>}
        </details>
      )}
    </article>
  );
}

export function TaskBoard(props: ForgeViewProps & { rail?: HTMLElement | null }) {
  const { state, full, actions, focusId } = props;
  const [view, setView] = useState<TaskView>(() => {
    try { const saved = localStorage.getItem(`vorton:task-view:${state.profile}`); return VIEWS.includes(saved as TaskView) ? saved as TaskView : "list"; }
    catch { return "list"; }
  });
  const [grouping, setGrouping] = useState<"status" | "date" | "goal">(() => {
    try {
      const legacy = localStorage.getItem(`vorton:task-view:${state.profile}`);
      if (legacy === "agenda") return "date";
      if (legacy === "goals") return "goal";
      const saved = localStorage.getItem(`vorton:task-group:${state.profile}`);
      return saved === "date" || saved === "goal" ? saved : "status";
    } catch { return "status"; }
  });
  useEffect(() => { try { localStorage.setItem(`vorton:task-group:${state.profile}`, grouping); } catch { /* Preference is optional. */ } }, [grouping, state.profile]);
  const [scope, setScope] = useState("open");
  const [boardStatus, setBoardStatus] = useState<"active" | "done">("active");
  useEffect(() => { try { localStorage.setItem(`vorton:task-view:${state.profile}`, view); } catch { /* Preference is optional. */ } }, [view, state.profile]);
  const canonical = Boolean(full.canonical);
  const goals = useMemo(() => new Map(full.goals.map((g) => [g.id, g])), [full.goals]);
  const { pending, deferred } = suggestions(state, "task");
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [mobile, setMobile] = useState<Column>("todo");
  // On phones, keep showing the column of the task last changed here, even when
  // a records review rather than this board moves it.
  const follow = useRef("");
  useEffect(() => {
    const task = follow.current && full.tasks.find((t) => t.id === follow.current);
    if (!task) return;
    const column = columnOf(task);
    setMobile(column === "cancelled" ? "done" : column);
  }, [full.tasks]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<Column | null>(null);
  const [saving, setSaving] = useState("");
  const refocus = useRef("");

  const now = Date.now();
  const columns = useMemo(() => {
    const by: Record<Flow | "cancelled", Task[]> = { todo: [], doing: [], blocked: [], done: [], cancelled: [] };
    for (const task of state.tasks) by[columnOf(task)].push(task);
    for (const key of ["todo", "doing", "blocked"] as const) by[key].sort(sortOpen);
    by.done.sort(byRecent);
    by.cancelled.sort(byRecent);
    return by;
  }, [state.tasks]);
  const recentDone = columns.done.filter((t) => !t.updatedAt || now - Date.parse(t.updatedAt) <= RECENT_MS);
  const earlierDone = columns.done.length - recentDone.length;

  const today = todayIso();
  const open = [...columns.todo, ...columns.doing, ...columns.blocked];

  const visible: Column[] = boardStatus === "done" ? ["done"] : ["todo", "doing", "blocked"];
  const active: Column = visible.includes(mobile) ? mobile : visible[0];

  // Deep links reveal the linked task on small screens and in collapsed groups.
  const revealed = useRef("");
  useEffect(() => {
    if (!focusId) { revealed.current = ""; return; }
    if (revealed.current === focusId) return;
    const task = focusId.startsWith("task-") ? state.tasks.find((t) => `task-${t.id}` === focusId) : undefined;
    if (!task) return;
    revealed.current = focusId;
    setView("list");
    if (task.status === "done" || task.status === "cancelled") setScope("all");
    const column = columnOf(task);
    if (column === "cancelled") setShowCancelled(true);
    if (column === "done" && task.updatedAt && Date.now() - Date.parse(task.updatedAt) > RECENT_MS) setShowEarlier(true);
    setMobile(column === "cancelled" ? "done" : column);
  }, [focusId, state.tasks]);

  // Keep keyboard focus on a card after it moves to another column.
  useEffect(() => {
    if (!refocus.current) return;
    const card = document.getElementById(`task-${refocus.current}`);
    if (card) card.focus({ preventScroll: false });
    else if (view === "board") document.getElementById(`ftb-status-${boardStatus}`)?.focus({ preventScroll: true });
    refocus.current = "";
  }, [state.tasks, view, boardStatus]);

  const writable = actions.canWrite && !actions.busy && !saving;
  const canMoveFrom = (task: Task) => !(canonical && task.status === "done");

  async function move(task: Task, to: Flow) {
    if (task.status === to) return;
    if (!actions.canWrite) { actions.notify("Changes are unavailable right now. Reconnect to move tasks."); return; }
    if (actions.busy || saving) return;
    if (!canMoveFrom(task)) { actions.notify("Completed outcomes stay recorded. Create a follow-up task for new work."); return; }
    setSaving(task.id);
    refocus.current = task.id;
    // The shared patch type intersects every kind's status, so widen through TaskFields.
    const patch: Partial<TaskFields> = { status: to };
    const okay = await actions.update("task", task, patch as Parameters<ForgeActions["update"]>[2]);
    setSaving("");
    if (!okay) { refocus.current = ""; return; }
    const message = to === "done" ? "Task completed." : task.status === "done" || task.status === "cancelled"
      ? "Task reopened." : `Moved to ${LABEL[to]}: ${task.title}.`;
    actions.notify(actions.local ? `${message} Saved on this device; server acceptance is pending.` : message);
    setMobile(to);
  }

  function step(task: Task, direction: -1 | 1) {
    const from = columnOf(task);
    const index = from === "cancelled" ? FLOW.length - 1 : FLOW.indexOf(from);
    const to = FLOW[index + direction];
    if (!to) { actions.notify(direction > 0 ? `${task.title} is already in ${LABEL.done}.` : `${task.title} is already in ${LABEL.todo}.`); return; }
    void move(task, to);
  }

  const accepts = (column: Column) => {
    if (!drag || column === "suggested") return false;
    if (drag.kind === "suggestion") return column === drag.to;
    return column !== drag.from;
  };
  const dropProps = (column: Column) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!accepts(column)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (over !== column) setOver(column);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setOver((current) => current === column ? null : current);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const current = drag;
      setDrag(null); setOver(null);
      if (!current || !accepts(column) || column === "suggested") return;
      if (current.kind === "task") void move(current.task, column);
      else void actions.resolve(current.recommendation, "accepted");
    },
  });
  const startDrag = (value: Drag, id: string) => (event: React.DragEvent) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    // Let the browser capture the drag image before the source dims.
    requestAnimationFrame(() => setDrag(value));
  };
  const endDrag = () => { setDrag(null); setOver(null); };

  const card = (task: Task) => {
    const draggable = view === "board" && writable && canMoveFrom(task);
    return (
      <TaskCard key={task.id} task={task} goal={goals.get(task.goalId)} focused={focusId === `task-${task.id}`} saving={saving === task.id}
        dragging={drag?.kind === "task" && drag.task.id === task.id}
        draggable={draggable} open={() => actions.open("task", task)} onMove={(direction) => { if (view === "board") step(task, direction); }}
        toggle={() => { follow.current = task.id; void move(task, task.status === "done" ? "todo" : "done"); }}
        toggleDisabled={!actions.canWrite || actions.busy || Boolean(saving) || (canonical && task.status === "done")}
        canonical={canonical} followUp={() => actions.open("task")}
        onDragStart={startDrag({ kind: "task", task, from: columnOf(task) }, task.id)} onDragEnd={endDrag} />
    );
  };

  const countOf = (column: Column) => column === "suggested" ? pending.length : column === "done" ? (showEarlier ? columns.done.length : recentDone.length) : columns[column].length;

  function columnBody(column: Column) {
    if (column === "suggested") {
      return (
        <>
          {pending.map((recommendation) => {
            const draggable = writable && !isRevision(recommendation);
            const to = (FLOW as readonly string[]).includes((recommendation.proposal as TaskFields).status) ? (recommendation.proposal as TaskFields).status as Flow : "todo";
            return <SuggestionCard key={recommendation.id} recommendation={recommendation} props={props}
              onDragStart={draggable ? startDrag({ kind: "suggestion", recommendation, to }, recommendation.id) : undefined} onDragEnd={endDrag} />;
          })}
          {deferred.length > 0 && (
            <div className="ftb-snoozed">
              <button type="button" className="ftb-link" aria-expanded={showSnoozed} onClick={() => setShowSnoozed(!showSnoozed)}>
                {showSnoozed ? "Hide snoozed" : `${deferred.length} snoozed`}
              </button>
              {showSnoozed && deferred.map((recommendation) => <SuggestionCard key={recommendation.id} recommendation={recommendation} props={props} />)}
            </div>
          )}
        </>
      );
    }
    const list = column === "done" ? (showEarlier ? columns.done : recentDone) : columns[column];
    return (
      <>
        {list.length === 0 && <p className="ftb-empty">{EMPTY[column]}</p>}
        {list.map(card)}
        {column === "done" && earlierDone > 0 && (
          <button type="button" className="ftb-link" aria-expanded={showEarlier} onClick={() => setShowEarlier(!showEarlier)}>
            {showEarlier ? "Show recent only" : `+${earlierDone} earlier`}
          </button>
        )}
        {column === "done" && columns.cancelled.length > 0 && (
          <div className="ftb-cancelled">
            <button type="button" className="ftb-link" aria-expanded={showCancelled} onClick={() => setShowCancelled(!showCancelled)}>
              {showCancelled ? "Hide cancelled" : `Show cancelled (${columns.cancelled.length})`}
            </button>
            {showCancelled && columns.cancelled.map(card)}
          </div>
        )}
      </>
    );
  }

  const selectedTasks = (scope === "all" ? [...state.tasks] : scope === "done" ? [...columns.done, ...columns.cancelled] : scope === "open" ? open : open.filter(t => t.status === scope)).sort(sortOpen);
  const rows = (tasks: Task[]) => <div className="ftv-rows">{tasks.map(card)}{!tasks.length && <p className="ftv-empty">No tasks here. Try another filter or add a task.</p>}</div>;
  const group = (title: string, tasks: Task[], description?: string, key = title) => tasks.length > 0 && <section className="ftv-group" key={key}><header><h2>{title}</h2><span>{tasks.length}</span></header>{description && <p className="ftv-description">{description}</p>}{rows(tasks)}</section>;
  const week = new Date(); week.setDate(week.getDate() + 7);
  const weekEnd = `${week.getFullYear()}-${String(week.getMonth()+1).padStart(2,"0")}-${String(week.getDate()).padStart(2,"0")}`;

  return (
    <div className={`ftb ftv view-${view}`}>
      {props.rail && createPortal(<div className="ftv-rail-controls" data-vorton-view-control>
        <p>View</p>
        <ViewportRail className="ftv-switch" label="Task views">{VIEWS.map(item => <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)}>{VIEW_LABEL[item]}</button>)}</ViewportRail>
        {view === "list" ? <>
          <label className="ftv-scope">Group by<select value={grouping} onChange={e => setGrouping(e.target.value as typeof grouping)}><option value="status">Status</option><option value="date">Due date</option><option value="goal">Goal</option></select></label>
          <label className="ftv-scope">Show<select value={scope} onChange={e => setScope(e.target.value)}><option value="open">Open tasks</option><option value="doing">In progress</option><option value="blocked">Blocked</option><option value="done">Completed and cancelled</option><option value="all">All tasks</option></select></label>
        </> : <div className="ftb-status-rail"><p>Tasks</p><ViewportRail className="ftb-status-options" label="Board status">
          {(["active", "done"] as const).map(status => <button key={status} id={`ftb-status-${status}`} type="button" aria-pressed={boardStatus === status}
            onClick={() => { setBoardStatus(status); if (status === "done") setShowEarlier(true); }}>
            <span>{status === "active" ? "Active" : "Done"}</span><span>{status === "active" ? open.length : columns.done.length}</span>
          </button>)}
        </ViewportRail></div>}
      </div>, props.rail)}
      <h1 className="ftb-sr">Tasks</h1>
      {(view !== "board" || boardStatus === "active") && (pending.length > 0 || deferred.length > 0) && <details className="ftv-review"><summary>Council suggestions <span>{pending.length}</span><small>Review before adding to your work</small></summary><div className="ftv-review-body"><p>Proposals only. They do not count as tasks until you confirm.</p>{pending.map(recommendation => <SuggestionCard key={recommendation.id} recommendation={recommendation} props={props}/>)}{deferred.length > 0 && <details><summary>Snoozed suggestions ({deferred.length})</summary>{deferred.map(recommendation => <SuggestionCard key={recommendation.id} recommendation={recommendation} props={props}/>)}</details>}</div></details>}
      <p id="ftb-card-help" className="ftb-sr">Press Enter to open the task.{view === "board" ? " Use the left and right arrow keys to move it to the previous or next column." : " Use its checkbox to complete it."}</p>
      {view === "list" && grouping === "status" && <div className="ftv-list">{group("In progress", selectedTasks.filter(t => t.status === "doing"))}{group("To do", selectedTasks.filter(t => !["doing","blocked","done","cancelled"].includes(t.status)))}{group("Blocked", selectedTasks.filter(t => t.status === "blocked"))}{group("Completed", selectedTasks.filter(t => t.status === "done"))}{group("Cancelled", selectedTasks.filter(t => t.status === "cancelled"))}{!selectedTasks.length && rows([])}</div>}
      {view === "list" && grouping === "date" && <div className="ftv-agenda">{group("Overdue", selectedTasks.filter(t => t.dueOn && t.dueOn < today))}{group("Today", selectedTasks.filter(t => t.dueOn === today))}{group("Next seven days", selectedTasks.filter(t => t.dueOn > today && t.dueOn <= weekEnd))}{group("Later", selectedTasks.filter(t => t.dueOn > weekEnd))}{group("No date", selectedTasks.filter(t => !t.dueOn))}{!selectedTasks.length && rows([])}</div>}
      {view === "list" && grouping === "goal" && <div className="ftv-goals">{full.goals.map(goal => group(goal.title, selectedTasks.filter(t => t.goalId === goal.id), goal.successCriteria, goal.id))}{group("Independent tasks", selectedTasks.filter(t => !goals.has(t.goalId)))}{!selectedTasks.length && rows([])}</div>}
      {view === "board" && <><div className="ftb-pills" role="tablist" aria-label="Task stages">
        {visible.map((column) => (
          <button key={column} type="button" role="tab" aria-selected={active === column} aria-controls={`ftb-col-${column}`}
            className={`ftb-pill${column === "suggested" ? " is-suggest" : ""}`} onClick={() => setMobile(column)}>
            <StageIcon stage={column} />{LABEL[column]}<span className="ftb-count">{countOf(column)}</span>
          </button>
        ))}
      </div>
      <div className="ftb-board" data-columns={visible.length} data-dragging={drag ? drag.kind : undefined}>
        {visible.map((column) => (
          <section key={column} id={`ftb-col-${column}`} aria-labelledby={`ftb-head-${column}`}
            className={`ftb-col col-${column}${active === column ? " is-active" : ""}${accepts(column) ? " is-target" : ""}${over === column ? " is-over" : ""}`}
            {...dropProps(column)}>
            <header className="ftb-col-head">
              <StageIcon stage={column} />
              <h2 id={`ftb-head-${column}`}>{column === "suggested" ? "Council suggests" : LABEL[column]}</h2>
              <span className="ftb-count" aria-label={`${countOf(column)} ${column === "done" && earlierDone && !showEarlier ? "in the last two weeks" : "cards"}`}>{countOf(column)}</span>
            </header>
            {column === "suggested" && <p className="ftb-col-note">Not counted until you confirm.</p>}
            <div className="ftb-col-body">{columnBody(column)}</div>
          </section>
        ))}
      </div>
      </>}
    </div>
  );
}
