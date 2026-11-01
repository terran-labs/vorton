import sqlite3InitModule, { type Database, type SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import { parseSyncOperation } from "../../shared/sync-contract.ts";
import { LocalReplica, type SqlRow } from "./replica-sql.ts";

// A stable directory and filename survive shell upgrades. Admission and
// editor orchestration stay outside this worker. No caller may claim a save
// until the transaction response is received.
const channel = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
};
let database: Database | undefined;
let replica: LocalReplica | undefined;
let opening: Promise<Database> | undefined;
let release: (() => void) | undefined;
let pool: SAHPoolUtil | undefined;
function closeDatabase() {
  database?.close();
  database = undefined;
  replica = undefined;
  pool?.pauseVfs();
  release?.();
  release = undefined;
  opening = undefined;
}
async function openDatabase(): Promise<Database> {
  if (database) return database;
  if (opening) return opening;
  opening = (async () => {
    if (!navigator.locks || !navigator.storage?.getDirectory)
      throw Error("Persistent device storage is unavailable. Reconnect and keep this draft open.");
    await new Promise<void>((resolve, reject) => {
      void navigator.locks.request("vorton-replica-v1", { ifAvailable: true }, async lock => {
        if (!lock) { reject(Error("Device storage is open in another Vorton tab. Close that tab and retry.")); return; }
        await new Promise<void>(hold => { release = hold; resolve(); });
      }).catch(reject);
    });
    try {
      const sqlite = await sqlite3InitModule();
      pool ??= await sqlite.installOpfsSAHPoolVfs({ name: "vorton-replica", directory: "/vorton-replica-v1" });
      if (pool.isPaused()) await pool.unpauseVfs();
      const db = new pool.OpfsSAHPoolDb("/replica.sqlite3");
      try {
        db.exec("PRAGMA synchronous=FULL");
        const next = new LocalReplica({
          run: (sql, parameters = []) => { db.exec({ sql, bind: parameters }); },
          all: (sql, parameters = []) => db.exec({ sql, bind: parameters, rowMode: "object", returnValue: "resultRows" }) as SqlRow[],
        });
        next.initialize();
        replica = next;
      } catch (error) { db.close(); throw error; }
      database = db;
      return db;
    } catch (error) { closeDatabase(); throw error; }
  })().catch(error => { opening = undefined; throw error; });
  return opening;
}
let serial = Promise.resolve();
channel.onmessage = event => {
  const request = event.data;
  serial = serial.then(async () => {
    try {
      if (!request || !Number.isSafeInteger(request.requestId) || typeof request.scope !== "string" || !request.scope || request.scope.length > 500)
        throw Error("Invalid local storage request");
      if (request.action === "close") {
        closeDatabase();
        channel.postMessage({ requestId: request.requestId, ok: true });
        return;
      }
      await openDatabase();
      const store = replica!;
      let result: unknown;
      const deviceEpoch = request.deviceEpoch ?? { readEpoch: 0, draftEpoch: 0 };
      if (request.action === "clear-device") {
        result = store.clearDevice(request.scope, deviceEpoch, request.all === true);
        channel.postMessage({ requestId: request.requestId, ok: true, result });
        return;
      }
      store.authorize(request.scope, deviceEpoch);
      if (request.action === "export-device") {
        result = store.exportDevice(request.scope);
      } else if (request.action === "inspect") {
        result = store.inspect(request.scope);
      } else if (request.action === "read") {
        result = store.read(request.scope).records;
      } else if (request.action === "workspace") {
        result = store.read(request.scope);
      } else if (request.action === "configure") {
        result = store.configure(request.scope, request.profile, request.state);
      } else if (request.action === "begin-history-review") {
        result = store.beginHistoryReview(request.scope, request.profile, request.state, request.reviewId, request.replaceReviewId);
      } else if (request.action === "pull-history-review") {
        result = store.pullHistoryReview(request.scope, request.reviewId, request.after, request.feed);
      } else if (request.action === "compare-history") {
        result = store.historyComparison(request.scope, request.reviewId);
      } else if (request.action === "adopt-history") {
        result = store.adoptHistoryReview(request.scope, request.reviewId, request.adoptionId, request.comparison, request.verifiedGeneration);
      } else if (request.action === "history-adoption") {
        result = store.historyAdoption(request.scope, request.adoptionId);
      } else if (request.action === "recover-attempt") {
        result = store.recoverAttempt(request.scope, request.operationId);
      } else if (request.action === "record-identity") {
        result = store.resolveRecordIdentity(request.scope, request.kind, request.id, request.generation);
      } else if (request.action === "review-record-identity") {
        result = store.reviewRecordIdentity(request.scope, request.kind, request.id, request.generation, request.review);
      } else if (request.action === "pull") {
        result = store.pull(request.scope, request.after, request.feed);
      } else if (request.action === "next") {
        result = store.next(request.scope);
      } else if (request.action === "mark") {
        result = store.mark(request.scope, request.operationId, request.status, request.error ?? null);
      } else if (request.action === "reconcile") {
        result = store.reconcile(request.scope, request.receipt);
      } else if (request.action === "resolve") {
        result = store.resolve(request.scope, request.operationId, request.choice, request.resolutionId, request.review);
      } else if (request.action === "enqueue") {
        const { operationId, kind, id, title, operation, record } = request;
        const parsed = parseSyncOperation(operation);
        if (parsed.operationId !== operationId || parsed.kind !== kind || parsed.id !== id)
          throw Error("Offline operation does not match its local record");
        result = store.enqueue(request.scope, operation, title, record, request.baselineVersion, request.expectedGeneration);
      } else throw Error("Unsupported local storage action");
      channel.postMessage({ requestId: request.requestId, ok: true, result });
    } catch (error) {
      channel.postMessage({ requestId: request?.requestId, ok: false, error: error instanceof Error ? error.message : "Device storage failed. Keep your draft open and retry.",
        errorCode: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined });
    }
  });
};
