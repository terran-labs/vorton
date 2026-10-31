import React, { useEffect, useRef, useState, type ComponentType } from "react";
import "./idea-capture.css";
import { CaptureButton } from "./capture-button";
import { useBrowserLocation } from "./application/browser-router";

type CaptureForm = ComponentType<{ profile: "AubOS"; onSaved: () => void }>;
let prepared: Promise<CaptureForm> | undefined;
function prepare() {
  // Intent downloads code only. The form owns the planning read when opened.
  return prepared ??= import("./idea-capture-form").then(module => module.default).catch(error => {
    prepared = undefined;
    throw error;
  });
}

/** Shell overlay: no editor, authority, or planning dependency on mount. */
export function AubosCapture({ profile }: { profile: "AubOS" }) {
  const forge = /^\/aubos\/forge(?:\/|[?#]|$)/.test(useBrowserLocation());
  const [open, setOpen] = useState(false);
  const [Form, setForm] = useState<CaptureForm>();
  const [error, setError] = useState("");
  const launcher = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const close = () => { generation.current++; setOpen(false); launcher.current?.focus({ preventScroll: true }); };
  useEffect(() => () => { generation.current++; }, []);
  const load = () => {
    setError("");
    void prepare().then(component => setForm(() => component)).catch(() => setError("The capture form could not load."));
  };
  useEffect(() => {
    if (!open) return;
    load();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) { generation.current++; setOpen(false); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    };
    document.addEventListener("pointerdown", outside);
    root.current?.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      root.current?.removeEventListener("keydown", escape);
    };
  }, [open]);
  const openedGeneration = generation.current;
  return <div className="aubos-capture" ref={root}>
    {open && <section className="aubos-capture-card" role="dialog" aria-modal="false" aria-labelledby="aubos-capture-heading" id="aubos-capture-card">
      <header><h2 id="aubos-capture-heading">Capture</h2><button type="button" aria-label="Close capture" onClick={close}>×</button></header>
      {Form ? <Form profile={profile} onSaved={() => { if (generation.current === openedGeneration) close(); }} />
        : error ? <div role="alert"><p>{error}</p><button type="button" onClick={load}>Retry capture form</button></div>
        : <p role="status">Opening capture…</p>}
    </section>}
    {!forge && <CaptureButton ref={launcher} aria-label="Capture"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "aubos-capture-card" : undefined}
      onPointerEnter={() => { void prepare().catch(() => {}); }} onFocus={() => { void prepare().catch(() => {}); }}
      onClick={() => { generation.current++; setOpen(value => !value); }} />}
  </div>;
}
