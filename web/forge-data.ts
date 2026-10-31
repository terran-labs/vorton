import type { State, Idea } from "./types";

type Record = State["goals"][number] | State["tasks"][number] | Idea;

// Built once per record-array identity, rather than once per input keystroke.
export function forgeIndex(state: State) {
  const records: Record[] = [
    ...state.goals,
    ...state.tasks,
    ...(state.ideas ?? []),
  ];
  const text = new Map(
    records.map((record) => [
      record,
      [
        record.title,
        record.owner,
        record.status,
        ...(record.projects ?? []),
        ...(record.tags ?? []),
        ...("description" in record
          ? [
              record.description,
              record.startCondition,
              record.experiment,
              record.evidence,
              record.original,
              record.reviewOn,
              record.value,
              record.complexity,
              record.effort,
              record.upkeep,
              record.confidence,
              record.pull,
              JSON.stringify(record.legacy ?? {}),
              JSON.stringify(record.history),
            ]
          : []),
        ...("intent" in record
          ? [
              record.intent,
              record.successCriteria,
              record.evidence,
              ...record.milestones.map((milestone) => milestone.title),
            ]
          : []),
        ...("notes" in record ? [record.notes] : []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    ]),
  );
  const facets = {
    project: [...new Set(records.flatMap((r) => r.projects ?? []))].sort(),
    tag: [...new Set(records.flatMap((r) => r.tags ?? []))].sort(),
  };
  const goals = new Map(state.goals.map((goal) => [goal.id, goal.title]));
  const origins = new Map<string, string>();
  for (const recommendation of state.recommendations) {
    if (recommendation.status === "accepted" && recommendation.resultId)
      origins.set(recommendation.resultId, recommendation.id);
  }
  const blocked = new Map<string, State["tasks"]>();
  for (const task of state.tasks) {
    if (task.status !== "blocked") continue;
    const tasks = blocked.get(task.goalId) ?? [];
    tasks.push(task);
    blocked.set(task.goalId, tasks);
  }
  return { text, facets, goals, origins, blocked };
}

export function filterForge(
  state: State,
  index: ReturnType<typeof forgeIndex>,
  query: string,
  project: string,
  tag: string,
): State & { ideas: Idea[] } {
  const needle = query.toLowerCase();
  const matches = (record: Record) =>
    (!project || record.projects?.includes(project)) &&
    (!tag || record.tags?.includes(tag)) &&
    (!needle || index.text.get(record)?.includes(needle));
  return {
    ...state,
    goals: state.goals.filter(matches),
    tasks: state.tasks.filter(matches),
    ideas: (state.ideas ?? []).filter(matches),
    // Council suggestions follow the same filters, matched on their proposed fields.
    recommendations: state.recommendations.filter((r) => {
      const proposal = (r.proposal ?? {}) as { [key: string]: unknown; projects?: string[]; tags?: string[] };
      const text = [proposal.title, proposal.description, proposal.intent, proposal.notes, r.rationale]
        .filter((value) => typeof value === "string").join(" ").toLowerCase();
      return (!project || proposal.projects?.includes(project)) &&
        (!tag || proposal.tags?.includes(tag)) && (!needle || text.includes(needle));
    }),
  };
}

export function groupIdeas(
  ideas: Idea[],
  group: string,
  stages: readonly string[],
) {
  const groups = new Map<string, Idea[]>();
  for (const idea of ideas) {
    const keys =
      group === "readiness"
        ? [idea.status]
        : group === "project"
          ? [...new Set(idea.projects.length ? idea.projects : ["No project"])]
          : ["All ideas"];
    for (const key of keys) {
      const items = groups.get(key) ?? [];
      items.push(idea);
      groups.set(key, items);
    }
  }
  const keys =
    group === "readiness"
      ? stages.filter((stage) => groups.has(stage))
      : group === "project"
        ? [...groups.keys()].sort()
        : [...groups.keys()];
  return keys.map((key) => ({ key, ideas: groups.get(key)! }));
}
