import { check } from "./errors.ts";
import { RECORD_FIELDS } from "../shared/sync-contract.ts";
import type { Idea, IdeaFields, GoalFields, TaskFields, Opportunity, OpportunityFields, LedgerFields, FinancePlan, Recommendation } from "../shared/domain.ts";

export function recommendationInput(input: unknown, allowedRoles: readonly string[]): Omit<Recommendation, "id" | "status" | "ownerNote" | "resultId" | "createdAt"> {
  fields(input, [
    "role",
    "kind",
    "targetId",
    "targetVersion",
    "rationale",
    "tradeoffs",
    "confidence",
    "evidence",
    "proposal",
  ]);
  const kind = choose(
    input.kind,
    ["goal", "task", "goal-review", "task-review", "idea", "idea-review", "idea-graduate"],
    "recommendation kind",
  );
  const isReview = kind.endsWith("-review") || kind === "idea-graduate";
  let targetVersion: number | null = null;
  if (isReview) {
    check(
      typeof input.targetVersion === "number" && Number.isInteger(input.targetVersion) && input.targetVersion > 0,
      "Review must bind the current target version",
    );
    targetVersion = input.targetVersion;
  }
  return {
    role: choose(input.role, allowedRoles, "executive role"),
    kind,
    targetId: text(input.targetId ?? "", "target", 80, isReview),
    targetVersion,
    rationale: text(input.rationale, "rationale", 8000),
    tradeoffs: text(input.tradeoffs ?? "", "tradeoffs", 8000, false),
    confidence: choose(
      input.confidence ?? "medium",
      ["low", "medium", "high"],
      "confidence",
    ),
    evidence: text(input.evidence ?? "", "evidence", 12000, false),
    proposal: kind === "idea" || kind === "idea-review" ? ideaInput(input.proposal) : kind.startsWith("goal") || kind === "idea-graduate"
      ? goalInput(input.proposal)
      : taskInput(input.proposal),
  };
}

export function text(value: unknown, name: string, limit = 4000, required = true): string {
  check(
    typeof value === "string" &&
      value.length <= limit &&
      (!required || value.trim().length > 0),
    `Invalid ${name}`,
  );
  return value.trim();
}
function retainedText(value: unknown, previous: unknown, name: string, limit: number, required = true): string {
  // Existing imported text may exceed modern editor limits. Preserve it byte
  // for byte when unchanged, while validating every replacement normally.
  if (typeof value === "string" && value === previous && (!required || value.trim())) return value;
  return text(value, name, limit, required);
}
export function choose<const T extends string>(v: unknown, set: readonly T[], name: string): T {
  check(set.includes(v as T), `Invalid ${name}`);
  return v as T;
}
function deadline(v: unknown): string {
  if (v === "" || v === undefined) return "";
  check(
    typeof v === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(v) &&
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Invalid date",
  );
  return v;
}
export function fields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected an object",
  );
  check(
    Object.keys(value).every((k) => allowed.includes(k)),
    "Unexpected field",
  );
}
export function labelsInput(value: unknown = []): string[] {
  check(Array.isArray(value) && value.length <= 30, "Use at most 30 labels");
  return [...new Set(value.map(v => text(v, "label", 80)))];
}
const organized = (input: Record<string, unknown>) => ({projects: labelsInput(input.projects), tags: labelsInput(input.tags), ideaIds: labelsInput(input.ideaIds)});
export const ideaFields = RECORD_FIELDS.idea;
export function ideaInput(input: unknown, previous: Pick<IdeaFields, "title"> | null = null): IdeaFields {
  fields(input, ideaFields);
  const band = (key: string) => choose(input[key] ?? "unknown", ["unknown", "low", "medium", "high"], key);
  return {
    title: retainedText(input.title, previous?.title, "title", 180), description: text(input.description ?? "", "description", 8000, false),
    owner: text(input.owner ?? "Owner", "owner", 120),
    status: choose(input.status ?? "inbox", ["inbox", "exploring", "ready", "parked", "graduated", "archived"], "idea status"),
    projects: labelsInput(input.projects), tags: labelsInput(input.tags),
    value: band("value"), complexity: band("complexity"), effort: band("effort"), upkeep: band("upkeep"), confidence: band("confidence"), pull: band("pull"),
    startCondition: text(input.startCondition ?? "", "start condition", 4000, false),
    experiment: text(input.experiment ?? "", "smallest useful test", 4000, false),
    reviewOn: deadline(input.reviewOn), evidence: text(input.evidence ?? "", "evidence", 12000, false),
    goalIds: labelsInput(input.goalIds),
  };
}
export function legacyIdea(row: Opportunity): Idea {
  return {...ideaInput({title: row.title, owner: row.owner, description: row.notes ?? "",
    status: ({new:"inbox",qualified:"exploring",proposed:"ready",won:"graduated",lost:"archived"})[row.status] ?? "inbox",
    experiment: row.nextAction ?? "", reviewOn: row.followUpOn ?? "", goalIds: row.goalId ? [row.goalId] : []}),
    id: row.id, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, history: row.history ?? [],
    original: row.notes || row.title, legacy: row};
}
export const goalFields = RECORD_FIELDS.goal;
export function goalInput(input: unknown): GoalFields {
  fields(input, goalFields);
  const progress = input.progress ?? 0;
  check(
    typeof progress === "number" && Number.isInteger(progress) && progress >= 0 && progress <= 100,
    "Progress must be 0 to 100",
  );
  const milestones = input.milestones ?? [];
  check(
    Array.isArray(milestones) && milestones.length <= 30,
    "Invalid milestones",
  );
  return {
    ...organized(input),
    title: text(input.title, "title", 180),
    intent: text(input.intent ?? "", "intent", 4000, false),
    successCriteria: text(
      input.successCriteria ?? "",
      "success criteria",
      4000,
      false,
    ),
    owner: text(input.owner ?? "Owner", "owner", 120),
    horizon: text(input.horizon ?? "", "horizon", 160, false),
    priority: choose(
      input.priority ?? "normal",
      ["high", "normal", "low"],
      "priority",
    ),
    parentId: text(input.parentId ?? "", "parent goal", 80, false),
    reviewOn: deadline(input.reviewOn),
    milestones: milestones.map((m) => {
      fields(m, ["title", "done"]);
      check(typeof m.done === "boolean", "Invalid milestone state");
      return { title: text(m.title, "milestone", 240), done: m.done };
    }),
    evidence: text(input.evidence ?? "", "evidence", 12000, false),
    progress,
    status: choose(
      input.status ?? "active",
      ["active", "paused", "achieved", "retired"],
      "goal status",
    ),
  };
}
function integer(value: unknown, name: string, min: number, max: number): number {
  check(typeof value === "number"&&Number.isSafeInteger(value)&&value>=min&&value<=max,`Invalid ${name}`);
  return value;
}
export function opportunityInput(input: unknown): OpportunityFields {
  fields(input,['title','owner','contact','kind','status','valueCents','nextAction','followUpOn','notes','goalId']);
  return {title:text(input.title,'title',180),owner:text(input.owner,'owner',120),contact:text(input.contact??'','contact',160,false),kind:choose(input.kind,['booking','event','partnership'],'opportunity kind'),status:choose(input.status,['new','qualified','proposed','won','lost'],'opportunity status'),valueCents:integer(input.valueCents,'estimated value',0,10000000000),nextAction:text(input.nextAction??'','next action',500,false),followUpOn:deadline(input.followUpOn),notes:text(input.notes??'','notes',4000,false),goalId:text(input.goalId??'','goal',80,false)};
}
export function entryInput(input: unknown): LedgerFields {
  fields(input,['title','kind','amountCents','date','category','notes']);
  const date=deadline(input.date);check(date,'A ledger date is required');
  return {title:text(input.title,'title',180),kind:choose(input.kind,['income','expense'],'entry kind'),amountCents:integer(input.amountCents,'amount',1,10000000000),date,category:text(input.category,'category',120),notes:text(input.notes??'','notes',4000,false)};
}
export function financePlanInput(input: unknown): FinancePlan {
  fields(input,['openingCashCents','rooms','days','occupancy','rateCents','variableCents','fixedCents']);
  return {openingCashCents:integer(input.openingCashCents,'opening cash',0,10000000000),rooms:integer(input.rooms,'rooms',1,500),days:integer(input.days,'days',1,31),occupancy:integer(input.occupancy,'occupancy',0,100),rateCents:integer(input.rateCents,'room rate',0,100000000),variableCents:integer(input.variableCents,'variable cost',0,100000000),fixedCents:integer(input.fixedCents,'fixed costs',0,10000000000)};
}
export const taskFields = RECORD_FIELDS.task;
export function taskInput(input: unknown, previous: Pick<TaskFields, "title" | "notes"> | null = null): TaskFields {
  fields(input, taskFields);
  return {
    ...organized(input),
    title: retainedText(input.title, previous?.title, "title", 180),
    notes: retainedText(input.notes ?? "", previous?.notes, "notes", 8000, false),
    goalId: text(input.goalId ?? "", "goal", 80, false),
    owner: text(input.owner ?? "Owner", "owner", 120),
    dueOn: deadline(input.dueOn),
    status: choose(
      input.status ?? "todo",
      ["todo", "doing", "blocked", "done", "cancelled"],
      "task status",
    ),
    priority: choose(
      input.priority ?? "normal",
      ["high", "normal", "low"],
      "priority",
    ),
  };
}
