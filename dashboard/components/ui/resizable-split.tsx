"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** Both children render in order. First gets flex-1, second has draggable height. */
  top: ReactNode;
  bottom: ReactNode;
  /** Initial pixel height of the bottom pane. */
  defaultBottomHeight?: number;
  /** Minimum pixel height for either pane. */
  minPx?: number;
  /** Persist height under this key in localStorage. */
  storageKey?: string;
  className?: string;
}

/**
 * Vertical split: top pane flexes to fill, bottom pane is a fixed pixel
 * height the user can drag. Persists to localStorage. No deps.
 */
export function ResizableSplit({
  top,
  bottom,
  defaultBottomHeight = 192,
  minPx = 80,
  storageKey,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>(() => {
    if (typeof window !== "undefined" && storageKey) {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const v = Number(raw);
        if (Number.isFinite(v) && v >= minPx) return v;
      }
    }
    return defaultBottomHeight;
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (storageKey && typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, String(height));
    }
  }, [height, storageKey]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxBottom = rect.height - minPx;
      const next = Math.max(minPx, Math.min(maxBottom, rect.bottom - e.clientY));
      setHeight(next);
    };
    const onUp = () => setDragging(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, minPx]);

  const containerStyle: CSSProperties = { height: "100%" };

  return (
    <div
      ref={containerRef}
      className={cn("flex flex-col min-h-0", className)}
      style={containerStyle}
    >
      <div className="flex-1 min-h-0 overflow-hidden">{top}</div>
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => setHeight(defaultBottomHeight)}
        className={cn(
          "relative h-1 shrink-0 cursor-row-resize group",
          "before:absolute before:inset-x-0 before:-top-1 before:-bottom-1 before:content-['']",
          dragging ? "bg-accent/60" : "bg-border hover:bg-accent/40 transition-colors"
        )}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Drag to resize"
        title="Drag to resize · double-click to reset"
      >
        <span
          className={cn(
            "absolute left-1/2 -translate-x-1/2 -top-0.5 h-2 w-10 rounded-full",
            "bg-border group-hover:bg-accent/30 transition-colors"
          )}
        />
      </div>
      <div style={{ height }} className="shrink-0 overflow-hidden">
        {bottom}
      </div>
    </div>
  );
}
