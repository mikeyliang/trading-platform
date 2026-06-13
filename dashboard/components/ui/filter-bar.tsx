"use client";
import * as React from "react";
import { X, SlidersHorizontal, Search } from "lucide-react";
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
        "rounded-md border border-border bg-surface flex flex-col",
        className
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 flex-wrap">
        {search && (
          <div className="relative flex-1 min-w-[180px]">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
            />
            <Input
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder ?? "Search..."}
              className="pl-6 h-6 text-xs leading-normal"
            />
          </div>
        )}
        {hasChips && (
          <div className="flex items-center gap-1 flex-wrap">
            {chips!.map((c) => (
              <button
                key={c.key}
                onClick={c.onRemove}
                className="inline-flex items-center gap-1 rounded-full bg-surface-2 hover:bg-surface-3 border border-border text-[10px] text-text-secondary px-2 py-0.5 transition-colors"
              >
                <span className="truncate max-w-[140px]">{c.label}</span>
                <X size={10} className="text-text-muted" />
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
                "inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface-2 hover:bg-surface-3 text-[11px] text-text-secondary px-2 py-1 transition-colors",
                open && "text-text-primary"
              )}
              aria-expanded={open}
            >
              <SlidersHorizontal size={11} />
              Filters
            </button>
          )}
          {actions}
        </div>
      </div>
      {advanced && open && (
        <div className="px-3 py-2 border-t border-border animate-fade-in">{advanced}</div>
      )}
    </div>
  );
}
