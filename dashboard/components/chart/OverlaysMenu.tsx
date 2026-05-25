"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Check, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface OverlayToggle {
  id: string;
  label: string;
  active: boolean;
  onToggle: () => void;
  title?: string;
  /** Optional inline icon (lucide). */
  icon?: LucideIcon;
  /** Optional secondary text shown muted on the right of the row. */
  hint?: string;
}

export interface OverlayGroup {
  title?: string;
  toggles: OverlayToggle[];
  /** Optional node rendered after the toggles (e.g. fib lookback pills). */
  extra?: React.ReactNode;
}

/**
 * Chart-toolbar overlays menu — single button trigger, popover with grouped
 * row toggles. Row layout (vs the old chip grid) gives icons + descriptions
 * proper room and makes the active state more legible.
 */
export function OverlaysMenu({ groups }: { groups: OverlayGroup[] }) {
  const activeCount = groups.reduce(
    (n, g) => n + g.toggles.filter((t) => t.active).length,
    0,
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            "h-6 px-2 text-[11px] tabular tracking-normal rounded-sm transition-colors inline-flex items-center gap-1.5",
            activeCount > 0
              ? "text-text-primary bg-surface-2"
              : "text-text-muted hover:text-text-secondary hover:bg-surface-2/60",
          )}
        >
          <span>Overlays</span>
          {activeCount > 0 && (
            <span className="text-[10px] tabular text-text-muted">
              {activeCount}
            </span>
          )}
          <ChevronDown size={11} className="opacity-60" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 w-[260px] rounded-md border border-border bg-surface/95 backdrop-blur-md shadow-xl animate-fade-in overflow-hidden"
        >
          {groups.map((g, i) => (
            <div
              key={i}
              className={cn("py-2", i > 0 && "border-t border-border/40")}
            >
              {g.title && (
                <div className="px-3 pb-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                  {g.title}
                </div>
              )}
              <div className="flex flex-col">
                {g.toggles.map((t) => (
                  <OverlayRow key={t.id} toggle={t} />
                ))}
              </div>
              {g.extra && <div className="px-3 pt-2 pb-1">{g.extra}</div>}
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function OverlayRow({ toggle }: { toggle: OverlayToggle }) {
  const Icon = toggle.icon;
  return (
    <DropdownMenu.Item
      onSelect={(e) => {
        e.preventDefault();
        toggle.onToggle();
      }}
      title={toggle.title}
      className={cn(
        "relative flex items-center gap-2.5 px-3 h-8 cursor-pointer outline-none transition-colors group",
        toggle.active
          ? "text-text-primary bg-surface-2/60"
          : "text-text-secondary hover:bg-surface-2/40",
      )}
    >
      {toggle.active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-r-full bg-accent" />
      )}
      {Icon ? (
        <Icon
          size={13}
          className={cn(
            "shrink-0",
            toggle.active ? "text-accent" : "text-text-muted",
          )}
        />
      ) : (
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0 transition-colors",
            toggle.active
              ? "bg-accent"
              : "bg-text-muted/40 group-hover:bg-text-muted",
          )}
        />
      )}
      <span className="text-[12px] tabular flex-1">{toggle.label}</span>
      {toggle.hint && (
        <span className="text-[10px] tabular text-text-muted">
          {toggle.hint}
        </span>
      )}
      {toggle.active && <Check size={11} className="text-accent shrink-0" />}
    </DropdownMenu.Item>
  );
}
