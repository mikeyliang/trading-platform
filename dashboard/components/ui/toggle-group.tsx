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

// BoardUI segmented control (components/base/segmented-control): a tertiary
// track with a raised primary thumb behind the selected segment.
export function ToggleGroup<T extends string = string>({
  options,
  value,
  onChange,
  className,
  size = "sm",
  ariaLabel,
}: ToggleGroupProps<T>) {
  const seg = size === "xs" ? "h-5 px-2 text-caption-1-medium" : "h-6 px-2.5 text-body-2-medium";
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex items-center gap-0.5 rounded-2lg bg-segmented-control-background p-0.5", className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center justify-center rounded-md transition-[background-color,color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
              seg,
              active
                ? "bg-segmented-control-selected-background text-text-primary shadow-2xs"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
