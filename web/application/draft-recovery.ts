import { canonicalJson, type SyncOperation } from "../../shared/sync-contract.ts";
import type { DraftKey, SavedDraft } from "./offline-store.ts";
import type { IdentityReview } from "./replica-sql.ts";

type Identity = { id: string; generation: string };
export type DraftTarget = IdentityReview & { profile: string; kind: DraftKey["kind"] };
export type RetainedDraft = { draft: SavedDraft; sourceId: string; sourceGeneration: string; target: DraftTarget };
type Resolve = (kind: SyncOperation["kind"], id: string, generation: string, review?: IdentityReview) => Promise<Identity>;
export const sameDraftKey = (left: DraftKey, right: DraftKey) => left.profile === right.profile && left.schema === right.schema && left.kind === right.kind && left.targetId === right.targetId;
export function editorRecordKind(kind: DraftKey["kind"]): SyncOperation["kind"] | undefined {
  return kind === "task-editor-v1" ? "task" : kind === "goal-editor-v1" ? "goal" : kind === "idea-editor-v1" ? "idea" : undefined;
}
const relevant = (drafts: SavedDraft[], target: DraftTarget) => drafts.filter(draft => draft.key.profile === target.profile && draft.key.kind === target.kind);
const fingerprint = (drafts: SavedDraft[], target: DraftTarget) => canonicalJson(relevant(drafts, target).map(draft =>
  [draft.key.targetId, draft.savedAt, draft.baseline?.syncGeneration ?? null, draft.fields.__vortonLocalRecord ?? null]).sort());

/** Discovery never loads fields, changes a baseline or picks the newest draft.
 * Only a known identity chain associates an earlier editor key with a copy. */
export async function findRetainedDrafts(drafts: SavedDraft[], target: DraftTarget, storageKey: DraftKey, resolve: Resolve) {
  const kind = editorRecordKind(target.kind), candidates: RetainedDraft[] = [];
  let currentPresent = false;
  if (!kind) return { candidates, currentPresent, ambiguous: false };
  for (const draft of relevant(drafts, target)) {
    const bound = typeof draft.fields.__vortonLocalRecord === "string";
    const sourceId = bound ? draft.fields.__vortonLocalRecord as string : draft.key.targetId;
    const sourceGeneration = draft.baseline?.syncGeneration;
    let matches = draft.key.targetId === target.id && (!bound || sourceId === target.id);
    if ((bound || !matches) && sourceId !== "new" && sourceGeneration) {
      const identity = await resolve(kind, sourceId, sourceGeneration);
      matches = identity.id === target.id && identity.generation === target.generation;
    }
    if (!matches) continue;
    if (sameDraftKey(draft.key, storageKey)) currentPresent = true;
    else candidates.push({ draft, sourceId: draft.key.targetId === target.id ? target.id : sourceId,
      sourceGeneration: draft.key.targetId === target.id ? target.generation : sourceGeneration!, target });
  }
  return { candidates, currentPresent, ambiguous: candidates.length > 1 || currentPresent && candidates.length > 0 };
}

/** Revalidate the source, competing drafts and current record without claiming
 * an atomic transaction across IndexedDB and SQLite. The later draft write
 * still uses its original key and timestamp CAS. */
export async function verifyRetainedDraft(candidate: RetainedDraft, storageKey: DraftKey, read: () => Promise<SavedDraft[]>, resolve: Resolve, selecting = true) {
  const before = await read(), source = before.find(draft => sameDraftKey(draft.key, candidate.draft.key));
  if (!source || source.savedAt !== candidate.draft.savedAt)
    throw Error("This saved draft changed during review. Refresh the retained drafts before choosing.");
  const search = await findRetainedDrafts(before, candidate.target, storageKey, resolve);
  if (!search.candidates.some(match => sameDraftKey(match.draft.key, source.key)) || selecting && search.ambiguous)
    throw Error("Multiple or changed drafts need review. Preserve them before choosing which draft to keep.");
  const kind = editorRecordKind(candidate.target.kind);
  if (!kind) throw Error("This draft does not belong to a supported record editor.");
  await resolve(kind, candidate.sourceId, candidate.sourceGeneration, candidate.target);
  const after = await read();
  if (fingerprint(before, candidate.target) !== fingerprint(after, candidate.target))
    throw Error("Saved drafts changed during review. Refresh the retained drafts before choosing.");
  return source;
}
