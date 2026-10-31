export type NativeRoute = { profile: string; page: string; forgeView?: string; adminSection?: string; redirect?: string; secondaryNavigation?: boolean };
const sections = ["bridge", "council", "forge", "finance", "tools", "admin"];
const adminSections = ["", "organization", "settings", "integrations", "integrations/omi", "exports", "activity", "decisions"];

// Private adapters register their own profiles and deeper routes. Unknown paths
// are rejected before a screen can request another workspace's records.
export function nativeRoute(pathname: string, profile: string): NativeRoute | null {
  const prefix = `/${profile.toLowerCase()}`;
  if (pathname === prefix || pathname === `${prefix}/`) return { profile, page: "bridge", redirect: `${prefix}/bridge` };
  if (!pathname.startsWith(`${prefix}/`)) return null;
  const parts = pathname.slice(prefix.length + 1).split("/");
  const page = parts[0];
  if (parts.length === 1 && ["goals", "tasks", "ideas", "opportunities"].includes(page)) return { profile, page: "forge", redirect: `${prefix}/forge/${page === "opportunities" ? "ideas" : page}` };
  if (page === "recommendations" && parts.length === 1) return { profile, page: "council", redirect: `${prefix}/council#recommendations` };
  if (page === "forge" && parts.length <= 2 && (!parts[1] || ["overview", "goals", "tasks", "ideas"].includes(parts[1]))) return { profile, page, forgeView: !parts[1] || parts[1] === "overview" ? "tasks" : parts[1], secondaryNavigation: true, ...(!parts[1] || parts[1] === "overview" ? { redirect: `${prefix}/forge/tasks` } : {}) };
  if (page === "admin") {
    const adminSection = parts.slice(1).join("/");
    const allowed = [...adminSections, ...(profile === "AubOS" ? ["council-tuning", "integrations/vorteo"] : [])];
    if (profile === "AubOS" && adminSection === "decisions") return null;
    return allowed.includes(adminSection) ? { profile, page, adminSection } : null;
  }
  if (parts.length === 1 && (sections.includes(page) || (profile === "FreedOS" && page === "factory"))) return { profile, page };
  return null;
}
