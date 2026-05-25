"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

interface Option<T extends string = string> {
  label: React.ReactNode;
  value: T;
  title?: string;
}

interface ToggleGroupProps<T extends string = string> {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  size?: "sm" | "xs";
  ariaLabel?: string;
}

export function ToggleGroup<T extends string = string>({
  options,
  value,
  onChange,
  className,
  size = "sm",
  ariaLabel,
}: ToggleGroupProps<T>) {
  const pad =
    size === "xs" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]";
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="radio"
            aria-checked={active}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-sm font-medium uppercase tracking-wider transition-colors",
              pad,
              active
                ? "bg-surface-3 text-text-primary"
                : "text-text-muted hover:text-text-secondary hover:bg-surface-2",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
