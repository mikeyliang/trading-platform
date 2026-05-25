"use client";

import { useStore } from "@/lib/store";
import { cn, fmt, fmtPct, pnlClass } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Search, Sparkles } from "lucide-react";
import { useChatAvailable } from "@/lib/chat-availability";
import { useHealth } from "@/lib/health";

// IBKR-style top bar: search, active-symbol quote pill, mode badge, copilot.
// Connection status now lives in the StatusFooter; keep this bar lean.
export function Header() {
  const { activeSymbol, quotes } = useStore();
  const { health } = useHealth();
  const chatAvailable = useChatAvailable();

  const mode = health?.mode?.toUpperCase() ?? "PAPER";
  const q = quotes[activeSymbol];

  return (
    <header className="h-9 flex items-center px-3 gap-3 bg-bg border-b border-border/60 shrink-0">
      <button
        type="button"
        onClick={openPalette}
        className="flex items-center gap-2 h-6 w-64 px-2 rounded-sm bg-surface-2/50 hover:bg-surface-2 transition-colors text-text-muted"
        aria-label="Open command palette"
      >
        <Search size={11} className="shrink-0 opacity-60" />
        <span className="text-[11px] flex-1 text-left">
          Search symbol, strategy, page…
        </span>
        <kbd className="text-[10px] tabular font-mono text-text-muted/60">
          ⌘K
        </kbd>
      </button>

      <Separator orientation="vertical" className="h-4" />

      {/* Active symbol quote pill (IBKR has a similar always-visible quote strip) */}
      <ActiveQuote symbol={activeSymbol} quote={q} />

      <div className="ml-auto flex items-center gap-2">
        <Badge variant={mode === "LIVE" ? "up" : "warning"}>{mode}</Badge>
        {chatAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={openCopilot}
                className="flex items-center justify-center w-6 h-6 rounded-sm text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                aria-label="Open AI co-pilot"
              >
                <Sparkles size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Co-pilot · ⌘J</TooltipContent>
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
    last: number;
    change: number;
    change_pct: number;
    bid: number;
    ask: number;
  };
}) {
  return (
    <div className="flex items-center gap-2 tabular font-mono text-[11px]">
      <span className="text-text-primary font-medium tracking-tight">
        {symbol}
      </span>
      {quote ? (
        <>
          <span className="text-text-primary">{fmt(quote.last, 2)}</span>
          <span className={cn(pnlClass(quote.change))}>
            {quote.change >= 0 ? "+" : ""}
            {fmt(quote.change, 2)} {fmtPct(quote.change_pct)}
          </span>
          <span className="text-text-muted">
            B {fmt(quote.bid, 2)} · A {fmt(quote.ask, 2)}
          </span>
        </>
      ) : (
        <span className="text-text-muted">— no quote</span>
      )}
    </div>
  );
}

function openPalette() {
  const event = new KeyboardEvent("keydown", {
    key: "k",
    metaKey: true,
    ctrlKey: true,
    bubbles: true,
  });
  document.dispatchEvent(event);
}
function openCopilot() {
  const event = new KeyboardEvent("keydown", {
    key: "j",
    metaKey: true,
    ctrlKey: true,
    bubbles: true,
  });
  document.dispatchEvent(event);
}
