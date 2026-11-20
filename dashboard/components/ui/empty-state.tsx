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

// Minimal: a quiet icon, a one-line title, at most one short line of help
// and one action. No tile, no box; it sits in the region it describes.
export function EmptyState({ icon: Icon, title, description, action, className, size = "default" }: EmptyStateProps) {
  const compact = size === "sm";
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center text-center animate-fade-in",
        compact ? "gap-1 py-5 px-4" : "gap-1 py-10 px-6",
        className
      )}
    >
      {Icon && <Icon size={compact ? 18 : 20} className="mb-1.5 text-foreground-icon-tertiary" aria-hidden="true" />}
      <p className={cn("text-text-secondary", compact ? "text-body-2-medium" : "text-body-2-medium")}>{title}</p>
      {description && (
        <p className={cn("text-text-tertiary text-caption-1-regular", compact ? "max-w-[220px]" : "max-w-sm")}>
          {description}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
