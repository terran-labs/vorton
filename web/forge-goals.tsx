// Forge Goals: a Things-style page per goal, an overview grouped by stage and
// the goals Council has proposed. Adapted from the approved "Focus Lists"
// mockup (docs/mockups/forge/concept-focus.js, renderGoalPage and friends).
//
// Progress shown on the big ring is the owner's estimate. Task counts come from
// confirmed tasks only, and Council suggestions never count until accepted.
import React, { useEffect, useRef, useState } from "react";
import { CouncilOrigin, RecordLabels } from "./forge";
import { PageHeading } from "./design/page-heading";
import { ViewportRail } from "./design/viewport-rail";
import {
  Avatar,
  DueChip,
  Provenance,
  Ring,
  SuggestionActions,
  daysFromToday,
  goalStageLabels,
  hueFor,
  isRevision,
  relativeDate,
  suggestionKeys,
  suggestions,
  taskProgress,
  taskStageLabels,
  type ForgeActions,
  type ForgeViewProps,
} from "./forge-shared";
import type { Goal, GoalFields, Recommendation, State, Task, TaskFields } from "./types";
import "./forge-goals.css";

// ------------------------------------------------------------------ icons
const ICONS = {
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.8" /><rect x="13" y="4" width="7" height="7" rx="1.8" /><rect x="4" y="13" width="7" height="7" rx="1.8" /><rect x="13" y="13" width="7" height="7" rx="1.8" /></>,
  review: <><path d="M12 3.2l1.9 5.1 5.1 1.9-5.1 1.9L12 17.2l-1.9-5.1L5 10.2l5.1-1.9z" /><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></>,
  flag: <path d="M5.5 21V4M5.5 4.5h11l-2 4 2 4h-11" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  list: <><path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11" /><circle cx="4.5" cy="6.5" r=".8" fill="currentColor" /><circle cx="4.5" cy="12" r=".8" fill="currentColor" /><circle cx="4.5" cy="17.5" r=".8" fill="currentColor" /></>,
  chevron: <path d="M9 6l6 6-6 6" />,
  pause: <path d="M9.5 6v12M14.5 6v12" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  up: <path d="M12 19V5M6.5 10.5L12 5l5.5 5.5" />,
  bulb: <path d="M9.5 18h5M10.5 21h3M12 3a6 6 0 00-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0012 3z" />,
  notes: <path d="M5 6h14M5 10.5h14M5 15h9" />,
  logbook: <><rect x="4" y="3.5" width="16" height="17" rx="2.5" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
} as const;

function Icon({ name, size = 16, className = "" }: { name: keyof typeof ICONS; size?: number; className?: string }) {
  return (
    <svg className={`fg-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

// ------------------------------------------------------------------ helpers
const STAGE_ORDER = ["active", "paused", "achieved", "retired"] as const;
const STAGE_HINTS: Record<string, string> = {
  active: "Committed. Tasks roll up into it.",
  paused: "Deliberately on hold.",
  achieved: "Success criteria met.",
  retired: "Stopped on purpose. History is kept.",
};
const OPEN_TASK_ORDER = ["doing", "blocked", "todo"];
const GOAL_FIELD_LABELS: Partial<Record<keyof GoalFields, string>> = {
  title: "Title", intent: "Why", successCriteria: "Done when", owner: "Owner", horizon: "Horizon", priority: "Priority",
  parentId: "Parent goal", reviewOn: "Review date", milestones: "Milestones", evidence: "Evidence", progress: "Progress estimate", status: "Stage",
};
const TASK_FIELD_LABELS: Partial<Record<keyof TaskFields, string>> = {
  title: "Title", notes: "Notes", goalId: "Goal", owner: "Owner", dueOn: "Due date", status: "Status", priority: "Priority",
};

// Calm, distinct hues per goal. Red is left out so a goal never reads as an alarm.
const GOAL_HUES = [212, 176, 145, 28, 258, 196, 300, 42, 232, 160];
const goalHue = (id: string) => ({ "--gh": GOAL_HUES[hueFor(id) % GOAL_HUES.length] }) as React.CSSProperties;
const isOpenTask = (t: Task) => t.status !== "done" && t.status !== "cancelled";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Patch = Parameters<ForgeActions["update"]>[2];
/**
 * The shared update patch type intersects task, goal and idea fields, which
 * narrows "status" to idea stages. Goal and task patches pass through here.
 */
const save = (actions: ForgeActions, kind: "goal" | "task", record: Goal | Task, patch: Partial<GoalFields> | Partial<TaskFields>) =>
  actions.update(kind, record, patch as Patch);

function changedFields<T extends object>(before: T | undefined, after: T, labels: Partial<Record<keyof T, string>>) {
  if (!before) return [];
  return (Object.keys(labels) as (keyof T)[])
    .filter((key) => JSON.stringify(before[key] ?? "") !== JSON.stringify(after[key] ?? ""))
    .map((key) => labels[key] as string);
}

/** Which page to show: an explicit rail choice, then a deep link, then the first active goal. */
function resolveSelection({ selection, focusId, state, full }: ForgeViewProps) {
  if (selection === "all" || selection === "proposed") return selection;
  if (selection && full.goals.some((g) => g.id === selection)) return selection;
  const linked = /^goal-(.+)$/.exec(focusId)?.[1];
  if (linked && full.goals.some((g) => g.id === linked)) return linked;
  const first = state.goals.find((g) => g.status === "active") ?? state.goals.find((g) => g.status === "paused") ?? state.goals[0];
  return first?.id ?? "all";
}

function pendingGoalSuggestions(state: State) {
  return suggestions(state, "goal");
}

/** Pending task suggestions that would land under this goal, including changes to its tasks. */
function taskSuggestionsFor(state: State, goalId: string) {
  return suggestions(state, "task").pending.filter((r) => (r.proposal as TaskFields).goalId === goalId);
}

function GoalRing({ goal, size, stroke, showValue = false }: { goal: Goal; size: number; stroke: number; showValue?: boolean }) {
  const value = Math.max(0, Math.min(100, Math.round(goal.progress || 0)));
  return (
    <span className="fg-ring" style={goalHue(goal.id)}>
      <Ring percent={value} size={size} stroke={stroke} label={`Owner estimate ${value} percent`} />
      {showValue && <small aria-hidden="true">{value}</small>}
    </span>
  );
}

function ReviewChip({ goal }: { goal: Goal }) {
  if (!goal.reviewOn) return null;
  const days = daysFromToday(goal.reviewOn);
  const open = goal.status === "active" || goal.status === "paused";
  const tone = open && days < 0 ? " overdue" : open && days <= 2 ? " soon" : "";
  return (
    <span className={`forge-chip fg-review${tone}`} title={`Review on ${goal.reviewOn}`}>
      <Icon name="calendar" size={12} />Review {relativeDate(goal.reviewOn)}
    </span>
  );
}

function StagePill({ status }: { status: string }) {
  return <span className={`fg-pill st-${status}`}>{goalStageLabels[status] ?? status}</span>;
}

// ------------------------------------------------------------------ rail
export function GoalsRail(props: ForgeViewProps) {
  const { state, full, select } = props;
  const current = resolveSelection(props);
  const pending = pendingGoalSuggestions(full).pending.length;
  const [showDone, setShowDone] = useState(false);
  const active = state.goals.filter((g) => g.status === "active");
  const paused = state.goals.filter((g) => g.status === "paused");
  const done = state.goals.filter((g) => g.status === "achieved" || g.status === "retired");
  const currentDone = done.some((g) => g.id === current);
  const goalLink = (g: Goal) => (
    <button key={g.id} type="button" className={`forge-rail-link fg-rail-goal st-${g.status}`} aria-current={current === g.id ? "true" : undefined}
      title={g.title} onClick={() => select(g.id)}>
      <GoalRing goal={g} size={18} stroke={2.6} />
      <span>{g.title}</span>
      {g.status === "paused" && <span className="fg-rail-flag" aria-label="Paused"><Icon name="pause" size={12} /></span>}
    </button>
  );
  return (
    <nav className="fg-rail" aria-label="Goals">
      <p className="fg-rail-caption">Goals</p>
      <ViewportRail className="fg-rail-list" label="Goal filters">
        <button type="button" className="forge-rail-link fg-rail-fixed" aria-current={current === "all" ? "true" : undefined} onClick={() => select("all")}>
          <span className="fg-rail-icon"><Icon name="grid" size={17} /></span><span>All goals</span>
          <span className="count">{state.goals.length}</span>
        </button>
        {pending > 0 && (
          <button type="button" className="forge-rail-link fg-rail-fixed fg-rail-proposed" aria-current={current === "proposed" ? "true" : undefined} onClick={() => select("proposed")}>
            <span className="fg-rail-icon"><Icon name="review" size={17} /></span><span>Proposed</span>
            <span className="count suggest" aria-label={`${pending} waiting for review`}>{pending}</span>
          </button>
        )}
        {(active.length > 0 || paused.length > 0) && <span className="fg-rail-gap" aria-hidden="true" />}
        {active.map(goalLink)}
        {paused.map(goalLink)}
        {done.length > 0 && (
          <button type="button" className="fg-rail-done-toggle" aria-expanded={showDone || currentDone} onClick={() => setShowDone((v) => !v)}>
            <Icon name="chevron" size={12} className={showDone || currentDone ? "is-open" : ""} />Done <span className="count">{done.length}</span>
          </button>
        )}
        {(showDone || currentDone) && done.map(goalLink)}
      </ViewportRail>
    </nav>
  );
}

// ------------------------------------------------------------------ view
export function GoalsView(props: ForgeViewProps) {
  const { full, focusId, selection, select } = props;
  // A deep link such as #goal-g4 selects that goal once; later rail choices win.
  useEffect(() => {
    const linked = /^goal-(.+)$/.exec(focusId)?.[1];
    if (linked && linked !== selection && full.goals.some((g) => g.id === linked)) select(linked);
  }, [focusId]);
  const current = resolveSelection(props);
  // A new rail choice starts at the top; the first render keeps any deep-link scroll.
  const shown = useRef(current);
  useEffect(() => {
    if (shown.current === current) return;
    shown.current = current;
    window.scrollTo({ top: 0 });
  }, [current]);
  if (!full.goals.length && current !== "proposed") return <NoGoals {...props} />;
  if (current === "all") return <AllGoals {...props} />;
  if (current === "proposed") return <ProposedGoalsPage {...props} />;
  const goal = full.goals.find((g) => g.id === current);
  return goal ? <GoalPage {...props} goal={goal} /> : <AllGoals {...props} />;
}

function NoGoals({ actions, full }: ForgeViewProps) {
  const pending = pendingGoalSuggestions(full).pending;
  return (
    <div className="fg">
      {pending.length > 0 && <ProposedStrip state={full} actions={actions} list={pending} collapsible={false} />}
      <section className="fg-sheet fg-empty-sheet">
        <div className="forge-empty fg-empty">
          <span className="fg-empty-icon"><Icon name="target" size={34} /></span>
          <b>Start with a goal worth pursuing</b>
          <span>Name an outcome, what done looks like and the first milestone. Tasks you add under it roll up here.</span>
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ proposed goals
function ProposedCard({ state, recommendation, actions }: { state: State; recommendation: Recommendation; actions: ForgeActions }) {
  const proposal = recommendation.proposal as GoalFields;
  const revision = isRevision(recommendation);
  const target = revision ? state.goals.find((g) => g.id === recommendation.targetId) : undefined;
  const changes = revision ? changedFields<GoalFields>(target, proposal, GOAL_FIELD_LABELS) : [];
  const title = revision ? `Change to ${target?.title ?? proposal.title}` : proposal.title;
  return (
    <article className="fg-pcard is-suggested" id={`recommendation-${recommendation.id}`} tabIndex={0}
      aria-label={`Suggested ${revision ? "change" : "goal"}: ${title}. Press Y to confirm, E to edit, N for later or X to decline.`}
      onKeyDown={suggestionKeys(recommendation, actions)}>
      <div className="fg-pcard-top">
        <span className="fg-kind"><Icon name="target" size={13} />{revision ? "Goal change" : "Goal"}</span>
        <span className="forge-unconfirmed">Unconfirmed</span>
        {recommendation.status === "deferred" && <span className="forge-snoozed">Snoozed</span>}
      </div>
      <h3 className="fg-pcard-title">{title}</h3>
      {revision && changes.length > 0 && <p className="fg-pcard-changes">Changes {changes.join(", ").toLowerCase()}.</p>}
      {proposal.intent && <p className="fg-pcard-blurb">{proposal.intent}</p>}
      <div className="fg-targets">
        <span className="fg-target"><Icon name="flag" size={13} /><span><small>Done when</small>{proposal.successCriteria || "Not defined yet"}</span></span>
        {proposal.horizon && <span className="fg-target"><Icon name="clock" size={13} /><span><small>Horizon</small>{proposal.horizon}</span></span>}
        {proposal.milestones?.[0] && <span className="fg-target"><Icon name="flag" size={13} /><span><small>First milestone</small>{proposal.milestones[0].title}</span></span>}
        {proposal.owner && <span className="fg-target"><Avatar name={proposal.owner} size="xs" /><span><small>Owner</small>{proposal.owner}</span></span>}
      </div>
      <div className="fg-pcard-prov"><Provenance state={state} recommendation={recommendation} long /></div>
      <SuggestionActions recommendation={recommendation} actions={actions} />
    </article>
  );
}

function ProposedStrip({ state, actions, list, collapsible }: { state: State; actions: ForgeActions; list: Recommendation[]; collapsible: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = !collapsible || open;
  const names = [...new Set(list.map((r) => state.council?.identities.find((i) => i.id === r.role)?.name ?? String(r.role)))];
  return (
    <section className={`fg-proposed${expanded ? " is-open" : ""}`} aria-label="Goals proposed by Council">
      <button type="button" className="fg-proposed-head" aria-expanded={collapsible ? expanded : undefined} disabled={!collapsible}
        onClick={() => setOpen((v) => !v)}>
        <span className="fg-faces">{names.slice(0, 3).map((name) => <Avatar key={name} name={name} size="sm" />)}</span>
        <span className="fg-proposed-text"><b>{plural(list.length, "goal")} proposed by Council.</b> Not goals until you confirm.</span>
        {collapsible && <span className="fg-proposed-go">{expanded ? "Hide" : "Review"}<Icon name="chevron" size={14} className={expanded ? "is-open" : ""} /></span>}
      </button>
      {expanded && (
        <div className="fg-pcards">
          {list.map((r) => <ProposedCard key={r.id} state={state} recommendation={r} actions={actions} />)}
        </div>
      )}
    </section>
  );
}

function ProposedGoalsPage({ full, actions, select }: ForgeViewProps) {
  const { pending, deferred } = pendingGoalSuggestions(full);
  return (
    <div className="fg">
      <section className="fg-sheet">
        <PageHeading className="fg-heading" title="Proposed goals" description="Council suggestions remain unconfirmed until you accept them." />
        {pending.length ? (
          <div className="fg-pcards fg-pcards-page">
            {pending.map((r) => <ProposedCard key={r.id} state={full} recommendation={r} actions={actions} />)}
          </div>
        ) : (
          <div className="forge-empty fg-empty">
            <span className="fg-empty-icon"><Icon name="logbook" size={34} /></span>
            <b>Nothing waiting for review</b>
            <span>New Council suggestions for goals will appear here.</span>
            <button type="button" onClick={() => select("all")}>See all goals</button>
          </div>
        )}
        {deferred.length > 0 && (
          <p className="forge-snoozed fg-snoozed-note">{plural(deferred.length, "suggestion")} snoozed. {deferred.length === 1 ? "It stays" : "They stay"} in Council review.</p>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ all goals
function GoalRow({ goal, full, focused, onSelect }: { goal: Goal; full: State; focused: boolean; onSelect: () => void }) {
  const progress = taskProgress(full, goal.id);
  const open = full.tasks.filter((t) => t.goalId === goal.id && isOpenTask(t)).length;
  return (
    <button type="button" id={`goal-${goal.id}`} className={`fg-grow st-${goal.status}${focused ? " is-focused" : ""}`} onClick={onSelect}>
      <GoalRing goal={goal} size={36} stroke={3.5} showValue />
      <span className="fg-grow-main">
        <b>{goal.title}</b>
        <span className="fg-meta">
          {goal.projects?.[0] && <span className="fg-meta-project"><span className="fg-dot" style={goalHue(goal.id)} />{goal.projects[0]}</span>}
          <span>{plural(open, "open task")}</span>
          {progress.total > 0 && <span>{progress.done} of {progress.total} done</span>}
          {goal.horizon && <span className="fg-meta-horizon">{goal.horizon}</span>}
          <ReviewChip goal={goal} />
        </span>
      </span>
      <span className="fg-grow-side">{goal.owner && <Avatar name={goal.owner} size="sm" />}</span>
    </button>
  );
}

function AllGoals(props: ForgeViewProps) {
  const { state, full, actions, select, focusId } = props;
  const pending = pendingGoalSuggestions(full).pending;
  const filtered = state.goals.length !== full.goals.length;
  return (
    <div className="fg">
      <section className="fg-sheet">
        <h1 className="ftb-sr">Goals</h1>
        {pending.length > 0 && <ProposedStrip state={full} actions={actions} list={pending} collapsible />}
        {STAGE_ORDER.map((stage) => {
          const list = state.goals.filter((g) => g.status === stage);
          if (!list.length) return null;
          return (
            <section key={stage} className={`fg-sec tone-${stage}`} aria-labelledby={`fg-stage-${stage}`}>
              <h2 className="fg-sec-head" id={`fg-stage-${stage}`}>
                <span>{goalStageLabels[stage]}</span><span className="fg-sec-count">{list.length}</span>
                <span className="fg-sec-sub">{STAGE_HINTS[stage]}</span>
              </h2>
              <div className="fg-rows">
                {list.map((g) => <GoalRow key={g.id} goal={g} full={full} focused={focusId === `goal-${g.id}`} onSelect={() => select(g.id)} />)}
              </div>
            </section>
          );
        })}
        {!state.goals.length && filtered && (
          <div className="forge-empty fg-empty"><b>No goals match</b><span>Clear the filters to see every goal.</span></div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ goal page
function stageActions(status: string): { to: string; label: string; tone?: "primary" | "ghost" }[] {
  switch (status) {
    case "active": return [{ to: "paused", label: "Pause" }, { to: "achieved", label: "Mark achieved", tone: "primary" }, { to: "retired", label: "Retire", tone: "ghost" }];
    case "paused": return [{ to: "active", label: "Resume", tone: "primary" }, { to: "achieved", label: "Mark achieved" }, { to: "retired", label: "Retire", tone: "ghost" }];
    case "achieved": return [{ to: "active", label: "Reopen" }];
    case "retired": return [{ to: "active", label: "Reactivate" }];
    default: return [{ to: "active", label: "Activate", tone: "primary" }];
  }
}

function Stepper({ goal, actions }: { goal: Goal; actions: ForgeActions }) {
  const main = ["active", "achieved"];
  const alt = ["paused", "retired"];
  const index = main.indexOf(goal.status);
  const disabled = actions.busy || !actions.canWrite;
  const move = (to: string) => void save(actions, "goal", goal, { status: to });
  return (
    <div className="fg-stepper">
      <ol className="fg-steps">
        {main.map((s, i) => {
          const state = i === index ? "is-current" : index > -1 && i < index ? "is-past" : "";
          return (
            <li key={s} className={`fg-step ${state}`}>
              <button type="button" disabled={disabled || i === index} aria-current={i === index ? "step" : undefined} onClick={() => move(s)}
                title={STAGE_HINTS[s]}>
                <span className="fg-step-dot">{state === "is-past" && <Icon name="check" size={11} />}</span>
                <span className="fg-step-label">{goalStageLabels[s]}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="fg-step-alts">
        <span>Also</span>
        {alt.map((s) => (
          <button key={s} type="button" className={`fg-step-alt${goal.status === s ? " is-current" : ""}`} disabled={disabled || goal.status === s}
            aria-pressed={goal.status === s} onClick={() => move(s)}>{goalStageLabels[s]}</button>
        ))}
      </div>
      <p className="fg-step-hint">{STAGE_HINTS[goal.status] ?? ""}</p>
    </div>
  );
}

function Milestones({ goal, actions }: { goal: Goal; actions: ForgeActions }) {
  const [draft, setDraft] = useState("");
  const disabled = actions.busy || !actions.canWrite;
  const next = goal.milestones.findIndex((m) => !m.done);
  const toggle = (index: number) =>
    void save(actions, "goal", goal, { milestones: goal.milestones.map((m, i) => (i === index ? { ...m, done: !m.done } : m)) });
  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    if (await save(actions, "goal", goal, { milestones: [...goal.milestones, { title, done: false }] })) setDraft("");
  };
  return (
    <>
      {goal.milestones.length ? (
        <ol className="fg-timeline">
          {goal.milestones.map((m, i) => (
            <li key={`${i}:${m.title}`} className={`${m.done ? "is-done" : ""}${i === next ? " is-next" : ""}`}>
              <button type="button" className="fg-tl-dot" role="checkbox" aria-checked={m.done} disabled={disabled}
                aria-label={`${m.done ? "Mark not done" : "Mark done"}: ${m.title}`} onClick={() => toggle(i)}>
                {m.done && <Icon name="check" size={12} />}
              </button>
              <div><b>{m.title}</b><span>{m.done ? "Done" : i === next ? "Next" : "Later"}</span></div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="fg-quiet">No milestones yet. Two or three checkpoints make progress easier to judge.</p>
      )}
      {actions.canWrite && (
        <form className="fg-ms-add" data-vorton-unsaved={Boolean(draft)} onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Icon name="plus" size={14} />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add milestone" aria-label="New milestone" maxLength={240} disabled={actions.busy} />
          {draft.trim() && <button type="submit" disabled={actions.busy}>Add</button>}
        </form>
      )}
    </>
  );
}

function TaskCheck({ task, locked, onToggle, completing }: { task: Task; locked: string; onToggle: () => void; completing: boolean }) {
  const done = task.status === "done";
  if (task.status === "cancelled") return <span className="fg-check is-cancelled" aria-hidden="true"><Icon name="close" size={12} /></span>;
  return (
    <button type="button" className={`fg-check prio-${task.priority}${done || completing ? " is-checked" : ""}`} role="checkbox" aria-checked={done || completing}
      aria-label={`${done ? "Reopen" : "Complete"} ${task.title}`} disabled={Boolean(locked)} title={locked || undefined} onClick={onToggle}>
      <Icon name="check" size={14} />
    </button>
  );
}

function TaskRow({ task, full, actions, completing, onComplete }: {
  task: Task; full: State; actions: ForgeActions; completing: boolean; onComplete: (task: Task) => void;
}) {
  const canonicalDone = Boolean(full.canonical) && task.status === "done";
  const locked = !actions.canWrite ? "Read only" : actions.busy ? "Saving" : canonicalDone ? "Completed outcomes stay recorded. Create a follow-up task instead." : "";
  const status = task.status === "doing" || task.status === "blocked" ? task.status : "";
  return (
    <div className={`fg-row${task.status === "done" ? " is-done" : ""}${task.status === "cancelled" ? " is-cancelled" : ""}${completing ? " is-completing" : ""}`}>
      <TaskCheck task={task} locked={locked} completing={completing} onToggle={() => onComplete(task)} />
      <div className="fg-row-body">
        <button type="button" className="fg-row-title" onClick={() => actions.open("task", task)}>
          {task.priority === "high" && <span className="forge-prio high" aria-label="High priority">!!</span>}
          <span className="fg-title-text">{task.title}</span>
        </button>
        {(task.dueOn || status || task.notes) && (
          <span className="fg-meta">
            {task.dueOn && <DueChip dueOn={task.dueOn} open={isOpenTask(task)} />}
            {status && <span className={`fg-pill st-${status}`}>{taskStageLabels[status]}</span>}
            {task.notes && <span className="fg-meta-notes" title="Has notes"><Icon name="notes" size={13} /></span>}
          </span>
        )}
      </div>
      {task.owner && <span className="fg-row-owner"><Avatar name={task.owner} size="sm" /></span>}
    </div>
  );
}

function SuggestedTaskRow({ recommendation, full, actions }: { recommendation: Recommendation; full: State; actions: ForgeActions }) {
  const proposal = recommendation.proposal as TaskFields;
  const revision = isRevision(recommendation);
  const target = revision ? full.tasks.find((t) => t.id === recommendation.targetId) : undefined;
  const changes = revision ? changedFields<TaskFields>(target, proposal, TASK_FIELD_LABELS) : [];
  const title = revision ? `Change to ${target?.title ?? proposal.title}` : proposal.title;
  return (
    <div className="fg-row fg-row-sug is-suggested" tabIndex={0} id={`recommendation-${recommendation.id}`}
      aria-label={`Suggested ${revision ? "change" : "task"}: ${title}. Press Y to confirm, E to edit, N for later or X to decline.`}
      onKeyDown={suggestionKeys(recommendation, actions)}>
      <span className="fg-check is-locked" role="checkbox" aria-checked="false" aria-disabled="true" title="Confirm this suggestion before you can complete it" />
      <div className="fg-row-body">
        <span className="fg-row-title is-static">
          <span className="fg-title-text">{title}</span>
          <span className="forge-unconfirmed">Unconfirmed</span>
        </span>
        {(revision ? changes.length > 0 : proposal.dueOn || proposal.owner) && (
          <span className="fg-meta">
            {revision && <span>Changes {changes.join(", ").toLowerCase()}</span>}
            {revision && changes.includes("Due date") && proposal.dueOn && <span>Due {relativeDate(proposal.dueOn)}</span>}
            {!revision && proposal.dueOn && <DueChip dueOn={proposal.dueOn} />}
            {!revision && proposal.owner && <span className="fg-meta-owner"><Avatar name={proposal.owner} size="xs" />{proposal.owner}</span>}
          </span>
        )}
        <Provenance state={full} recommendation={recommendation} />
      </div>
      <div className="fg-row-actions"><SuggestionActions recommendation={recommendation} actions={actions} compact /></div>
    </div>
  );
}

function GoalPage(props: ForgeViewProps & { goal: Goal }) {
  const { goal, full, actions, select, focusId } = props;
  const [showDone, setShowDone] = useState(false);
  const [completing, setCompleting] = useState<string[]>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => { setShowDone(false); setCompleting([]); }, [goal.id]);

  const pendingGoals = pendingGoalSuggestions(full).pending;
  const tasks = full.tasks.filter((t) => t.goalId === goal.id);
  const openTasks = tasks.filter(isOpenTask).sort((a, b) =>
    OPEN_TASK_ORDER.indexOf(a.status) - OPEN_TASK_ORDER.indexOf(b.status) || (a.dueOn || "9999").localeCompare(b.dueOn || "9999"));
  const closed = tasks.filter((t) => !isOpenTask(t));
  const doneCount = closed.filter((t) => t.status === "done").length;
  const cancelledCount = closed.length - doneCount;
  const suggested = taskSuggestionsFor(full, goal.id);
  const progress = taskProgress(full, goal.id);
  const estimate = Math.max(0, Math.min(100, Math.round(goal.progress || 0)));
  const parent = goal.parentId ? full.goals.find((g) => g.id === goal.parentId) : undefined;
  const children = full.goals.filter((g) => g.parentId === goal.id);
  const ideas = (goal.ideaIds ?? []).map((id) => ({ id, title: full.ideas?.find((i) => i.id === id)?.title ?? "Source idea" }));
  const profile = full.profile.toLowerCase();
  const disabled = actions.busy || !actions.canWrite;

  const toggleTask = (task: Task) => {
    if (task.status === "done") { void save(actions, "task", task, { status: "todo" }); return; }
    if (completing.includes(task.id)) return;
    setCompleting((c) => [...c, task.id]);
    const finish = async () => {
      const saved = await save(actions, "task", task, { status: "done" });
      setCompleting((c) => c.filter((id) => id !== task.id));
      if (saved) actions.notify(`Completed: ${task.title}.`);
    };
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) void finish();
    else timers.current.push(window.setTimeout(() => void finish(), 620));
  };

  return (
    <div className="fg">
      {pendingGoals.length > 0 && <ProposedStrip state={full} actions={actions} list={pendingGoals} collapsible />}
      <div className={`fg-goal st-${goal.status}${focusId === `goal-${goal.id}` ? " is-focused" : ""}`} id={`goal-${goal.id}`} style={goalHue(goal.id)}>
        <article className="fg-sheet fg-goal-sheet" aria-labelledby={`fg-title-${goal.id}`}>
          <header className="fg-hero">
            <div className="fg-hero-ring">
              <span className="fg-ring fg-ring-big">
                <Ring percent={estimate} size={84} stroke={6} label={`Owner estimate ${estimate} percent`} />
                <b aria-hidden="true">{estimate}%</b>
              </span>
              <small>Owner estimate</small>
            </div>
            <PageHeading className="fg-heading fg-goal-heading" id={`fg-title-${goal.id}`}
              breadcrumbs={parent ? (
                <button type="button" className="fg-parent" onClick={() => select(parent.id)}>
                  <Icon name="up" size={13} />Part of {parent.title}
                </button>
              ) : undefined}
              eyebrow={<span className="fg-eyebrow">
                <span className="fg-dot" />{goal.projects?.[0] ?? "Goal"}<StagePill status={goal.status} />
              </span>}
              title={goal.title}
              description={<span className="fg-goal-meta">
                {goal.owner && <span><Avatar name={goal.owner} size="xs" />{goal.owner}</span>}
                {goal.horizon && <span><Icon name="clock" size={14} />{goal.horizon}</span>}
                <ReviewChip goal={goal} />
                <span>{progress.total ? `${progress.done} of ${progress.total} tasks done` : "No tasks yet"}</span>
              </span>} />
          </header>

          {goal.intent ? (
            <section className="fg-why" aria-label="Why">
              <h2 className="fg-label">Why</h2>
              <p>{goal.intent}</p>
            </section>
          ) : null}
          <div className={`fg-donewhen${goal.successCriteria ? "" : " is-missing"}`}>
            <h2 className="fg-label"><Icon name="flag" size={14} />Done when</h2>
            {goal.successCriteria ? <p>{goal.successCriteria}</p> : (
              <p>Not defined yet. <button type="button" className="fg-linkish" onClick={() => actions.open("goal", goal)}>Add success criteria</button> so you can tell when this is achieved.</p>
            )}
          </div>

          <div className="fg-goal-actions">
            {stageActions(goal.status).map((a) => (
              <button key={a.to} type="button" className={a.tone === "primary" ? "primary" : a.tone === "ghost" ? "fg-ghost" : ""} disabled={disabled}
                onClick={() => void save(actions, "goal", goal, { status: a.to })}>{a.label}</button>
            ))}
            <button type="button" className="fg-ghost fg-edit" onClick={() => actions.open("goal", goal)}>Edit goal</button>
          </div>

          <section className="fg-sec" aria-labelledby={`fg-tasks-${goal.id}`}>
            <h2 className="fg-sec-head" id={`fg-tasks-${goal.id}`}>
              <Icon name="list" size={16} /><span>Tasks</span><span className="fg-sec-count">{openTasks.length}</span>
            </h2>
            <div className="fg-rows">
              {openTasks.map((t) => (
                <TaskRow key={t.id} task={t} full={full} actions={actions} completing={completing.includes(t.id)} onComplete={toggleTask} />
              ))}
              {!openTasks.length && <p className="fg-quiet">{doneCount ? "Every task here is done." : "No tasks yet."}</p>}
              <button type="button" className="fg-row fg-new-task"
                onClick={() => actions.open("task", undefined, { goalId: goal.id, owner: goal.owner, projects: goal.projects ?? [], tags: goal.tags ?? [] })}>
                <span className="fg-new-plus"><Icon name="plus" size={15} /></span><span>New task</span>
              </button>
            </div>
            {closed.length > 0 && (
              <>
                <button type="button" className="fg-showdone" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                  <Icon name="chevron" size={13} className={showDone ? "is-open" : ""} />
                  {plural(doneCount, "completed task")}{cancelledCount ? `, ${cancelledCount} cancelled` : ""}
                </button>
                {showDone && (
                  <div className="fg-rows">
                    {closed.map((t) => <TaskRow key={t.id} task={t} full={full} actions={actions} completing={false} onComplete={toggleTask} />)}
                  </div>
                )}
              </>
            )}
          </section>

          {suggested.length > 0 && (
            <section className="fg-sec fg-sec-suggest" aria-labelledby={`fg-sug-${goal.id}`}>
              <h2 className="fg-sec-head" id={`fg-sug-${goal.id}`}>
                <Icon name="review" size={16} /><span>Suggested by Council</span><span className="fg-sec-count">{suggested.length}</span>
                <span className="fg-sec-sub">Not counted until confirmed</span>
              </h2>
              <div className="fg-rows">
                {suggested.map((r) => <SuggestedTaskRow key={r.id} recommendation={r} full={full} actions={actions} />)}
              </div>
            </section>
          )}

          {(children.length > 0 || ideas.length > 0 || goal.evidence || goal.projects?.length || goal.tags?.length) && (
            <section className="fg-links" aria-label="Related">
              {children.length > 0 && (
                <div><h2 className="fg-label">Sub-goals</h2>
                  <ul>{children.map((c) => <li key={c.id}><button type="button" className="fg-linkish" onClick={() => select(c.id)}>{c.title}</button></li>)}</ul>
                </div>
              )}
              {ideas.length > 0 && (
                <div><h2 className="fg-label">Source ideas</h2>
                  <ul>{ideas.map((i) => <li key={i.id}><Icon name="bulb" size={13} /><a href={`/${profile}/forge/ideas#idea-${i.id}`}>{i.title}</a></li>)}</ul>
                </div>
              )}
              {goal.evidence && (
                <details className="fg-evidence"><summary>Evidence</summary><p>{goal.evidence}</p></details>
              )}
              <RecordLabels record={goal} />
            </section>
          )}
          <div className="fg-origin"><CouncilOrigin state={full} id={goal.id} /></div>
        </article>

        <aside className="fg-aside" aria-label="Goal timeline and stage">
          <section className="fg-card">
            <h2 className="fg-card-head"><Icon name="flag" size={15} />Milestones</h2>
            <Milestones goal={goal} actions={actions} />
          </section>
          <section className="fg-card">
            <h2 className="fg-card-head"><Icon name="target" size={15} />Stage</h2>
            <Stepper goal={goal} actions={actions} />
          </section>
        </aside>
      </div>
    </div>
  );
}
