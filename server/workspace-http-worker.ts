import { parentPort } from "node:worker_threads";
import { Fault } from "./store.ts";
import {
  PortableWorkspaceExecutor,
  httpError,
  WORKSPACE_HTTP_PROTOCOL,
} from "./workspace-http-runtime.ts";
import type {
  EffectDispatch,
  HostMessage,
  TuningEffectContext,
  TuningEffectResult,
  WorkerConfiguration,
  WorkerMessage,
  WorkspaceExecutor,
} from "./workspace-http-runtime.ts";

export type ExecutorFactory = (
  configuration: WorkerConfiguration,
  effects: EffectDispatch,
) => WorkspaceExecutor | Promise<WorkspaceExecutor>;
/** Only control replies/guards run while a top-level operation awaits effects. */
export function runWorkspaceWorker(factory: ExecutorFactory) {
  const port = parentPort;
  if (!port) throw Error("HTTP worker entry requires a worker thread");
  let executor: WorkspaceExecutor | undefined,
    active: { id: number; target: string } | undefined,
    sequence = 0;
  let initializing = false;
  let hostEpoch = "";
  const effects = new Map<
    number,
    {
      context: TuningEffectContext;
      resolve: (result: TuningEffectResult) => void;
      reject: (error: Error) => void;
    }
  >();
  const send = (message: WorkerMessage, transfer: ArrayBuffer[] = []) =>
    port.postMessage(message, transfer);
  const dispatch: EffectDispatch = async (target, effect) => {
    if (!active || target !== active.target)
      throw new Fault(403, "Effect does not belong to the active operation");
    const effectId = ++sequence,
      context = {
        ...effect,
        hostEpoch,
        effectId,
        operationId: active.id,
        target,
      };
    return new Promise<TuningEffectResult>((resolve, reject) => {
      effects.set(effectId, { context, resolve, reject });
      send({ kind: "effect", context });
    });
  };
  port.on("message", (message: HostMessage) => {
    if (message.kind === "admit-origin") {
      try {
        if (!executor) throw new Fault(503, "HTTP worker is not ready");
        executor.admitOrigin(message.target, message.origin);
        send({ kind: "origin.reply", id: message.id });
      } catch (error) {
        send({ kind: "origin.reply", id: message.id, error: httpError(error) });
      }
      return;
    }
    if (message.kind === "effect.reply") {
      const pending = effects.get(message.effectId);
      if (!pending) {
        send({
          kind: "fatal",
          error: { status: 500, message: "Unexpected effect reply" },
        });
        return;
      }
      effects.delete(message.effectId);
      if (message.error)
        pending.reject(
          new Fault(
            message.error.status,
            message.error.message,
            message.error.code,
          ),
        );
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.kind === "guard") {
      const pending = effects.get(message.effectId);
      void (async () => {
        try {
          if (
            !pending ||
            !active ||
            pending.context.operationId !== active.id ||
            !executor
          )
            throw new Fault(403, "Effect context is no longer active");
          await executor.guard(pending.context);
          send({
            kind: "guard.reply",
            id: message.id,
            effectId: message.effectId,
          });
        } catch (error) {
          send({
            kind: "guard.reply",
            id: message.id,
            effectId: message.effectId,
            error: httpError(error),
          });
        }
      })();
      return;
    }
    if (message.kind === "close") {
      if (active || initializing || effects.size) {
        send({
          kind: "fatal",
          error: { status: 500, message: "HTTP worker closed before draining" },
        });
        return;
      }
      port.close();
      return;
    }
    if (message.kind === "initialize") {
      if (message.protocol !== WORKSPACE_HTTP_PROTOCOL) {
        send({
          kind: "fatal",
          error: {
            status: 503,
            message: "HTTP worker protocol does not match",
            code: "http-worker-protocol",
          },
        });
        return;
      }
      if (executor || initializing) {
        send({
          kind: "fatal",
          error: { status: 500, message: "HTTP worker initialized twice" },
        });
        return;
      }
      initializing = true;
      hostEpoch = message.configuration.hostEpoch ?? "";
      void Promise.resolve()
        .then(() => factory(message.configuration, dispatch))
        .then(
          (value) => {
            executor = value;
            initializing = false;
            send({ kind: "ready", protocol: WORKSPACE_HTTP_PROTOCOL });
          },
          (error) => {
            initializing = false;
            send({ kind: "fatal", error: httpError(error) });
          },
        );
      return;
    }
    if (message.kind !== "execute" || !executor || active || initializing) {
      send({
        kind: "fatal",
        error: { status: 500, message: "Invalid HTTP worker operation state" },
      });
      return;
    }
    active = { id: message.id, target: message.target };
    const instance = executor;
    void Promise.resolve()
      .then(() => instance.execute(message.target, message.operation))
      .then(
        (value) => {
          active = undefined;
          send({ kind: "result", id: message.id, value }, [
            value.bytes.buffer as ArrayBuffer,
          ]);
        },
        (error) => {
          active = undefined;
          send({ kind: "error", id: message.id, error: httpError(error) });
        },
      );
  });
}

// The private entry imports the loop without starting the portable factory.
import { workerData } from "node:worker_threads";
if (parentPort && workerData?.entry === "portable")
  runWorkspaceWorker((configuration) => {
    if (configuration.targets.some((target) => target.kind !== "portable"))
      throw new Fault(403, "Private target in portable HTTP worker");
    return new PortableWorkspaceExecutor(configuration);
  });
