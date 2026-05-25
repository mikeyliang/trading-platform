"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { ws } from "@/lib/ws";
import { cn, fmtPct } from "@/lib/utils";
import type { Position, WatchlistItem } from "@/types";
import { Plus, X, Eye } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { Logo } from "@/components/ui/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";

export function WatchlistPanel() {
  const { quotes, positions, setWatchlist, updateQuote } = useStore();
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");

  // Aggregate unrealized P&L per underlying so we can surface a "total gain"
  // alongside each watchlist row when the user has open positions in it.
  const upnlBySymbol = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of positions as Position[]) {
      m[p.symbol] = (m[p.symbol] ?? 0) + (p.unrealized_pnl ?? 0);
    }
    return m;
  }, [positions]);

  const load = async () => {
    const data = await api.watchlist().catch(() => []);
    setItems(data);
    setWatchlist(data);
    setLoading(false);
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
        {loading && items.length === 0 && (
          <div className="px-2.5 py-2 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-5 w-5 rounded-full shrink-0" />
                <div className="flex-1 flex flex-col gap-1">
                  <Skeleton className="h-2.5 w-14" />
                  <Skeleton className="h-2 w-10" />
                </div>
                <Skeleton className="h-2.5 w-10 shrink-0" />
              </div>
            ))}
          </div>
        )}
        {Object.entries(grouped).map(([sector, stocks]) => (
          <div key={sector}>
            <div className="px-3 py-1 text-[9px] font-medium text-text-muted uppercase tracking-wider bg-surface/80 backdrop-blur sticky top-0 z-10 border-b border-border/40 flex items-center gap-2">
              <span>{sector}</span>
              <span className="text-text-muted/70 tabular">{stocks.length}</span>
            </div>
            {stocks.map((item) => {
              const q = quotes[item.symbol];
              // Treat 0 as "no data" when bid/ask are also zero — the NT
              // bridge emits last=0/change=0/change_pct=0 placeholders until
              // a real tick arrives, and rendering those as "$0.00 +0.00%"
              // misleads the trader into thinking the symbol crashed.
              const stale = isStaleZero(q);
              const last = stale ? null : pickNumber(q?.last, item.last);
              const changePct = stale ? null : pickNumber(q?.change_pct, item.change_pct);
              const change = stale ? null : pickNumber(q?.change, item.change);
              const hasData = last != null && (changePct != null || change != null);
              const positive = (changePct ?? change ?? 0) >= 0;
              const totalGain = upnlBySymbol[item.symbol];
              const hasPosition = totalGain != null && totalGain !== 0;

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
                      <span className="tabular text-[10px] text-text-muted leading-tight">
                        {last != null ? `$${last.toFixed(2)}` : "—"}
                      </span>
                    </div>
                    <div className="flex flex-col items-end leading-tight shrink-0">
                      {hasData ? (
                        <>
                          <span
                            className={cn(
                              "tabular text-[10px] font-medium leading-none",
                              positive ? "text-up" : "text-down"
                            )}
                          >
                            {change != null && fmtSignedDollar(change)}
                            {change != null && changePct != null && (
                              <span className="text-text-muted/70"> · </span>
                            )}
                            {changePct != null && fmtPct(changePct)}
                          </span>
                          {hasPosition && (
                            <span
                              className={cn(
                                "tabular text-[9px] leading-none mt-0.5",
                                totalGain >= 0 ? "text-up/80" : "text-down/80"
                              )}
                              title="Total unrealized P&L on this symbol"
                            >
                              {fmtSignedDollar(totalGain)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="tabular text-[10px] text-text-muted leading-none">—</span>
                      )}
                    </div>
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
        {!loading && items.length === 0 && (
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

// Pick the first numeric value. The NT bridge emits 0 placeholders for
// change/change_pct until a real prior-close comparison is available;
// treat undefined/null as "missing" but trust explicit zeros from the
// REST item (which only sets them when a quote came through).
function pickNumber(
  primary: number | null | undefined,
  fallback: number | null | undefined,
): number | null {
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return null;
}

function isStaleZero(q: { last?: number | null; bid?: number | null; ask?: number | null } | undefined): boolean {
  if (!q) return false;
  const z = (x: number | null | undefined) => x == null || x === 0;
  return z(q.last) && z(q.bid) && z(q.ask);
}

function fmtSignedDollar(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  // Sub-dollar moves get 2dp; bigger swings round to whole dollars so
  // the row stays narrow.
  const body = abs >= 100 ? abs.toFixed(0) : abs.toFixed(2);
  return `${sign}$${body}`;
}
