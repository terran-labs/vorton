import { workspaceAccess } from "./offline-access";
import { loadSession } from "./profile-cache";

/** Non-planning tools retain their existing writers. This boundary ensures a
 * saved page cannot submit with stale admission, or publish a late response.
 */
export async function beginLiveAction(profile: string) {
  const captured = workspaceAccess.getSnapshot();
  const ticket = { ...captured, profile };
  if (captured.managed) workspaceAccess.assertLive(ticket);
  const session = await loadSession(true);
  if (!session.profiles.includes(profile)) throw new Error("This workspace is no longer available.");
  if (captured.managed) {
    const identity = session as typeof session & { installationId?: string; variant?: string };
    workspaceAccess.assertLive(ticket);
    if (identity.installationId !== ticket.installationId || identity.variant !== ticket.variant) {
      throw new Error("The installation changed. Reopen this workspace before submitting.");
    }
  } else if (workspaceAccess.getSnapshot().managed) {
    throw new Error("Workspace admission changed. Reopen this tool before submitting.");
  }
  return {
    token: session.token,
    assertCurrent() {
      if (captured.managed) workspaceAccess.assertLive(ticket);
      else if (workspaceAccess.getSnapshot().managed) throw new Error("Workspace admission changed while the request was in progress.");
    },
  };
}
