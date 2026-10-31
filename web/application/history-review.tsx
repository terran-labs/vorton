import { useRef, useState } from "react";
import { profileReplica } from "./profile-cache";
import type { HistoryComparison, ReplicaSnapshot } from "./replica-service";

export const recoveryOriginLabel: Record<string, string> = {
  "queued-intent": "Local intent without confirmed acceptance",
  "historically-accepted": "Accepted in earlier server history",
  "cached-history": "Earlier saved server value",
};

export function HistoryReview({ profile, snapshot }: { profile: string; snapshot: ReplicaSnapshot }) {
  const [comparison, setComparison] = useState<HistoryComparison>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const adoptionId = useRef("");
  const section = useRef<HTMLElement>(null);
  if (!snapshot.historyChanged) return null;
  async function compare(restart = false) {
    setBusy(true); setError("");
    try {
      const next = await profileReplica.reviewHistory(profile, restart);
      adoptionId.current = crypto.randomUUID();
      setComparison(next);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function adopt() {
    if (!comparison || !adoptionId.current) return;
    const focusTarget = section.current?.parentElement;
    setBusy(true); setError("");
    try {
      await profileReplica.adoptHistory(profile, comparison, adoptionId.current);
      setComparison(undefined);
      if (document.activeElement === document.body) focusTarget?.focus();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  const progress = snapshot.historyReview;
  return <section ref={section} aria-label="Restored server history" aria-busy={busy}>
    <h3>Restored server history</h3>
    <p>Sending is paused. Your saved records, drafts and earlier attempts remain on this device.</p>
    <p>Compare the restored server with saved history. Adoption keeps differences blocked for individual review and does not send them automatically.</p>
    {busy && <p role="status">{progress && progress.cursor < progress.head ? "Downloading restored records…" : "Checking restored history…"}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="pending-changes-actions">
      <button type="button" disabled={busy || snapshot.reviewing} onClick={() => void compare()}>{comparison ? "Refresh comparison" : progress ? "Resume history review" : "Compare restored history"}</button>
      {progress && <button type="button" disabled={busy || snapshot.reviewing} onClick={() => void compare(true)}>Restart comparison</button>}
    </div>
    {comparison && <>
      <p role="status">{comparison.differences.length} saved {comparison.differences.length === 1 ? "difference needs" : "differences need"} individual review.</p>
      {comparison.differences.length > 0 && <ol className="pending-changes-list" aria-label="Restored history differences" tabIndex={0}>
        {comparison.differences.map(row => <li key={`${row.kind}/${row.id}`}>
          <strong>{row.title}</strong>
          <p>{row.local === null ? "Saved deletion" : row.server === null ? "Absent from restored server" : "Different saved fields"} · {row.kind}</p>
          <p>{recoveryOriginLabel[row.origin]}</p>
        </li>)}
      </ol>}
      <p>Keep the earlier history in the recovery export and adopt the restored server. Each difference will remain available below for a separate decision. Drafts are kept and may need review before saving.</p>
      <button type="button" disabled={busy || snapshot.reviewing} onClick={() => void adopt()}>Adopt restored history</button>
    </>}
  </section>;
}
