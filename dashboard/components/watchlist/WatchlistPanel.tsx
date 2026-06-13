"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { ws } from "@/lib/ws";
import { cn, fmtPct } from "@/lib/utils";
import type { WatchlistItem } from "@/types";
import { Plus, X, Eye } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { Logo } from "@/components/ui/logo";
import { toast } from "@/components/ui/toaster";

export function WatchlistPanel() {
  const { quotes, setWatchlist, updateQuote } = useStore();
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");

  const load = async () => {
    const data = await api.watchlist().catch(() => []);
    setItems(data);
    setWatchlist(data);
  };

  useEffect(() => { load(); }, []);

  // Subscribe every watchlist symbol over WS so push-ticks update the store.
  useEffect(() => {
    if (items.length === 0) return;
    ws.subscribe(items.map((i) => i.symbol));
  }, [items]);

  // REST fallback — for environments where the WS isn't reachable (Coder
  // port-forwarding, no entitlement, etc.) we batch-fetch quotes every 15s
  // and write straight into the store. WS pushes still win when they
  // arrive (they update the same store keys).
  useEffect(() => {
    if (items.length === 0) return;
    let alive = true;
    const fetchOnce = async () => {
      try {
        const syms = items.map((i) => i.symbol).join(",");
        const data = await api.quotes(syms.split(","));
        if (!alive) return;
        data.forEach((q) => updateQuote(q));
      } catch {
        // ignore
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, 15000);
    return () => { alive = false; clearInterval(id); };
  }, [items, updateQuote]);

  const add = async () => {
    if (!input.trim()) return;
    const sym = input.trim().toUpperCase();
    try {
      await api.watchlistAdd(sym);
      toast.success(`${sym} added to watchlist`);
    } catch {
      toast.error(`Failed to add ${sym}`);
    }
    setInput("");
    setAdding(false);
    load();
  };

  const remove = async (sym: string) => {
    try {
      await api.watchlistRemove(sym);
      toast(`${sym} removed`, { description: "Symbol dropped from watchlist." });
    } catch {
      toast.error(`Failed to remove ${sym}`);
    }
    load();
  };

  // group by sector
  const grouped = items.reduce<Record<string, WatchlistItem[]>>((acc, item) => {
    const s = item.sector || "Other";
    if (!acc[s]) acc[s] = [];
    acc[s].push(item);
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 h-9 border-b border-border shrink-0">
        <span className="text-[11px] font-medium text-text-secondary uppercase tracking-wider">
          Watchlist
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setAdding(!adding)}
              aria-label="Add symbol"
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Add symbol</TooltipContent>
        </Tooltip>
      </div>

      {adding && (
        <div className="px-3 py-2 border-b border-border flex gap-2 shrink-0">
          <Input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="e.g. AAPL"
            className="h-7"
          />
          <Button onClick={add} variant="default" size="sm">
            add
          </Button>
        </div>
      )}

      <ScrollArea className="flex-1">
        {Object.entries(grouped).map(([sector, stocks]) => (
          <div key={sector}>
            <div className="px-3 py-1 text-[9px] font-medium text-text-muted uppercase tracking-wider bg-surface/80 backdrop-blur sticky top-0 z-10 border-b border-border/40 flex items-center gap-2">
              <span>{sector}</span>
              <span className="text-text-muted/70 tabular">{stocks.length}</span>
            </div>
            {stocks.map((item) => {
              const q = quotes[item.symbol];
              const changePct = q?.change_pct ?? item.change_pct ?? 0;
              const last = q?.last ?? item.last;
              const positive = changePct >= 0;

              return (
                <div
                  key={item.symbol}
                  className="group flex items-center gap-2 px-2.5 py-1.5 hover:bg-surface-2 transition-colors border-b border-border/20 last:border-b-0"
                >
                  <Link
                    href={`/chart/${item.symbol}`}
                    className="flex-1 flex items-center gap-2 min-w-0"
                  >
                    <Logo symbol={item.symbol} size={20} />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-[11px] font-semibold text-text-primary leading-tight">
                        {item.symbol}
                      </span>
                      {last != null && (
                        <span className="tabular text-[10px] text-text-muted leading-tight">
                          ${last.toFixed(2)}
                        </span>
                      )}
                    </div>
                    <span
                      className={cn(
                        "tabular text-[10px] font-medium leading-none shrink-0",
                        positive ? "text-up" : "text-down"
                      )}
                    >
                      {fmtPct(changePct)}
                    </span>
                  </Link>
                  <button
                    onClick={() => remove(item.symbol)}
                    className="opacity-0 group-hover:opacity-100 w-4 h-4 rounded-sm flex items-center justify-center text-text-muted hover:text-down hover:bg-down/10 transition-all"
                    aria-label={`Remove ${item.symbol}`}
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {items.length === 0 && (
          <EmptyState
            icon={Eye}
            title="Empty watchlist"
            description="Click + to track a symbol."
          />
        )}
      </ScrollArea>
    </div>
  );
}
