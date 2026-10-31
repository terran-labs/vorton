import { useSyncExternalStore } from "react";
import { workspaceAccess } from "./offline-access.ts";
export { workspaceAccess } from "./offline-access.ts";
export type { WorkspaceAccessSnapshot, WorkspaceAccessTicket } from "./offline-access.ts";

export function useWorkspaceAccess() {
  return useSyncExternalStore(workspaceAccess.subscribe, workspaceAccess.getSnapshot, workspaceAccess.getSnapshot);
}
