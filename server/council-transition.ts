import type { RuntimeState, Command } from "./store.ts";
// Internal bridge called by the authoritative adapter while its writer lease is held.
import { loadCouncil } from "../modules/council/config.ts";
import { publishCouncil } from "./council.ts";
import { importRecommendations } from "./review.ts";
import { applyCommand } from "./store.ts";
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const { state, command } = JSON.parse(input) as { state: RuntimeState; command: Command };
  state.council = await loadCouncil(process.argv[2], state.profile);
  let planning = null;
  if (command.action === "council.publish") publishCouncil(state, command.payload);
  else if (command.action === "recommendations.import") importRecommendations(state, command.payload);
  else if (command.action.startsWith("idea.") || command.action === "recommendation.resolve") {
    const result = applyCommand(state, command) as { id: string; status?: string; kind: string; resultId?: string; targetId?: string };
    if (command.action === "idea.graduate" || (result.status === "accepted" && !["idea", "idea-review"].includes(result.kind))) {
      const kind = command.action === "idea.graduate" || result.kind === "idea-graduate" || result.kind.startsWith("goal") ? "goal" : "task";
      if (command.action === "idea.graduate") result.resultId = result.id;
      const saved = state[kind === "goal" ? "goals" : "tasks"].find(x => x.id === result.resultId)! as (RuntimeState["goals"][number] | RuntimeState["tasks"][number]) & { origin?: string; resultId?: string };
      const { id, version, history, createdAt, updatedAt, origin, ...fields } = saved;
      delete fields.resultId;
      const update = command.action === "idea.graduate" ? Boolean(command.payload!.goalId) : result.kind.endsWith("-review");
      planning = { action: `${kind}.${update ? "update" : "create"}`, payload: { id: command.action === "idea.graduate" ? command.payload!.goalId : result.targetId, fields }, temporaryId: id, recommendationId: command.action === "recommendation.resolve" ? result.id : null };
    }
  } else throw new Error("Unsupported council transition");
  console.log(JSON.stringify({ ideas: state.ideas ?? [], recommendations: state.recommendations, councilSessions: state.councilSessions ?? [], planning }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
