// Forge Ideas: the Focus Lists notebook with the Outcome Studio value against
// effort chart above it. Provenance: docs/mockups/forge/concept-focus.js
// (maturity, ideaActions, ideaCard, renderIdeas, rail) and concept-studio.js
// (placeIdeas, score, matrix, legend, needs assessment, ranked list).
//
// Council idea suggestions are pending recommendations, not ideas. They show as
// unconfirmed cards and hollow dashed bubbles until the owner confirms them.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ViewportRail } from "./design/viewport-rail";
import {
  Avatar,
  Provenance,
  SuggestionActions,
  daysFromToday,
  ideaStageLabels,
  ideaStages,
  isRevision,
  relativeDate,
  suggestionKeys,
  suggestions,
  type ForgeActions,
  type ForgeViewProps,
} from "./forge-shared";
import type { Idea, IdeaFields, Recommendation, State, TaskFields } from "./types";
import "./forge-ideas.css";

// ------------------------------------------------------------------ lists

const LISTS = [
  ["", "All ideas"],
  ["suggested", "Suggested"],
  ["inbox", "Inbox"],
  ["exploring", "Exploring"],
  ["ready", "Ready"],
  ["parked", "Parked"],
  ["history", "Graduated and archived"],
] as const;
const LIST_TITLES: Record<string, string> = {
  "": "Ideas", suggested: "Suggested ideas", inbox: "Inbox", exploring: "Exploring", ready: "Ready", parked: "Parked", history: "Graduated and archived",
};
const SECTION_HINTS: Record<string, string> = {
  suggested: "Not ideas until you confirm them",
  inbox: "Raw thoughts, not yet looked at",
  exploring: "Being shaped with a smallest test",
  ready: "Shaped and waiting for a slot",
  parked: "Not now, not never",
  graduated: "Became goals",
  archived: "Set aside",
};
const ACTIVE = new Set<string>(ideaStages);
const CLOSED = new Set(["graduated", "archived"]);

function listCount(list: string, ideas: Idea[], pending: number) {
  if (list === "") return ideas.filter((idea) => ACTIVE.has(idea.status)).length;
  if (list === "suggested") return pending;
  if (list === "history") return ideas.filter((idea) => CLOSED.has(idea.status)).length;
  return ideas.filter((idea) => idea.status === list).length;
}

export function IdeasRail({ state, selection, select }: ForgeViewProps) {
  const ideas = state.ideas ?? [];
  const pending = suggestions(state, "idea").pending.length;
  return (
    <nav className="fi-rail" aria-label="Idea lists">
      <p className="fi-rail-caption">Ideas</p>
      <ViewportRail className="fi-rail-links" label="Idea stages">
        {LISTS.map(([value, label]) => {
          if (value === "suggested" && !pending && selection !== value) return null;
          const count = listCount(value, ideas, pending);
          return (
            <button key={value || "all"} type="button" className={`forge-rail-link fi-rl st-${value || "all"}`}
              aria-current={selection === value ? "true" : undefined} onClick={() => select(value)}>
              <i className="fi-rl-mark" aria-hidden="true" />
              <span>{label}</span>
              {count > 0 && <span className={`count${value === "suggested" ? " suggest" : ""}`}>{count}</span>}
            </button>
          );
        })}
      </ViewportRail>
    </nav>
  );
}

// ------------------------------------------------------------------ items

/** One card or bubble: a confirmed idea, or a pending Council suggestion. */
type Item = {
  key: string;
  domId: string;
  fields: IdeaFields;
  idea?: Idea;
  rec?: Recommendation;
  /** The idea a revision suggestion would change. */
  target?: Idea;
};
const ideaItem = (idea: Idea): Item => ({ key: idea.id, domId: `idea-${idea.id}`, fields: idea, idea });
const suggestionItem = (rec: Recommendation, ideas: Idea[]): Item => ({
  key: `rec:${rec.id}`,
  domId: `idea-suggestion-${rec.id}`,
  fields: rec.proposal as IdeaFields,
  rec,
  target: isRevision(rec) ? ideas.find((idea) => idea.id === rec.targetId) : undefined,
});
function keyForFocus(focusId: string) {
  if (focusId.startsWith("idea-suggestion-")) return `rec:${focusId.slice("idea-suggestion-".length)}`;
  return focusId.startsWith("idea-") ? focusId.slice(5) : "";
}

const BAND: Record<string, number> = { unknown: 0, low: 1, medium: 2, high: 3 };
const band = (value: string) => BAND[value] ?? 0;
const assessed = (fields: IdeaFields) => band(fields.value) > 0 && band(fields.effort) > 0;
/** Mockup priority score from value, effort, confidence and pull. */
function score(fields: IdeaFields) {
  const v = band(fields.value) || 1.5, e = band(fields.effort) || 2, c = band(fields.confidence) || 1.5, p = band(fields.pull) || 1.5;
  return Math.round((v * 2.2 - e * 1.3 + c * 0.8 + p * 0.6 + 2) * 10);
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const stageOf = (item: Item) => (item.rec ? "suggested" : item.fields.status);
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ view

export function IdeasView({ state, full, actions, selection, select, focusId, draftTask, capture }: ForgeViewProps) {
  const ideas = useMemo(() => state.ideas ?? [], [state.ideas]);
  const allIdeas = useMemo(() => full.ideas ?? [], [full.ideas]);
  const { pending, deferred } = useMemo(() => suggestions(full, "idea"), [full]);
  const origins = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of full.recommendations) if (r.status === "accepted" && r.resultId) map.set(r.resultId, r.id);
    return map;
  }, [full.recommendations]);
  const goals = useMemo(() => new Map(full.goals.map((goal) => [goal.id, goal.title])), [full.goals]);
  const list = LISTS.some(([value]) => value === selection) ? selection : "";

  const suggestionItems = useMemo(() => pending.map((rec) => suggestionItem(rec, allIdeas)), [pending, allIdeas]);
  const sections = useMemo(() => {
    const stages = list === "" ? ["suggested", ...ideaStages] : list === "history" ? ["graduated", "archived"] : [list];
    return stages.map((stage) => ({
      stage,
      items: stage === "suggested" ? suggestionItems : ideas.filter((idea) => idea.status === stage).map(ideaItem),
    }));
  }, [list, ideas, suggestionItems]);
  const visible = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  // The chart plots new ideas only; a revision suggestion changes an idea already plotted.
  const chartItems = useMemo(() => visible.filter((item) => !item.rec || !isRevision(item.rec)), [visible]);

  const focusKey = keyForFocus(focusId);
  const [selected, setSelected] = useState(focusKey);
  useEffect(() => { if (focusKey) setSelected(focusKey); }, [focusKey]);
  // A deep link must show its idea even when the current list would hide it.
  const linked = useMemo(() => {
    if (!focusKey || visible.some((item) => item.key === focusKey)) return null;
    const idea = allIdeas.find((i) => i.id === focusKey);
    if (idea) return ideaItem(idea);
    const rec = full.recommendations.find((r) => `rec:${r.id}` === focusKey && r.kind.startsWith("idea") && r.kind !== "idea-graduate");
    return rec ? suggestionItem(rec, allIdeas) : null;
  }, [focusKey, visible, allIdeas, full.recommendations]);

  const reveal = (key: string) => {
    setSelected(key);
    const item = [...visible, ...(linked ? [linked] : [])].find((i) => i.key === key);
    if (!item) return;
    requestAnimationFrame(() => {
      const card = document.getElementById(item.domId);
      if (!card) return;
      card.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      const target = card.matches("[tabindex]") ? card : card.querySelector<HTMLElement>("[data-card-focus]");
      target?.focus({ preventScroll: true });
    });
  };

  const context: CardContext = { full, actions, selected, focusKey, origins, goals, draftTask, toggle: (key) => setSelected((current) => (current === key ? "" : key)) };
  const empty = !visible.length && !(list === "suggested" && deferred.length);
  return (
    <div className="fi">
      <h1 className="ftb-sr">{LIST_TITLES[list]}</h1>
      {capture && <div className="fi-capture">{capture}</div>}
      <ValueEffortChart items={chartItems} selected={selected} onSelect={reveal} onAssess={item => { if (item.idea) actions.open("idea", item.idea); else if (item.rec) actions.editSuggestion(item.rec); }} listName={LIST_TITLES[list]} />
      <div className="fi-notebook" aria-label="Ideas notebook">
        {linked && (
          <section className="fi-sec is-linked" aria-labelledby="fi-sec-linked">
            <h2 className="fi-sec-head" id="fi-sec-linked"><span>Opened from a link</span><span className="fi-sec-sub">Outside the current list</span></h2>
            {linked.idea && CLOSED.has(linked.idea.status)
              ? <ul className="fi-history"><HistoryRow item={linked} context={context} /></ul>
              : <div className="fi-ideas"><IdeaCard item={linked} context={context} /></div>}
          </section>
        )}
        {sections.map(({ stage, items }) => {
          const snoozed = stage === "suggested" ? deferred.length : 0;
          if (!items.length && !snoozed) return null;
          const history = stage === "graduated" || stage === "archived";
          return (
            <section key={stage} className={`fi-sec st-${stage}`} aria-labelledby={`fi-sec-${stage}`}>
              <h2 className="fi-sec-head" id={`fi-sec-${stage}`}>
                <i className="fi-sec-mark" aria-hidden="true" />
                <span>{stage === "suggested" ? "Suggested by Council" : ideaStageLabels[stage]}</span>
                <span className="fi-sec-count">{items.length}</span>
                <span className="fi-sec-sub">{SECTION_HINTS[stage]}</span>
              </h2>
              {snoozed > 0 && <p className="fi-snoozed">{plural(snoozed, "suggestion", "suggestions")} snoozed. {snoozed === 1 ? "It waits" : "They wait"} in Council review.</p>}
              {history
                ? <ul className="fi-history">{items.map((item) => <HistoryRow key={item.key} item={item} context={context} />)}</ul>
                : <div className="fi-ideas">{items.map((item) => <IdeaCard key={item.key} item={item} context={context} />)}</div>}
            </section>
          );
        })}
        {empty && (
          <div className="forge-empty">
            <b>{list === "" ? "No ideas yet" : list === "suggested" ? "No suggestions waiting" : "Nothing in this list"}</b>
            <span>{list === "" ? "Capture a thought above. You can shape it later." : list === "suggested" ? "Council proposals appear here for you to confirm." : "Ideas you move here will appear in this list."}</span>
            {list !== "" && <button type="button" onClick={() => select("")}>Show all ideas</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ cards

type CardContext = {
  full: State;
  actions: ForgeActions;
  selected: string;
  focusKey: string;
  origins: Map<string, string>;
  goals: Map<string, string>;
  draftTask: (fields: TaskFields) => void;
  toggle: (key: string) => void;
};

const MATURITY: Record<string, number> = { inbox: 1, exploring: 2, ready: 3 };
const MATURITY_LABEL: Record<string, string> = { inbox: "Raw", exploring: "Exploring", ready: "Ready", parked: "Parked", graduated: "Graduated", archived: "Archived" };
function Maturity({ status }: { status: string }) {
  const n = MATURITY[status] ?? 0;
  return (
    <span className={`fi-maturity m-${status}`} title={`Maturity: ${MATURITY_LABEL[status] ?? status}`}>
      <i className={n >= 1 ? "on" : ""} /><i className={n >= 2 ? "on" : ""} /><i className={n >= 3 ? "on" : ""} />
      <span>{MATURITY_LABEL[status] ?? status}</span>
    </span>
  );
}
function Meter({ label, value, tone }: { label: string; value: string; tone: "value" | "effort" }) {
  const level = band(value);
  return (
    <span className={`fi-band b-${tone}`} role="img" aria-label={`${label} ${level ? value : "not assessed"}`} title={`${label}: ${level ? value : "not assessed"}`}>
      <small aria-hidden="true">{label}</small>
      <span className={`fi-bars lv-${level}`} aria-hidden="true"><i /><i /><i /></span>
    </span>
  );
}
function ReviewChip({ fields, createdAt }: { fields: IdeaFields; createdAt?: string }) {
  if (fields.reviewOn) {
    const days = daysFromToday(fields.reviewOn);
    const tone = days < 0 ? " overdue" : days <= 7 ? " soon" : "";
    return <span className={`forge-chip fi-review${tone}`} title={`Review on ${fields.reviewOn}`}>Review {relativeDate(fields.reviewOn)}</span>;
  }
  return createdAt ? <span className="fi-dim fi-review">Captured {relativeDate(createdAt.slice(0, 10))}</span> : null;
}
function confidenceLine(fields: IdeaFields) {
  const parts = [
    band(fields.confidence) ? `confidence ${fields.confidence}` : "",
    band(fields.pull) ? `pull ${fields.pull}` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  const text = parts.join(", ");
  return text[0].toUpperCase() + text.slice(1);
}

const STATUS_MOVES: Record<string, [Idea["status"], string, string][]> = {
  inbox: [["exploring", "Explore", ""], ["parked", "Park", "fi-ghost"]],
  exploring: [["ready", "Mark ready", ""], ["parked", "Park", "fi-ghost"]],
  ready: [["parked", "Park", "fi-ghost"]],
  parked: [["exploring", "Explore again", ""], ["archived", "Archive", "fi-ghost"]],
  archived: [["inbox", "Restore to Inbox", ""]],
};

function makeTask(idea: Idea): TaskFields {
  return {
    title: (idea.experiment || `First step: ${idea.title}`).slice(0, 180),
    notes: idea.experiment ? `Smallest useful test for the idea "${idea.title}".` : "",
    owner: idea.owner,
    goalId: idea.goalIds[0] ?? "",
    ideaIds: [idea.id],
    projects: idea.projects,
    tags: idea.tags,
    dueOn: "",
    status: "todo",
    priority: "normal",
  };
}

function IdeaActions({ idea, context }: { idea: Idea; context: CardContext }) {
  const { actions } = context;
  const locked = actions.busy || !actions.canWrite;
  const move = async (status: Idea["status"], label: string) => {
    if (await actions.update("idea", idea, { status })) actions.notify(`Moved "${idea.title}" to ${label}.`);
  };
  return (
    <div className="fi-actions">
      {idea.status === "ready" && (
        <button type="button" className="primary" disabled={locked} onClick={() => actions.graduate(idea)}>Graduate to goal</button>
      )}
      {(STATUS_MOVES[idea.status] ?? []).map(([status, label, tone]) => (
        <button key={status} type="button" className={tone} disabled={locked} onClick={() => void move(status, ideaStageLabels[status])}>{label}</button>
      ))}
      {!CLOSED.has(idea.status) && (
        <button type="button" className="fi-ghost" disabled={locked} onClick={() => context.draftTask(makeTask(idea))}>Make task</button>
      )}
      <button type="button" className="fi-ghost" aria-label="Edit idea" onClick={() => actions.open("idea", idea)}>Edit</button>
    </div>
  );
}

const CHANGE_LABELS: Record<string, string> = {
  title: "Title", description: "Description", owner: "Owner", status: "Stage", value: "Value", complexity: "Complexity", effort: "Effort",
  upkeep: "Upkeep", confidence: "Confidence", pull: "Pull", startCondition: "Start when", experiment: "Smallest test", reviewOn: "Review on", evidence: "Evidence",
};
function changesFor(target: Idea, proposal: IdeaFields) {
  return Object.entries(CHANGE_LABELS).flatMap(([key, label]) => {
    const before = String(target[key as keyof IdeaFields] ?? "");
    const after = String(proposal[key as keyof IdeaFields] ?? "");
    if (before === after) return [];
    const short = (text: string) => (text.length > 40 ? `${text.slice(0, 38)}…` : text || "empty");
    const show = (text: string) => (key === "status" ? ideaStageLabels[text] ?? text : short(text));
    return [`${label}: ${show(before)} to ${show(after)}`];
  });
}

function IdeaCard({ item, context }: { item: Item; context: CardContext }) {
  const { fields, idea, rec } = item;
  const { full, actions } = context;
  const isSelected = context.selected === item.key;
  const isFocused = context.focusKey === item.key;
  const project = fields.projects?.[0] ?? "";
  const missingTest = !fields.experiment && (fields.status === "exploring" || fields.status === "ready");
  const test = fields.experiment
    ? <p className="fi-test"><FlaskIcon /><span><b>Smallest test.</b> {fields.experiment}</span></p>
    : missingTest && !rec ? <p className="fi-test is-missing"><FlaskIcon /><span>No smallest test yet</span></p> : null;
  const bands = (
    <div className="fi-bandrow">
      <Meter label="Value" value={fields.value} tone="value" />
      <Meter label="Effort" value={fields.effort} tone="effort" />
      <ReviewChip fields={fields} createdAt={idea?.createdAt} />
      {!rec && confidenceLine(fields) && <span className="fi-dim fi-conf">{confidenceLine(fields)}</span>}
    </div>
  );
  const className = `fi-idea${rec ? " is-suggested" : ""}${isSelected ? " is-selected" : ""}${isFocused ? " is-focused" : ""}`;

  if (rec) {
    const revision = isRevision(rec);
    const changes = revision && item.target ? changesFor(item.target, fields) : [];
    return (
      <article id={item.domId} className={className} tabIndex={0} onKeyDown={suggestionKeys(rec, actions)}
        aria-label={`Suggested idea: ${revision ? `change to ${item.target?.title ?? fields.title}` : fields.title}. Y confirm, E edit, N later, X decline.`}>
        <header className="fi-idea-top">
          <span className="forge-unconfirmed">Unconfirmed</span>
          <span className="fi-idea-area">{project}</span>
          <Avatar name={fields.owner || "Owner"} size="xs" />
        </header>
        <h3>{revision ? <>Change to {item.target?.title ?? fields.title}</> : fields.title}</h3>
        {changes.length > 0 && <ul className="fi-changes">{changes.map((change) => <li key={change}>{change}</li>)}</ul>}
        {!revision && fields.description && <p className="fi-desc">{fields.description}</p>}
        {!revision && test}
        {!revision && bands}
        <Provenance state={full} recommendation={rec} long />
        <SuggestionActions recommendation={rec} actions={actions} />
      </article>
    );
  }
  if (!idea) return null;
  const origin = context.origins.get(idea.id);
  const detailId = `${item.domId}-detail`;
  return (
    <article id={item.domId} className={className}>
      <header className="fi-idea-top">
        <Maturity status={idea.status} />
        <span className="fi-idea-area">{project}</span>
        <Avatar name={idea.owner || "Owner"} size="xs" />
      </header>
      <h3>
        <button type="button" className="fi-title" data-card-focus aria-expanded={isSelected} aria-controls={isSelected ? detailId : undefined}
          onClick={() => context.toggle(item.key)}>
          {idea.title}
        </button>
      </h3>
      {idea.description && <p className={`fi-desc${isSelected ? " is-open" : ""}`}>{idea.description}</p>}
      {test}
      {bands}
      {isSelected && (
        <div className="fi-detail" id={detailId}>
          {idea.startCondition && <p><b>Start when.</b> {idea.startCondition}</p>}
          {idea.evidence && <p><b>Evidence.</b> {idea.evidence}</p>}
          <dl className="fi-assess">
            {(["complexity", "upkeep", "confidence", "pull"] as const).map((key) => (
              <div key={key}><dt>{CHANGE_LABELS[key]}</dt><dd>{band(idea[key]) ? idea[key] : "Not assessed"}</dd></div>
            ))}
          </dl>
          {!assessed(idea) && <p className="fi-hint">Set value and effort in Edit to place this idea on the chart.</p>}
          <p className="fi-links">
            {idea.goalIds.map((id) => (
              <a key={id} href={`/${full.profile.toLowerCase()}/forge/goals#goal-${id}`}>{context.goals.get(id) ?? "Linked goal"}</a>
            ))}
            <a href={`/${full.profile.toLowerCase()}/forge/ideas#idea-${idea.id}`}>Idea link</a>
          </p>
          {(idea.status === "inbox" || idea.status === "exploring") && (
            <button type="button" className="fi-inline" disabled={actions.busy || !actions.canWrite} onClick={() => actions.graduate(idea)}>Graduate to goal</button>
          )}
        </div>
      )}
      {origin && (
        <a className="fi-origin" href={`/${full.profile.toLowerCase()}/council#recommendation-${origin}`}>
          <span aria-hidden="true">✦</span> From a Council recommendation
        </a>
      )}
      <IdeaActions idea={idea} context={context} />
    </article>
  );
}

function HistoryRow({ item, context }: { item: Item; context: CardContext }) {
  const idea = item.idea;
  if (!idea) return null;
  const { full } = context;
  const className = `fi-hrow${context.selected === item.key ? " is-selected" : ""}${context.focusKey === item.key ? " is-focused" : ""}`;
  return (
    <li id={item.domId} className={className}>
      <span className={`fi-hstage st-${idea.status}`}>{ideaStageLabels[idea.status]}</span>
      <span className="fi-htitle">
        <b data-card-focus tabIndex={-1}>{idea.title}</b>
        <small>
          {[idea.projects[0], idea.owner].filter(Boolean).join(", ")}
          {idea.goalIds.map((id) => (
            <React.Fragment key={id}>{" "}<a href={`/${full.profile.toLowerCase()}/forge/goals#goal-${id}`}>Goal: {context.goals.get(id) ?? "linked goal"}</a></React.Fragment>
          ))}
        </small>
      </span>
      <IdeaActions idea={idea} context={context} />
    </li>
  );
}

function FlaskIcon() {
  return (
    <svg className="fi-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21.5h11.6a2 2 0 0 0 1.7-3L14 9V3" /><path d="M7 15h10" />
    </svg>
  );
}

// ------------------------------------------------------------------ chart

const PULL_SIZE: Record<string, number> = { unknown: 26, low: 28, medium: 36, high: 46 };
const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
type Point = { item: Item; x: number; y: number; r: number; size: number };
type Rect = { x: number; y: number; w: number; h: number };

/**
 * Deterministic placement in pixels: band position, nudged by complexity and
 * confidence, a stable per-idea jitter, then pairwise separation passes.
 * Bubbles stay clear of the quadrant captions in the corners.
 */
function placeIdeas(items: Item[], W: number, H: number, scale: number, captionBand: number): Point[] {
  const pts = items.map((item) => {
    const f = item.fields;
    const e = (band(f.effort) - 1) / 2, v = (band(f.value) - 1) / 2;
    const cx = (band(f.complexity) || 2) - 2, cf = (band(f.confidence) || 2) - 2;
    const h = hash(item.key);
    const x = 0.2 + 0.6 * e + cx * 0.06 + ((h % 100) / 100 - 0.5) * 0.08;
    const y = 0.2 + 0.6 * v + cf * 0.06 + ((((h >> 7) % 100) / 100) - 0.5) * 0.08;
    const size = Math.round((PULL_SIZE[f.pull] ?? 26) * scale);
    return { item, x: x * W, y: (1 - y) * H, r: size / 2 + 4 * scale, size };
  });
  const bound = (p: Point) => {
    p.x = clamp(p.x, p.r + 6, W - p.r - 6);
    p.y = clamp(p.y, p.r + captionBand, H - p.r - captionBand);
  };
  pts.forEach(bound);
  for (let pass = 0; pass < 90; pass++) {
    let moved = false;
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) {
      const A = pts[a], B = pts[b];
      let dx = B.x - A.x, dy = B.y - A.y;
      const min = A.r + B.r + 8 * scale;
      let dist = Math.hypot(dx, dy);
      if (dist >= min) continue;
      if (dist < 0.01) { dx = 1; dy = 0.5; dist = Math.hypot(dx, dy); }
      const push = (min - dist) / 2;
      A.x -= (dx / dist) * push; A.y -= (dy / dist) * push * 0.8;
      B.x += (dx / dist) * push; B.y += (dy / dist) * push * 0.8;
      moved = true;
    }
    pts.forEach(bound);
    if (!moved) break;
  }
  return pts;
}

let measureContext: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, font: string) {
  if (measureContext === undefined) measureContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 6.6;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}
const overlapsCircle = (rect: Rect, p: Point) => {
  const nx = clamp(p.x, rect.x, rect.x + rect.w), ny = clamp(p.y, rect.y, rect.y + rect.h);
  return Math.hypot(nx - p.x, ny - p.y) < p.size / 2 + 3;
};
const overlapsRect = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Put a bubble's label on the side that collides with nothing, or with the least. */
function placeLabel(p: Point, points: Point[], W: number, H: number, font: string, obstacles: Rect[]): Rect {
  const maxW = Math.min(220, W * 0.62);
  const natural = Math.ceil(textWidth(p.item.fields.title, font) + 18);
  // One line when it fits, then a narrower two-line block for crowded spots.
  const shapes = [natural <= maxW ? { w: natural, h: 21 } : { w: Math.ceil(maxW), h: 37 }];
  if (natural > 110) shapes.push({ w: Math.max(96, Math.ceil(Math.min(natural, maxW * 2) / 2) + 14), h: 37 });
  const gap = p.size / 2 + 6;
  const candidates = shapes.flatMap(({ w, h }) => {
    const side = [0, -0.9, 0.9].flatMap((shift) => [
      { x: p.x + gap, y: p.y - h / 2 + shift * h, w, h },
      { x: p.x - gap - w, y: p.y - h / 2 + shift * h, w, h },
    ]);
    const stack = [-w / 2, -p.size / 2, p.size / 2 - w].flatMap((dx) => [
      { x: p.x + dx, y: p.y - gap - h, w, h },
      { x: p.x + dx, y: p.y + gap, w, h },
    ]);
    return [...side.slice(0, 2), ...stack.slice(0, 2), ...side.slice(2), ...stack.slice(2)]
      .map((r) => ({ ...r, x: clamp(r.x, 4, W - w - 4), y: clamp(r.y, 4, H - h - 4) }));
  });
  let best = candidates[0], bestHits = Infinity;
  for (const rect of candidates) {
    const hits = points.filter((q) => overlapsCircle(rect, q)).length + obstacles.filter((o) => overlapsRect(rect, o)).length;
    if (hits < bestHits) { best = rect; bestHits = hits; }
    if (!hits) break;
  }
  return best;
}

const LEGEND = [
  ["inbox", "Inbox"], ["exploring", "Exploring"], ["ready", "Ready"], ["parked", "Parked"], ["graduated", "Graduated"], ["archived", "Archived"],
] as const;
const QUADRANTS = [
  ["q-tl", "Quick wins", "High value, low effort"],
  ["q-tr", "Big bets", "High value, high effort"],
  ["q-bl", "Fill-ins", "Low value, low effort"],
  ["q-br", "Money pits", "Low value, high effort"],
] as const;

function ValueEffortChart({ items, selected, onSelect, onAssess, listName }: { items: Item[]; selected: string; onSelect: (key: string) => void; onAssess: (item: Item) => void; listName: string }) {
  const matrixRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hot, setHot] = useState("");
  const [showAll, setShowAll] = useState(false);
  const hasAssessed = items.some(item => assessed(item.fields));
  useLayoutEffect(() => {
    const el = matrixRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasAssessed]);
  const compact = size.w > 0 && size.w < 520;
  const scale = compact ? 0.76 : 1;
  const captionBand = compact ? 30 : 44;
  const plotted = useMemo(() => items.filter((item) => assessed(item.fields)), [items]);
  const unassessed = items.filter((item) => !assessed(item.fields));
  const points = useMemo(
    () => (size.w > 40 ? placeIdeas(plotted, size.w, size.h, scale, captionBand) : []),
    [plotted, size.w, size.h, scale, captionBand],
  );
  const ranked = useMemo(
    () => plotted.filter(item => !item.rec).sort((a, b) => score(b.fields) - score(a.fields) || a.fields.title.localeCompare(b.fields.title)),
    [plotted],
  );
  const rankNo = new Map(ranked.filter((item) => !item.rec).map((item, n) => [item.key, n + 1]));
  const stages = new Set(items.map(stageOf));
  const font = useMemo(() => {
    const family = matrixRef.current ? getComputedStyle(matrixRef.current).fontFamily : "sans-serif";
    return `600 12px ${family}`;
  }, [size.w > 0]);
  const captionW = compact ? 92 : 150;
  const obstacles: Rect[] = size.w ? [
    { x: 0, y: 0, w: captionW, h: captionBand }, { x: size.w - captionW, y: 0, w: captionW, h: captionBand },
    { x: 0, y: size.h - captionBand, w: captionW, h: captionBand }, { x: size.w - captionW, y: size.h - captionBand, w: captionW, h: captionBand },
  ] : [];
  const labelled = [...new Set([selected, hot])].filter(Boolean)
    .map((key) => points.find((p) => p.item.key === key))
    .filter((p): p is Point => Boolean(p))
    // On a phone only the selected bubble is labelled.
    .filter((p) => !compact || p.item.key === selected);
  const labelFor = (item: Item) => `${item.fields.title}, value ${item.fields.value}, effort ${item.fields.effort}${item.rec ? ", suggested by Council" : ""}`;

  if (!plotted.length) return <section className="fi-chart fi-chart-empty" aria-labelledby="fi-chart-title">
    <h2 id="fi-chart-title">Value against effort</h2>
    <p>{unassessed.length ? `${unassessed.length} ideas need value and effort ratings before they can be plotted. No ratings have been assumed.` : "No ideas match this view."}</p>
    {unassessed.length > 0 && <button type="button" onClick={() => onAssess(unassessed[0])}>Assess an idea</button>}
  </section>;

  return (
    <section className="fi-chart" aria-labelledby="fi-chart-title">
      <div className="fi-chart-head">
        <h2 id="fi-chart-title">Value against effort</h2>
        <span className="fi-dim">Bubble size shows pull. Position is nudged by complexity and confidence. Numbers match the ranking.</span>
      </div>
      <div className="fi-chart-body">
        <div className="fi-frame">
          <span className="fi-axis-y" aria-hidden="true">Value</span>
          <div className="fi-matrix" ref={matrixRef} role="group" aria-label={`${listName}: ${plotted.length} ideas plotted by value and effort`}>
            {QUADRANTS.map(([cls, title, hint]) => (
              <div key={cls} className={`fi-quad ${cls}`} aria-hidden="true"><b>{title}</b><span>{hint}</span></div>
            ))}
            <i className="fi-mid-x" aria-hidden="true" /><i className="fi-mid-y" aria-hidden="true" />
            {points.map((p) => {
              const sel = p.item.key === selected;
              return (
                <button key={p.item.key} type="button"
                  className={`fi-bubble st-${stageOf(p.item)}${p.item.rec ? " sugg" : ""}${sel ? " sel" : ""}`}
                  style={{ left: p.x, top: p.y, width: p.size, height: p.size }}
                  aria-label={labelFor(p.item)} aria-pressed={sel}
                  onClick={() => onSelect(p.item.key)}
                  onMouseEnter={() => setHot(p.item.key)} onMouseLeave={() => setHot((k) => (k === p.item.key ? "" : k))}
                  onFocus={() => setHot(p.item.key)} onBlur={() => setHot((k) => (k === p.item.key ? "" : k))}>
                  <span aria-hidden="true">{rankNo.get(p.item.key) ?? "✦"}</span>
                </button>
              );
            })}
            {labelled.map((p) => {
              const rect = placeLabel(p, points, size.w, size.h, font, obstacles);
              return (
                <span key={`label-${p.item.key}`} aria-hidden="true"
                  className={`fi-label${p.item.rec ? " sugg" : ""}${p.item.key === selected ? " sel" : ""}`}
                  style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
                  {p.item.fields.title}
                </span>
              );
            })}
            {!items.length && <p className="fi-matrix-empty">No ideas in this list to plot.</p>}
          </div>
          <span className="fi-axis-x" aria-hidden="true"><span>Low effort</span><span>Effort</span><span>High effort</span></span>
        </div>
        <div className={`fi-rank${showAll ? "" : " is-collapsed"}`}>
          <h3>Ranked</h3>
          <p className="fi-dim">Score from value, effort, confidence and pull. Suggestions are never ranked.</p>
          <ol>
            {ranked.map((item) => (
              <li key={item.key}>
                <button type="button" className={`fi-rank-row st-${stageOf(item)}${item.rec ? " sugg" : ""}${item.key === selected ? " sel" : ""}`}
                  aria-current={item.key === selected ? "true" : undefined} onClick={() => onSelect(item.key)}>
                  <span className="fi-rank-no" aria-hidden="true">{rankNo.get(item.key) ?? "✦"}</span>
                  <span className="fi-rank-title">{item.fields.title}</span>
                  <span className="fi-rank-score">{item.rec ? "Suggested" : assessed(item.fields) ? score(item.fields) : "Assess"}</span>
                </button>
              </li>
            ))}
          </ol>
          {ranked.length > 5 && (
            <button type="button" className="fi-rank-more" onClick={() => setShowAll((value) => !value)}>
              {showAll ? "Show fewer" : `Show all ${ranked.length}`}
            </button>
          )}
        </div>
      </div>
      <div className="fi-legend" aria-label="Legend">
        {LEGEND.filter(([stage]) => stages.has(stage)).map(([stage, label]) => (
          <span key={stage} className={`fi-legend-item st-${stage}`}><i aria-hidden="true" />{label}</span>
        ))}
        {stages.has("suggested") && <span className="fi-legend-item st-suggested sugg"><i aria-hidden="true" />Suggested, not confirmed</span>}
        <span className="fi-legend-item size"><i aria-hidden="true" /><i className="big" aria-hidden="true" />Pull</span>
      </div>
      {unassessed.length > 0 && (
        <div className="fi-assess-strip">
          <b>Needs assessment</b>
          <span className="fi-dim">Value or effort unknown, so not plotted. Open one and set both to place it.</span>
          <div className="fi-assess-list">
            {unassessed.map((item) => (
              <button key={item.key} type="button"
                className={`fi-assess-chip st-${stageOf(item)}${item.rec ? " sugg" : ""}${item.key === selected ? " sel" : ""}`}
                aria-label={`${item.fields.title}, value ${item.fields.value}, effort ${item.fields.effort}`}
                onClick={() => onSelect(item.key)}>
                <i aria-hidden="true" />{item.fields.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
