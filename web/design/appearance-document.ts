import { getAppearanceAttributes, type AppearanceId } from "./theme-registry";

export function applyAppearanceToDocument(next: AppearanceId) {
  const root = document.documentElement;
  Object.assign(root.dataset, getAppearanceAttributes(next));
  // Browser chrome needs an opaque color. Read the existing theme token rather
  // than duplicating palettes or passing the translucent header background.
  const color = getComputedStyle(root).getPropertyValue("--aub-background").trim();
  if (!color) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
  }
  meta.content = color;
}
