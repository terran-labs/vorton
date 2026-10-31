import React, { memo } from "react";
import type { Idea, TaskFields } from "./types";

// Only the explicitly selected card mounts rich content. Every summary remains
// in the document for native browser Find; application search covers full data.
export const ForgeIdeaCard = memo(function ForgeIdeaCard({
  idea,
  expanded,
  base,
  origin,
  goals,
  busy,
  select,
  edit,
  graduate,
  draftTask,
  anchor = true,
}: {
  idea: Idea;
  expanded: boolean;
  base: string;
  origin?: string;
  goals: Map<string, string>;
  busy: boolean;
  select: (id: string) => void;
  edit: (idea: Idea) => void;
  graduate: (idea: Idea) => void;
  draftTask: (fields: TaskFields) => void;
  anchor?: boolean;
}) {
  return (
    <article
      className="panel forge-card"
      id={anchor ? `idea-${idea.id}` : undefined}
    >
      <h3>
        <button
          className="title-button"
          aria-expanded={expanded}
          aria-controls={expanded ? `idea-detail-${idea.id}` : undefined}
          onClick={() => {
            select(expanded ? "" : idea.id);
            if (!anchor)
              requestAnimationFrame(() => {
                const card = document.getElementById(`idea-${idea.id}`);
                card?.scrollIntoView({ block: "nearest" });
                card
                  ?.querySelector<HTMLButtonElement>(".title-button")
                  ?.focus({ preventScroll: true });
              });
          }}
        >
          {idea.title}
        </button>
      </h3>
      <button className="forge-edit-idea" disabled={busy} onClick={() => edit(idea)}>Edit idea</button>
      <p className="quiet forge-summary-meta">
        {[
          idea.status,
          idea.owner,
          ...idea.projects,
          ...idea.tags.map((tag) => `#${tag}`),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <p className="prose">
        {idea.description.slice(0, 240) ||
          "An idea worth keeping. Add detail when you are ready."}
        {idea.description.length > 240 ? "…" : ""}
      </p>
      {expanded && (
        <div className="forge-detail" id={`idea-detail-${idea.id}`}>
          {idea.description.length > 240 && (
            <p className="prose">{idea.description}</p>
          )}
          {origin && (
            <p>
              <a
                href={`${base.split("/forge")[0]}/council#recommendation-${origin}`}
              >
                Council recommendation
              </a>
            </p>
          )}
          <dl className="forge-assessments">
            {Object.entries({
              Value: idea.value,
              Complexity: idea.complexity,
              Effort: idea.effort,
              Upkeep: idea.upkeep,
              Confidence: idea.confidence,
              Pull: idea.pull,
            }).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {idea.sourceChanged && (
            <p role="status">
              Source evidence changed. Current source details are shown; review
              your earlier edits in history.
            </p>
          )}
          {idea.startCondition && (
            <p className="prose">
              <strong>Start when:</strong> {idea.startCondition}
            </p>
          )}
          {idea.experiment && (
            <p className="prose">
              <strong>Smallest useful test:</strong> {idea.experiment}
            </p>
          )}
          {idea.reviewOn && <p>Review {idea.reviewOn}</p>}
          {idea.evidence && (
            <p className="prose">
              <strong>Evidence and value notes:</strong> {idea.evidence}
            </p>
          )}
          {idea.goalIds.map((id) => (
            <a key={id} href={`${base}/goals#goal-${id}`}>
              {goals.get(id) ?? "Linked goal"}
            </a>
          ))}
          <details>
            <summary>Original capture and history</summary>
            <p className="prose">{idea.original}</p>
            {idea.legacy && <pre>{JSON.stringify(idea.legacy, null, 2)}</pre>}
            {idea.history.map((h) => (
              <details key={h.version}>
                <summary>Version {h.version}</summary>
                <pre>{JSON.stringify(h.fields, null, 2)}</pre>
              </details>
            ))}
          </details>
          <div className="actions">
            {!["graduated", "archived"].includes(idea.status) && (
              <button disabled={busy} onClick={() => graduate(idea)}>
                Graduate to goal
              </button>
            )}
            {idea.experiment && (
              <button
                onClick={() =>
                  draftTask({
                    title: idea.experiment.slice(0, 180),
                    notes: idea.experiment,
                    owner: idea.owner,
                    goalId: "",
                    ideaIds: [idea.id],
                    projects: idea.projects,
                    tags: idea.tags,
                    dueOn: "",
                    status: "todo",
                    priority: "normal",
                  })
                }
              >
                Draft experiment
              </button>
            )}
            <a href={`${base}/ideas#idea-${idea.id}`}>Idea link</a>
          </div>
        </div>
      )}
    </article>
  );
});
