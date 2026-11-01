// Navigation must remain usable before workspace rendering modules load.
export const workspaceSections = [
  "bridge",
  "council",
  "forge",
  "finance",
  "tools",
  "admin",
];

export const workspaceLinks = (profile: string) =>
  workspaceSections.map((id) => ({
    id,
    label: id[0].toUpperCase() + id.slice(1),
    path: `/${profile.toLowerCase()}/${id}`,
  }));
