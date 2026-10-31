"use client";
import { useEffect, useState } from "react";
import "./vorteo-activity.css";

type Thread = { key:string; title:string; project:string; projectId:string; workspace:string; workspaceId:string; agentId:string; hostId:string; environment:string; status:string; attention:string|null; updatedAt:string|null; observedAt:string; present:boolean; sourceUrl:string|null; sourceRoute:string; delivery:{status:string;reason:string;receipts:{url:string;label:string}[]} };
type Activity = { status:string; observedAt:string|null; coverage:{complete:boolean;gaps:string[]}; threads:Thread[]; sources?:{environment:string;hostId:string|null;status:string;observedAt:string|null;coverage:{complete:boolean;gaps:string[]}}[] };
const when = (value:string|null) => value ? new Date(value).toLocaleString() : "Unknown";
export function VorteoActivity({token}:{token:string}) {
  const [activity,setActivity] = useState<Activity|null>(null);
  const [error,setError] = useState("");
  const [project,setProject] = useState("");
  const [busy,setBusy] = useState(false);
  async function load(signal?:AbortSignal) {
    setBusy(true);
    try {
      const response = await fetch("/api/aubos/integrations/vorteo", {cache:"no-store",signal,headers:{"X-Vorton-Session":token}});
      if (!response.ok) throw new Error("Activity observation is unavailable.");
      setActivity(await response.json()); setError("");
    } catch (e) { if (!(e instanceof DOMException && e.name === "AbortError")) setError("Activity observation is unavailable. Retained observations may be stale."); }
    finally { setBusy(false); }
  }
  useEffect(() => { const controller=new AbortController(); void load(controller.signal); return () => controller.abort(); },[token]);
  const projects = [...new Set(activity?.threads.map(row=>row.project) ?? [])].sort();
  const rows = activity?.threads.filter(row => !project || row.project === project).slice(0,80) ?? [];
  return <section className="panel vorteo-activity" aria-labelledby="vorteo-activity-heading">
    <header className="record-heading"><div><p className="eyebrow">Daily work</p><h2 id="vorteo-activity-heading">Vorteo activity</h2></div><button type="button" onClick={()=>void load()} disabled={busy}>{busy?"Reading…":"Refresh observations"}</button></header>
    <p className="quiet">Current and recent threads. Agent turn completion does not prove merged or released work.</p>
    <p role="status">{error || (activity ? `${activity.status.replaceAll("-"," ")} · Observed ${when(activity.observedAt)}` : "Reading the selected host…")}</p>
    {activity?.sources && <dl className="activity-sources">{activity.sources.map(source=><div key={source.environment}><dt>{source.environment}</dt><dd>{source.status.replaceAll("-"," ")} · {source.hostId ?? "Host identity unavailable"} · Observed {when(source.observedAt)}</dd></div>)}</dl>}
    {activity?.coverage.gaps.length ? <details className="activity-coverage" open><summary>Coverage gaps</summary><ul>{activity.coverage.gaps.map(gap=><li key={gap}>{gap}</li>)}</ul></details> : null}
    {projects.length>1 && <label className="activity-filter">Project <select value={project} onChange={event=>setProject(event.target.value)}><option value="">All authorized projects</option>{projects.map(name=><option key={name}>{name}</option>)}</select></label>}
    <div className="activity-threads">{rows.map(row=><article key={row.key} className="activity-thread">
      <div className="activity-thread-heading"><h3>{row.sourceUrl ? <a href={row.sourceUrl} target="_blank" rel="noreferrer">{row.title} ↗</a> : row.title}</h3><span>{row.present ? row.status === "idle" && row.attention === "finished" ? "Agent turn complete" : row.status : "Missing from latest directory"}</span></div>
      <p>{row.project} · {row.workspace || row.workspaceId} · {row.environment}</p>
      <p className="quiet">Updated {when(row.updatedAt)} · Shipping {row.delivery.status}</p>
      {row.delivery.receipts.map(receipt=><a key={receipt.url} href={receipt.url} target="_blank" rel="noreferrer">{receipt.label}</a>)}
      <details><summary>Source provenance</summary><dl>{[["Host",row.hostId],["Project",row.projectId],["Workspace",row.workspaceId],["Agent",row.agentId],["Observed",row.observedAt],["Native route",row.sourceRoute]].map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl><p>{row.delivery.reason}</p></details>
    </article>)}</div>
    {activity && !rows.length && <p>{activity.status === "ready" ? "No threads were returned for this project." : "No threads are available within the observed coverage."}</p>}
    {(activity?.threads.length ?? 0)>80 && <p className="quiet">Showing up to 80 threads. Filter by project to narrow the retained observations.</p>}
  </section>;
}
