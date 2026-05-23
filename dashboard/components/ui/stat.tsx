import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "default" | "up" | "down" | "warning" | "muted";

const toneClass: Record<Tone, string> = {
  default: "text-text-primary",
  up: "text-up",
  down: "text-down",
  warning: "text-warning",
  muted: "text-text-secondary",
};

interface StatProps {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function Stat({ label, value, hint, tone = "default", size = "sm", className }: StatProps) {
  const valueSize =
    size === "lg" ? "text-lg" : size === "md" ? "text-sm" : "text-xs";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[10px] uppercase tracking-wider text-text-muted truncate">{label}</div>
      <div className={cn("font-semibold tabular leading-tight mt-0.5 truncate", valueSize, toneClass[tone])}>
        {value}
      </div>
      {hint != null && <div className="text-[10px] text-text-muted tabular mt-0.5 truncate">{hint}</div>}
    </div>
  );
}

interface StatGroupProps {
  children: React.ReactNode;
  className?: string;
  /** number of columns, defaults to auto-fit min 110px */
  cols?: number;
}

export function StatGroup({ children, className, cols }: StatGroupProps) {
  const colStyle = cols
    ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
    : { gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))" };
  return (
    <div
      style={colStyle}
      className={cn(
        "grid gap-x-4 gap-y-2 divide-x divide-border/40 [&>*]:px-3 [&>*:first-child]:pl-0",
        className
      )}
    >
      {children}
    </div>
  );
}
