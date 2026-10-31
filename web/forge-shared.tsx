// Shared pieces for the Forge Tasks board, Goals and Ideas views.
//
// Council and agent proposals are not records yet. They are pending
// recommendations, and they surface here as "Suggested" items that never count
// toward progress until the owner accepts them through recommendation.resolve.
import React from "react";
import type { DraftPreconditions, DraftSubmitResult } from "./forge-draft-submit";
import {
  recommendationResultKind,
  type Goal,
  type GoalFields,
  type Idea,
  type IdeaFields,
  type Recommendation,
  type State,
  type Task,
  type TaskFields,
} from "./types";

export type ForgeKind = "task" | "goal" | "idea";
export type ForgeRecord = Task | Goal | Idea;

export type ExplicitCommand = (
  action: string,
  payload: unknown,
  preconditions?: DraftPreconditions,
) => Promise<DraftSubmitResult>;

/** Everything a Forge view may do. Every write keeps the canonical revision checks. */
export type ForgeActions = {
  busy: boolean;
  canWrite: boolean;
  local?: boolean;
  /** Save changed fields on an existing record. Resolves true when the save is confirmed. */
  update: (kind: ForgeKind, record: ForgeRecord, patch: Record<string, unknown>) => Promise<boolean>;
  /** Accept, defer or reject a Council suggestion. */
  resolve: (recommendation: Recommendation, decision: "accepted" | "deferred" | "rejected") => Promise<boolean>;
  /** Open the full editor for a suggestion, then accept it with the edits. */
  editSuggestion: (recommendation: Recommendation) => void;
  /** Open the full editor for a record, or a blank one with optional draft fields. */
  open: (kind: ForgeKind, record?: ForgeRecord, draft?: Partial<TaskFields>) => void;
  /** Start the existing graduate-to-goal dialog for an idea. */
  graduate: (idea: Idea) => void;
  notify: (message: string) => void;
};

const TASK_KEYS = ["title", "notes", "goalId", "owner", "dueOn", "priority", "status"] as const;
const GOAL_KEYS = ["title", "intent", "successCriteria", "owner", "horizon", "priority", "parentId", "reviewOn", "milestones", "evidence", "progress", "status"] as const;
const IDEA_KEYS = ["title", "description", "owner", "status", "projects", "tags", "goalIds", "value", "complexity", "effort", "upkeep", "confidence", "pull", "startCondition", "experiment", "reviewOn", "evidence"] as const;
const ORGANIZATION_KEYS = ["projects", "tags", "ideaIds"] as const;

/**
 * The complete field set an update command requires, built from the stored
 * record with `patch` applied. Optional organization fields are only sent when
 * the record already has them, so an update never invents empty relations.
 */
export function fieldsFor(kind: ForgeKind, record: ForgeRecord, patch: Record<string, unknown> = {}) {
  const keys = kind === "task" ? TASK_KEYS : kind === "goal" ? GOAL_KEYS : IDEA_KEYS;
  const source = record as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of keys) fields[key] = key in patch ? patch[key] : source[key];
  if (kind !== "idea")
    for (const key of ORGANIZATION_KEYS)
      if (key in patch || source[key] !== undefined) fields[key] = key in patch ? patch[key] : source[key];
  return fields;
}

export const kindOfRecommendation = (r: Recommendation): ForgeKind => recommendationResultKind(r.kind);

/** Pending suggestions for one kind. Deferred ones are counted separately as snoozed. */
export function suggestions(state: State, kind: ForgeKind) {
  const all = state.recommendations.filter((r) => kindOfRecommendation(r) === kind && r.kind !== "idea-graduate");
  return {
    pending: all.filter((r) => r.status === "pending"),
    deferred: all.filter((r) => r.status === "deferred"),
  };
}

/** A suggestion that changes an existing record rather than creating one. */
export const isRevision = (r: Recommendation) => r.kind.endsWith("-review");

export function proposerName(state: State, r: Recommendation) {
  return state.council?.identities.find((identity) => identity.id === r.role)?.name ?? String(r.role);
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Stable hue per name, so the same owner always gets the same avatar color. */
export function hueFor(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  // Spread by the golden angle so similar names, such as g1 and g2, get distinct hues.
  return Math.round((hash * 137.508) % 360);
}

export function Avatar({ name, size = "" }: { name: string; size?: "" | "xs" | "sm" | "lg" }) {
  return (
    <span className={`forge-avatar ${size}`} style={{ "--hue": hueFor(name) } as React.CSSProperties} title={name} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Ring({ percent, size = 28, stroke = 3, label }: { percent: number; size?: number; stroke?: number; label?: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg className="forge-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? `${value} percent`}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--forge-ring-track)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

const DAY = 86_400_000;
const localDay = (iso: string) => new Date(`${iso}T12:00:00`);
export function todayIso() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
export const daysFromToday = (iso: string) => Math.round((localDay(iso).getTime() - localDay(todayIso()).getTime()) / DAY);

export function relativeDate(iso: string) {
  if (!iso) return "";
  const days = daysFromToday(iso);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days < 7) return localDay(iso).toLocaleDateString(undefined, { weekday: "short" });
  return localDay(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Due date chip, red when overdue and amber when within two days. */
export function DueChip({ dueOn, open = true }: { dueOn: string; open?: boolean }) {
  if (!dueOn) return null;
  const days = daysFromToday(dueOn);
  const tone = open && days < 0 ? " overdue" : open && days <= 2 ? " soon" : "";
  return <span className={`forge-chip${tone}`} title={dueOn}>{relativeDate(dueOn)}</span>;
}

/** Goal progress from confirmed tasks only. Suggestions never count. */
export function taskProgress(state: State, goalId: string) {
  const tasks = state.tasks.filter((task) => task.goalId === goalId && task.status !== "cancelled");
  const done = tasks.filter((task) => task.status === "done").length;
  return { done, total: tasks.length, percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0 };
}

/** Who suggested it, from which session, and how sure they are. */
export function Provenance({ state, recommendation, long = false }: { state: State; recommendation: Recommendation; long?: boolean }) {
  const name = proposerName(state, recommendation);
  const confidence = (recommendation.confidence || "unknown").toLowerCase();
  return (
    <div className={`forge-provenance${long ? " long" : ""}`}>
      <span className="forge-prov-who"><Avatar name={name} size="xs" /><b>{name.split(" ")[0]}</b> suggested</span>
      <span className={`forge-confidence conf-${confidence}`}>{confidence} confidence</span>
      {long && recommendation.rationale && <p className="forge-why"><b>Why.</b> {recommendation.rationale}</p>}
      {long && recommendation.tradeoffs && <p className="forge-why"><b>Trade-off.</b> {recommendation.tradeoffs}</p>}
    </div>
  );
}

/** Accept, edit, defer and reject controls for one suggestion. */
export function SuggestionActions({ recommendation, actions, compact = false }: { recommendation: Recommendation; actions: ForgeActions; compact?: boolean }) {
  const disabled = actions.busy || !actions.canWrite;
  return (
    <div className={`forge-suggest-actions${compact ? " compact" : ""}`}>
      <button type="button" className="forge-confirm" disabled={disabled} onClick={() => void actions.resolve(recommendation, "accepted")}>
        {compact ? "Confirm" : isRevision(recommendation) ? "Accept change" : "Confirm"}
      </button>
      <button type="button" disabled={disabled} onClick={() => actions.editSuggestion(recommendation)}>Edit</button>
      {recommendation.status !== "deferred" && (
        <button type="button" disabled={disabled} onClick={() => void actions.resolve(recommendation, "deferred")}>Later</button>
      )}
      <button type="button" className="forge-ghost" disabled={disabled} aria-label={`Decline: ${recommendation.proposal.title}`}
        onClick={() => void actions.resolve(recommendation, "rejected")}>
        {compact ? "✕" : "Decline"}
      </button>
    </div>
  );
}

/** Keyboard triage on a focused suggestion: Y confirm, E edit, N later, X decline. */
export function suggestionKeys(recommendation: Recommendation, actions: ForgeActions) {
  return (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || actions.busy || !actions.canWrite) return;
    const key = event.key.toLowerCase();
    if (key === "y") void actions.resolve(recommendation, "accepted");
    else if (key === "e") actions.editSuggestion(recommendation);
    else if (key === "n" && recommendation.status !== "deferred") void actions.resolve(recommendation, "deferred");
    else if (key === "x") void actions.resolve(recommendation, "rejected");
    else return;
    event.preventDefault();
  };
}

export const ideaStages = ["inbox", "exploring", "ready", "parked"] as const;
export const ideaStageLabels: Record<string, string> = {
  inbox: "Inbox", exploring: "Exploring", ready: "Ready", parked: "Parked", graduated: "Graduated", archived: "Archived",
};
export const goalStageLabels: Record<string, string> = { active: "Active", paused: "Paused", achieved: "Achieved", retired: "Retired" };
export const taskStageLabels: Record<string, string> = { todo: "To do", doing: "In progress", blocked: "Blocked", done: "Done", cancelled: "Cancelled" };

/** Props every Forge view and rail receives from the Forge shell. */
export type ForgeViewProps = {
  /** Records after the shared search, project and tag filters. */
  state: State;
  /** Unfiltered records, for lookups such as a task's goal title. */
  full: State;
  actions: ForgeActions;
  /** This view's rail selection, such as a goal id or an idea list. Empty means the default. */
  selection: string;
  select: (value: string) => void;
  /** The URL fragment, such as "goal-abc", for deep links from Council and Bridge. */
  focusId: string;
  draftTask: (fields: TaskFields) => void;
  /** The shared quick idea capture form, or null where capture belongs elsewhere. */
  capture: React.ReactNode;
};
