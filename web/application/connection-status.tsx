import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { checkConnection, type ConnectionResult } from "./connection-check";
import { checkPwaUpdate, pwaStatus } from "./pwa-client";
import { useWorkspaceAccess } from "./offline-context";
import { useReplica } from "./use-replica";
import { PendingChanges } from "./pending-changes";
import { observeUpdateSafety, type UpdateSafety } from "./update-safety";
import "./connection-status.css";

export function ConnectionStatus({ onReconnect }: { href: string; onReconnect: (explicit?: boolean) => void }) {
  const access = useWorkspaceAccess();
  const replica = useReplica(access.profile ?? "");
  const code = useSyncExternalStore(pwaStatus.subscribe, pwaStatus.getSnapshot);
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const [safety, setSafety] = useState<UpdateSafety>({ edited: false, blocked: true });
  const safetyNow = useRef(safety);
  const edited = safety.edited;
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const pending = useRef<Promise<void> | undefined>(undefined);
  const reconnect = useRef(onReconnect); reconnect.current = onReconnect;
  const previousReachable = useRef<boolean | undefined>(undefined);
  const offline = result ? !result.reachable : !browserOnline;
  const reloadReady = code.needsNavigation || (code.codeReady ?? code.ready) && Boolean(code.shellId && code.shellId !== document.querySelector('meta[name="vorton-shell"]')?.getAttribute("content"));

  function testConnection(explicit = false) {
    if (pending.current) return pending.current;
    const ticket = ++generation.current;
    setBusy(true);
    const task = checkConnection().then(next => {
      if (ticket !== generation.current) return;
      const recovered = previousReachable.current === false && next.admitted;
      previousReachable.current = next.reachable;
      setResult(next); setBrowserOnline(next.browserOnline);
      if (next.admitted && (explicit || recovered)) reconnect.current(explicit);
      if (next.reachable) void checkPwaUpdate().catch(() => {});
    }).finally(() => {
      if (ticket === generation.current) { setBusy(false); pending.current = undefined; }
    });
    pending.current = task;
    return task;
  }

  useEffect(() => {
    void testConnection();
    const foreground = () => { if (document.visibilityState !== "hidden") void testConnection(); };
    const disconnected = () => {
      generation.current++; pending.current = undefined; previousReachable.current = false;
      setResult(null); setBrowserOnline(false); setBusy(false);
    };
    window.addEventListener("offline", disconnected);
    window.addEventListener("online", foreground);
    document.addEventListener("visibilitychange", foreground);
    const timer = setInterval(foreground, 30_000);
    return () => {
      generation.current++; clearInterval(timer);
      window.removeEventListener("offline", disconnected); window.removeEventListener("online", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, []);

  useEffect(() => observeUpdateSafety(next => {
    safetyNow.current = next;
    setSafety(previous => previous.edited === next.edited && previous.blocked === next.blocked ? previous : next);
  }), []);

  useEffect(() => {
    if (!code.updateAvailable || !reloadReady || edited || safety.blocked || offline || open) return;
    const timer = setTimeout(() => {
      if (safetyNow.current.edited || safetyNow.current.blocked || document.visibilityState === "hidden") return;
      const from = document.querySelector('meta[name="vorton-shell"]')?.getAttribute("content");
      const to = code.needsNavigation ? "legacy-migration" : code.shellId;
      if (!from || from === to) return;
      const key = "vorton-auto-update";
      try {
        const previous = JSON.parse(sessionStorage.getItem(key) ?? "null");
        if (previous?.from === from && previous?.to === to && Date.now() - previous.at < 300_000) return;
        sessionStorage.setItem(key, JSON.stringify({ from, to, at: Date.now() }));
      } catch { return; /* Without a loop guard, offer the explicit update action. */ }
      location.reload();
    }, 500);
    return () => clearTimeout(timer);
  }, [code.updateAvailable, reloadReady, code.shellId, code.needsNavigation, edited, safety.blocked, offline, open]);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  if (!offline && !code.updateAvailable && !code.error && !replica.pending && !replica.error && !replica.historyChanged && !open && !visited) return null;
  const label = offline ? browserOnline ? "Cannot reach Vorton. Connection details" : "Offline. Connection details" : replica.historyChanged ? "Restored history needs review" : replica.pending ? `${replica.pending} pending local changes. Sync details` : replica.error ? "Local storage needs attention" : code.error ? "Offline update needs attention" : code.updateAvailable ? "Update ready. Update details" : "Connection details";
  return <div className="connection-status">
    {open && <div id="connection-status-panel" className="connection-status-panel" ref={panel} role="dialog" aria-labelledby="connection-status-title" tabIndex={-1}
      onKeyDown={event => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } }}>
      <h2 id="connection-status-title">{offline ? browserOnline ? "Cannot reach Vorton" : "You’re offline" : "Connection and updates"}</h2>
      <p>{offline ? replica.ready && !replica.historyChanged ? "Edits save on this device and wait for server acceptance." : "Saved content and local drafts remain available. Device storage must be ready before saving records offline." : "Vorton is reachable."}</p>
      {access.profile && <PendingChanges key={replica.scope ?? access.profile} profile={access.profile} snapshot={replica} reconnect={() => onReconnect(true)}/>}
      <dl>
        <dt>Browser connection</dt><dd>{browserOnline ? "Reports online" : "Reports offline"}</dd>
        <dt>Vorton server</dt><dd>{result?.serverMessage ?? "Not tested yet"}</dd>
        <dt>Workspace access</dt><dd>{result?.sessionMessage ?? "Not tested yet"}</dd>
        <dt>Running version</dt><dd>{code.runningVersion ?? "Version unavailable"}</dd>
        <dt>Prepared version</dt><dd>{code.availableVersion ?? "Not checked yet"}</dd>
        <dt>Offline access</dt><dd>{code.ready ? "Ready" : code.preparing ? "Preparing" : "Incomplete"}{Boolean(code.pendingAssets) && ` · ${code.pendingAssets} files remaining`}</dd>
        <dt>Local records</dt><dd>{replica.historyChanged ? "Saved records awaiting history review" : replica.ready ? "Ready for offline editing" : "Device storage needs preparation"}</dd>
      </dl>
      {result && <p className="connection-status-time">Checked {new Date(result.checkedAt).toLocaleTimeString()} · {result.elapsedMs} ms</p>}
      {offline && <p>Check Wi-Fi or mobile data and your private network connection. A browser can report online while Vorton is unreachable.</p>}
      <button type="button" disabled={busy} onClick={() => void testConnection(true)}>{busy ? "Testing connection…" : "Test connection and retry"}</button>
      {code.error && <section role="status"><p>{code.error}</p><button type="button" onClick={() => void checkPwaUpdate()}>Retry offline update</button></section>}
      {code.updateAvailable && <section><p>{reloadReady ? `A new version is ready.${edited ? " Finish or save your edits before reloading." : " Reload to use it now."}` : "An update is finishing installation."}</p><button type="button" disabled={!reloadReady || edited} onClick={() => location.reload()}>Reload with update</button></section>}
      <button type="button" className="connection-status-close" onClick={() => { setOpen(false); trigger.current?.focus(); }}>Close</button>
    </div>}
    <button ref={trigger} type="button" className={`connection-status-button${offline ? " is-offline" : " is-update"}`} aria-label={label} title={label} aria-expanded={open} aria-haspopup="dialog" aria-controls="connection-status-panel"
      onClick={() => { setVisited(true); setOpen(value => !value); if (!open) void testConnection(); }}>
      {offline ? <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m3 3 18 18M5 9a12 12 0 0 0-2 2m5 3a6 6 0 0 0-2 1m5 4h2M9 5a14 14 0 0 1 12 6m-7 0a7 7 0 0 1 4 4"/></svg>
        : <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg>}
      {replica.pending > 0 && <span className="connection-status-count" aria-hidden="true">{replica.pending}</span>}
    </button>
  </div>;
}
