import * as React from "react";
import { cn } from "@/lib/utils";

type IconComponent = React.ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

interface EmptyStateProps {
  icon?: IconComponent;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  /** Compact variant for dense panels (e.g. watchlist, options sidebar). */
  size?: "default" | "sm";
}

// Icon tile, one-line title, a sentence of help, one action. Centred in the
// region it describes so the empty state reads as part of that region.
export function EmptyState({ icon: Icon, title, description, action, className, size = "default" }: EmptyStateProps) {
  const compact = size === "sm";
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center text-center animate-fade-in",
        compact ? "gap-1.5 py-6 px-4" : "gap-2 py-12 px-6",
        className
      )}
    >
      {Icon && (
        <div
          className={cn(
            "rounded-2lg bg-background-secondary-default flex items-center justify-center mb-1 text-foreground-icon-secondary",
            compact ? "size-8" : "size-10"
          )}
        >
          <Icon size={compact ? 16 : 20} aria-hidden="true" />
        </div>
      )}
      <p className={cn("text-text-primary", compact ? "text-body-2-medium" : "text-body-medium")}>{title}</p>
      {description && (
        <p className={cn("text-text-tertiary", compact ? "text-caption-1-regular max-w-[220px]" : "text-body-2-regular max-w-xs")}>
          {description}
        </p>
      )}
      {action && <div className={cn(compact ? "mt-1" : "mt-2")}>{action}</div>}
    </div>
  );
}
