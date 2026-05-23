import * as React from "react";
import { cn } from "@/lib/utils";
import { type LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  /** Compact variant for dense panels (e.g. watchlist, options sidebar). */
  size?: "default" | "sm";
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  size = "default",
}: EmptyStateProps) {
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
            "rounded-full bg-surface-2 border border-border flex items-center justify-center mb-1",
            compact ? "w-7 h-7" : "w-9 h-9"
          )}
        >
          <Icon
            size={compact ? 13 : 15}
            className="text-text-muted"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </div>
      )}
      <p className={cn("font-medium text-text-secondary", compact ? "text-[11px]" : "text-xs")}>
        {title}
      </p>
      {description && (
        <p
          className={cn(
            "text-text-muted leading-relaxed",
            compact ? "text-[10px] max-w-[200px]" : "text-[11px] max-w-xs"
          )}
        >
          {description}
        </p>
      )}
      {action && <div className={cn(compact ? "mt-1" : "mt-2")}>{action}</div>}
    </div>
  );
}
