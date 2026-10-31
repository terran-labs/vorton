import { useLayoutEffect } from "react";
import "./toolbar-heading-policy.css";

/** Apply the same rule to shared and retained private page-heading components.
 * Only the first page title can repeat navigation; section and record titles stay.
 */
export function useToolbarHeadingPolicy(href: string) {
  useLayoutEffect(() => {
    const marked = new Set<Element>();
    const clear = () => { for (const node of marked) node.classList.remove("toolbar-repeated-heading", "toolbar-repeated-caption", "toolbar-repeated-container"); marked.clear(); };
    const mark = (node: Element, name: string) => { node.classList.add(name); marked.add(node); };
    const reconcile = () => {
      clear();
      const heading = document.getElementById("workspace-main")?.querySelector("h1");
      if (!heading || heading.closest(".fg-goal-heading, .goal-dossier-heading, [data-record-heading]")) return;
      const normalize = (text: string | null) => text?.trim().replace(/\s+/g, " ").toLocaleLowerCase();
      const labels = [...document.querySelectorAll('.view-nav [aria-current="page"]')].map(node => normalize(node.textContent));
      if (!labels.includes(normalize(heading.textContent))) return;
      mark(heading, "toolbar-repeated-heading");
      const container = heading.closest(".vorton-page-heading, .page-heading, .tool-page-heading, .goal-index-title, .tasks-hero");
      if (!container) return;
      mark(container, "toolbar-repeated-container");
      for (const node of container.querySelectorAll(":scope > p, :scope > div > p")) mark(node, "toolbar-repeated-caption");
    };
    // Lazy screens and the secondary toolbar arrive after the shell. Attribute
    // mutations are excluded so our own presentation classes cannot loop.
    const observer = new MutationObserver(reconcile);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    reconcile();
    return () => { observer.disconnect(); clear(); };
  }, [href]);
}
