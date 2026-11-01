import { Worker } from "node:worker_threads";
import { serialize } from "node:v8";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Server, ServerResponse } from "node:http";
import { Fault, check } from "./store.ts";
import type { Store } from "./store.ts";
import {
  validateTargets,
  WORKSPACE_HTTP_PROTOCOL,
} from "./workspace-http-runtime.ts";
import type {
  HostMessage,
  TuningEffectContext,
  TuningEffectResult,
  WorkerMessage,
  WorkspaceHttpBytes,
  WorkspaceHttpError,
  WorkspaceHttpTarget,
  WorkspaceOperation,
} from "./workspace-http-runtime.ts";

export interface WorkspaceEffects {
  dispatch(
    context: TuningEffectContext,
    guard: () => Promise<void>,
  ): Promise<TuningEffectResult>;
  reconcile(
    context: TuningEffectContext,
    result: TuningEffectResult | undefined,
    error: unknown,
  ): Promise<void>;
  forget?(context: TuningEffectContext): void;
}
export type WorkspaceHttpResult = WorkspaceHttpBytes & { release(): void };
type Job = {
  id: number;
  target: string;
  operation: WorkspaceOperation;
  size: number;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (value: WorkspaceHttpResult) => void;
  reject: (error: Error) => void;
  abandoned: boolean;
};
export type WorkspaceHttpHostOptions = {
  targets: WorkspaceHttpTarget[];
  effects?: WorkspaceEffects;
  maximumQueuedJobs?: number;
  maximumQueuedBytes?: number;
};

/** One top-level job and one output permit. Control traffic never queues behind it. */
export class WorkspaceHttpHost {
  private readonly options: WorkspaceHttpHostOptions;
  private worker?: Worker;
  private readiness?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private queue: Job[] = [];
  private queuedBytes = 0;
  private active?: Job;
  private sequence = 0;
  private guardSequence = 0;
  private guards = new Map<
    number,
    { effectId: number; resolve: () => void; reject: (error: Error) => void }
  >();
  private originUpdates = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private origins = new Map<string, Promise<void>>();
  private effects = new Map<
    number,
    { context: TuningEffectContext; task: Promise<void> }
  >();
  private readonly hostEpoch = randomUUID();
  private lastEffectId = 0;
  private observedEffects: {
    context: TuningEffectContext;
    result: TuningEffectResult;
  }[] = [];
  private reconciliations = new Set<Promise<void>>();
  private cleanupFailure?: unknown;
  private policies = new Map<
    string,
    { store: Store; expected: Store["beforeCommand"] }[]
  >();
  private closing = false;
  private shutdownRequested = false;
  private exited = false;
  private failed?: Error;
  private closed?: Promise<void>;
  private exit?: Promise<void>;
  private drained: (() => void)[] = [];
  constructor(options: WorkspaceHttpHostOptions) {
    validateTargets(options.targets);
    for (const limit of [
      options.maximumQueuedJobs ?? 16,
      options.maximumQueuedBytes ?? 2 * 1024 * 1024,
    ])
      check(
        Number.isSafeInteger(limit) && limit > 0,
        "Invalid HTTP worker queue limit",
      );
    this.options = { ...options, targets: structuredClone(options.targets) };
  }
  /** Register the exact local policy reference before exposing app.store. */
  bindPolicy(
    target: string,
    store: Store,
    installed?: { kind: "installed-aubos-planning"; directory: string },
  ) {
    const configuration = this.options.targets.find((t) => t.id === target);
    check(
      !this.readiness && configuration,
      "Bind HTTP policy before starting the worker",
    );
    // A function baseline cannot establish equivalence with a worker policy.
    // Trusted composition can explicitly bind the known installed adapter only.
    if (store.beforeCommand !== null) {
      check(
        configuration.kind === "native" &&
          installed?.kind === "installed-aubos-planning" &&
          installed.directory === configuration.aubosDirectory &&
          store.root === path.resolve(configuration.root) &&
          store.allowedProfiles?.length === 1 &&
          store.allowedProfiles[0] === "AubOS" &&
          store.organizationRoots.AubOS ===
            path.join(configuration.root, configuration.aubosDirectory),
        "Initial HTTP callback policy is unsupported. Use the explicit installed native adapter contract.",
        503,
        "http-policy-unsupported",
      );
    } else
      check(
        installed === undefined,
        "Installed native policy callback is missing",
        503,
        "http-policy-unsupported",
      );
    const policies = this.policies.get(target) ?? [];
    policies.push({ store, expected: store.beforeCommand });
    this.policies.set(target, policies);
  }
  private checkPolicy(target: string) {
    for (const { store, expected } of this.policies.get(target) ?? [])
      check(
        store.beforeCommand === expected,
        "HTTP Store policy changed. A local callback cannot be transferred to the worker.",
        503,
        "http-policy-changed",
      );
  }
  ready(): Promise<void> {
    if (this.closing || this.failed)
      return Promise.reject(
        this.failed ?? new Fault(503, "HTTP worker is closing"),
      );
    if (this.readiness) return this.readiness;
    this.readiness = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const entry = this.options.targets.some((t) => t.kind === "native")
      ? "private"
      : "portable";
    try {
      const worker = new Worker(
        new URL(
          entry === "private"
            ? "./private-workspace-http-worker.ts"
            : "./workspace-http-worker.ts",
          import.meta.url,
        ),
        { workerData: { entry } },
      );
      this.worker = worker;
      this.exit = new Promise<void>((resolve) =>
        worker.once("exit", () => resolve()),
      );
      worker.on("message", (message: WorkerMessage) => this.message(message));
      worker.on("error", (error) => this.fail(error));
      worker.on("exit", (code) => {
        this.exited = true;
        if (!this.shutdownRequested || this.active || code !== 0)
          this.fail(
            new Fault(
              503,
              "HTTP worker stopped. An admitted operation may have completed; reload before retrying.",
              "http-worker-unavailable",
            ),
          );
      });
      this.send({
        kind: "initialize",
        protocol: WORKSPACE_HTTP_PROTOCOL,
        configuration: {
          targets: this.options.targets,
          effects: Boolean(this.options.effects),
          hostEpoch: this.hostEpoch,
        },
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : Error(String(error)));
    }
    return this.readiness;
  }
  private send(message: HostMessage, transfer: ArrayBuffer[] = []) {
    this.worker!.postMessage(message, transfer);
  }
  /** Trusted composition only, after checking the parent's exact allowed set. */
  async admitOrigin(target: string, origin: string): Promise<void> {
    check(
      this.options.targets.some((t) => t.id === target && t.kind === "native"),
      "Unknown private origin target",
      403,
    );
    const url = new URL(origin);
    check(
      url.origin === origin && ["http:", "https:"].includes(url.protocol),
      "Invalid admitted private origin",
      403,
    );
    check(!this.closing && !this.failed, "HTTP worker is unavailable", 503);
    const identity = `${target}/${origin}`,
      prior = this.origins.get(identity);
    if (prior) return prior;
    const pending = (async () => {
      await this.ready();
      check(!this.closing && !this.failed, "HTTP worker is unavailable", 503);
      await new Promise<void>((resolve, reject) => {
        const id = ++this.guardSequence;
        this.originUpdates.set(id, { resolve, reject });
        this.send({ kind: "admit-origin", id, target, origin });
      });
    })();
    this.origins.set(identity, pending);
    try {
      await pending;
    } catch (error) {
      this.origins.delete(identity);
      throw error;
    }
  }
  async execute(
    target: string,
    operation: WorkspaceOperation,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceHttpResult> {
    check(!this.closing && !this.failed, "HTTP worker is unavailable", 503);
    check(
      this.options.targets.some((t) => t.id === target),
      "Unknown HTTP worker target",
      404,
    );
    this.checkPolicy(target);
    if (options.signal?.aborted)
      throw new Fault(499, "Request disconnected before dispatch");
    // HTTP admission has already bounded these inputs. Cloning captures their identity.
    const captured = structuredClone(operation),
      size = serialize(captured).byteLength;
    check(
      this.queue.length < (this.options.maximumQueuedJobs ?? 16) &&
        this.queuedBytes + size <=
          (this.options.maximumQueuedBytes ?? 2 * 1024 * 1024),
      "HTTP worker queue is full. Retry the saved operation later.",
      503,
      "http-worker-busy",
    );
    return new Promise<WorkspaceHttpResult>((resolve, reject) => {
      const job: Job = {
        id: ++this.sequence,
        target,
        operation: captured,
        size,
        signal: options.signal,
        abandoned: false,
        resolve,
        reject,
        abort: () => {
          job.abandoned = true;
          const index = this.queue.indexOf(job);
          if (index >= 0) {
            this.queue.splice(index, 1);
            this.queuedBytes -= job.size;
            job.signal?.removeEventListener("abort", job.abort);
            reject(new Fault(499, "Request disconnected before dispatch"));
          }
        },
      };
      job.signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.queuedBytes += size;
      void this.ready().then(
        () => this.pump(),
        (error) => this.fail(error),
      );
    });
  }
  private pump() {
    if (this.active || this.closing || this.failed || !this.worker) return;
    const job = this.queue.shift();
    if (!job) return;
    this.queuedBytes -= job.size;
    try {
      this.checkPolicy(job.target);
    } catch (error) {
      job.signal?.removeEventListener("abort", job.abort);
      job.reject(error as Error);
      this.pump();
      return;
    }
    this.active = job; // Reserves output capacity BEFORE worker assembly/encoding.
    try {
      this.send({
        kind: "execute",
        id: job.id,
        target: job.target,
        operation: job.operation,
      });
    } catch (error) {
      this.fail(error as Error);
    }
  }
  private release(job: Job) {
    if (this.active !== job) return;
    job.signal?.removeEventListener("abort", job.abort);
    this.active = undefined;
    this.drained.splice(0).forEach((resolve) => resolve());
    this.pump();
  }
  private message(message: WorkerMessage) {
    if (message.kind === "origin.reply") {
      const pending = this.originUpdates.get(message.id);
      if (!pending) {
        this.fail(new Fault(503, "Unexpected origin admission reply"));
        return;
      }
      this.originUpdates.delete(message.id);
      if (message.error) pending.reject(this.error(message.error));
      else pending.resolve();
      return;
    }
    if (message.kind === "ready") {
      if (message.protocol !== WORKSPACE_HTTP_PROTOCOL) {
        this.fail(
          new Fault(
            503,
            "HTTP worker protocol does not match",
            "http-worker-protocol",
          ),
        );
        return;
      }
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      return;
    }
    if (message.kind === "fatal") {
      this.fail(this.error(message.error));
      return;
    }
    if (message.kind === "guard.reply") {
      const pending = this.guards.get(message.id);
      if (!pending || pending.effectId !== message.effectId) {
        this.fail(new Fault(503, "Invalid HTTP worker guard reply"));
        return;
      }
      this.guards.delete(message.id);
      if (message.error) pending.reject(this.error(message.error));
      else pending.resolve();
      return;
    }
    if (message.kind === "effect") {
      this.effect(message.context);
      return;
    }
    const job = this.active;
    if (!job || message.id !== job.id) {
      this.fail(new Fault(503, "Unexpected HTTP worker reply"));
      return;
    }
    if (message.kind === "error") {
      const error = this.error(message.error);
      void this.reconcileObserved(error).then(
        () => {
          job.reject(error);
          this.release(job);
        },
        (failure) => this.fail(failure),
      );
      return;
    }
    // A successful top-level reply confirms consumption and completion.
    for (const observation of this.observedEffects.splice(0))
      this.options.effects?.forget?.(observation.context);
    if (job.abandoned) {
      job.reject(
        new Fault(
          499,
          "Request disconnected. The admitted operation was not cancelled.",
        ),
      );
      this.release(job);
      return;
    }
    job.resolve({ ...message.value, release: () => this.release(job) });
  }
  private error(error: WorkspaceHttpError) {
    return new Fault(error.status, error.message, error.code);
  }
  private guard(context: TuningEffectContext): Promise<void> {
    if (this.failed || !this.worker || this.active?.id !== context.operationId)
      return Promise.reject(
        this.failed ?? new Fault(503, "Effect context is retired"),
      );
    return new Promise<void>((resolve, reject) => {
      const id = ++this.guardSequence;
      this.guards.set(id, { effectId: context.effectId, resolve, reject });
      this.send({ kind: "guard", id, effectId: context.effectId });
    });
  }
  private effect(context: TuningEffectContext) {
    const target = this.options.targets.find((t) => t.id === context.target);
    const job = this.active;
    if (
      !job ||
      job.id !== context.operationId ||
      job.target !== context.target ||
      target?.kind !== "native" ||
      ![
        "tuning.start",
        "tuning.cancel",
        "tuning.status",
        "tuning.recover",
      ].includes(job.operation.kind) ||
      context.hostEpoch !== this.hostEpoch ||
      !Number.isSafeInteger(context.effectId) ||
      context.effectId <= this.lastEffectId ||
      this.effects.size ||
      !this.options.effects
    ) {
      this.fail(new Fault(503, "Invalid or repeated HTTP native effect"));
      return;
    }
    const operation = job.operation;
    if (
      operation.kind === "tuning.start" ||
      operation.kind === "tuning.cancel"
    ) {
      const input = operation.input;
      if (
        !input ||
        typeof input !== "object" ||
        !("expectedGeneration" in input) ||
        input.expectedGeneration !== context.generation ||
        (operation.kind === "tuning.start" &&
          (!("requestId" in input) ||
            input.requestId !== context.requestId ||
            context.kind !== "launch")) ||
        (operation.kind === "tuning.cancel" &&
          (!("runId" in input) ||
            input.runId !== context.runId ||
            context.kind === "launch"))
      ) {
        this.fail(
          new Fault(
            503,
            "Native effect does not match its admitted browser operation",
          ),
        );
        return;
      }
    } else if (context.kind !== "launch") {
      this.fail(new Fault(503, "Unexpected native recovery effect"));
      return;
    }
    this.lastEffectId = context.effectId;
    const executor = this.options.effects;
    const task = (async () => {
      let result: TuningEffectResult | undefined;
      try {
        result = await executor.dispatch(context, () => this.guard(context));
        if (this.failed) {
          try {
            await executor.reconcile(context, result, this.failed);
          } finally {
            executor.forget?.(context);
          }
          return;
        }
        // Retain only identity/outcome metadata, never a CLI JSON body.
        this.observedEffects.push({
          context,
          result: { supervisorPid: result.supervisorPid },
        });
        this.send(
          { kind: "effect.reply", effectId: context.effectId, result },
          result?.bytes ? [result.bytes.buffer as ArrayBuffer] : [],
        );
      } catch (error) {
        try {
          await executor.reconcile(context, result, error);
        } finally {
          executor.forget?.(context);
        }
        if (!this.failed) {
          try {
            this.send({
              kind: "effect.reply",
              effectId: context.effectId,
              error: {
                status: error instanceof Fault ? error.status : 503,
                message:
                  error instanceof Fault
                    ? error.message
                    : "Native effect outcome requires inspection",
                ...(error instanceof Fault && error.code
                  ? { code: error.code }
                  : {}),
              },
            });
          } catch {
            this.fail(
              new Fault(
                503,
                "Native effect reply was not confirmed. Inspect private reconciliation evidence.",
                "http-worker-unavailable",
              ),
            );
          }
        }
      } finally {
        this.effects.delete(context.effectId);
      }
    })();
    this.effects.set(context.effectId, { context, task });
    void task.catch((error) => {
      this.cleanupFailure ??= error;
      this.fail(error instanceof Error ? error : Error(String(error)));
    });
  }
  private fail(error: Error) {
    if (this.failed) return;
    this.failed = error;
    this.rejectReady?.(error);
    this.rejectReady = undefined;
    for (const job of this.queue.splice(0)) {
      job.signal?.removeEventListener("abort", job.abort);
      job.reject(error);
    }
    this.queuedBytes = 0;
    for (const guard of this.guards.values()) guard.reject(error);
    this.guards.clear();
    for (const update of this.originUpdates.values()) update.reject(error);
    this.originUpdates.clear();
    void this.reconcileObserved(error).catch(() => {
      /* close reports failed reconciliation. */
    });
    if (this.active) {
      const job = this.active;
      job.reject(error);
      this.release(job);
    }
  }
  private reconcileObserved(error: unknown): Promise<void> {
    const observations = this.observedEffects.splice(0);
    const task = (async () => {
      let failure: unknown;
      for (const observed of observations) {
        try {
          await this.options.effects!.reconcile(
            observed.context,
            observed.result,
            error,
          );
        } catch (error) {
          failure ??= error;
        } finally {
          this.options.effects?.forget?.(observed.context);
        }
      }
      if (failure) throw failure;
    })();
    this.reconciliations.add(task);
    void task.then(
      () => this.reconciliations.delete(task),
      (error) => {
        this.cleanupFailure ??= error;
      },
    );
    return task;
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    for (const job of this.queue.splice(0)) {
      job.signal?.removeEventListener("abort", job.abort);
      job.reject(new Fault(503, "HTTP worker is closing before dispatch"));
    }
    this.queuedBytes = 0;
    this.closed = (async () => {
      if (!this.worker) return;
      try {
        await this.readiness;
      } catch {
        /* Failed startup still needs an exit. */
      }
      if (this.active)
        await new Promise<void>((resolve) => this.drained.push(resolve));
      try {
        await Promise.all(
          [...this.effects.values()].map((effect) => effect.task),
        );
        await Promise.all([...this.reconciliations]);
      } catch (error) {
        this.cleanupFailure ??= error;
      } finally {
        if (!this.exited) {
          if (this.failed || this.cleanupFailure) await this.worker.terminate();
          else {
            this.shutdownRequested = true;
            this.send({ kind: "close" });
          }
        }
        await this.exit;
      }
      if (this.cleanupFailure) throw this.cleanupFailure;
    })();
    return this.closed;
  }
}

/** Bind release before delivery, including compression errors and disconnected sockets. */
export function releaseWorkspaceResponse(
  response: ServerResponse,
  result: WorkspaceHttpResult,
) {
  const release = () => {
    response.removeListener("finish", release);
    response.removeListener("close", release);
    response.removeListener("error", release);
    result.release();
  };
  response.once("finish", release);
  response.once("close", release);
  response.once("error", release);
  if (response.destroyed || response.writableFinished) release();
}

/** Root integration owns listen-failure handling and deciding which server owns host.close. */
export type WorkspaceServerLifecycle = {
  server: Server;
  owned: boolean;
  host: WorkspaceHttpHost;
};
