"use client";
import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleProps {
  title: React.ReactNode;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function Collapsible({
  title,
  defaultOpen = false,
  actions,
  className,
  children,
}: CollapsibleProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div
      className={cn("rounded-md border border-border bg-surface", className)}
    >
      <div className="flex items-center justify-between border-b border-border">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 px-3 py-2 flex-1 min-w-0 text-left hover:bg-surface-2 transition-colors"
        >
          <ChevronDown
            size={12}
            className={cn(
              "text-text-muted shrink-0 transition-transform",
              open ? "rotate-0" : "-rotate-90",
            )}
          />
          <div className="text-xs font-medium text-text-secondary uppercase tracking-wider truncate">
            {title}
          </div>
        </button>
        {actions && (
          <div className="flex items-center gap-1.5 pr-3 shrink-0">
            {actions}
          </div>
        )}
      </div>
      {open && <div className="p-3 animate-fade-in">{children}</div>}
    </div>
  );
}

interface SectionProps {
  title: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

export function Section({
  title,
  description,
  actions,
  className,
  bodyClassName,
  children,
}: SectionProps) {
  return (
    <section
      className={cn("rounded-md border border-border bg-surface", className)}
    >
      <header className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider truncate">
            {title}
          </h3>
          {description && (
            <p className="text-[11px] text-text-muted mt-0.5 truncate">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-1.5 shrink-0">{actions}</div>
        )}
      </header>
      <div className={cn("p-3", bodyClassName)}>{children}</div>
    </section>
  );
}
