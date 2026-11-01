import { check } from "./errors.ts";

/** Browser commands must name the history they reviewed. Trusted local tools
 * obtain their baseline through Store; cached clients cannot establish it
 * from a numeric revision alone after a restore. */
export function requireBrowserHistory(command: unknown): asserts command is Record<string, unknown> & { expectedGeneration: string } {
  check(command && typeof command === "object" && !Array.isArray(command), "Expected a command");
  check("expectedGeneration" in command && typeof command.expectedGeneration === "string" && command.expectedGeneration.length > 0,
    "This interface cannot confirm server history. Reload the current app before saving. Your local work remains on this device.", 409, "history-required");
}
