import { profileReplica } from "./profile-cache";

export async function downloadLocalChanges(profile: string) {
  const data = await profileReplica.exportDevice(profile);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = "vorton-local-changes.json"; link.hidden = true;
  document.body.append(link);
  try { link.click(); } finally { link.remove(); }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
