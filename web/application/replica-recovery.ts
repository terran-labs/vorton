import { canonicalJson, RECORD_FIELDS, type SyncOperation } from "../../shared/sync-contract.ts";
import type { SqlRow } from "./replica-sql.ts";

type Value = (Record<string, unknown> & { title?: string; version?: number }) | null;
export type RecoveryOrigin = "queued-intent" | "historically-accepted" | "cached-history";
type Source = { kind: string; id: string; body: string; proof: SqlRow[]; projection: boolean };
export function editableRecord(kind: string, value: Value) {
  return value === null ? null : Object.fromEntries(RECORD_FIELDS[kind as SyncOperation["kind"]]
    .filter(field => field in value).map(field => [field, value[field]]));
}

/** The comparison and adoption use the same plan. Differences identify
 * recoverable values, never proof that every difference is an unsent edit. */
export function planHistoryRecovery(baseline: Record<string, SqlRow[]>) {
  const oldGeneration = baseline.workspace_meta[0]?.generation ?? baseline.history_identity[0]?.generation;
  const source = new Map<string, Source>();
  const key = (row: SqlRow) => canonicalJson([row.kind, row.id ?? row.record_id]);
  for (const row of [...baseline.server_records, ...baseline.local_records]) {
    // Resolution keeps a revision-zero absence when an old identity is
    // replaced by a copy. That placeholder is not a saved deletion intent.
    if (row.body === "null" && row.revision === 0) continue;
    source.set(key(row), { kind: String(row.kind), id: String(row.id), body: String(row.body), proof: [], projection: true });
  }
  for (const row of baseline.outbox.filter(row => row.generation === oldGeneration)) {
    const identity = key(row), current = source.get(identity);
    if (current) current.proof.push(row);
    if (row.receipt && !current?.projection) {
      const receipt = JSON.parse(String(row.receipt));
      if (receipt.status === "accepted") {
        if (current) current.body = canonicalJson(receipt.value);
        else source.set(identity, { kind: String(row.kind), id: String(row.record_id), body: canonicalJson(receipt.value), proof: [row], projection: false });
      }
    }
  }
  const candidates = new Map(baseline.history_candidates.map(row => [key(row), row]));
  const proposals: { saved: Source; local: Value; server: Value; revision: number; title: string; origin: RecoveryOrigin }[] = [];
  for (const saved of source.values()) {
    const candidate = candidates.get(canonicalJson([saved.kind, saved.id]));
    const local = JSON.parse(saved.body) as Value;
    const server = candidate ? JSON.parse(String(candidate.body)) as Value : null;
    const matchesSaved = (value: Value) => canonicalJson(editableRecord(saved.kind, value)) === canonicalJson(editableRecord(saved.kind, local));
    if (matchesSaved(server)) continue;
    const activeProof = saved.proof.filter(row => !["accepted", "superseded"].includes(String(row.status)));
    const acceptedProof = saved.proof.some(row => {
      if (row.status !== "accepted" || !row.receipt) return false;
      const receipt = JSON.parse(String(row.receipt));
      return receipt.status === "accepted" && receipt.deleted === (local === null) && matchesSaved(receipt.value);
    });
    const inheritedAcceptance = activeProof.some(row => {
      if (row.recovery_origin !== "historically-accepted") return false;
      const operation = JSON.parse(String(row.operation));
      return local === null ? operation.action === "delete" : operation.action !== "delete" && canonicalJson(operation.value) === canonicalJson(editableRecord(saved.kind, local));
    });
    const origin = activeProof.some(row => !row.recovery_origin || row.recovery_origin === "queued-intent") ? "queued-intent"
      : inheritedAcceptance || acceptedProof ? "historically-accepted" : "cached-history";
    proposals.push({ saved, local, server, revision: Number(candidate?.revision ?? 0), origin,
      title: String(local?.title ?? saved.proof.at(-1)?.title ?? server?.title ?? "Deleted record") });
  }
  return { sources: [...source.values()], proposals };
}
