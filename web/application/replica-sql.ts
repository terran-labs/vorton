import { canonicalJson, parseSyncOperation, SYNC_PROTOCOL, RECORD_FIELDS, type SyncOperation } from "../../shared/sync-contract.ts";
import { editableRecord, planHistoryRecovery } from "./replica-recovery.ts";

type Cell = string | number | null;
export type SqlRow = Record<string, Cell>;
export interface ReplicaSql {
  run(sql: string, parameters?: Cell[]): void;
  all(sql: string, parameters?: Cell[]): SqlRow[];
}
type Entity = Record<string, unknown> & { id: string };
export type RemoteChange = { cursor: number; kind: string; id: string; revision: number; deleted: boolean; value: unknown };
export type RemoteFeed = { protocol: string; generation: string; cursor: number; head?: number; changes: RemoteChange[] };
export type LocalStatus = "pending" | "sending" | "auth-required" | "failed";
export type DeviceEpoch = { readEpoch: number; draftEpoch: number };
export type ResolutionReview = { serverRevision: number; localRevision: number; queueTail: string };
export type IdentityReview = { id: string; generation: string; localRevision: number; version: number };
const kinds = ["task", "goal", "idea"];
export class LocalReplicaError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function check(condition: unknown, message: string, code = "invalid"): asserts condition { if (!condition) throw new LocalReplicaError(code, message); }
const entity = (value: unknown, id: string): value is Entity => Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Entity).id === id);

/** SQL shared by the browser worker and real SQLite transaction tests. This
 * module has no browser, network, filesystem or credential dependencies. */
export class LocalReplica {
  private sql: ReplicaSql;
  constructor(sql: ReplicaSql) { this.sql = sql; }
  private transaction<T>(change: () => T): T {
    this.sql.run("BEGIN IMMEDIATE");
    try { const result = change(); this.sql.run("COMMIT"); return result; }
    catch (error) { this.sql.run("ROLLBACK"); throw error; }
  }
  initialize() {
    this.transaction(() => {
      this.sql.run("CREATE TABLE IF NOT EXISTS local_schema(version INTEGER NOT NULL)");
      const schemas = this.sql.all("SELECT version FROM local_schema");
      check(schemas.length <= 1 && schemas.every(row => [1, 2, 3, 4, 5, 6, 7, 8].includes(Number(row.version))), "Device storage needs a newer Vorton version. Local work remains saved.");
      const schema = schemas[0];
      this.sql.run("CREATE TABLE IF NOT EXISTS local_records(scope TEXT, kind TEXT, id TEXT, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,kind,id))");
      this.sql.run(`CREATE TABLE IF NOT EXISTS outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
        operation_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, title TEXT NOT NULL,
        operation TEXT NOT NULL, status TEXT NOT NULL, error TEXT, receipt TEXT, generation TEXT,
        dependencies TEXT NOT NULL DEFAULT '[]', UNIQUE(scope,operation_id))`);
      // Additive upgrade from the initial worker. Never rename or clear its
      // stable database, local records or unacknowledged operations.
      const localColumns = this.sql.all("PRAGMA table_info(local_records)").map(row => row.name);
      if (!localColumns.includes("revision")) {
        this.sql.run("ALTER TABLE local_records ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
        this.sql.run(`UPDATE local_records SET revision=COALESCE((SELECT MAX(json_extract(operation,'$.expectedRevision')+1)
          FROM outbox WHERE outbox.scope=local_records.scope AND outbox.kind=local_records.kind AND record_id=local_records.id),0)`);
      }
      const columns = this.sql.all("PRAGMA table_info(outbox)").map(row => row.name);
      if (!columns.includes("receipt")) this.sql.run("ALTER TABLE outbox ADD COLUMN receipt TEXT");
      if (!columns.includes("generation")) this.sql.run("ALTER TABLE outbox ADD COLUMN generation TEXT");
      if (!columns.includes("dependencies")) this.sql.run("ALTER TABLE outbox ADD COLUMN dependencies TEXT NOT NULL DEFAULT '[]'");
      if (!columns.includes("recovery_origin")) this.sql.run("ALTER TABLE outbox ADD COLUMN recovery_origin TEXT");
      if (!columns.includes("local_version")) {
        this.sql.run("ALTER TABLE outbox ADD COLUMN local_version INTEGER");
        this.sql.run(`UPDATE outbox SET local_version=COALESCE(json_extract(receipt,'$.value.version'),
          CASE WHEN NOT EXISTS(SELECT 1 FROM outbox AS later WHERE later.scope=outbox.scope AND later.kind=outbox.kind AND later.record_id=outbox.record_id AND later.sequence>outbox.sequence)
          THEN (SELECT json_extract(body,'$.version') FROM local_records WHERE local_records.scope=outbox.scope AND local_records.kind=outbox.kind AND local_records.id=outbox.record_id) END)`);
      }
      this.sql.run("CREATE TABLE IF NOT EXISTS server_records(scope TEXT, kind TEXT, id TEXT, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,kind,id))");
      this.sql.run("CREATE TABLE IF NOT EXISTS workspace_meta(scope TEXT PRIMARY KEY, profile TEXT NOT NULL, body TEXT NOT NULL, generation TEXT, cursor INTEGER NOT NULL DEFAULT 0, download_head INTEGER NOT NULL DEFAULT 0, verified_at INTEGER NOT NULL DEFAULT 0)");
      const metadataColumns = this.sql.all("PRAGMA table_info(workspace_meta)").map(row => row.name);
      if (!metadataColumns.includes("download_head")) {
        this.sql.run("ALTER TABLE workspace_meta ADD COLUMN download_head INTEGER NOT NULL DEFAULT 0");
        this.sql.run("UPDATE workspace_meta SET download_head=cursor");
      }
      if (!metadataColumns.includes("verified_at")) this.sql.run("ALTER TABLE workspace_meta ADD COLUMN verified_at INTEGER NOT NULL DEFAULT 0");
      this.sql.run("CREATE TABLE IF NOT EXISTS workspace_staging(scope TEXT PRIMARY KEY, profile TEXT NOT NULL, body TEXT NOT NULL, generation TEXT NOT NULL, verified_at INTEGER NOT NULL)");
      this.sql.run("CREATE TABLE IF NOT EXISTS device_epochs(installation TEXT PRIMARY KEY, read_epoch INTEGER NOT NULL, draft_epoch INTEGER NOT NULL)");
      this.sql.run("CREATE TABLE IF NOT EXISTS local_resolutions(scope TEXT, operation_id TEXT, resolution_id TEXT NOT NULL, choice TEXT NOT NULL, server_revision INTEGER NOT NULL, PRIMARY KEY(scope,operation_id))");
      const resolutionColumns = this.sql.all("PRAGMA table_info(local_resolutions)").map(row => row.name);
      if (!resolutionColumns.includes("local_revision")) this.sql.run("ALTER TABLE local_resolutions ADD COLUMN local_revision INTEGER");
      if (!resolutionColumns.includes("queue_tail")) this.sql.run("ALTER TABLE local_resolutions ADD COLUMN queue_tail TEXT");
      if (!resolutionColumns.includes("outcome")) this.sql.run("ALTER TABLE local_resolutions ADD COLUMN outcome TEXT");
      this.sql.run(`CREATE TABLE IF NOT EXISTS history_reviews(scope TEXT PRIMARY KEY, review_id TEXT NOT NULL,
        profile TEXT NOT NULL, generation TEXT NOT NULL, head INTEGER NOT NULL, cursor INTEGER NOT NULL,
        body TEXT NOT NULL, verified_at INTEGER NOT NULL)`);
      this.sql.run(`CREATE TABLE IF NOT EXISTS history_candidates(scope TEXT, kind TEXT, id TEXT, revision INTEGER NOT NULL,
        deleted INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,kind,id))`);
      this.sql.run(`CREATE TABLE IF NOT EXISTS history_adoptions(scope TEXT, request_id TEXT, comparison TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY(scope,request_id))`);
      this.sql.run("CREATE TABLE IF NOT EXISTS history_epochs(scope TEXT PRIMARY KEY, counter INTEGER NOT NULL)");
      this.sql.run("CREATE TABLE IF NOT EXISTS history_identity(scope TEXT PRIMARY KEY, profile TEXT NOT NULL, generation TEXT NOT NULL)");
      this.sql.run("INSERT OR IGNORE INTO history_identity SELECT scope,profile,generation FROM workspace_meta WHERE generation IS NOT NULL");
      // Earlier development schemas could clear metadata while retaining
      // receipts. An adoption receipt, or one unambiguous operation generation,
      // can retain that identity without inventing a record snapshot.
      for (const row of this.sql.all("SELECT DISTINCT scope FROM outbox UNION SELECT DISTINCT scope FROM history_adoptions")) {
        if (this.sql.all("SELECT 1 FROM history_identity WHERE scope=?", [row.scope]).length) continue;
        const adoption = this.sql.all("SELECT json_extract(result,'$.generation') AS generation FROM history_adoptions WHERE scope=? ORDER BY json_extract(result,'$.counter') DESC LIMIT 1", [row.scope])[0];
        const generations = this.sql.all("SELECT DISTINCT generation FROM outbox WHERE scope=? AND generation IS NOT NULL", [row.scope]);
        const generation = adoption?.generation ?? (generations.length === 1 ? generations[0].generation : null);
        const profile = String(row.scope).split("/").at(-2);
        if (generation && profile && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(profile))
          this.sql.run("INSERT INTO history_identity VALUES(?,?,?)", [row.scope, profile, generation]);
      }
      this.sql.run("CREATE TABLE IF NOT EXISTS history_attempts(scope TEXT, operation_id TEXT, recovery_id TEXT NOT NULL, PRIMARY KEY(scope,operation_id))");
      this.sql.run(`CREATE TABLE IF NOT EXISTS record_identities(scope TEXT, kind TEXT, source_id TEXT, source_generation TEXT,
        target_id TEXT NOT NULL, target_generation TEXT NOT NULL, PRIMARY KEY(scope,kind,source_id,source_generation))`);
      if (!schema) this.sql.run("INSERT INTO local_schema VALUES(8)");
      else if (schema.version !== 8) this.sql.run("UPDATE local_schema SET version=8");
    });
  }
  private device(scope: string, epoch: DeviceEpoch) {
    const parts = scope.split("/");
    check(parts.length >= 3 && parts.every(Boolean) && epoch && [epoch.readEpoch, epoch.draftEpoch].every(value => Number.isSafeInteger(value) && value >= 0), "Invalid device storage epoch.");
    const installation = parts.slice(0, -2).join("/");
    return { installation, current: this.sql.all("SELECT * FROM device_epochs WHERE installation=?", [installation])[0] };
  }
  authorize(scope: string, epoch: DeviceEpoch) {
    const { installation, current } = this.device(scope, epoch);
    check(!current || current.read_epoch === epoch.readEpoch && current.draft_epoch === epoch.draftEpoch,
      "Device storage was cleared in another window. Reopen storage controls to finish clearing, then reconnect.", "obsolete-device");
    if (!current) this.sql.run("INSERT INTO device_epochs VALUES(?,?,?)", [installation, epoch.readEpoch, epoch.draftEpoch]);
  }
  exportDevice(scope: string) {
    const prefix = scope.split("/").slice(0, -2).join("/") + "/";
    return Object.fromEntries(["local_records", "server_records", "workspace_meta", "workspace_staging", "outbox", "local_resolutions", "history_reviews", "history_candidates", "history_adoptions", "history_epochs", "history_identity", "history_attempts", "record_identities"].map(table =>
      [table, this.sql.all(`SELECT * FROM ${table} WHERE substr(scope,1,length(?))=?`, [prefix, prefix])]));
  }
  clearDevice(scope: string, epoch: DeviceEpoch, all: boolean) {
    return this.transaction(() => {
      const { installation, current } = this.device(scope, epoch);
      const next = { readEpoch: epoch.readEpoch + 1, draftEpoch: epoch.draftEpoch + (all ? 1 : 0) };
      check(Number.isSafeInteger(next.readEpoch) && Number.isSafeInteger(next.draftEpoch), "Device storage epoch is exhausted.");
      // A second attempt completes the IndexedDB half after a prior SQLite
      // clear. It must never delete work created after the first attempt.
      if (current?.read_epoch === next.readEpoch && current.draft_epoch === next.draftEpoch) return next;
      check(!current || current.read_epoch === epoch.readEpoch && current.draft_epoch === epoch.draftEpoch,
        "Storage changed in another window. Reopen these controls.", "obsolete-device");
      const prefix = installation + "/";
      if (!all) check(!this.sql.all("SELECT 1 FROM history_reviews WHERE substr(scope,1,length(?))=? LIMIT 1", [prefix, prefix]).length,
        "A restored history is awaiting review. Finish reviewing it before clearing saved reads; recovery downloads remain available.", "history-changed");
      if (!all) check(!this.sql.all("SELECT 1 FROM outbox WHERE substr(scope,1,length(?))=? AND status NOT IN ('accepted','superseded') LIMIT 1", [prefix, prefix]).length,
        "Pending local changes remain on this device. Synchronize them before clearing saved reads, or export them before explicitly forgetting this installation.");
      // Retained drafts can still refer to accepted operations whose local
      // confirmation was lost. Read clearing must preserve that recovery log.
      for (const table of ["local_records", "server_records", "workspace_meta", "workspace_staging", ...(all ? ["outbox", "local_resolutions", "history_reviews", "history_candidates", "history_adoptions", "history_epochs", "history_identity", "history_attempts", "record_identities"] : [])])
        this.sql.run(`DELETE FROM ${table} WHERE substr(scope,1,length(?))=?`, [prefix, prefix]);
      this.sql.run("INSERT INTO device_epochs VALUES(?,?,?) ON CONFLICT(installation) DO UPDATE SET read_epoch=excluded.read_epoch,draft_epoch=excluded.draft_epoch", [installation, next.readEpoch, next.draftEpoch]);
      return next;
    });
  }
  private requireCurrentHistory(scope: string) {
    check(!this.sql.all("SELECT 1 FROM history_reviews WHERE scope=?", [scope]).length,
      "A restored server history is awaiting review. Your saved local work remains available.", "history-changed");
  }
  /** Replacement records never enter the current projection during download.
   * The durable marker also fences callers that bypass the service's pause. */
  beginHistoryReview(scope: string, profile: string, state: Record<string, unknown>, reviewId: string, replaceReviewId?: string) {
    check(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(reviewId), "Invalid history review identity.");
    check(state.profile === profile && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(profile) &&
      Number.isSafeInteger(state.revision) && Number(state.revision) >= 0 && typeof state.syncGeneration === "string" && state.syncGeneration.length > 0 &&
      typeof state.syncCursor === "number" && Number.isSafeInteger(state.syncCursor) && state.syncCursor >= 0,
    "A restored history needs verified metadata and a captured record boundary.");
    const generation = state.syncGeneration, head = state.syncCursor;
    return this.transaction(() => {
      const current = this.sql.all("SELECT profile,generation FROM workspace_meta WHERE scope=? UNION ALL SELECT profile,generation FROM history_identity WHERE scope=? LIMIT 1", [scope, scope])[0];
      check(current?.profile === profile && current.generation && current.generation !== state.syncGeneration,
        "Compare restored history with the original saved workspace before adopting it.");
      check(!this.sql.all(`SELECT 1 FROM history_adoptions WHERE scope=? AND
        (json_extract(result,'$.generation')=? OR json_extract(comparison,'$.workspace_meta[0].generation')=?
          OR json_extract(comparison,'$.history_identity[0].generation')=?) LIMIT 1`, [scope, generation, generation, generation]).length,
      "This server reused an earlier history identity. Finish server recovery with a fresh history identity before reviewing it.", "history-changed");
      const body = canonicalJson({ ...state, goals: [], tasks: [], ideas: [] });
      const prior = this.sql.all("SELECT * FROM history_reviews WHERE scope=?", [scope])[0];
      if (replaceReviewId !== undefined) {
        check(prior?.review_id === replaceReviewId && reviewId !== replaceReviewId,
          "The restored-history comparison changed. Reopen it before restarting.");
        // Candidate downloads contain no new local intent. Replace only this
        // explicitly reviewed download; original records and proof stay intact.
        this.sql.run("DELETE FROM history_candidates WHERE scope=?", [scope]);
        this.sql.run("DELETE FROM history_reviews WHERE scope=?", [scope]);
      }
      if (prior && replaceReviewId === undefined) {
        check(prior.review_id === reviewId && prior.body === body, "A different restored history is already awaiting review. Resume that review first.");
        return;
      }
      this.sql.run("INSERT INTO history_reviews VALUES(?,?,?,?,?,0,?,?)",
        [scope, reviewId, profile, generation, head, body, Date.now()]);
    });
  }
  pullHistoryReview(scope: string, reviewId: string, after: number, feed: RemoteFeed) {
    return this.transaction(() => {
      const review = this.sql.all("SELECT * FROM history_reviews WHERE scope=?", [scope])[0];
      check(review?.review_id === reviewId, "Reopen the current restored-history review.");
      check(feed.protocol === SYNC_PROTOCOL && feed.generation === review.generation && feed.head === review.head,
        "The restored history download changed identity or boundary. Keep local work and restart the comparison.", "history-changed");
      check(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(feed.cursor) && feed.cursor >= after && feed.cursor <= Number(review.head) && Array.isArray(feed.changes),
        "Invalid restored-history page.");
      check(feed.cursor > after || after === review.head, "Restored-history download made no progress. Keep local work and retry.");
      if (after !== review.cursor) {
        check(feed.cursor <= Number(review.cursor), "A restored-history page arrived before its predecessor.");
        return;
      }
      let cursor = after;
      for (const change of feed.changes) {
        check(kinds.includes(change.kind) && typeof change.id === "string" && change.id.length > 0 &&
          Number.isSafeInteger(change.cursor) && change.cursor > cursor && change.cursor <= feed.cursor &&
          Number.isSafeInteger(change.revision) && change.revision > 0 && typeof change.deleted === "boolean" &&
          (change.deleted ? change.value === null : entity(change.value, change.id)), "Invalid restored-history record.");
        const body = canonicalJson(change.value);
        const prior = this.sql.all("SELECT * FROM history_candidates WHERE scope=? AND kind=? AND id=?", [scope, change.kind, change.id])[0];
        check(!prior || Number(prior.revision) < change.revision || prior.revision === change.revision && prior.body === body && prior.deleted === Number(change.deleted),
          "A restored-history record changed without advancing its revision.");
        this.sql.run(`INSERT INTO history_candidates VALUES(?,?,?,?,?,?) ON CONFLICT(scope,kind,id)
          DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,body=excluded.body`,
        [scope, change.kind, change.id, change.revision, Number(change.deleted), body]);
        cursor = change.cursor;
      }
      check(cursor === feed.cursor, "Restored-history cursor does not match its records.");
      this.sql.run("UPDATE history_reviews SET cursor=? WHERE scope=?", [cursor, scope]);
    });
  }
  private historyBaseline(scope: string, reviewId: string) {
      const review = this.sql.all("SELECT * FROM history_reviews WHERE scope=?", [scope])[0];
      check(review?.review_id === reviewId && review.cursor === review.head, "Finish downloading restored history before reviewing it.");
      // Include receipts and resolutions, not only visible records. A late
      // acknowledgement invalidates a comparison even if its title is equal.
      const baseline = Object.fromEntries(["local_records", "server_records", "workspace_meta", "workspace_staging", "outbox", "local_resolutions", "history_reviews", "history_candidates", "history_epochs", "history_identity", "history_attempts", "record_identities"].map(table =>
        [table, this.sql.all(`SELECT * FROM ${table} WHERE scope=? ORDER BY rowid`, [scope])]));
      return { review, baseline, comparison: canonicalJson(baseline) };
  }
  historyComparison(scope: string, reviewId: string) {
    return this.transaction(() => {
      const captured = this.historyBaseline(scope, reviewId);
      return { ...captured, differences: planHistoryRecovery(captured.baseline).proposals.map(({ saved, local, server, title, origin }) =>
        ({ kind: saved.kind, id: saved.id, title, origin, local: editableRecord(saved.kind, local), server: editableRecord(saved.kind, server) })) };
    });
  }
  historyAdoption(scope: string, requestId: string) {
    const row = this.sql.all("SELECT result FROM history_adoptions WHERE scope=? AND request_id=?", [scope, requestId])[0];
    return row ? JSON.parse(String(row.result)) as { reviewId: string; generation: string; counter: number; recoveries: number } : null;
  }
  /** This commit only prepares blocked recovery proposals. It never changes
   * an old intent into a sendable operation. The caller must freshly verify
   * the server generation before asking to adopt this complete comparison. */
  adoptHistoryReview(scope: string, reviewId: string, requestId: string, comparison: string, verifiedGeneration: string) {
    check(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId) && typeof comparison === "string" && comparison.length > 0,
      "Invalid restored-history confirmation.");
    return this.transaction(() => {
      const prior = this.sql.all("SELECT * FROM history_adoptions WHERE scope=? AND request_id=?", [scope, requestId])[0];
      if (prior) {
        const result = JSON.parse(String(prior.result)) as { reviewId: string; generation: string; counter: number; recoveries: number };
        check(prior.comparison === comparison && result.reviewId === reviewId && result.generation === verifiedGeneration,
          "This history confirmation identity was already used for another comparison.");
        return result;
      }
      const captured = this.historyBaseline(scope, reviewId), { review, baseline } = captured;
      check(review.generation === verifiedGeneration, "Server history changed again. Review the latest history before adopting it.", "history-changed");
      check(captured.comparison === comparison, "Saved history changed during review. Compare the latest versions before confirming.");
      const counter = Number(baseline.history_epochs[0]?.counter ?? 0) + 1;
      check(Number.isSafeInteger(counter), "Device history review counter is exhausted.");
      const oldGeneration = baseline.workspace_meta[0]?.generation ?? baseline.history_identity[0]?.generation;
      this.sql.run("UPDATE outbox SET status='superseded',error='Preserved in restored-history recovery. Review the replacement proposal before sending.' WHERE scope=? AND status NOT IN ('accepted','superseded')", [scope]);
      for (const table of ["local_records", "server_records", "workspace_meta", "workspace_staging"])
        this.sql.run(`DELETE FROM ${table} WHERE scope=?`, [scope]);
      this.sql.run("INSERT INTO server_records SELECT * FROM history_candidates WHERE scope=?", [scope]);
      this.sql.run("INSERT INTO local_records(scope,kind,id,body,revision) SELECT scope,kind,id,body,revision FROM history_candidates WHERE scope=?", [scope]);
      this.sql.run("INSERT INTO workspace_meta(scope,profile,body,generation,cursor,download_head,verified_at) VALUES(?,?,?,?,?,?,?)",
        [scope, review.profile, review.body, review.generation, review.head, review.head, review.verified_at]);
      this.sql.run("INSERT INTO history_identity VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET profile=excluded.profile,generation=excluded.generation",
        [scope, review.profile, review.generation]);
      const plan = planHistoryRecovery(baseline);
      let recoveries = 0;
      for (const saved of plan.sources)
        this.sql.run("INSERT INTO record_identities VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
          [scope, saved.kind, saved.id, oldGeneration ?? null, saved.id, review.generation]);
      for (const { saved, local, revision, title, origin } of plan.proposals) {
        const operationId = crypto.randomUUID();
        // A missing historical record may use a pre-UUID identity. The blocked
        // proposal is an update; explicit resolution creates a new UUID copy.
        const operation = parseSyncOperation({ operationId, kind: saved.kind, id: saved.id, expectedRevision: revision,
          action: local ? "update" : "delete", ...(local ? { value: editableRecord(saved.kind, local) } : {}) });
        this.sql.run(`INSERT INTO outbox(scope,operation_id,kind,record_id,title,operation,status,error,generation,dependencies,local_version,recovery_origin)
          VALUES(?,?,?,?,?,?,'conflict',?,?,'[]',?,?)`, [scope, operationId, saved.kind, saved.id, String(title), canonicalJson(operation),
          "Saved history differs from the restored server. Review its origin and both versions before choosing.", review.generation, local?.version ?? null, origin]);
        this.local(scope, saved.kind, saved.id, saved.body, revision + 1);
        for (const original of saved.proof) this.sql.run("INSERT INTO history_attempts VALUES(?,?,?) ON CONFLICT DO NOTHING",
          [scope, original.operation_id, operationId]);
        recoveries++;
      }
      this.sql.run("INSERT INTO history_epochs VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET counter=excluded.counter", [scope, counter]);
      const result = { reviewId, generation: String(review.generation), counter, recoveries };
      this.sql.run("INSERT INTO history_adoptions VALUES(?,?,?,?)", [scope, requestId, comparison, canonicalJson(result)]);
      this.sql.run("DELETE FROM history_candidates WHERE scope=?", [scope]);
      this.sql.run("DELETE FROM history_reviews WHERE scope=?", [scope]);
      return result;
    });
  }
  private identity(scope: string, kind: string, id: string, generation: string) {
    const seen = new Set<string>();
    while (true) {
      const key = canonicalJson([id, generation]);
      check(!seen.has(key), "Saved record identity contains a cycle. Export recovery data before proceeding.");
      seen.add(key);
      const next = this.sql.all("SELECT * FROM record_identities WHERE scope=? AND kind=? AND source_id=? AND source_generation=?", [scope, kind, id, generation])[0];
      if (!next) return { id, generation };
      id = String(next.target_id); generation = String(next.target_generation);
    }
  }
  resolveRecordIdentity(scope: string, kind: string, id: string, generation: string) {
    check(kinds.includes(kind) && typeof id === "string" && id.length > 0 && typeof generation === "string" && generation.length > 0, "Invalid saved record identity.");
    return this.transaction(() => this.identity(scope, kind, id, generation));
  }
  reviewRecordIdentity(scope: string, kind: string, id: string, generation: string, review: IdentityReview) {
    check(kinds.includes(kind) && typeof id === "string" && id.length > 0 && typeof generation === "string" && generation.length > 0 &&
      review && typeof review.id === "string" && review.id.length > 0 && typeof review.generation === "string" && review.generation.length > 0 &&
      Number.isSafeInteger(review.localRevision) && review.localRevision >= 0 && Number.isSafeInteger(review.version) && review.version >= 0,
    "Invalid retained-draft record review.");
    return this.transaction(() => {
      this.requireCurrentHistory(scope);
      const resolved = this.identity(scope, kind, id, generation);
      const metadata = this.sql.all("SELECT generation,cursor,download_head FROM workspace_meta WHERE scope=?", [scope])[0];
      const local = this.sql.all("SELECT body,revision FROM local_records WHERE scope=? AND kind=? AND id=?", [scope, kind, resolved.id])[0];
      check(resolved.id === review.id && resolved.generation === review.generation && metadata?.generation === review.generation &&
        Number(metadata.cursor) >= Number(metadata.download_head) && local && local.body !== "null" && local.revision === review.localRevision &&
        JSON.parse(String(local.body)).version === review.version,
      "The record changed during draft review. Review the latest copy before using this draft.");
      return resolved;
    });
  }
  recoverAttempt(scope: string, operationId: string) {
    return this.transaction(() => {
      const original = this.sql.all("SELECT * FROM outbox WHERE scope=? AND operation_id=?", [scope, operationId])[0];
      check(original, "The original local attempt is unavailable. Keep the draft and export recovery data before starting another record.");
      let saved = original, disposition = "saved";
      const seen = new Set<string>();
      while (true) {
        check(!seen.has(String(saved.operation_id)), "Saved attempt recovery contains a cycle. Export recovery data before proceeding.");
        seen.add(String(saved.operation_id));
        const resolution = this.sql.all("SELECT * FROM local_resolutions WHERE scope=? AND operation_id=?", [scope, saved.operation_id])[0];
        if (resolution?.choice === "server") { disposition = "server"; break; }
        if (resolution?.outcome === "deleted") { disposition = "deleted"; break; }
        const recovery = this.sql.all("SELECT recovery_id FROM history_attempts WHERE scope=? AND operation_id=?", [scope, saved.operation_id])[0];
        const nextId = resolution?.resolution_id ?? recovery?.recovery_id;
        if (!nextId) break;
        const next = this.sql.all("SELECT * FROM outbox WHERE scope=? AND operation_id=?", [scope, nextId])[0];
        check(next, "A reviewed attempt is missing its saved result. Export recovery data before proceeding.");
        saved = next;
      }
      const identity = this.identity(scope, String(saved.kind), String(saved.record_id), String(saved.generation));
      const record = this.sql.all("SELECT * FROM local_records WHERE scope=? AND kind=? AND id=?", [scope, saved.kind, identity.id])[0] ?? null;
      return { original, saved, identity, record, disposition };
    });
  }
  configure(scope: string, profile: string, state: Record<string, unknown>) {
    check(state.profile === profile && Number.isSafeInteger(state.revision) && Number(state.revision) >= 0 &&
      /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(profile), "Workspace identity does not match device storage.");
    check(typeof state.syncGeneration === "string" && state.syncGeneration.length > 0, "Connect to the SQLite server to prepare offline editing.");
    const generation = state.syncGeneration;
    check(state.syncCursor === undefined || typeof state.syncCursor === "number" && Number.isSafeInteger(state.syncCursor) && state.syncCursor >= 0,
      "Invalid server metadata download boundary.");
    this.transaction(() => {
      this.requireCurrentHistory(scope);
      const current = this.sql.all("SELECT * FROM workspace_meta WHERE scope=?", [scope])[0];
      const identity = this.sql.all("SELECT * FROM history_identity WHERE scope=?", [scope])[0];
      check(!current || current.profile === profile, "Device scope belongs to another workspace.");
      check(!identity || identity.profile === profile, "Device history belongs to another workspace.");
      check((!current?.generation || current.generation === generation) && (!identity || identity.generation === generation), "Server history changed. Review saved local changes before reconnecting.", "history-changed");
      if (typeof state.syncCursor === "number" && Number(current?.cursor ?? 0) > state.syncCursor) return;
      if (current?.generation === generation && Number(JSON.parse(String(current.body)).revision) > Number(state.revision)) return;
      const staged = this.sql.all("SELECT body,generation FROM workspace_staging WHERE scope=?", [scope])[0];
      if (staged?.generation === generation && Number(JSON.parse(String(staged.body)).revision) > Number(state.revision)) return;
      this.sql.run(`INSERT INTO workspace_staging VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE
        SET profile=excluded.profile,body=excluded.body,generation=excluded.generation,verified_at=excluded.verified_at`,
      [scope, profile, JSON.stringify({ ...state, goals: [], tasks: [], ideas: [] }), generation, Date.now()]);
    });
  }
  read(scope: string) {
    return { metadata: this.sql.all("SELECT * FROM workspace_meta WHERE scope=?", [scope])[0] ?? null,
      stagedMetadata: this.sql.all("SELECT * FROM workspace_staging WHERE scope=?", [scope])[0] ?? null,
      historyReview: this.sql.all("SELECT * FROM history_reviews WHERE scope=?", [scope])[0] ?? null,
      historyIdentity: this.sql.all("SELECT * FROM history_identity WHERE scope=?", [scope])[0] ?? null,
      adoptionCounter: Number(this.sql.all("SELECT counter FROM history_epochs WHERE scope=?", [scope])[0]?.counter ?? 0),
      records: this.sql.all("SELECT * FROM local_records WHERE scope=? ORDER BY rowid", [scope]),
      acceptedRecords: this.sql.all("SELECT * FROM server_records WHERE scope=? ORDER BY rowid", [scope]),
      outbox: this.inspect(scope) };
  }
  inspect(scope: string) { return this.sql.all("SELECT * FROM outbox WHERE scope=? ORDER BY sequence", [scope]); }
  private outstanding(scope: string, kind: string, id: string) {
    return this.sql.all("SELECT 1 FROM outbox WHERE scope=? AND kind=? AND record_id=? AND status NOT IN ('accepted','superseded') LIMIT 1", [scope, kind, id]).length > 0;
  }
  private local(scope: string, kind: string, id: string, body: string, revision: number) {
    this.sql.run("INSERT INTO local_records VALUES(?,?,?,?,?) ON CONFLICT(scope,kind,id) DO UPDATE SET body=excluded.body,revision=excluded.revision", [scope, kind, id, body, revision]);
  }
  private server(scope: string, kind: string, id: string, revision: number, deleted: boolean, value: unknown) {
    const body = canonicalJson(value);
    const previous = this.sql.all("SELECT revision,body FROM server_records WHERE scope=? AND kind=? AND id=?", [scope, kind, id])[0];
    check(!previous || previous.revision !== revision || canonicalJson(JSON.parse(String(previous.body))) === body,
      "The server returned different contents for an unchanged revision.");
    this.sql.run(`INSERT INTO server_records VALUES(?,?,?,?,?,?) ON CONFLICT(scope,kind,id)
      DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,body=excluded.body WHERE excluded.revision>=server_records.revision`,
    [scope, kind, id, revision, Number(deleted), body]);
  }
  private publishServer(scope: string, kind: string, id: string) {
    const current = this.sql.all("SELECT body,revision FROM server_records WHERE scope=? AND kind=? AND id=?", [scope, kind, id])[0];
    check(current, "The accepted server record is unavailable.");
    this.local(scope, kind, id, String(current.body), Number(current.revision));
  }
  pull(scope: string, after: number, feed: RemoteFeed) {
    return this.transaction(() => {
      this.requireCurrentHistory(scope);
      check(feed.protocol === SYNC_PROTOCOL && typeof feed.generation === "string" && feed.generation.length > 0 &&
        Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(feed.cursor) && feed.cursor >= 0 && Array.isArray(feed.changes), "Invalid server change page.");
      const head = feed.head ?? feed.cursor;
      check(Number.isSafeInteger(head) && head >= feed.cursor, "Invalid server download boundary.");
      const metadata = this.sql.all("SELECT * FROM workspace_meta WHERE scope=?", [scope])[0];
      const staged = this.sql.all("SELECT * FROM workspace_staging WHERE scope=?", [scope])[0];
      const identity = this.sql.all("SELECT * FROM history_identity WHERE scope=?", [scope])[0];
      check(metadata || staged, "Prepare this workspace before downloading its records.");
      check((!metadata?.generation || metadata.generation === feed.generation) && (!staged || staged.generation === feed.generation) && (!identity || identity.generation === feed.generation),
        "Server history changed. Review saved local changes before reconnecting.", "history-changed");
      if (after !== (metadata?.cursor ?? 0)) {
        check(feed.cursor <= Number(metadata?.cursor ?? 0), "A newer change page arrived before its predecessor.");
        return;
      }
      check(head >= Number(metadata?.download_head ?? 0), "Server download boundary moved backwards. Retry synchronization.");
      let cursor = after;
      for (const change of feed.changes) {
        check(kinds.includes(change.kind) && typeof change.id === "string" && change.id.length > 0 &&
          Number.isSafeInteger(change.cursor) && change.cursor > cursor && Number.isSafeInteger(change.revision) && change.revision > 0 &&
          typeof change.deleted === "boolean" && (change.deleted ? change.value === null : entity(change.value, change.id)), "Invalid server record change.");
        this.server(scope, change.kind, change.id, change.revision, change.deleted, change.value);
        if (!this.outstanding(scope, change.kind, change.id)) this.publishServer(scope, change.kind, change.id);
        cursor = change.cursor;
      }
      check(cursor === feed.cursor, "Server cursor does not match its records.");
      const stagedHead = staged ? (JSON.parse(String(staged.body)) as { syncCursor?: number }).syncCursor : undefined;
      const downloadHead = Math.max(head, stagedHead ?? 0);
      if (staged && (!metadata || Number(JSON.parse(String(staged.body)).revision) >= Number(JSON.parse(String(metadata.body)).revision))) {
        this.sql.run(`INSERT INTO workspace_meta(scope,profile,body,generation,verified_at) VALUES(?,?,?,?,?)
          ON CONFLICT(scope) DO UPDATE SET body=excluded.body,verified_at=excluded.verified_at`,
        [scope, staged.profile, staged.body, feed.generation, staged.verified_at]);
      }
      this.sql.run("DELETE FROM workspace_staging WHERE scope=?", [scope]);
      this.sql.run("UPDATE workspace_meta SET cursor=?,generation=?,download_head=? WHERE scope=?", [cursor, feed.generation, downloadHead, scope]);
      this.sql.run("INSERT INTO history_identity VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET profile=excluded.profile,generation=excluded.generation",
        [scope, staged?.profile ?? metadata!.profile, feed.generation]);
      this.sql.run("UPDATE outbox SET generation=? WHERE scope=? AND generation IS NULL", [feed.generation, scope]);
    });
  }
  enqueue(scope: string, input: unknown, title: string, record: unknown, baselineVersion?: number, expectedGeneration?: string) {
    const operation = parseSyncOperation(input);
    check(typeof title === "string" && title.trim() && title.length <= 12000 &&
      (operation.action === "delete" ? record === null : entity(record, operation.id)), "Invalid locally saved record.");
    return this.transaction(() => this.enqueueInTransaction(scope, operation, title, record, baselineVersion, expectedGeneration));
  }
  private enqueueInTransaction(scope: string, operation: SyncOperation, title: string, record: unknown, baselineVersion?: number, expectedGeneration?: string) {
      const serialized = canonicalJson(operation);
      const prior = this.sql.all("SELECT operation FROM outbox WHERE scope=? AND operation_id=?", [scope, operation.operationId])[0];
      if (prior) {
        check(prior.operation === serialized, "Offline operation identity was reused with different contents.");
        return { status: "locally-saved", operationId: operation.operationId };
      }
      this.requireCurrentHistory(scope);
      const metadata = this.sql.all("SELECT generation,cursor,download_head FROM workspace_meta WHERE scope=?", [scope])[0];
      const adoptionCounter = Number(this.sql.all("SELECT counter FROM history_epochs WHERE scope=?", [scope])[0]?.counter ?? 0);
      check(adoptionCounter === 0 || expectedGeneration !== undefined,
        "This save has no reviewed server history. Review the current record before submitting; your draft remains available.", "draft-review-required");
      check(expectedGeneration === undefined || metadata?.generation === expectedGeneration,
        "Server history changed while preparing this save. Review the current records; your draft remains saved.", "history-changed");
      check(metadata?.generation && Number(metadata.cursor) >= Number(metadata.download_head), "Finish the initial record download before editing offline. Your draft remains available.");
      const current = this.sql.all("SELECT body,revision FROM local_records WHERE scope=? AND kind=? AND id=?", [scope, operation.kind, operation.id])[0];
      check((current?.revision ?? 0) === operation.expectedRevision, "This record changed on this device. Review its current version before saving.");
      if (operation.action === "create") check(!current, "This record identity already exists on this device.");
      else {
        check(current && current.body !== "null", "This record was removed on this device.");
        if (baselineVersion !== undefined) check(JSON.parse(String(current.body)).version === baselineVersion, "This editor contains an older local version. Keep your text and review the newer edit.");
      }
      const references: [string, string][] = [];
      if (record && typeof record === "object") {
        const fields = record as Record<string, unknown>;
        if (typeof fields.goalId === "string" && fields.goalId) references.push(["goal", fields.goalId]);
        if (typeof fields.parentId === "string" && fields.parentId) references.push(["goal", fields.parentId]);
        for (const [field, kind] of [["goalIds", "goal"], ["ideaIds", "idea"]]) {
          const ids = fields[field];
          if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") references.push([kind, id]);
        }
      }
      const dependencies = references.flatMap(([kind, id]) => this.sql.all(`SELECT operation_id FROM outbox WHERE scope=? AND kind=? AND record_id=?
        AND json_extract(operation,'$.action')='create' AND status NOT IN ('accepted','superseded') ORDER BY sequence DESC LIMIT 1`, [scope, kind, id]).map(row => String(row.operation_id)));
      for (const [kind, id] of references) {
        const target = this.sql.all("SELECT body FROM local_records WHERE scope=? AND kind=? AND id=?", [scope, kind, id])[0];
        check(target && target.body !== "null", "A linked record is unavailable on this device. Select a current record before saving.");
      }
      const localVersion = record && typeof record === "object" && "version" in record && Number.isSafeInteger(record.version) ? Number(record.version) : null;
      this.sql.run("INSERT INTO outbox(scope,operation_id,kind,record_id,title,operation,status,generation,dependencies,local_version) VALUES(?,?,?,?,?,?,'pending',?,?,?)",
        [scope, operation.operationId, operation.kind, operation.id, title, serialized, metadata.generation, JSON.stringify([...new Set(dependencies)]), localVersion]);
      this.local(scope, operation.kind, operation.id, JSON.stringify(record), operation.expectedRevision + 1);
      return { status: "locally-saved", operationId: operation.operationId };
  }
  resolve(scope: string, operationId: string, choice: "server" | "local", resolutionId: string, review: ResolutionReview) {
    const expectedServerRevision = review?.serverRevision;
    check(["server", "local"].includes(choice) && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(resolutionId) && Number.isSafeInteger(expectedServerRevision) && expectedServerRevision >= 0, "Invalid local resolution.");
    check(Number.isSafeInteger(review.localRevision) && review.localRevision >= 0 && typeof review.queueTail === "string" && review.queueTail.length > 0, "Review the current local version before resolving this change.");
    return this.transaction(() => {
      this.requireCurrentHistory(scope);
      const prior = this.sql.all("SELECT * FROM local_resolutions WHERE scope=? AND operation_id=?", [scope, operationId])[0];
      if (prior) {
        check(prior.choice === choice && prior.server_revision === expectedServerRevision, "This change was already resolved. Review the current queue.");
        check((prior.local_revision === null || prior.local_revision === review.localRevision) && (prior.queue_tail === null || prior.queue_tail === review.queueTail), "This change was already resolved from a different local version. Review the current queue.");
        return { resolutionId: prior.resolution_id };
      }
      const target = this.sql.all("SELECT * FROM outbox WHERE scope=? AND operation_id=?", [scope, operationId])[0];
      check(target && ["failed", "conflict"].includes(String(target.status)), "Only a confirmed failure or conflict can be resolved. Uncertain attempts must retry their original identity.");
      const records = this.sql.all("SELECT * FROM outbox WHERE scope=? AND kind=? AND record_id=? AND status NOT IN ('accepted','superseded') ORDER BY sequence", [scope, target.kind, target.record_id]);
      check(records[0]?.operation_id === operationId, "Resolve this record’s earliest blocked change first.");
      const metadata = this.sql.all("SELECT generation,cursor,download_head FROM workspace_meta WHERE scope=?", [scope])[0];
      check(metadata?.generation === target.generation && Number(metadata.cursor) >= Number(metadata.download_head), "Finish downloading the current server history before resolving this change.");
      const base = this.sql.all("SELECT * FROM server_records WHERE scope=? AND kind=? AND id=?", [scope, target.kind, target.record_id])[0];
      check(Number(base?.revision ?? 0) === expectedServerRevision, "The accepted server version changed. Review it again before resolving.");
      const local = this.sql.all("SELECT * FROM local_records WHERE scope=? AND kind=? AND id=?", [scope, target.kind, target.record_id])[0];
      check(local, "The saved local version is unavailable. Export local changes before proceeding.");
      check(local.revision === review.localRevision && records.at(-1)?.operation_id === review.queueTail,
        "The local version changed while you were reviewing it. Review the latest comparison before resolving.");
      const latest = JSON.parse(String(local.body));
      this.sql.run("UPDATE outbox SET status='superseded',error=? WHERE scope=? AND kind=? AND record_id=? AND status NOT IN ('accepted','superseded')",
        [choice === "server" ? "Owner chose the accepted server version. This local intent remains in recovery history." : "Owner resolved this intent with a new operation against the reviewed server version.", scope, target.kind, target.record_id]);
      if (base) this.publishServer(scope, String(target.kind), String(target.record_id));
      else this.local(scope, String(target.kind), String(target.record_id), "null", 0);
      if (!base || base.deleted) {
        for (const row of records) this.sql.run(`UPDATE outbox SET status='failed',error=? WHERE scope=? AND status NOT IN ('accepted','superseded','conflict')
          AND EXISTS(SELECT 1 FROM json_each(outbox.dependencies) WHERE value=?)`,
        ["A linked local creation was replaced or discarded. Review its relationship before retrying.", scope, row.operation_id]);
      }
      let outcome = choice === "server" ? "server" : "deleted";
      if (choice === "local" && (latest || base && !base.deleted)) {
        const kind = String(target.kind) as SyncOperation["kind"];
        const copying = Boolean(latest && (!base || base.deleted));
        const id = copying ? resolutionId : String(target.record_id);
        const operation = parseSyncOperation({ operationId: resolutionId, kind, id,
          action: latest ? copying ? "create" : "update" : "delete", expectedRevision: copying ? 0 : Number(base!.revision),
          ...(latest ? { value: Object.fromEntries(RECORD_FIELDS[kind].filter(key => key in latest).map(key => [key, latest[key]])) } : {}) });
        const accepted = base && !base.deleted ? JSON.parse(String(base.body)) : null;
        const record = latest ? { ...latest, id, version: Number(accepted?.version ?? 0) + 1, updatedAt: new Date().toISOString() } : null;
        this.enqueueInTransaction(scope, operation, String(latest?.title ?? target.title), record, undefined, String(metadata.generation));
        outcome = "saved";
        if (copying) {
          const generations = new Set(this.sql.all("SELECT generation FROM outbox WHERE scope=? AND kind=? AND record_id=? AND generation IS NOT NULL", [scope, target.kind, target.record_id]).map(row => String(row.generation)));
          for (const generation of generations) this.sql.run("INSERT INTO record_identities VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
            [scope, target.kind, target.record_id, generation, id, metadata.generation]);
        }
      }
      this.sql.run("INSERT INTO local_resolutions(scope,operation_id,resolution_id,choice,server_revision,local_revision,queue_tail,outcome) VALUES(?,?,?,?,?,?,?,?)",
        [scope, operationId, resolutionId, choice, expectedServerRevision, review.localRevision, review.queueTail, outcome]);
      return { resolutionId };
    });
  }
  next(scope: string) {
    if (this.sql.all("SELECT 1 FROM history_reviews WHERE scope=?", [scope]).length) return null;
    return this.sql.all(`SELECT * FROM outbox AS current WHERE scope=? AND status IN ('pending','sending') AND NOT EXISTS
      (SELECT 1 FROM outbox AS earlier WHERE earlier.scope=current.scope AND earlier.kind=current.kind AND earlier.record_id=current.record_id
      AND earlier.sequence<current.sequence AND earlier.status NOT IN ('accepted','superseded')) AND NOT EXISTS
      (SELECT 1 FROM json_each(current.dependencies) AS dependency JOIN outbox AS required
      ON required.scope=current.scope AND required.operation_id=dependency.value WHERE required.status NOT IN ('accepted','superseded'))
      ORDER BY sequence LIMIT 1`, [scope])[0] ?? null;
  }
  mark(scope: string, operationId: string, status: LocalStatus, error: string | null = null) {
    check(["pending", "sending", "auth-required", "failed"].includes(status) && (!error || error.length <= 2000), "Invalid local synchronization state.");
    this.sql.run("UPDATE outbox SET status=?,error=? WHERE scope=? AND operation_id=? AND status NOT IN ('accepted','conflict','superseded')", [status, error, scope, operationId]);
  }
  reconcile(scope: string, receipt: Record<string, unknown>) {
    return this.transaction(() => {
      const row = this.sql.all("SELECT * FROM outbox WHERE scope=? AND operation_id=?", [scope, String(receipt.operationId)])[0];
      check(row && receipt.protocol === SYNC_PROTOCOL && receipt.generation === row.generation, "The acknowledgement does not match this saved operation.");
      const operation = JSON.parse(String(row.operation)) as SyncOperation;
      const encoded = canonicalJson(receipt);
      if (row.receipt) { check(row.receipt === encoded, "The server returned a different acknowledgement for this operation."); return; }
      check(receipt.status === "accepted" || receipt.status === "conflict", "Unknown server acknowledgement.");
      // Once review starts, acknowledgements are historical evidence only.
      // Their original operation and generation remain immutable. They cannot
      // publish into the replacement history, now or after adoption.
      const metadata = this.sql.all("SELECT generation FROM workspace_meta WHERE scope=?", [scope])[0];
      const historical = metadata?.generation !== row.generation || Boolean(this.sql.all("SELECT 1 FROM history_reviews WHERE scope=?", [scope]).length);
      if (receipt.status === "conflict") {
        this.sql.run("UPDATE outbox SET status=CASE WHEN status='superseded' THEN status ELSE 'conflict' END,receipt=?,error=CASE WHEN status='superseded' THEN error ELSE ? END WHERE scope=? AND operation_id=?", [encoded, "The server record changed. Review both versions.", scope, operation.operationId]);
        return;
      }
      check(receipt.kind === operation.kind && receipt.id === operation.id && receipt.revision === operation.expectedRevision + 1 &&
        receipt.deleted === (operation.action === "delete") && (receipt.deleted ? receipt.value === null : entity(receipt.value, operation.id)), "Invalid accepted record.");
      this.sql.run("UPDATE outbox SET status=CASE WHEN status='superseded' THEN status ELSE 'accepted' END,receipt=?,error=CASE WHEN status='superseded' THEN error ELSE NULL END WHERE scope=? AND operation_id=?", [encoded, scope, operation.operationId]);
      if (historical) return;
      this.server(scope, operation.kind, operation.id, Number(receipt.revision), receipt.deleted === true, receipt.value);
      if (!this.outstanding(scope, operation.kind, operation.id)) this.publishServer(scope, operation.kind, operation.id);
    });
  }
}
