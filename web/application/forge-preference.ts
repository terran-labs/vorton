// Forge always opens Tasks. Old preferences no longer override its entry point.
export function rememberedForgePath(pathname: string, profile: string, read: (key: string) => string | null = key => localStorage.getItem(key)) {
  const base = `/${profile.toLowerCase()}/forge`;
  if (pathname !== base) return;
  return `${base}/tasks`;
}
