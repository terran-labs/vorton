export type UpdateSafety = { edited: boolean; blocked: boolean };
const draftWrites = new Set<Promise<unknown>>();
const changedEvent = "vorton:draft-write-state";

/** Closing an editor can leave its final serialized draft write in progress. */
export function trackDraftWrite<T>(task: Promise<T>): Promise<T> {
  const notify = () => { if (typeof document !== "undefined") document.dispatchEvent(new Event(changedEvent)); };
  draftWrites.add(task); notify();
  const settled = () => { draftWrites.delete(task); notify(); };
  void task.then(settled, settled);
  return task;
}

/** Editors publish their own unsent state. Other edited controls stay protected
 * until reset or removal. Only explicitly marked view controls are exempt. */
export function observeUpdateSafety(report: (state: UpdateSafety) => void): () => void {
  const edited = new Set<Element>();
  const blocked = () => document.visibilityState === "hidden" ||
    Boolean(document.activeElement?.matches("input, textarea, select, [contenteditable=true]") || document.querySelector('dialog[open], [role="dialog"]'));
  const refresh = () => {
    for (const element of edited) if (!element.isConnected || element.getAttribute("data-vorton-unsaved") === "false") edited.delete(element);
    report({ edited: draftWrites.size > 0 || edited.size > 0 || Boolean(document.querySelector('[data-vorton-unsaved="true"]')), blocked: blocked() });
  };
  const changed = (event: Event) => {
    if (!(event.target instanceof Element) || event.target.closest("#connection-status-panel")) return;
    const editor = event.target.closest("[data-vorton-unsaved]") ?? (event.target.closest("[data-vorton-view-control]") ? null
      : event.target.closest("form, [contenteditable=true]") ?? event.target.closest("input, textarea, select"));
    if (editor) {
      edited.add(editor);
      // Protect this event immediately, before React publishes its draft state.
      report({ edited: true, blocked: blocked() });
    }
    queueMicrotask(refresh);
  };
  const reset = (event: Event) => queueMicrotask(() => {
    if (!event.defaultPrevented && event.target instanceof Element) edited.delete(event.target);
    refresh();
  });
  const focus = () => queueMicrotask(refresh);
  const observer = new MutationObserver(refresh);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-vorton-unsaved", "open"] });
  for (const type of ["input", "change"]) document.addEventListener(type, changed, true);
  for (const type of ["focusin", "focusout", "close"]) document.addEventListener(type, focus, true);
  document.addEventListener("reset", reset, true);
  document.addEventListener("visibilitychange", refresh);
  document.addEventListener(changedEvent, refresh);
  refresh();
  return () => {
    observer.disconnect();
    for (const type of ["input", "change"]) document.removeEventListener(type, changed, true);
    for (const type of ["focusin", "focusout", "close"]) document.removeEventListener(type, focus, true);
    document.removeEventListener("reset", reset, true);
    document.removeEventListener("visibilitychange", refresh);
    document.removeEventListener(changedEvent, refresh);
  };
}
