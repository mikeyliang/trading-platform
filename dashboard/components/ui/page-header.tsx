import * as React from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  eyebrow?: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

// Compact, IBKR-style page header. Single tight strip — no big marketing block.
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
}: PageHeaderProps) {
  const compact = !eyebrow && !description;
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border/40",
        compact ? "pb-1.5" : "pb-2 items-end",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[9px] uppercase tracking-wider text-text-muted mb-0.5">
            {eyebrow}
          </div>
        )}
        <h1 className="text-[12px] font-semibold text-text-primary leading-tight tracking-tight">
          {title}
        </h1>
        {description && (
          <p className="text-[11px] text-text-muted mt-0.5">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-1.5 shrink-0">{actions}</div>
      )}
    </div>
  );
}

// Dense default — was p-4/gap-4, now p-3/gap-3 to push more data on-screen.
export function PageShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 p-3 h-full overflow-y-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}
