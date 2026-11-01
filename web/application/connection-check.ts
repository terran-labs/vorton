import { readJsonWithDeadline } from "./profile-cache";

export type ConnectionResult = {
  browserOnline: boolean; reachable: boolean; admitted: boolean;
  serverMessage: string; sessionMessage: string; elapsedMs: number; checkedAt: number;
};

/** Checks this installation only. A browser network hint is not reachability. */
export async function checkConnection(fetcher: typeof fetch = (...args) => fetch(...args), browserOnline = navigator.onLine, milliseconds = 5000): Promise<ConnectionResult> {
  const started = Date.now();
  const [health, session] = await Promise.allSettled([
    readJsonWithDeadline("/api/health", fetcher, milliseconds),
    readJsonWithDeadline("/api/session", fetcher, milliseconds),
  ]);
  const server = health.status === "fulfilled" ? health.value as { status?: string; service?: string } : undefined;
  const admission = session.status === "fulfilled" ? session.value as { profiles?: unknown; installationId?: unknown } : undefined;
  const reachable = server?.status === "ready" && server.service === "vorton-local";
  const admitted = Boolean(admission && Array.isArray(admission.profiles) && typeof admission.installationId === "string");
  const detail = (result: PromiseSettledResult<unknown>) => result.status === "rejected" ? String(result.reason instanceof Error ? result.reason.message : "Request failed") : "Unexpected response from this address.";
  return {
    browserOnline, reachable: reachable || admitted, admitted,
    serverMessage: reachable ? "Vorton is reachable." : detail(health),
    sessionMessage: admitted ? "Workspace access is available." : detail(session),
    elapsedMs: Date.now() - started, checkedAt: Date.now(),
  };
}
