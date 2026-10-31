import { useRef, useState } from "react";
import { profileReplica } from "./profile-cache";
import type { ReplicaSnapshot, QueueRow } from "./replica-service";
import { downloadLocalChanges } from "./replica-export";
import { RECORD_FIELDS } from "../../shared/sync-contract.ts";
import type { ResolutionReview } from "./replica-sql";
import { HistoryReview, recoveryOriginLabel } from "./history-review";

const active = (row: QueueRow) => !["accepted", "superseded"].includes(row.status);
const decode = (text?: string) => { try { return text ? JSON.parse(text) : null; } catch { return "Saved details could not be decoded. Export local changes before proceeding."; } };
const labels: Record<string, string> = { goalId: "Linked goal", parentId: "Parent goal", goalIds: "Linked goals", ideaIds: "Linked ideas", pull: "Personal pull", dueOn: "Due date", reviewOn: "Review date" };
const label = (field: string) => labels[field] ?? field.replace(/([A-Z])/g, " $1").replace(/^./, letter => letter.toUpperCase());
function fieldValue(field: string, value: unknown, snapshot: ReplicaSnapshot): string {
  if (value === undefined || value === null || value === "") return "None";
  if (Array.isArray(value)) return value.length ? value.map(item => field === "milestones" && item && typeof item === "object" && "title" in item
    ? `${"done" in item && item.done ? "Done: " : ""}${item.title}` : fieldValue(field, item, snapshot)).join(", ") : "None";
  if (["goalId", "parentId", "goalIds", "ideaIds"].includes(field) && typeof value === "string") {
    const collection = field === "ideaIds" ? snapshot.state?.ideas : snapshot.state?.goals;
    return collection?.find(record => record.id === value)?.title ?? `Unavailable record (${value})`;
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
function stateLabel(row: QueueRow, queue: QueueRow[]) {
  if (row.status === "sending") return "Sending. Server acceptance is not confirmed.";
  if (row.status === "conflict") return "Conflict. Your local version is saved.";
  if (row.status === "failed") return "Needs attention. Your local version is saved.";
  if (row.status === "auth-required") return "Reconnect to renew workspace access.";
  const dependencies = decode(row.dependencies);
  if (Array.isArray(dependencies) && dependencies.some(id => queue.some(required => required.operation_id === id && active(required))))
    return "Saved on this device. Waiting for a linked change.";
  if (queue.some(prior => prior.sequence < row.sequence && prior.kind === row.kind && prior.record_id === row.record_id && active(prior)))
    return "Saved on this device. Waiting for an earlier change.";
  return "Saved on this device. Waiting for server acceptance.";
}

/** Queue visibility follows durable state, never browser reachability. */
export function PendingChanges({ profile, snapshot, reconnect }: { profile: string; snapshot: ReplicaSnapshot; reconnect: () => void }) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{ operationId: string; review: ResolutionReview }>();
  const section = useRef<HTMLElement>(null);
  const pending = snapshot.queue.filter(active);
  async function run(operationId: string, action: () => Promise<unknown>) {
    setBusy(operationId); setError("");
    try { await action(); setConfirm(undefined); }
    catch (cause) { setError((cause as Error).message); }
    finally {
      setBusy(undefined);
      if (document.activeElement === document.body) section.current?.focus();
    }
  }
  return <section ref={section} tabIndex={-1} aria-label="Local changes" className="pending-changes">
    <h3>Local changes</h3>
    <p role="status" aria-live="polite">{pending.length ? `${pending.length} pending ${pending.length === 1 ? "change" : "changes"}${snapshot.syncing ? ". Synchronizing…" : "."}`
      : !snapshot.ready && snapshot.error ? "Local change status is unavailable. Restore device storage before checking synchronization."
        : snapshot.queue.some(row => row.status === "superseded") ? "No pending local changes. Reviewed resolutions remain in recovery history."
        : snapshot.queue.some(row => row.status === "accepted" && row.generation === snapshot.state?.syncGeneration) ? "All local changes have been accepted by the server."
        : snapshot.queue.some(row => row.status === "accepted") ? "No pending local changes. Earlier confirmations remain in recovery history." : "No pending local changes."}</p>
    {snapshot.error && <p role="status">{snapshot.error}</p>}
    <HistoryReview profile={profile} snapshot={snapshot}/>
    {error && <p role="alert">{error}</p>}
    {pending.length > 0 && <ol className="pending-changes-list" aria-label="Pending local changes" tabIndex={0}>
      {pending.map(row => {
        const operation = decode(row.operation);
        const action = operation?.action === "create" ? "Create" : operation?.action === "delete" ? "Delete" : row.kind === "task" && operation?.value?.status === "done" ? "Complete" : "Edit";
        const base = snapshot.serverRows.find(record => record.kind === row.kind && record.id === row.record_id);
        const local = snapshot.rows.find(record => record.kind === row.kind && record.id === row.record_id);
        const earliest = !pending.some(prior => prior.sequence < row.sequence && prior.kind === row.kind && prior.record_id === row.record_id);
        const resolvable = ["conflict", "failed"].includes(row.status) && earliest && !!local && snapshot.ready && !snapshot.historyChanged;
        const chain = pending.filter(other => other.kind === row.kind && other.record_id === row.record_id);
        const review = { serverRevision: base?.revision ?? 0, localRevision: local?.revision ?? 0, queueTail: chain.at(-1)!.operation_id };
        const confirmation = confirm?.operationId === row.operation_id ? confirm : undefined;
        const confirmationCurrent = confirmation && confirmation.review.serverRevision === review.serverRevision &&
          confirmation.review.localRevision === review.localRevision && confirmation.review.queueTail === review.queueTail;
        const localVersion = decode(local?.body);
        const serverVersion = decode(base?.body);
        const fields = RECORD_FIELDS[row.kind as keyof typeof RECORD_FIELDS] ?? [];
        const differences = fields.map(field => ({ field, local: fieldValue(field, localVersion?.[field], snapshot), server: fieldValue(field, serverVersion?.[field], snapshot) })).filter(value => value.local !== value.server);
        const copying = Boolean(localVersion && (!base || base.deleted));
        return <li key={row.operation_id} data-operation-id={row.operation_id}>
          <div className="pending-changes-heading"><strong>{row.title}</strong><span className="pending-changes-operation">{action} {row.kind}</span></div>
          <p>{stateLabel(row, pending)}</p>
          {row.recovery_origin && <p>{recoveryOriginLabel[row.recovery_origin] ?? "Saved history awaiting review"}</p>}
          {row.error && <p className="pending-changes-error">{row.error}</p>}
          <details><summary>Review change</summary>
            <p>Latest local version compared with the last accepted server version. Later queued edits are included.</p>
            {!localVersion && <p>The local record is deleted.</p>}
            {!serverVersion && <p>The server record is absent.</p>}
            {differences.length ? <dl className="pending-changes-differences">{differences.map(value => <div key={value.field}>
              <dt>{label(value.field)}</dt><dd><span>Local:</span> <span>{value.local}</span></dd><dd><span>Server:</span> <span>{value.server}</span></dd>
            </div>)}</dl> : <p>Editable fields match. The record revision or its history may have changed.</p>}
            {localVersion && <p><a href={`/${profile.toLowerCase()}/forge/${row.kind === "idea" ? "ideas" : row.kind === "goal" ? "goals" : "tasks"}#${row.kind}-${row.record_id}`}>Open record</a></p>}
            {resolvable && <>
              <p>Resolve all {pending.filter(other => other.kind === row.kind && other.record_id === row.record_id).length} pending changes to this record together. Original intents stay in recovery history.</p>
              {copying && <p>The server record is absent. Keeping this local version creates a copy; linked records may need review.</p>}
              <div className="pending-changes-actions">
                <button type="button" disabled={!!busy} onClick={() => void run(row.operation_id, () => profileReplica.resolve(profile, row.operation_id, "local", review))}>
                  {copying ? "Create a copy" : localVersion ? "Submit my saved version" : "Keep my deletion"}
                </button>
                <button type="button" disabled={!!busy} onClick={() => setConfirm({ operationId: row.operation_id, review })}>Use server version</button>
              </div>
              {confirmation && <div role="group" aria-label="Confirm using server version">
                <p>This replaces this record’s local projection with the accepted server version and stops its pending changes. Saved intents remain in the recovery export.</p>
                {!confirmationCurrent && <p role="status">The comparison changed. Cancel and review the current versions before confirming.</p>}
                <button type="button" disabled={!!busy || !confirmationCurrent} onClick={() => void run(row.operation_id, () => profileReplica.resolve(profile, row.operation_id, "server", confirmation.review))}>Confirm server version</button>
                <button type="button" onClick={() => setConfirm(undefined)}>Cancel</button>
              </div>}
            </>}
            <details><summary>Operation details</summary><pre>{JSON.stringify(operation, null, 2)}</pre></details>
          </details>
          {row.status === "auth-required" && <button type="button" disabled={!!busy} onClick={reconnect}>Reconnect</button>}
          {row.status === "pending" && row.error && <button type="button" disabled={!!busy || snapshot.syncing || snapshot.historyChanged} onClick={() => void run(row.operation_id, () => profileReplica.retry(profile, row.operation_id))}>Retry this change</button>}
        </li>;
      })}
    </ol>}
    {(!snapshot.ready || snapshot.storageRecovery) && <button type="button" disabled={!!busy} onClick={() => void run("storage", async () => { await profileReplica.hydrate(profile, true); await profileReplica.synchronize(profile, true); })}>Retry device storage</button>}
    {snapshot.serverStorageRecovery && <button type="button" disabled={!!busy || snapshot.verifying} onClick={() => void run("server-storage", () => profileReplica.verifyServerStorage(profile))}>Verify server storage</button>}
    {snapshot.verificationReady && <p role="status">Read-only verification completed. Saved changes have not been sent.</p>}
    <div className="pending-changes-actions">
      {pending.length > 0 && <button type="button" disabled={!!busy || snapshot.syncing} onClick={() => void run("sync", () => profileReplica.synchronize(profile, true))}>Sync changes</button>}
      {(pending.length > 0 || snapshot.error) && <button type="button" disabled={!!busy} onClick={() => void run("export", () => downloadLocalChanges(profile))}>Export changes</button>}
    </div>
  </section>;
}
