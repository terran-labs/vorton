import { randomUUID } from "node:crypto";
import { appended } from "./workspace-delta.ts";

type Task = { id: string; status: string };
type Outcome = { id: string; taskId: string };
type GovernedState = {
  governance?: { tasks?: { retainCompletedOutcomes?: boolean } };
  tasks: Task[];
  taskOutcomes?: Outcome[];
};

/** Imported outcomes and new completions obey the same invariant. Historical
 * evidence stays opaque here: an unavailable source is not newly verified. */
export function validateCompletionOutcomes(state: GovernedState): void {
  if (!state.governance?.tasks?.retainCompletedOutcomes) return;
  const tasks = new Map(state.tasks.map(task => [task.id, task]));
  const identities = new Set<string>(), completed = new Set<string>();
  for (const outcome of state.taskOutcomes ?? []) {
    if (!outcome.id || identities.has(outcome.id)) throw Error("Invalid or duplicate completion outcome identity");
    identities.add(outcome.id);
    if (tasks.get(outcome.taskId)?.status !== "done") throw Error("Completion outcome requires a completed task");
    if (completed.has(outcome.taskId)) throw Error("Completed task has duplicate outcomes");
    completed.add(outcome.taskId);
  }
  if (state.tasks.some(task => task.status === "done" && !completed.has(task.id)))
    throw Error("Completed task is missing its governed outcome");
}

type Command = { action: string; requestId?: string; payload?: Record<string, unknown> };
type AuditRecord = {
  id: string; at: string; workspaceRevision: number; action: string;
  operationId: string | null; actor: "owner"; subjectId: string;
  resultVersion: number | null; authority: string;
  decision?: { proposal: unknown; choice: unknown; note: unknown; resultId: string | null };
};
type AuditState = { revision: number; strategicAudit?: AuditRecord[] };

/** Called by the domain reducer, so audit, record changes and the durable
 * operation receipt share the caller's SQLite transaction. */
export function recordDomainAudit(
  state: AuditState, command: Command,
  result: { id?: string; version?: number; resultId?: string } | undefined,
  proposal?: unknown,
): void {
  if (!/^(task|goal|idea|recommendation)\./.test(command.action)) return;
  const entry: AuditRecord = {
    id: randomUUID(), at: new Date().toISOString(), workspaceRevision: state.revision + 1,
    action: command.action, operationId: command.requestId ?? null, actor: "owner",
    subjectId: result?.id ?? "", resultVersion: result?.version ?? null,
    authority: "Owner changed local planning records; no external action authorized.",
  };
  if (command.action === "recommendation.resolve") entry.decision = {
    proposal: structuredClone(proposal), choice: command.payload?.decision,
    note: command.payload?.note ?? "", resultId: result?.resultId ?? null,
  };
  (state.strategicAudit ??= []).push(entry);
  appended(state, 'strategicAudit', entry);
}
