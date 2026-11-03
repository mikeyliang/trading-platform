"use client";
import * as React from "react";
import { RiCloseLine as X, RiEqualizerLine as SlidersHorizontal, RiSearchLine as Search } from "@remixicon/react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

interface FilterBarProps {
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  };
  /** Active filter chips (label + onRemove) */
  chips?: { key: string; label: string; onRemove: () => void }[];
  /** Children render advanced filters in the disclosure panel */
  advanced?: React.ReactNode;
  /** Right-aligned actions, always visible */
  actions?: React.ReactNode;
  className?: string;
  defaultAdvancedOpen?: boolean;
}

export function FilterBar({
  search,
  chips,
  advanced,
  actions,
  className,
  defaultAdvancedOpen = false,
}: FilterBarProps) {
  const [open, setOpen] = React.useState(defaultAdvancedOpen);
  const hasChips = chips && chips.length > 0;
  return (
    <div
      className={cn(
        "rounded-2lg bg-background-secondary-default flex flex-col",
        className
      )}
    >
      <div className="flex items-center gap-2 p-2 flex-wrap">
        {search && (
          <div className="relative flex-1 min-w-[180px]">
            <Search
              size={16}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-icon-tertiary pointer-events-none"
            />
            <Input
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder ?? "Search..."}
              className="pl-8 bg-background-primary-default"
            />
          </div>
        )}
        {hasChips && (
          <div className="flex items-center gap-1 flex-wrap">
            {chips!.map((c) => (
              <button
                key={c.key}
                onClick={c.onRemove}
                className="inline-flex items-center gap-1 rounded-md bg-status-blue-background text-status-blue-text text-caption-1-medium px-1.5 h-6 transition-colors hover:brightness-95"
              >
                <span className="truncate max-w-[140px]">{c.label}</span>
                <X size={14} />
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1 ml-auto">
          {advanced && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1 h-8 rounded-lg border border-separator-border-button-default bg-background-primary-default hover:bg-background-primary-hover text-body-2-medium text-text-primary px-2.5 shadow-xs transition-colors",
                open && "text-text-primary"
              )}
              aria-expanded={open}
            >
              <SlidersHorizontal size={18} />
              Filters
            </button>
          )}
          {actions}
        </div>
      </div>
      {advanced && open && (
        <div className="px-3 py-3 border-t border-separator-border animate-fade-in">{advanced}</div>
      )}
    </div>
  );
}
