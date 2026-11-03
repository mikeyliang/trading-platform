"use client";

import { useStore } from "@/lib/store";
import { cn, fmt, fmtPct, pnlClass } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Kbd } from "@/components/base/kbd/kbd";
import { RiMenuLine, RiSearchLine, RiSparklingLine } from "@remixicon/react";
import { useChatAvailable } from "@/lib/chat-availability";
import { useHealth } from "@/lib/health";
import { ConnectionPill } from "@/components/layout/ConnectionPill";

// Top row on the page ground: command palette trigger, the active symbol's
// quote, and account status on the right. The per-connection breakdown
// lives in StatusFooter.
export function Header({ onMenuClick }: { onMenuClick?: () => void } = {}) {
  const { activeSymbol, quotes } = useStore();
  const { health } = useHealth();
  const chatAvailable = useChatAvailable();

  const mode = health?.mode?.toUpperCase() ?? "PAPER";
  const q = quotes[activeSymbol];

  return (
    <header className="h-9 flex items-center gap-3 shrink-0">
      <button
        type="button"
        onClick={onMenuClick}
        className="md:hidden flex items-center justify-center size-8 rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-text-primary transition-colors"
        aria-label="Open navigation"
      >
        <RiMenuLine className="size-5" />
      </button>

      <button
        type="button"
        onClick={openPalette}
        className="flex items-center gap-2 h-8 w-full max-w-[280px] px-2.5 rounded-2lg bg-background-secondary-default hover:bg-background-secondary-hover transition-colors text-text-tertiary outline-none focus-visible:ring-2 focus-visible:ring-border-button-default-focus-ring"
        aria-label="Open command palette"
      >
        <RiSearchLine className="size-[18px] shrink-0 text-foreground-icon-tertiary" />
        <span className="text-body-2-regular flex-1 text-left truncate">Search symbol, strategy, page</span>
        <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
      </button>

      <ActiveQuote symbol={activeSymbol} quote={q} />

      <div className="ml-auto flex items-center gap-2">
        <ConnectionPill />
        <Badge variant={mode === "LIVE" ? "warning" : "muted"} title={mode === "LIVE" ? "Real money" : "Paper account"}>
          {mode === "LIVE" ? "Live" : "Paper"}
        </Badge>
        {chatAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={openCopilot}
                className="flex items-center justify-center size-8 rounded-lg text-foreground-icon-secondary hover:text-accent-600 hover:bg-background-secondary-hover transition-colors"
                aria-label="Open AI co-pilot"
              >
                <RiSparklingLine className="size-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Co-pilot, ⌘J</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

function ActiveQuote({
  symbol,
  quote,
}: {
  symbol: string;
  quote?: {
    last?: number | null;
    change?: number | null;
    change_pct?: number | null;
    bid?: number | null;
    ask?: number | null;
  };
}) {
  const last = quote?.last ?? null;
  const change = quote?.change ?? null;
  const changePct = quote?.change_pct ?? null;
  const bid = quote?.bid ?? null;
  const ask = quote?.ask ?? null;
  const hasAnything = last != null || bid != null || ask != null;
  if (!hasAnything) return null;
  return (
    <div className="hidden sm:flex items-baseline gap-2 tabular text-body-2-regular min-w-0">
      <span className="text-body-2-medium text-text-primary">{symbol}</span>
      <span className="text-text-primary text-body-2-medium">{last != null ? fmt(last, 2) : "n/a"}</span>
      {(change != null || changePct != null) && (
        <span className={cn(pnlClass(change ?? changePct ?? 0))}>
          {change != null && (
            <>
              {change >= 0 ? "+" : ""}
              {fmt(change, 2)}{" "}
            </>
          )}
          {changePct != null && `(${fmtPct(changePct)})`}
        </span>
      )}
      <span className="hidden lg:inline text-text-tertiary">
        {bid != null ? fmt(bid, 2) : "n/a"} × {ask != null ? fmt(ask, 2) : "n/a"}
      </span>
    </div>
  );
}

function openPalette() {
  const event = new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true });
  document.dispatchEvent(event);
}
function openCopilot() {
  const event = new KeyboardEvent("keydown", { key: "j", metaKey: true, ctrlKey: true, bubbles: true });
  document.dispatchEvent(event);
}
