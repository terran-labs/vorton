import React, { useEffect, useRef, useState } from "react";
import "./council-tuning.css";
import { ReportBody } from "./council-report";
import { CouncilWorkbench } from "./council-workbench";
import { beginLiveAction } from "./application/live-action";

type Instruction = { label: string; availability: string; text: string | null; sha256?: string | null; gap?: string };
type Version = { id: string; title: string; kind: string; createdAt: string; parentId?: string; report: string | null; reportSha256: string | null; instructions: Instruction[]; metadata: Record<string, unknown> };
type Run = { id: string; versionId: string; status: string; report: string | null; startedAt: string; deadlineAt: string; diagnostic?: string; [key: string]: unknown };
type Tuning = { revision: number; versions: Version[]; runs: Run[]; production: { status: string; promotion: string }; previewPolicy: { ready: boolean; provider: string; model: string; thinking: string; maximumSeconds: number; maximumTurns: number; maximumWords: number; evidence: string; cost: string } };
const pacificTime = (value: string) => new Date(value).toLocaleString(undefined, {timeZone:"America/Los_Angeles"}) + " Pacific";

/** Shared shell and tokens. Reports and prompts render as inert text, never HTML. */
export function CouncilTuning({ token }: { token: string }) {
  const reviewedGeneration = useRef<string | null>(null);
  const [data, setData] = useState<Tuning | null>(null);
  const [left, setLeft] = useState("A"), [right, setRight] = useState("C");
  const [parent, setParent] = useState("C"), [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saved, setSaved] = useState("");
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const [diffKind,setDiffKind]=useState("instructions");
  const endpoint = "/api/aubos/council-tuning";
  async function request<T>(body?: object, signal?: AbortSignal): Promise<T> {
    // Background polling must not rebind an open draft to restored history.
    const expectedGeneration = reviewedGeneration.current;
    if (body && !expectedGeneration) throw new Error("Reload Council Tuning before submitting. Your draft has no reviewed server history.");
    const command = body ? { ...body, expectedGeneration } : undefined;
    const live = body ? await beginLiveAction("AubOS") : undefined;
    const response = await fetch(endpoint, { method: body ? "POST" : "GET", cache: "no-store", signal, headers: { "X-Vorton-Session": live?.token ?? token, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(command ? { body: JSON.stringify(command) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Council Tuning request failed."); live?.assertCurrent();
    if (!body) {
      if (typeof result.syncGeneration !== "string" || !result.syncGeneration) throw new Error("Server history is unavailable. Keep your draft and reload before submitting.");
      if (reviewedGeneration.current && reviewedGeneration.current !== result.syncGeneration) throw new Error("Server history changed. Keep your draft and reload to review the restored records.");
      reviewedGeneration.current = result.syncGeneration;
    }
    return result;
  }
  useEffect(() => { const controller = new AbortController(); request<Tuning>(undefined, controller.signal).then(setData).catch(e => { if (e.name !== "AbortError") setError(e.message); }); return () => controller.abort(); }, [token]);
  const active = data?.runs.some(run => ["reserved", "running", "dispatch-unknown", "stop-unconfirmed"].includes(run.status));
  useEffect(() => { if (!active) return; const timer = setInterval(() => { request<Tuning>().then(setData).catch(e => setError(e.message)); }, 5000); return () => clearInterval(timer); }, [active, token]);
  async function act(body: object, success: string) {
    if (busy) return; setBusy(true); setError(""); setMessage("");
    try { const result = await request<{version?: Version}>(body); if (result.version) { setSaved(result.version.id); setParent(result.version.id); } setData(await request<Tuning>()); setMessage(success); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function edit(versionId: string) {
    const version = data?.versions.find(value => value.id === versionId); setParent(versionId); setSaved(""); setConfirmed(false);
    setTitle(version ? `${version.title} iteration` : "");
    setInstructions(version?.instructions.find(item => item.text !== null && item.availability === "exact")?.text ?? "");
  }
  const options = data?.versions.map(version => <option key={version.id} value={version.id}>{version.title} ({version.kind})</option>);
  const savedVersion=data?.versions.find(version=>version.id===saved);
  const binding=savedVersion?.metadata.ruleBinding as {previewEvidenceAvailable?:boolean}|null|undefined;
  const canPreview=!binding||binding.previewEvidenceAvailable===true;
  function comparisonText(id:string){const version=data?.versions.find(v=>v.id===id);return diffKind==='instructions'?version?.instructions.map(i=>i.text??`Unavailable: ${i.label}`).join('\n')??'':version?.report??data?.runs.slice().reverse().find(r=>r.versionId===id&&r.status==='completed')?.report??'';}
  const leftLines=comparisonText(left).split('\n'),rightLines=comparisonText(right).split('\n');
  const leftLineSet=new Set(leftLines),rightLineSet=new Set(rightLines);
  function pane(versionId: string) {
    const version = data?.versions.find(item => item.id === versionId);
    const preview = data?.runs.slice().reverse().find(run => run.versionId === versionId && run.status === "completed");
    const report = version?.report ?? preview?.report;
    const rule=version?.metadata.ruleBinding as {scope:string;roleId:string|null;day:string}|undefined;
    return version ? <article className="panel tuning-version"><h3>{version.title}</h3><p>{version.kind} · {pacificTime(version.createdAt)}</p>{rule&&<p>Target: {rule.roleId??'Central Council and executive synthesis'} · Inspection day {rule.day}</p>}<p className="quiet">{version.kind === "baseline" ? "Published production baseline" : version.kind === "shadow" ? "Historical shadow output" : "Saved draft, never promoted"}</p>
      {report ? <div className="tuning-report"><ReportBody text={report}/><details><summary>Exact report text</summary><pre>{report}</pre></details></div> : <p>No report yet. Run a private preview of this draft.</p>}
      <details><summary>Instructions and provenance</summary><p>Report SHA256: {version.reportSha256 ?? "No report"}</p>
        {version.instructions.map((item, index) => <details key={index}><summary>{item.label} · {item.availability}</summary>{item.text !== null ? <><p className="quiet">SHA256: {item.sha256}</p><pre>{item.text}</pre></> : <p>{item.gap ?? "The exact historical instruction was not retained."}</p>}</details>)}
        <h4>Evidence, coverage and run metadata</h4><pre>{JSON.stringify(version.metadata, null, 2)}</pre>{preview && <details><summary>Latest completed preview receipt</summary><pre>{JSON.stringify(preview,null,2)}</pre></details>}
      </details><button onClick={() => edit(version.id)}>Use {version.title} as draft starting point</button></article> : <p>Choose a saved version.</p>;
  }
  return <section className="council-tuning" aria-label="Council Tuning" aria-busy={busy}>
    {error && <p role="alert" className="error">{error}</p>}{message && <p role="status">{message}</p>}
    {!data ? <p>Loading Council comparisons…</p> : <>
      <CouncilWorkbench token={token} onSave={body=>act({action:"draft.save",expectedRevision:data.revision,parentId:parent,...body},"Perspective draft version saved. Production is unchanged.")}/>
      <section className="panel"><h2>Compare actual reports</h2><p>This retained A/B/C experiment is from October 2. A is the published Council synthesis, not a separate CEO run. B used four analytical contexts plus synthesis; C also saw A/B. All used codex-primary / gpt-6-astra. Retrieval, context and realized budgets differed; this comparison does not prove causal quality gains. Perspective drafts are labeled with their target below.</p>
        <div className="tuning-selectors"><div><label htmlFor="tuning-left">Left version</label><select id="tuning-left" value={left} onChange={e => setLeft(e.target.value)}>{options}</select></div><div><label htmlFor="tuning-right">Right version</label><select id="tuning-right" value={right} onChange={e => setRight(e.target.value)}>{options}</select></div></div></section>
      <div className="tuning-comparison">{pane(left)}{pane(right)}</div>
      <section className="panel"><h2>Rule and output differences</h2><label htmlFor="tuning-diff">Difference content</label><select id="tuning-diff" value={diffKind} onChange={e=>setDiffKind(e.target.value)}><option value="instructions">Retained instructions / rules</option><option value="output">Actual report output</option></select><p>Compare any two saved versions above, including successive versions of the same perspective. This line-presence comparison shows exact text present only on one side; it does not compare ordering, duplicate counts, or judge coaching quality.</p><details><summary>Inspect exact line differences</summary><div className="tuning-comparison"><article><h3>Only in left version</h3><pre>{leftLines.filter(l=>l&&!rightLineSet.has(l)).join('\n')||'No distinct lines retained.'}</pre></article><article><h3>Only in right version</h3><pre>{rightLines.filter(l=>l&&!leftLineSet.has(l)).join('\n')||'No distinct lines retained.'}</pre></article></div></details></section>
      <section className="panel"><h2>Version a tuning draft</h2><p>Each save creates an immutable version. Saving or previewing leaves the production baseline and nightly schedules unchanged. Starting text copies the selected version's first retained instruction. Its full historical instruction set remains available above.</p>
        <form onSubmit={e => { e.preventDefault(); void act({action: "draft.save", expectedRevision: data.revision, parentId: parent, title, instructions}, "Draft version saved. Production is unchanged."); }}>
          <label htmlFor="tuning-parent">Starting version</label><select id="tuning-parent" value={parent} onChange={e => edit(e.target.value)}>{options}</select>
          <label htmlFor="tuning-title">Draft title</label><input id="tuning-title" value={title} onChange={e => {setTitle(e.target.value);setSaved("");}} required maxLength={120}/>
          <label htmlFor="tuning-instructions">Advisory instructions</label><textarea id="tuning-instructions" rows={14} value={instructions} onChange={e => {setInstructions(e.target.value);setSaved("");}} maxLength={24000} required /><p className="quiet">{instructions.length.toLocaleString()} / 24,000 characters. Edit instructions into advisory preferences for the frozen evidence.</p>
          <button disabled={busy || !title.trim() || !instructions.trim() || instructions.length>24000}>Save new draft version</button>
        </form>
      </section>
      <section className="panel"><h2>Run a bounded private preview</h2><p>{data.previewPolicy.evidence}. {data.previewPolicy.provider} / {data.previewPolicy.model}, {data.previewPolicy.thinking} thinking. One analytical turn, ten-minute deadline, at most 2,000 report words.</p><p>{data.previewPolicy.cost}</p><p>Preview instructions restrict actions; provider permissions govern tool access. The prompt is not an operating-system sandbox. No new evidence is fetched and no recommendations are accepted.</p>
        <label className="tuning-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>Run one private preview with the saved draft and frozen private evidence.</label>
        <button disabled={busy || !saved || !confirmed || !data.previewPolicy.ready || !canPreview || Boolean(active)} onClick={() => {setConfirmed(false);void act({action:"preview.start",expectedRevision:data.revision,versionId:saved,requestId:crypto.randomUUID(),confirmation:"Run one private preview"}, "Preview request recorded. Watch its receipt below.");}}>Run saved draft preview</button>
        {binding&&!canPreview&&<p role="status">This saved perspective draft belongs to a session without a certified frozen preview bundle. No other day's evidence will be substituted.</p>}
        {!data.previewPolicy.ready && <p role="status">Preview transport has not been enabled for this installation.</p>}
        {data.runs.slice().reverse().map(run => <article className="tuning-run" key={run.id}><h3>Preview · {run.status}</h3><p>{pacificTime(run.startedAt)} · Version {data.versions.find(version => version.id === run.versionId)?.title}</p>{run.diagnostic && <p>{run.diagnostic}</p>}{run.status === "running" && <button disabled={busy} onClick={() => void act({action:"preview.cancel",runId:run.id}, "Preview stopped.")}>Stop preview</button>}{run.report && <pre className="tuning-report">{run.report}</pre>}<details><summary>Exact run receipt</summary><pre>{JSON.stringify(run,null,2)}</pre></details></article>)}
      </section>
      <section className="panel"><h2>Production configuration</h2><p>{data.production.promotion}. Council Tuning does not promote drafts. Request an explicit review and deployment when you choose a version.</p><a href="/aubos/council">Return to Council</a></section>
    </>}
  </section>;
}
