export type WorkerReply = { requestId: number; ok: boolean; result?: unknown; error?: string; errorCode?: string };
type RequestPayload = Record<string, unknown>;
type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** A timeout leaves the result unknown. Retrying a mutation must retain its
 * operation ID; terminating a worker must never be treated as cancelling it. */
export class SqliteClient {
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private worker: Worker | undefined;
  private createWorker: () => Worker;
  constructor(createWorker: () => Worker = () => new Worker(new URL("./sqlite-worker.ts", import.meta.url), { type: "module" })) { this.createWorker = createWorker; }
  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const response = event.data;
      const pending = this.pending.get(response?.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(Object.assign(new Error(response.error ?? "Device storage failed. Your edit has not been confirmed saved."), { code: response.errorCode }));
    };
    worker.onerror = () => {
      this.rejectPending("Device storage stopped. An attempted save may have completed; retry with the same operation identity.");
      worker.terminate();
      if (this.worker === worker) this.worker = undefined;
    };
    this.worker = worker;
    return worker;
  }
  async request(scope: string, action: string, payload: RequestPayload = {}, milliseconds = 15000): Promise<unknown> {
    const worker = this.start(), requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Device storage did not confirm completion. Keep your edit and retry using the same operation identity."));
      }, milliseconds);
      this.pending.set(requestId, { resolve, reject, timer });
      try { worker.postMessage({ ...payload, requestId, scope, action }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  private rejectPending(message: string) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }
  async close(scope: string) {
    if (!this.worker) return;
    await this.request(scope, "close");
    this.worker.terminate();
    this.worker = undefined;
    this.rejectPending("Device storage closed before confirming the result. Keep pending operation identities for recovery.");
  }
}
