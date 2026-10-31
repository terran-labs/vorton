import { useEffect, useState } from "react";
import { LoadingIndicator } from "./loading-indicator";
import { beginLiveAction } from "./application/live-action";

type Issue = {
  number: number; title: string; url: string;
  stage: "qualification" | "ready" | "building" | "review" | "ci" | "merge" | "merged" | "blocked";
  reason: string; auditUrl: string | null;
};
type Snapshot = {
  revision: string; observedAt: string; state: string; reason: string | null;
  controls: Array<"pause" | "drain" | "stop" | "resume">;
  quota: { maxConsumedPoints: number; consumedPoints: number | null; remainingPercent: number | null; observedAt: string | null };
  release: { state: string; lastSuccessfulAt: string | null; dueAt: string | null; reason: string | null };
  issues: Issue[];
  activity: Array<{ id: string; at: string; message: string; url: string | null }>;
};
const stages = [
  ["qualification", "Qualification"], ["ready", "Ready"], ["building", "Building"],
  ["review", "Review"], ["ci", "CI"], ["merge", "Merge queue"], ["merged", "Merged"], ["blocked", "Needs attention"],
] as const;
const count = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
const date = (value: string | null) => value ? new Date(value).toLocaleString() : "Not yet recorded";
const safeLink = (value: string | null) => {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
};

export function FactoryPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const session = await fetch("/api/session", { cache: "no-store", signal: abort.signal }).then(response => {
          if (!response.ok) throw new Error("Unable to read the current session.");
          return response.json();
        });
        const response = await fetch("/api/freedos/factory", { cache: "no-store", signal: abort.signal,
          headers: { "x-vorton-session": session.token } });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "Factory status is unavailable.");
        if (!abort.signal.aborted) { setSnapshot(value); setError(""); }
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "Factory status is unavailable.");
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(read, 15000);
      }
    };
    void read();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [refresh]);

  const command = async (action: Snapshot["controls"][number]) => {
    if (!snapshot || busy || error) return;
    setBusy(true);
    try {
      const live = await beginLiveAction("FreedOS");
      const response = await fetch("/api/freedos/factory", { method: "POST",
        headers: { "content-type": "application/json", "x-vorton-session": live.token },
        body: JSON.stringify({ action, expectedRevision: snapshot.revision, requestId: crypto.randomUUID() }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Factory command was not confirmed.");
      live.assertCurrent();
      setRefresh(value => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Factory command was not confirmed.");
    } finally { setBusy(false); }
  };
  return <section aria-label="Factory">
    <header><h1 className="mobile-page-title">Factory</h1>
      <p>Qualified issues, independent review, verified merges and daily dev releases.</p>
    </header>
    {error && <p role="alert">{error} {snapshot && "The previous snapshot is retained below; controls are disabled until status refreshes."}</p>}
    {!snapshot && !error && <LoadingIndicator label="Reading Factory status"/>}
    {snapshot && <>
      <section aria-label="Controller status">
        <h2>{snapshot.state}</h2><p>{snapshot.reason}</p>
        <p>Observed {date(snapshot.observedAt)}</p>
        <div className="actions">{snapshot.controls.map(action => <button key={action} disabled={busy || Boolean(error)}
          onClick={() => void command(action)}>{({ pause: "Pause admissions", drain: "Drain", stop: "Stop active work", resume: "Resume" })[action]}</button>)}</div>
      </section>
      <section aria-label="Account budget"><h2>Account consumption</h2>
        <p>{snapshot.quota.consumedPoints === null ? "Hourly consumption unavailable" : `${count(snapshot.quota.consumedPoints)} percentage points consumed in the trailing hour`}.
          {` Limit: ${count(snapshot.quota.maxConsumedPoints)} percentage points.`}</p>
        <p>{snapshot.quota.remainingPercent === null ? "Remaining allowance unavailable" : `${count(snapshot.quota.remainingPercent)}% account allowance remaining`}.
          {` Observed ${date(snapshot.quota.observedAt)}.`}</p>
        <p>Estimated account allowance, including other work on this account. No merge-count cap.</p>
      </section>
      <section aria-label="Dev release"><h2>Dev release</h2><p>{snapshot.release.state}</p>
        <p>Last successful release: {date(snapshot.release.lastSuccessfulAt)}. Next due: {date(snapshot.release.dueAt)}.</p>
        {snapshot.release.reason && <p>{snapshot.release.reason}</p>}
      </section>
      <section aria-label="Issues board"><h2>Issues</h2>
        {snapshot.issues.length === 0 ? <p>No issues in the current Factory snapshot.</p> : stages.map(([stage, label]) => {
          const issues = snapshot.issues.filter(issue => issue.stage === stage);
          return issues.length > 0 && <section key={stage} aria-label={label}><h3>{label} ({count(issues.length)})</h3>
            <ul>{issues.map(issue => <li key={issue.number}>
              <a href={safeLink(issue.url)}>#{count(issue.number)} {issue.title}</a>
              <p>{issue.reason}</p>{safeLink(issue.auditUrl) && <a href={safeLink(issue.auditUrl)}>Qualification audit</a>}
            </li>)}</ul>
          </section>;
        })}
      </section>
      <section aria-label="Factory activity"><h2>Activity</h2>
        {snapshot.activity.length === 0 ? <p>No recent execution events.</p> : <ol>{snapshot.activity.map(event => <li key={event.id}>
          <time dateTime={event.at}>{date(event.at)}</time><p>{event.message}</p>
          {safeLink(event.url) && <a href={safeLink(event.url)}>View evidence</a>}
        </li>)}</ol>}
      </section>
    </>}
  </section>;
}
