import type { State } from "../shared/domain.ts";
import { check } from "./errors.ts";

/** SQL workspace metadata and its cursor share a snapshot. Current Council
 * configuration remains adapter-supplied. Entity values arrive through the
 * bounded feed, while private auxiliary data stays out. */
export function replicaMetadata(state: State & { requests?: unknown; auxiliary?: unknown }): State {
  check(typeof state.syncGeneration === "string" && state.syncGeneration.length > 0 &&
    typeof state.syncCursor === "number" && Number.isSafeInteger(state.syncCursor) && state.syncCursor >= 0,
    "Replica metadata is missing its server download boundary", 503);
  const { requests, auxiliary, ...metadata } = state;
  return { ...metadata, goals: [], tasks: [], ideas: [],
    ...(state.canonical ? { canonical: { source: "sqlite", projection: "workspace-v1" } as const } : {}) };
}
