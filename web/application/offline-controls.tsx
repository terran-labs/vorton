import { useRef, useState, useSyncExternalStore } from "react";
import { useWorkspaceAccess } from "./offline-context";
import { profileReplica } from "./profile-cache";
import { downloadLocalChanges } from "./replica-export";
import { forgetPwaCode, pwaStatus } from "./pwa-client";

export function OfflineControls({ onReconnect }: { onReconnect: () => void }) {
  const access = useWorkspaceAccess();
  const code = useSyncExternalStore(pwaStatus.subscribe, pwaStatus.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  if (!access.managed || !access.installationId) return null;

  async function clear(all: boolean) {
    const scope = access.scope;
    if (!scope || busy) return;
    setBusy(true); setMessage("");
    try {
      await profileReplica.clearDevice(scope, all);
      if (all) await forgetPwaCode(scope);
      setMessage(all ? "Saved records, drafts and offline code were cleared for this installation. Close Vorton when finished." : "Saved read copies were cleared. Local drafts and save confirmations remain on this device.");
      setConfirmForget(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Device storage is unavailable."); }
    finally { setBusy(false); }
  }
  async function exportChanges() {
    if (!access.profile || busy) return;
    setBusy(true); setMessage("");
    try {
      await downloadLocalChanges(access.profile);
      setMessage("Local recovery export prepared. Keep the downloaded file before forgetting this installation.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function persist() {
    setBusy(true); setMessage("");
    try {
      const granted = await navigator.storage?.persist?.();
      setMessage(granted ? "The browser granted persistent storage. Browser settings can still remove it." : "The browser did not grant persistent storage. Saved data may be removed when storage is needed.");
    } catch { setMessage("Persistent storage is unavailable in this browser."); }
    finally { setBusy(false); }
  }
  return <>
    <button ref={trigger} className="appearance-button" type="button" onClick={() => { setConfirmForget(false); dialog.current?.showModal(); }}>Offline and device storage</button>
    <dialog ref={dialog} aria-labelledby="offline-storage-title" onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }} onClose={() => trigger.current?.focus()} style={{ width: "min(480px, calc(100vw - 32px))", maxHeight: "80dvh", overflow: "auto", boxSizing: "border-box", padding: 24, color: "var(--aub-text)", background: "var(--aub-card-solid)", border: "1px solid var(--aub-border)", borderRadius: 12, fontFamily: "var(--aub-font-body)", whiteSpace: "normal" }}>
      <h2 id="offline-storage-title">Offline and device storage</h2>
      <p role="status">{access.canWrite ? "Connected. Changes can be saved." : access.message ?? (access.status === "reconciling" ? "Checking connection…" : "Offline copy. Connect before saving changes.")}{!access.canWrite && access.verifiedAt ? ` Last connected ${new Date(access.verifiedAt).toLocaleString()}.` : ""}</p>
      {!access.canWrite && <button type="button" onClick={onReconnect}>Reconnect</button>}
      <p role="status">{code.ready ? "Application code is ready for offline reopening." : code.preparing ? "Preparing application code for offline reopening…" : code.error ?? "Application code is not yet ready offline. Reconnect to prepare it."}</p>
      <p>Records and dashboards are saved separately on this device. Only copies successfully saved by this browser are available offline. Unvisited views, external map tiles and live integrations may need a connection.</p>
      <p>Drafts stay local until you choose Save. While Vorton is open, saved offline changes synchronize on reconnect; unsubmitted drafts are never sent automatically.</p>
      {code.updateAvailable && <p>An update is ready. It opens automatically when you are not editing. Save any unfinished edits before reloading.</p>}
      <p>On iPhone, use Share → Add to Home Screen, then open Vorton from its icon.</p>
      {!access.scope && <p>Saved storage is unavailable or has been forgotten. Reconnect to enable it again.</p>}
      {message && <p role="status">{message}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {typeof navigator.storage?.persist === "function" && <button type="button" disabled={busy || !access.scope} onClick={() => void persist()}>Request persistent storage</button>}
        <button type="button" disabled={busy || !access.scope} onClick={() => void clear(false)}>Clear saved read copies</button>
        <button type="button" disabled={busy || !access.scope} onClick={() => setConfirmForget(true)}>Forget this installation</button>
      </div>
      {confirmForget && <section aria-label="Confirm forgetting local data"><p>This deletes this installation’s saved records, drafts and pending changes in every workspace from this browser. Export unsent work first if you want to keep it. Server records stay intact; changes already sent may still be accepted.</p><button type="button" disabled={busy || !access.profile} onClick={() => void exportChanges()}>Export local changes</button><button type="button" disabled={busy} onClick={() => void clear(true)}>Forget saved records and drafts</button><button type="button" disabled={busy} onClick={() => setConfirmForget(false)}>Cancel</button></section>}
      <p><button type="button" onClick={() => dialog.current?.close()}>Close</button></p>
    </dialog>
  </>;
}
