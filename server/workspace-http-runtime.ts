import { Store, check, Fault } from "./store.ts";
import type { Command, RuntimeState } from "./store.ts";
import { councilStateView } from "./council-state-view.ts";
import { replicaMetadata } from "./replica-metadata.ts";
import { councilPacket } from "./council.ts";
import { reviewPacket } from "./review.ts";
import { parseSyncRequest } from "../shared/sync-contract.ts";
import { requireBrowserHistory } from "./command-admission.ts";
type SyncRequest = ReturnType<typeof parseSyncRequest>;
export const WORKSPACE_HTTP_PROTOCOL = 1;

export type PortableHttpTarget = {
  id: string;
  kind: "portable";
  root: string;
  profiles: string[];
};
export type NativeHttpTarget = {
  id: string;
  kind: "native";
  root: string;
  profiles: string[];
  aubosDirectory: string;
  sourceRoot: string;
  privateDist: string;
  origin: string;
  additionalOrigins: string[];
};
export type WorkspaceHttpTarget = PortableHttpTarget | NativeHttpTarget;
export type WorkspaceOperation =
  | {
      kind: "state";
      profile: string;
      view?: "full" | "workspace" | "replica";
      councilSession?: string | null;
    }
  | { kind: "export"; profile: string; councilSession?: string | null }
  | { kind: "review"; profile: string; role?: string; session?: boolean }
  | { kind: "command"; profile: string; command: Command }
  | { kind: "sync"; profile: string; request: SyncRequest }
  | {
      kind: "changes";
      profile: string;
      after: number;
      head?: number;
      generation?: string;
    }
  | { kind: "tuning.status" | "tuning.recover" }
  | { kind: "tuning.workbench"; day?: string | null }
  | { kind: "tuning.save" | "tuning.start" | "tuning.cancel"; input: unknown }
  | {
      kind: "rolodex.request";
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: Uint8Array;
    };
export type WorkspaceHttpBytes = {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
};
export type WorkspaceHttpError = {
  status: number;
  message: string;
  code?: string;
};
export type TuningEffect = {
  kind: "launch" | "inspect" | "stop";
  runId: string;
  requestId: string;
  generation: string;
  agentId?: string;
};
export type TuningEffectContext = TuningEffect & {
  hostEpoch: string;
  operationId: number;
  effectId: number;
  target: string;
};
export type TuningEffectResult = { bytes?: Uint8Array; supervisorPid?: number };
export type WorkerConfiguration = {
  targets: WorkspaceHttpTarget[];
  effects: boolean;
  hostEpoch?: string;
};
export type HostMessage =
  | { kind: "initialize"; protocol: number; configuration: WorkerConfiguration }
  | {
      kind: "execute";
      id: number;
      target: string;
      operation: WorkspaceOperation;
    }
  | { kind: "guard"; id: number; effectId: number }
  | { kind: "admit-origin"; id: number; target: string; origin: string }
  | {
      kind: "effect.reply";
      effectId: number;
      result?: TuningEffectResult;
      error?: WorkspaceHttpError;
    }
  | { kind: "close" };
export type WorkerMessage =
  | { kind: "ready"; protocol: number }
  | { kind: "result"; id: number; value: WorkspaceHttpBytes }
  | { kind: "error"; id: number; error: WorkspaceHttpError }
  | { kind: "effect"; context: TuningEffectContext }
  | {
      kind: "guard.reply";
      id: number;
      effectId: number;
      error?: WorkspaceHttpError;
    }
  | { kind: "origin.reply"; id: number; error?: WorkspaceHttpError }
  | { kind: "fatal"; error: WorkspaceHttpError };
export interface WorkspaceExecutor {
  execute(
    target: string,
    operation: WorkspaceOperation,
  ): Promise<WorkspaceHttpBytes>;
  guard(context: TuningEffectContext): Promise<void>;
  admitOrigin(target: string, origin: string): void;
}
export type EffectDispatch = (
  target: string,
  effect: TuningEffect,
) => Promise<TuningEffectResult>;

export function httpError(error: unknown): WorkspaceHttpError {
  return error instanceof Fault
    ? {
        status: error.status,
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
      }
    : {
        status: 500,
        message: "Operation failed. Local records were not reset.",
      };
}
export function jsonBytes(
  value: unknown,
  headers: Record<string, string> = {},
): WorkspaceHttpBytes {
  return {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  };
}
export function publicWorkspace(
  state: RuntimeState,
  options?: Parameters<typeof councilStateView>[1],
) {
  const { requests, ...value } = state;
  return councilStateView(value, options);
}
export function validateTargets(targets: WorkspaceHttpTarget[]) {
  check(
    Array.isArray(targets) && targets.length > 0,
    "Missing HTTP worker targets",
  );
  const ids = new Set<string>();
  for (const target of targets) {
    check(
      target && /^[a-zA-Z0-9_-]{1,64}$/.test(target.id) && !ids.has(target.id),
      "Invalid HTTP worker target",
    );
    ids.add(target.id);
    check(
      ["portable", "native"].includes(target.kind) &&
        typeof target.root === "string" &&
        target.root.length > 0,
      "Invalid HTTP worker root",
    );
    check(
      Array.isArray(target.profiles) &&
        target.profiles.length > 0 &&
        target.profiles.every(
          (p) =>
            typeof p === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(p),
        ) &&
        new Set(target.profiles).size === target.profiles.length,
      "Invalid HTTP worker profiles",
    );
    if (target.kind === "native") {
      check(
        target.profiles.includes("AubOS") &&
          [
            target.aubosDirectory,
            target.sourceRoot,
            target.privateDist,
            target.origin,
          ].every((v) => typeof v === "string" && v.length > 0),
        "Invalid native worker configuration",
      );
      check(
        new URL(target.origin).origin === target.origin &&
          Array.isArray(target.additionalOrigins) &&
          target.additionalOrigins.every((v) => new URL(v).origin === v),
        "Invalid native worker origins",
      );
    }
  }
  check(
    targets.filter((t) => t.kind === "native").length <= 1,
    "Only one native installation per HTTP worker",
  );
}
export class PortableWorkspaceExecutor implements WorkspaceExecutor {
  protected targets: Map<string, WorkspaceHttpTarget>;
  protected stores: Map<string, Store>;
  constructor(configuration: WorkerConfiguration) {
    validateTargets(configuration.targets);
    this.targets = new Map(configuration.targets.map((t) => [t.id, t]));
    this.stores = new Map(
      configuration.targets.map((t) => [t.id, new Store(t.root, t.profiles)]),
    );
  }
  async guard(_context: TuningEffectContext): Promise<void> {
    throw new Fault(403, "Native effects are not configured");
  }
  admitOrigin(_target: string, _origin: string): void {
    throw new Fault(403, "Private origins are not configured");
  }
  async execute(
    targetId: string,
    operation: WorkspaceOperation,
  ): Promise<WorkspaceHttpBytes> {
    const target = this.targets.get(targetId),
      store = this.stores.get(targetId);
    check(target && store, "Unknown HTTP worker target", 404);
    check(
      operation &&
        typeof operation === "object" &&
        "profile" in operation &&
        target.profiles.includes(operation.profile),
      "Unknown installation",
      404,
    );
    switch (operation.kind) {
      case "changes":
        return jsonBytes(
          await store.changes(operation.profile, operation.after, 200, {
            head: operation.head,
            generation: operation.generation,
          }),
        );
      case "sync": {
        const request = parseSyncRequest(operation.request);
        return jsonBytes(
          await store.sync(operation.profile, request.operation, {
            generation: request.generation,
          }),
        );
      }
      case "command":
        requireBrowserHistory(operation.command);
        return jsonBytes(
          publicWorkspace(
            await store.command(operation.profile, operation.command),
          ),
        );
      case "review": {
        const state = await store.read(operation.profile);
        return jsonBytes(
          operation.session
            ? councilPacket(state)
            : reviewPacket(state, operation.role!),
        );
      }
      case "state": {
        check(
          operation.view === undefined ||
            ["full", "workspace", "replica"].includes(operation.view),
          "Unknown state view",
        );
        const state = publicWorkspace(
          await store.replicaState(operation.profile),
          { sessionId: operation.councilSession },
        );
        return jsonBytes(
          operation.view === "replica" ? replicaMetadata(state) : state,
        );
      }
      case "export":
        return jsonBytes(
          publicWorkspace(await store.read(operation.profile), {
            fullHistory: true,
            sessionId: operation.councilSession,
          }),
          {
            "content-disposition": `attachment; filename="${operation.profile}-goals-tasks.json"`,
          },
        );
      default:
        throw new Fault(400, "Unknown HTTP worker operation");
    }
  }
}
