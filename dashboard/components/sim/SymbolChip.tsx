"use client";

import { RiCloseLine } from "@remixicon/react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// A symbol in a form's symbol list: the Badge chip with a small close
// control. Without `onRemove` it is read-only (for example while a bot runs).
export function SymbolChip({ symbol, onRemove }: { symbol: string; onRemove?: () => void }) {
  return (
    <Badge variant="default" className={cn("tabular", onRemove && "pr-0.5")}>
      {symbol}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${symbol}`}
          className="inline-flex size-4 items-center justify-center rounded-sm text-foreground-icon-tertiary hover:bg-background-tertiary-hover hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-border-button-default-focus-ring"
        >
          <RiCloseLine size={14} aria-hidden />
        </button>
      )}
    </Badge>
  );
}
