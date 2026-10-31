import type { WorkspaceLink } from "../design/workspace-navigation";

const views = ["tasks", "goals", "ideas"] as const;

// Keep shell navigation independent of Forge's editor and rendering modules.
export function forgeNavigation(profile: string, view: string | undefined, search: string): { page: string; links: WorkspaceLink[] } {
  const parameters = new URLSearchParams(search);
  const filters = new URLSearchParams();
  for (const key of ["q", "project", "tag"]) {
    const value = parameters.get(key);
    if (value) filters.set(key, value);
  }
  const suffix = filters.size ? `?${filters}` : "";
  return {
    page: views.includes(view as typeof views[number]) ? view! : "tasks",
    links: views.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), path: `/${profile.toLowerCase()}/forge/${id}${suffix}` })),
  };
}
