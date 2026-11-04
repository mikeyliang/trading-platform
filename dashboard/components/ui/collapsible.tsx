"use client";
import * as React from "react";
import { RiArrowDownSLine as ChevronDown } from "@remixicon/react";
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
    <div className={cn("rounded-md border border-separator-border bg-background-primary-default", className)}>
      <div className="flex items-center justify-between border-b border-separator-border">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 px-3 py-2 flex-1 min-w-0 text-left hover:bg-background-secondary-hover transition-colors"
        >
          <ChevronDown
            size={14}
            className={cn(
              "text-text-tertiary shrink-0 transition-transform",
              open ? "rotate-0" : "-rotate-90"
            )}
          />
          <div className="text-caption-1-regular font-medium text-text-secondary truncate">
            {title}
          </div>
        </button>
        {actions && (
          <div className="flex items-center gap-1.5 pr-3 shrink-0">{actions}</div>
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
    <section className={cn("rounded-md border border-separator-border bg-background-primary-default", className)}>
      <header className="flex items-center justify-between gap-3 px-3 py-2 border-b border-separator-border">
        <div className="min-w-0">
          <h3 className="text-caption-1-regular font-medium text-text-secondary truncate">
            {title}
          </h3>
          {description && (
            <p className="text-caption-1-regular text-text-tertiary mt-0.5 truncate">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
      </header>
      <div className={cn("p-3", bodyClassName)}>{children}</div>
    </section>
  );
}
