import type { State } from "./types";

export type DraftSubmitResult =
  | { status: "saved" }
  | { status: "locally-saved"; operationId: string; recordId: string; version?: number; retainedEdits?: boolean; serverAccepted?: boolean; message: string }
  | { status: "blocked" | "conflict"; message: string }
  | { status: "unknown"; message: string; requestId: string };

export type DraftPreconditions = {
  basedOnRevision: number;
  entityVersion?: number;
  localRecordId?: string;
  syncGeneration?: string;
};
export type DraftAct = (action: string, payload: unknown, preconditions: DraftPreconditions,
  unknownRequestId?: string, prepareAttempt?: (requestId: string) => Promise<boolean>) => Promise<DraftSubmitResult>;

type Authority = {
  installationId: string | null;
  variant: "private" | "portable";
  profile: string | null;
  canWrite: boolean;
};
type Submission = {
  installationId: string;
  variant: Authority["variant"];
  profile: string;
  action: string;
  payload: unknown;
  token: string;
  preconditions?: DraftPreconditions;
  entityVersion?: () => number | undefined;
  unknownRequestId?: string;
  prepareAttempt?: (requestId: string) => Promise<boolean>;
  model: () => State | undefined;
  authority: () => Authority;
  assertLive: () => void;
  scopeCurrent: () => Promise<boolean>;
  commit: (state: State) => void | Promise<void>;
  fetcher?: typeof fetch;
};

export function checkDraftBaseline(
  revision: number,
  preconditions: DraftPreconditions,
  entityVersion?: number,
  syncGeneration?: string,
): DraftSubmitResult | undefined {
  // Legacy drafts can retain content digests; compare equality, not ordering.
  if (((syncGeneration !== undefined || preconditions.syncGeneration !== undefined) && preconditions.syncGeneration !== syncGeneration) || preconditions.basedOnRevision !== revision ||
      (preconditions.entityVersion !== undefined && preconditions.entityVersion !== entityVersion))
    return { status: "conflict", message: "Records changed since this draft began. Review current records before saving." };
}

function commandState(value: unknown, profile: string): State {
  const state = value as State | null;
  if (!state || state.profile !== profile || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      ![state.goals, state.tasks, state.recommendations, state.events].every(Array.isArray) ||
      (state.ideas !== undefined && !Array.isArray(state.ideas)))
    throw new Error("The server did not return a valid workspace confirmation.");
  if (state.canonical) {
    const canonical = state.canonical;
    if (typeof canonical !== "object" ||
        !("projection" in canonical
          ? canonical.projection === "workspace-v1" && ["governed-registers", "sqlite"].includes(canonical.source)
          : Array.isArray(canonical.goals) && Array.isArray(canonical.tasks)))
      throw new Error("The server returned an unsupported workspace confirmation.");
  }
  return state;
}

/** One explicit foreground attempt. No request storage, retry or replay. */
export async function submitExplicitCommand(input: Submission): Promise<DraftSubmitResult> {
  const unknown = (requestId: string, message = "We couldn’t confirm the save. Check current records before trying again."): DraftSubmitResult =>
    ({ status: "unknown", message, requestId });
  if (input.unknownRequestId) return unknown(input.unknownRequestId);
  const hasAuthority = () => {
    input.assertLive();
    const access = input.authority();
    return access.canWrite && access.installationId === input.installationId &&
      access.variant === input.variant && access.profile === input.profile;
  };
  try {
    if (!input.installationId || !input.token || !hasAuthority() || !await input.scopeCurrent() || !hasAuthority())
      return { status: "blocked", message: "Saving requires a current online session for this workspace. Your draft remains on this device." };
  } catch {
    return { status: "blocked", message: "Workspace authority could not be verified. Your draft has been retained." };
  }
  const state = input.model();
  if (!state || state.profile !== input.profile || !Number.isSafeInteger(state.revision) || state.revision < 0)
    return { status: "blocked", message: "Current records for this workspace are unavailable." };
  if (input.preconditions) {
    const conflict = checkDraftBaseline(state.revision, input.preconditions, input.entityVersion?.(), state.syncGeneration);
    if (conflict) return conflict;
  }
  const requestId = crypto.randomUUID();
  let body: string;
  try {
    body = JSON.stringify({ requestId, expectedRevision: state.revision, expectedGeneration: state.syncGeneration, action: input.action, payload: input.payload });
  } catch {
    return { status: "blocked", message: "The draft could not be prepared for saving." };
  }
  if (input.prepareAttempt) {
    try {
      if (!await input.prepareAttempt(requestId)) return { status: "blocked", message: "The attempt could not be safely saved on this device. Your text remains here; no command was sent." };
      if (!hasAuthority() || !await input.scopeCurrent() || !hasAuthority())
        return { status: "blocked", message: "Workspace authority changed before saving. No command was sent." };
      if (input.model()?.revision !== state.revision || input.model()?.syncGeneration !== state.syncGeneration)
        return { status: "conflict", message: "Records changed before saving. Review current records; no command was sent." };
    } catch {
      return { status: "blocked", message: "The attempt could not be prepared. No command was sent." };
    }
  }
  try {
    const response = await (input.fetcher ?? fetch)(`/api/${input.profile.toLowerCase()}/command`, {
      method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Vorton-Session": input.token }, body,
    });
    const value = await response.json();
    if (!response.ok) {
      const message = typeof value?.error === "string" && value.error.trim() ? value.error.slice(0, 2000) : undefined;
      // A proxy HTML error or server failure cannot prove the writer did not
      // commit. Only the application's explicit 4xx rejection is definitive.
      if (!message || response.status < 400 || response.status >= 500) return unknown(requestId);
      return { status: response.status === 409 ? "conflict" : "blocked", message };
    }
    const saved = commandState(value, input.profile);
    // The writer has confirmed this exact foreground request. Local admission
    // or cache failure cannot turn that acknowledgement into an unknown save.
    // Keep obsolete responses out of the cache without inviting another POST.
    try {
      if (hasAuthority() && await input.scopeCurrent() && hasAuthority()) await input.commit(saved);
    } catch {
      // The current read/reconciliation path owns recovery of local display.
    }
    return { status: "saved" };
  } catch {
    return unknown(requestId);
  }
}
