import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./viewport-rail.css";

/** Timeline-style mobile scrolling: viewport edges, content-aligned first item. */
export function ViewportRail({ children, className = "", label }: { children: ReactNode; className?: string; label: string }) {
  const origin = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const el = origin.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const scale = el.offsetWidth ? box.width / el.offsetWidth : 1;
      if (!scale) return;
      const width = document.documentElement.clientWidth;
      setGeometry({ "--rail-width": `${width / scale}px`, "--rail-offset": `${-box.left / scale}px`, "--rail-left": `${box.left / scale}px`, "--rail-right": `${Math.max(0, width - box.right) / scale}px` } as CSSProperties);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el); observer.observe(document.documentElement);
    window.addEventListener("resize", measure); measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  return <div className="viewport-rail-origin" ref={origin} style={geometry}>
    <div className={`viewport-rail ${className}`} role="group" aria-label={label} tabIndex={0}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.currentTarget.scrollLeft += event.key === "ArrowLeft" ? -150 : 150; } }}>
      {children}
    </div>
  </div>;
}
