"use client";

import { useStore } from "@/lib/store";
import { cn, fmt, fmtPct, pnlClass } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Search, Sparkles } from "lucide-react";
import { useChatAvailable } from "@/lib/chat-availability";
import { useHealth } from "@/lib/health";
import { ConnectionPill } from "@/components/layout/ConnectionPill";

// IBKR-style top bar: search, active-symbol quote pill, connection pill,
// mode badge, copilot. The full per-line breakdown stays in StatusFooter.
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
        className="flex items-center gap-2 h-7 w-72 px-3 rounded-md bg-surface-2 hover:bg-surface-3 hover:border-border transition-all text-text-muted border border-border/40 hover:shadow-sm"
        aria-label="Open command palette"
      >
        <Search size={12} className="shrink-0 text-text-secondary" />
        <span className="text-[11px] flex-1 text-left">Search symbol, strategy, page…</span>
        <kbd className="text-[10px] tabular font-mono bg-bg/80 px-1.5 py-0.5 rounded border border-border/60">⌘K</kbd>
      </button>

      <Separator orientation="vertical" className="h-4" />

      {/* Active symbol quote pill (IBKR has a similar always-visible quote strip) */}
      <ActiveQuote symbol={activeSymbol} quote={q} />

      <div className="ml-auto flex items-center gap-2">
        <ConnectionPill />
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
  return (
    <div className="flex items-center gap-2 tabular font-mono text-[11px]">
      <span className="text-text-primary font-medium tracking-tight">{symbol}</span>
      {hasAnything ? (
        <>
          <span className="text-text-primary">{last != null ? fmt(last, 2) : "—"}</span>
          {(change != null || changePct != null) && (
            <span className={cn(pnlClass(change ?? changePct ?? 0))}>
              {change != null && (
                <>
                  {change >= 0 ? "+" : ""}
                  {fmt(change, 2)}{" "}
                </>
              )}
              {changePct != null && fmtPct(changePct)}
            </span>
          )}
          <span className="text-text-muted">
            B {bid != null ? fmt(bid, 2) : "—"} · A {ask != null ? fmt(ask, 2) : "—"}
          </span>
        </>
      ) : (
        <span className="text-text-muted">— no quote</span>
      )}
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
