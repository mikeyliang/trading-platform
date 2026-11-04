import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "default" | "up" | "down" | "warning" | "muted";

const toneClass: Record<Tone, string> = {
  default: "text-text-primary",
  up: "text-status-lime-text",
  down: "text-status-rose-text",
  warning: "text-status-yellow-text",
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

// Label over figure over hint, the BoardUI stat-card inner recipe.
export function Stat({ label, value, hint, tone = "default", size = "sm", className }: StatProps) {
  const valueSize =
    size === "lg" ? "text-title-2-semibold" : size === "md" ? "text-headline-semibold" : "text-body-semibold";
  return (
    <div className={cn("min-w-0 flex flex-col gap-0.5", className)}>
      <div className="text-caption-1-medium text-text-tertiary truncate">{label}</div>
      <div className={cn("tabular truncate", valueSize, toneClass[tone])}>{value}</div>
      {hint != null && <div className="text-caption-1-regular text-text-tertiary tabular truncate">{hint}</div>}
    </div>
  );
}

interface StatGroupProps {
  children: React.ReactNode;
  className?: string;
  /** number of columns, defaults to auto-fit min 120px */
  cols?: number;
}

export function StatGroup({ children, className, cols }: StatGroupProps) {
  const colStyle = cols
    ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
    : { gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" };
  return (
    <div style={colStyle} className={cn("grid gap-y-3 [&>*]:px-4 [&>*]:border-l [&>*]:border-separator-border-strong [&>*:first-child]:pl-0 [&>*:first-child]:border-l-0", className)}>
      {children}
    </div>
  );
}
