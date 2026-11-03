"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { ws } from "@/lib/ws";
import { cn, fmt, fmtPct } from "@/lib/utils";
import type { WatchlistItem } from "@/types";
import { Plus, X, Eye } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { Logo } from "@/components/ui/logo";
import { WatchlistSparkline } from "@/components/watchlist/WatchlistSparkline";
import { toast } from "@/components/ui/toaster";

export function WatchlistPanel() {
  const { quotes, setWatchlist, updateQuote, activeSymbol } = useStore();
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");

  const load = async () => {
    const data = await api.watchlist().catch(() => []);
    setItems(data);
    setWatchlist(data);
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe every watchlist symbol over WS so push-ticks update the store.
  useEffect(() => {
    if (items.length === 0) return;
    ws.subscribe(items.map((i) => i.symbol));
  }, [items]);

  // REST fallback for environments where the WS isn't reachable: batch-fetch
  // quotes every 15s straight into the store. WS pushes still win when they
  // arrive (same store keys).
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
      toast.error(`Couldn't add ${sym}`);
    }
    setInput("");
    setAdding(false);
    load();
  };

  const remove = async (sym: string) => {
    try {
      await api.watchlistRemove(sym);
      toast(`${sym} removed from watchlist`);
    } catch {
      toast.error(`Couldn't remove ${sym}`);
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
    <div className="flex flex-col h-full bg-surface">
      <div className="flex items-center justify-between pl-3 pr-1.5 h-8 border-b border-border shrink-0">
        <span className="text-xs font-medium text-text-secondary">
          Watchlist
          {items.length > 0 && <span className="ml-1.5 text-text-muted tabular">{items.length}</span>}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setAdding(!adding)}
              aria-label="Add symbol"
              aria-expanded={adding}
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Add symbol</TooltipContent>
        </Tooltip>
      </div>

      {adding && (
        <form
          className="px-2 py-2 border-b border-border flex gap-1.5 shrink-0 animate-slide-up"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input
            autoFocus
            id="watchlist-add-symbol"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="Symbol, e.g. RUT"
            className="h-7 font-mono uppercase"
            aria-label="Symbol to add"
          />
          <Button type="submit" variant="default" size="sm">
            Add
          </Button>
        </form>
      )}

      <ScrollArea className="flex-1">
        {Object.entries(grouped).map(([sector, stocks]) => (
          <div key={sector}>
            <div className="px-3 h-6 flex items-center gap-2 eyebrow bg-surface/90 backdrop-blur sticky top-0 z-10 border-b border-border/40">
              <span className="truncate">{sector}</span>
              <span className="tabular">{stocks.length}</span>
            </div>
            {stocks.map((item) => {
              const q = quotes[item.symbol];
              const changePct = q?.change_pct ?? item.change_pct ?? null;
              const last = q?.last ?? item.last;
              const dir = changePct == null ? "flat" : changePct > 0 ? "up" : changePct < 0 ? "down" : "flat";
              const active = item.symbol === activeSymbol;

              return (
                <div
                  key={item.symbol}
                  className={cn(
                    "group relative flex items-center gap-2 pl-3 pr-1.5 h-11 transition-colors border-b border-border/30 last:border-b-0",
                    active ? "bg-accent/10" : "hover:bg-surface-2"
                  )}
                >
                  {active && <span aria-hidden className="absolute left-0 inset-y-1.5 w-0.5 rounded-r-full bg-accent" />}
                  <Link
                    href={`/chart/${item.symbol}`}
                    aria-current={active ? "true" : undefined}
                    className="flex-1 flex items-center gap-2 min-w-0"
                  >
                    <Logo symbol={item.symbol} size={18} />
                    <div className="flex flex-col min-w-0 flex-1 leading-tight">
                      <span className="text-xs font-mono font-medium text-text-primary">
                        {item.symbol}
                      </span>
                      <span className="tabular text-2xs text-text-muted">
                        {last != null ? fmt(last, 2) : "—"}
                      </span>
                    </div>
                    <WatchlistSparkline symbol={item.symbol} width={44} height={18} />
                    <span
                      className={cn(
                        "tabular text-xs font-medium leading-none shrink-0 w-14 text-right",
                        dir === "up" ? "text-up" : dir === "down" ? "text-down" : "text-text-muted"
                      )}
                    >
                      {changePct == null ? "—" : fmtPct(changePct)}
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => remove(item.symbol)}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 w-5 h-5 rounded-sm flex items-center justify-center text-text-muted hover:text-down hover:bg-down/10 transition-all"
                    aria-label={`Remove ${item.symbol} from watchlist`}
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {items.length === 0 && (
          <EmptyState
            icon={Eye}
            size="sm"
            title="Nothing watched yet"
            description="Add RUT, SPX or any symbol to see its quote and a 60-day trend here."
            action={
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                <Plus /> Add symbol
              </Button>
            }
          />
        )}
      </ScrollArea>
    </div>
  );
}
