"use client";

import * as React from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface InfoIconProps {
  /** Tooltip content — short explanation. Strings or rich nodes both fine. */
  hint: React.ReactNode;
  /** Override icon size in px. Default 9. */
  size?: number;
  /** Side to render the tooltip on. Default top. */
  side?: "top" | "bottom" | "left" | "right";
  /** Extra classes on the trigger. */
  className?: string;
}

/**
 * Tiny `ⓘ` glyph that reveals a tooltip on hover. Use to demote
 * always-visible hint text into on-demand explanations — keeps the visible
 * UI dense without sacrificing learnability.
 *
 * Pair with a label:
 *   <span>POP <InfoIcon hint="Probability of profit at expiry, risk-neutral" /></span>
 */
export function InfoIcon({
  hint,
  size = 9,
  side = "top",
  className,
}: InfoIconProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center text-text-muted/60 hover:text-text-secondary transition-colors align-baseline",
            className,
          )}
          aria-label="More info"
        >
          <Info size={size} />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className="max-w-[260px] text-[10.5px] leading-relaxed"
      >
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Tooltip-wrapped label — visible text stays terse, hover surfaces the
 * explanation. Cheaper than InfoIcon when you don't need a dedicated dot;
 * the whole label becomes the hover target.
 */
export function HintLabel({
  children,
  hint,
  side = "top",
  className,
}: {
  children: React.ReactNode;
  hint: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "cursor-help underline decoration-dotted decoration-text-muted/30 underline-offset-2",
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className="max-w-[260px] text-[10.5px] leading-relaxed"
      >
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
