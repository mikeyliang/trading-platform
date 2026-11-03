"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { cn, fmt, fmtPct, pnlClass } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Menu, Moon, Search, Sparkles, Sun } from "lucide-react";
import { useChatAvailable } from "@/lib/chat-availability";
import { useHealth } from "@/lib/health";
import { ConnectionPill } from "@/components/layout/ConnectionPill";

// Top bar: command palette trigger, the active symbol's quote, and account
// status on the right. The per-connection breakdown lives in StatusFooter.
export function Header({ onMenuClick }: { onMenuClick?: () => void } = {}) {
  const { activeSymbol, quotes } = useStore();
  const { health } = useHealth();
  const chatAvailable = useChatAvailable();
  const [dark, setDark] = useState(true);

  const mode = health?.mode?.toUpperCase() ?? "PAPER";
  const q = quotes[activeSymbol];

  // The inline script in app/layout.tsx applies the class before paint; this
  // only syncs React state with it.
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggleTheme = () => {
    const isDark = document.documentElement.classList.toggle("dark");
    setDark(isDark);
    try {
      localStorage.setItem("theme", isDark ? "dark" : "light");
    } catch {
      /* private mode */
    }
  };

  return (
    <header className="h-11 flex items-center px-3 gap-3 bg-surface border-b border-border shrink-0">
      <button
        type="button"
        onClick={onMenuClick}
        className="md:hidden flex items-center justify-center w-7 h-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors"
        aria-label="Open navigation"
      >
        <Menu size={15} />
      </button>

      <button
        type="button"
        onClick={openPalette}
        className="flex items-center gap-2 h-7 w-full max-w-xs px-2.5 rounded-md bg-surface-2 hover:bg-surface-3 border border-border/60 hover:border-border transition-colors text-text-muted"
        aria-label="Open command palette"
      >
        <Search size={13} className="shrink-0" />
        <span className="text-xs flex-1 text-left truncate">Search symbol, strategy, page</span>
        <kbd className="hidden sm:inline text-2xs font-mono text-text-muted bg-surface px-1.5 py-0.5 rounded border border-border">⌘K</kbd>
      </button>

      <div className="hidden sm:block h-5 w-px bg-border" aria-hidden />

      <ActiveQuote symbol={activeSymbol} quote={q} />

      <div className="ml-auto flex items-center gap-2">
        <ConnectionPill />
        <Badge variant={mode === "LIVE" ? "warning" : "muted"} title={mode === "LIVE" ? "Real money" : "Paper account"}>
          {mode}
        </Badge>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleTheme}
              className="flex items-center justify-center w-7 h-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors"
              aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
            >
              {dark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{dark ? "Light theme" : "Dark theme"}</TooltipContent>
        </Tooltip>
        {chatAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={openCopilot}
                className="flex items-center justify-center w-7 h-7 rounded-md text-text-secondary hover:text-accent-fg hover:bg-accent/10 transition-colors"
                aria-label="Open AI co-pilot"
              >
                <Sparkles size={14} />
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
    <div className="hidden sm:flex items-baseline gap-2 tabular text-xs min-w-0">
      <span className="font-mono font-medium text-text-primary">{symbol}</span>
      {hasAnything ? (
        <>
          <span className="text-text-primary font-medium">{last != null ? fmt(last, 2) : "—"}</span>
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
          <span className="hidden lg:inline text-text-muted">
            {bid != null ? fmt(bid, 2) : "—"} × {ask != null ? fmt(ask, 2) : "—"}
          </span>
        </>
      ) : (
        <span className="text-text-muted">no quote</span>
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
