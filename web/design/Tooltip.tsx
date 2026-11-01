"use client";
// Adapted from Freed packages/ui/src/components/Tooltip.tsx; see SOURCE.md.
import "./tooltip.css";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  cloneElement,
  type ReactElement,
  type PointerEvent,
  type ReactNode,
  type CSSProperties,
  type FocusEvent,
  type HTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  asChild?: boolean;
  label: string;
  description?: string;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  triggerStyle?: CSSProperties;
  badge?: ReactNode;
  content?: ReactNode;
  onDismiss?: () => void;
  onOpen?: () => void;
}

interface TooltipPosition {
  left: number;
  top: number;
  arrowLeft: number;
  arrowTop: number;
  placement: "top" | "bottom" | "left" | "right";
  ready: boolean;
}

const TOOLTIP_OFFSET = 12;
const VIEWPORT_PADDING = 12;
const TOOLTIP_ARROW_INSET = 18;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function Tooltip({
  children,
  label,
  description,
  shortcut,
  side = "bottom",
  className = "",
  triggerStyle,
  badge,
  content,
  onDismiss,
  onOpen,
  asChild = false,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({
    left: 0,
    top: 0,
    arrowLeft: TOOLTIP_ARROW_INSET,
    arrowTop: TOOLTIP_ARROW_INSET,
    placement: side,
    ready: false,
  });
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const pointerDownRef = useRef(false);
  const suppressHoverRef = useRef(false);
  const focusedRef = useRef(false);
  const hoveredRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();

  const cancelClose = () => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const closeTooltip = () => {
    cancelClose();
    setOpen(false);
    onDismiss?.();
  };
  const closeWhenIdle = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      if (!focusedRef.current && !hoveredRef.current) closeTooltip();
    }, 150);
  };

  useEffect(() => {
    setMounted(true);
    return cancelClose;
  }, []);

  const updatePosition = () => {
    if (!triggerRef.current || !tooltipRef.current) {
      return;
    }

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const roomAbove = triggerRect.top - VIEWPORT_PADDING;
    const roomBelow = viewportHeight - triggerRect.bottom - VIEWPORT_PADDING;

    const roomLeft = triggerRect.left - VIEWPORT_PADDING;
    const roomRight = viewportWidth - triggerRect.right - VIEWPORT_PADDING;
    const fitsAbove = roomAbove >= tooltipRect.height + TOOLTIP_OFFSET;
    const fitsBelow = roomBelow >= tooltipRect.height + TOOLTIP_OFFSET;
    const fitsLeft = roomLeft >= tooltipRect.width + TOOLTIP_OFFSET;
    const fitsRight = roomRight >= tooltipRect.width + TOOLTIP_OFFSET;

    let placement: "top" | "bottom" | "left" | "right" = side;

    if (side === "top" && !fitsAbove) {
      placement = fitsBelow ? "bottom" : roomBelow >= roomAbove ? "bottom" : "top";
    } else if (side === "bottom" && !fitsBelow) {
      placement = fitsAbove ? "top" : roomBelow >= roomAbove ? "bottom" : "top";
    } else if (side === "right" && !fitsRight) {
      placement = fitsLeft ? "left" : roomRight >= roomLeft ? "right" : "left";
    } else if (side === "left" && !fitsLeft) {
      placement = fitsRight ? "right" : roomRight >= roomLeft ? "right" : "left";
    }

    let left = 0;
    let top = 0;
    let arrowLeft = TOOLTIP_ARROW_INSET;
    let arrowTop = TOOLTIP_ARROW_INSET;

    if (placement === "top" || placement === "bottom") {
      const desiredLeft = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
      const maxLeft = Math.max(VIEWPORT_PADDING, viewportWidth - VIEWPORT_PADDING - tooltipRect.width);
      left = clamp(desiredLeft, VIEWPORT_PADDING, maxLeft);

      const desiredTop =
        placement === "top"
          ? triggerRect.top - tooltipRect.height - TOOLTIP_OFFSET
          : triggerRect.bottom + TOOLTIP_OFFSET;
      const maxTop = Math.max(VIEWPORT_PADDING, viewportHeight - VIEWPORT_PADDING - tooltipRect.height);
      top = clamp(desiredTop, VIEWPORT_PADDING, maxTop);

      arrowLeft = clamp(
        triggerRect.left + triggerRect.width / 2 - left,
        TOOLTIP_ARROW_INSET,
        Math.max(TOOLTIP_ARROW_INSET, tooltipRect.width - TOOLTIP_ARROW_INSET),
      );
    } else {
      const desiredLeft =
        placement === "right"
          ? triggerRect.right + TOOLTIP_OFFSET
          : triggerRect.left - tooltipRect.width - TOOLTIP_OFFSET;
      const maxLeft = Math.max(VIEWPORT_PADDING, viewportWidth - VIEWPORT_PADDING - tooltipRect.width);
      left = clamp(desiredLeft, VIEWPORT_PADDING, maxLeft);

      const desiredTop = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
      const maxTop = Math.max(VIEWPORT_PADDING, viewportHeight - VIEWPORT_PADDING - tooltipRect.height);
      top = clamp(desiredTop, VIEWPORT_PADDING, maxTop);

      arrowTop = clamp(
        triggerRect.top + triggerRect.height / 2 - top,
        TOOLTIP_ARROW_INSET,
        Math.max(TOOLTIP_ARROW_INSET, tooltipRect.height - TOOLTIP_ARROW_INSET),
      );
    }

    setPosition((current) => {
      const next = {
        left: Math.round(left),
        top: Math.round(top),
        arrowLeft: Math.round(arrowLeft),
        arrowTop: Math.round(arrowTop),
        placement,
        ready: true,
      };

      if (
        current.left === next.left &&
        current.top === next.top &&
        current.arrowLeft === next.arrowLeft &&
        current.arrowTop === next.arrowTop &&
        current.placement === next.placement &&
        current.ready === next.ready
      ) {
        return current;
      }

      return next;
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      return undefined;
    }

    let frameId = window.requestAnimationFrame(() => {
      updatePosition();
    });

    const dismissTooltip = () => {
      focusedRef.current = false;
      hoveredRef.current = false;
      closeTooltip();
    };
    const refreshPosition = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        updatePosition();
      });
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            refreshPosition();
          });

    if (triggerRef.current) {
      resizeObserver?.observe(triggerRef.current);
    }
    if (tooltipRef.current) {
      resizeObserver?.observe(tooltipRef.current);
    }

    window.addEventListener("scroll", refreshPosition, true);
    window.addEventListener("resize", refreshPosition);
    window.addEventListener("blur", dismissTooltip);
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Every open tooltip must cancel, including independently focused and hovered swatches.
      event.stopPropagation();
      dismissTooltip();
    };
    document.addEventListener("keydown", dismissWithKeyboard, true);
    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("scroll", refreshPosition, true);
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("blur", dismissTooltip);
      document.removeEventListener("keydown", dismissWithKeyboard, true);
    };
  }, [badge, content, description, label, open, shortcut, side, onDismiss]);

  const openTooltip = () => {
    cancelClose();
    if (!open) setPosition((current) => ({ ...current, placement: side, ready: false }));
    setOpen(true);
    onOpen?.();
  };

  const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
    triggerRef.current = event.currentTarget;
    if (event.pointerType === "touch" || suppressHoverRef.current) {
      return;
    }

    hoveredRef.current = true;
    openTooltip();
  };

  const handlePointerLeave = () => {
    suppressHoverRef.current = false;
    hoveredRef.current = false;
    closeWhenIdle();
  };

  const handlePointerDown = () => {
    pointerDownRef.current = true;
    suppressHoverRef.current = true;
    focusedRef.current = false;
    hoveredRef.current = false;
    closeTooltip();
  };

  const handleFocus = (event: FocusEvent<HTMLElement>) => {
    triggerRef.current = event.currentTarget;
    if (!(event.target instanceof HTMLElement) || !event.target.matches(":focus-visible")) {
      return;
    }

    if (pointerDownRef.current) {
      return;
    }

    focusedRef.current = true;
    openTooltip();
  };

  const handleBlur = () => {
    pointerDownRef.current = false;
    suppressHoverRef.current = false;
    focusedRef.current = false;
    if (!hoveredRef.current) closeTooltip();
  };

  const tooltipStyle = {
    ...(content ? { padding: 0, maxWidth: "calc(100vw - 1.5rem)", borderRadius: "1rem" } : {}),
    left: `${position.left}px`,
    top: `${position.top}px`,
    visibility: position.ready ? "visible" : "hidden",
    "--theme-tooltip-arrow-left": `${position.arrowLeft}px`,
    "--theme-tooltip-arrow-top": `${position.arrowTop}px`,
  } as CSSProperties;

  const describedChild = cloneElement(children, {
    "aria-describedby": [children.props["aria-describedby"], open ? tooltipId : undefined].filter(Boolean).join(" ") || undefined,
  });
  // A details element needs its summary as a direct child. Keep that native
  // structure and the child's ref and activation handlers when adding help.
  const trigger = asChild ? cloneElement(describedChild, {
    className: [children.props.className, className].filter(Boolean).join(" "),
    style: { ...children.props.style, ...triggerStyle },
    onPointerEnter: event => { children.props.onPointerEnter?.(event); handlePointerEnter(event); },
    onPointerLeave: event => { children.props.onPointerLeave?.(event); handlePointerLeave(); },
    onPointerDown: event => { children.props.onPointerDown?.(event); handlePointerDown(); },
    onFocus: event => { children.props.onFocus?.(event); handleFocus(event); },
    onBlur: event => { children.props.onBlur?.(event); handleBlur(); },
  }) : (
      <span
        className={["theme-tooltip-trigger", className].filter(Boolean).join(" ")}
        style={triggerStyle}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        {describedChild}
      </span>
  );

  return (
    <>
      {trigger}
      {mounted && open
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              data-placement={position.placement}
              className="theme-tooltip-panel"
              style={tooltipStyle}
              onPointerEnter={() => { hoveredRef.current = true; cancelClose(); }}
              onPointerLeave={() => { hoveredRef.current = false; closeWhenIdle(); }}
            >
              {badge ? <span className="theme-tooltip-badge">{badge}</span> : null}
              {content ?? <div className="theme-tooltip-body">
                <span className="theme-tooltip-label">
                  {label}
                  {shortcut ? <kbd className="theme-tooltip-shortcut">{shortcut}</kbd> : null}
                </span>
                {description ? (
                  <span className="theme-tooltip-description">{description}</span>
                ) : null}
              </div>}
              <span
                className={`theme-tooltip-arrow ${
                  position.placement === "top"
                    ? "theme-tooltip-arrow-top"
                    : position.placement === "bottom"
                      ? "theme-tooltip-arrow-bottom"
                      : position.placement === "right"
                        ? "theme-tooltip-arrow-right"
                        : "theme-tooltip-arrow-left"
                }`}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
