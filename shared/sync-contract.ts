export const SYNC_PROTOCOL = "vorton.sync.v1" as const;
export const RECORD_FIELDS = {
  task: ["projects", "tags", "ideaIds", "title", "notes", "goalId", "owner", "dueOn", "status", "priority"],
  goal: ["projects", "tags", "ideaIds", "title", "intent", "successCriteria", "owner", "horizon", "priority", "parentId", "reviewOn", "milestones", "evidence", "progress", "status"],
  idea: ["title", "description", "owner", "status", "projects", "tags", "value", "complexity", "effort", "upkeep", "confidence", "pull", "startCondition", "experiment", "reviewOn", "evidence", "goalIds"],
} as const;
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? "null";
}
export type SyncOperation = {
  operationId: string;
  kind: "task" | "goal" | "idea";
  id: string;
  expectedRevision: number;
  action: "create" | "update" | "delete";
  value?: Record<string, unknown>;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function parseSyncRequest(input: unknown): { protocol: typeof SYNC_PROTOCOL; generation: string; operation: SyncOperation } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Expected a synchronization request");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "generation,operation,protocol" || value.protocol !== SYNC_PROTOCOL ||
    typeof value.generation !== "string" || !uuid.test(value.generation)) throw Error("Unsupported synchronization request. Update Vorton before retrying.");
  return { protocol: SYNC_PROTOCOL, generation: value.generation, operation: parseSyncOperation(value.operation) };
}

/** Transport data remains untrusted even when the caller is TypeScript. */
export function parseSyncOperation(input: unknown): SyncOperation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Expected a synchronization operation");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["operationId", "kind", "id", "expectedRevision", "action", "value"].includes(key)) ||
      typeof value.operationId !== "string" || !uuid.test(value.operationId) ||
      !["task", "goal", "idea"].includes(String(value.kind)) ||
      typeof value.id !== "string" || !value.id || value.id.length > 200 ||
      typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
      !["create", "update", "delete"].includes(String(value.action))) throw Error("Invalid synchronization operation");
  if (value.action === "create" && (!uuid.test(value.id) || value.expectedRevision !== 0)) throw Error("New records require a stable UUID and revision zero");
  if (value.action !== "delete" && (!value.value || typeof value.value !== "object" || Array.isArray(value.value)))
    throw Error("Record fields are required");
  return value as SyncOperation;
}
