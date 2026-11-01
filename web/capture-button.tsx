import React, { useLayoutEffect, useRef, type ComponentProps } from "react";

// Shell and Forge own different actions. Carry only presentation across their
// immediate handoff so navigation can animate without sharing editor state.
let previous = { label: "", width: 56, at: 0 };

export function CaptureButton({ label = "", ref, ...props }: ComponentProps<"button"> & { label?: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const outgoing = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = button.current!, incoming = text.current!, old = outgoing.current!;
    const width = label ? 17 + 24 + 9 + incoming.getBoundingClientRect().width + 22 : 56;
    const from = performance.now() - previous.at < 500 ? previous : { label, width, at: 0 };
    el.style.width = `${width}px`;
    old.textContent = from.label;
    const animations: Animation[] = [];
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches && from.label !== label) {
      const timing = { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" };
      animations.push(el.animate([{ width: `${from.width}px` }, { width: `${width}px` }], timing));
      animations.push(incoming.animate([{ opacity: 0 }, { opacity: 1 }], timing));
      animations.push(old.animate([{ opacity: 1 }, { opacity: 0 }], timing));
    }
    return () => {
      previous = { label, width: el.getBoundingClientRect().width, at: performance.now() };
      animations.forEach(animation => animation.cancel());
    };
  }, [label]);
  return <button {...props} ref={node => {
    button.current = node;
    if (typeof ref === "function") return ref(node);
    if (ref) ref.current = node;
  }} className="aubos-capture-plus capture-transition" type="button" aria-label={props["aria-label"] ?? label}>
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
    <span ref={outgoing} className="capture-label capture-label-out" aria-hidden="true" />
    <span ref={text} className="capture-label" aria-hidden="true">{label}</span>
  </button>;
}
