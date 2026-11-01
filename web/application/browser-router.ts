import { useSyncExternalStore } from "react";

export const NAVIGATION_EVENT = "vorton:navigation";
let routerSubscribers = 0;
const subscribe = (listener: () => void) => {
  routerSubscribers++;
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  window.addEventListener(NAVIGATION_EVENT, listener);
  return () => {
    routerSubscribers--;
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
    window.removeEventListener(NAVIGATION_EVENT, listener);
  };
};
export function useBrowserLocation() {
  return useSyncExternalStore(subscribe, () => location.pathname + location.search + location.hash);
}
export function navigate(href: string, options: { replace?: boolean } = {}) {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) throw new Error("Navigation must remain on this origin");
  // The retained companion has no shared application router. Its rollback
  // screens still need document navigation when crossing framework pages.
  if (!routerSubscribers) {
    location[options.replace ? "replace" : "assign"](url.href);
    return;
  }
  const previousHash = location.hash;
  history[options.replace ? "replaceState" : "pushState"](history.state, "", url);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
  if (previousHash !== url.hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function ordinaryClick(event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
