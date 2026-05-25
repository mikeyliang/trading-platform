import * as React from "react";
import { cn } from "@/lib/utils";
import { type LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 py-12 px-6 text-center",
        className,
      )}
    >
      {Icon && (
        <div className="w-9 h-9 rounded-full bg-surface-2 border border-border flex items-center justify-center mb-1">
          <Icon size={15} className="text-text-muted" strokeWidth={1.75} />
        </div>
      )}
      <p className="text-xs font-medium text-text-secondary">{title}</p>
      {description && (
        <p className="text-[11px] text-text-muted max-w-xs leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
