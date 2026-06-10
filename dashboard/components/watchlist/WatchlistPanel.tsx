"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { ws } from "@/lib/ws";
import { cn, fmtPct } from "@/lib/utils";
import type { WatchlistItem } from "@/types";
import { ArrowDown, ArrowUp, Eye, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { List, type RowComponentProps } from "react-window";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { Logo } from "@/components/ui/logo";
import { toast } from "@/components/ui/toaster";

// Threshold at which we switch from straight DOM to react-window virtual
// scrolling. Below this, virtualization adds layout overhead without
// meaningful savings.
const VIRTUAL_THRESHOLD = 30;
const ROW_HEIGHT = 38;

type SortKey = "symbol" | "change_pct" | "price";
type SortDir = "asc" | "desc";

const SORT_OPTIONS: { key: SortKey; label: string; defaultDir: SortDir }[] = [
  { key: "symbol", label: "Sym", defaultDir: "asc" },
  { key: "change_pct", label: "%", defaultDir: "desc" },
  { key: "price", label: "$", defaultDir: "desc" },
];

export const WatchlistPanel = memo(function WatchlistPanel() {
  // Granular zustand selectors — `useStore()` with destructuring subscribes to
  // every key in the store, so the whole panel would re-render on any state
  // change (positions, account, health…). Selectors keep us bound only to the
  // slices we actually read.
  const quotes = useStore((s) => s.quotes);
  const setWatchlist = useStore((s) => s.setWatchlist);
  const updateQuote = useStore((s) => s.updateQuote);
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("symbol");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const load = useCallback(async () => {
    const data = await api.watchlist().catch(() => []);
    setItems(data);
    setWatchlist(data);
  }, [setWatchlist]);

  useEffect(() => { load(); }, [load]);

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

  const add = useCallback(async () => {
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
  }, [input, load]);

  const remove = useCallback(async (sym: string) => {
    try {
      await api.watchlistRemove(sym);
      toast(`${sym} removed`, { description: "Symbol dropped from watchlist." });
    } catch {
      toast.error(`Failed to remove ${sym}`);
    }
    load();
  }, [load]);

  // Pick the sort key. Clicking the active column flips direction; clicking
  // a new column adopts that column's natural default (alpha → asc, numeric → desc).
  const handleSort = useCallback((key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(SORT_OPTIONS.find((o) => o.key === key)!.defaultDir);
    }
  }, [sortKey]);

  // Filter + decorate with live quote values so sort sees current numbers,
  // not the stale REST snapshot baked into the item.
  const decorated = useMemo(() => {
    const q = filter.trim().toUpperCase();
    return items
      .filter((i) => !q || i.symbol.toUpperCase().includes(q))
      .map((item) => {
        const live = quotes[item.symbol];
        const last = live?.last ?? item.last ?? null;
        const changePct = live?.change_pct ?? item.change_pct ?? 0;
        return { item, last, changePct };
      });
  }, [items, filter, quotes]);

  const sortedFlat = useMemo(() => {
    const factor = sortDir === "asc" ? 1 : -1;
    return [...decorated].sort((a, b) => {
      if (sortKey === "symbol") return a.item.symbol.localeCompare(b.item.symbol) * factor;
      if (sortKey === "change_pct") return (a.changePct - b.changePct) * factor;
      // price — nulls sort to the bottom regardless of direction
      if (a.last == null && b.last == null) return 0;
      if (a.last == null) return 1;
      if (b.last == null) return -1;
      return (a.last - b.last) * factor;
    });
  }, [decorated, sortKey, sortDir]);

  // When sorting by symbol, keep sector grouping — that's the org-chart view.
  // When sorting by a numeric column the trader wants top movers globally, so
  // flatten the list and drop the sector headers.
  const groupBySector = sortKey === "symbol";
  const grouped = useMemo(() => {
    if (!groupBySector) return null;
    return sortedFlat.reduce<Record<string, typeof sortedFlat>>((acc, row) => {
      const s = row.item.sector || "Other";
      if (!acc[s]) acc[s] = [];
      acc[s].push(row);
      return acc;
    }, {});
  }, [groupBySector, sortedFlat]);

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

      {/* Filter + sort bar — only shown when the watchlist has any rows, so
          empty-state stays uncluttered. Filter is a substring search over
          symbol; sort is a 3-way segmented control where the active button
          shows the current direction arrow (click to flip). */}
      {items.length > 0 && (
        <div className="px-2 py-1.5 border-b border-border shrink-0 flex items-center gap-1.5">
          <div className={cn(
            "flex items-center gap-1 h-6 px-1.5 rounded-sm border border-border bg-surface-2/40 flex-1 min-w-0 transition-colors",
            filter ? "border-accent/50" : "hover:bg-surface-2/70"
          )}>
            <Search size={10} className="text-text-muted shrink-0" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value.toUpperCase())}
              placeholder="Filter"
              className="flex-1 min-w-0 bg-transparent text-[10px] tabular text-text-primary placeholder:text-text-muted/60 outline-none"
            />
            {filter && (
              <button
                onClick={() => setFilter("")}
                className="text-text-muted hover:text-text-primary shrink-0"
                aria-label="Clear filter"
              >
                <X size={10} />
              </button>
            )}
          </div>
          <div className="flex h-6 rounded-sm border border-border overflow-hidden shrink-0">
            {SORT_OPTIONS.map((o, i) => {
              const active = sortKey === o.key;
              return (
                <button
                  key={o.key}
                  onClick={() => handleSort(o.key)}
                  className={cn(
                    "px-1.5 text-[10px] inline-flex items-center gap-0.5 transition-colors",
                    i > 0 && "border-l border-border",
                    active
                      ? "bg-accent/15 text-accent font-medium"
                      : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                  )}
                  aria-label={`Sort by ${o.label} ${active ? (sortDir === "asc" ? "ascending" : "descending") : ""}`}
                >
                  {o.label}
                  {active && (sortDir === "asc" ? <ArrowUp size={8} /> : <ArrowDown size={8} />)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <ScrollArea className="flex-1">
          <EmptyState
            icon={Eye}
            title="Empty watchlist"
            description="Click + to track a symbol."
          />
        </ScrollArea>
      ) : sortedFlat.length === 0 ? (
        <div className="flex-1 px-3 py-6 text-center text-[11px] text-text-muted">
          No matches for &ldquo;{filter}&rdquo;
        </div>
      ) : groupBySector && grouped ? (
        // Sector-grouped view keeps sticky headers, so render with normal
        // scrolling — virtualization would break the sector boundaries.
        <ScrollArea className="flex-1">
          {Object.entries(grouped).map(([sector, rows]) => (
            <div key={sector}>
              <SectorHeader sector={sector} count={rows.length} />
              {rows.map(({ item, last, changePct }) => (
                <WatchRow
                  key={item.symbol}
                  symbol={item.symbol}
                  last={last}
                  changePct={changePct}
                  onRemove={remove}
                />
              ))}
            </div>
          ))}
        </ScrollArea>
      ) : sortedFlat.length >= VIRTUAL_THRESHOLD ? (
        // Flat sorted view → virtualize. Each row is a fixed height div so the
        // List can compute scroll offsets without measuring.
        <div className="flex-1 min-h-0">
          <List
            rowComponent={VirtualWatchRow}
            rowCount={sortedFlat.length}
            rowHeight={ROW_HEIGHT}
            rowProps={{ rows: sortedFlat, onRemove: remove }}
            style={{ height: "100%" }}
            overscanCount={4}
          />
        </div>
      ) : (
        <ScrollArea className="flex-1">
          {sortedFlat.map(({ item, last, changePct }) => (
            <WatchRow
              key={item.symbol}
              symbol={item.symbol}
              last={last}
              changePct={changePct}
              onRemove={remove}
            />
          ))}
        </ScrollArea>
      )}
    </div>
  );
});

type WatchRowDecorated = { item: WatchlistItem; last: number | null; changePct: number };

function VirtualWatchRow({
  index,
  style,
  rows,
  onRemove,
}: RowComponentProps<{
  rows: WatchRowDecorated[];
  onRemove: (sym: string) => void;
}>) {
  const { item, last, changePct } = rows[index];
  return (
    <div style={style}>
      <WatchRow
        symbol={item.symbol}
        last={last}
        changePct={changePct}
        onRemove={onRemove}
      />
    </div>
  );
}

const SectorHeader = memo(function SectorHeader({ sector, count }: { sector: string; count: number }) {
  return (
    <div className="px-3 py-1 text-[9px] font-medium text-text-muted uppercase tracking-wider bg-surface/80 backdrop-blur sticky top-0 z-10 border-b border-border/40 flex items-center gap-2">
      <span>{sector}</span>
      <span className="text-text-muted/70 tabular">{count}</span>
    </div>
  );
});

const WatchRow = memo(function WatchRow({
  symbol,
  last,
  changePct,
  onRemove,
}: {
  symbol: string;
  last: number | null;
  changePct: number;
  onRemove: (sym: string) => void;
}) {
  const positive = changePct >= 0;
  return (
    <div className="group flex items-center gap-2 px-2.5 py-1.5 hover:bg-surface-2 transition-colors border-b border-border/20 last:border-b-0">
      <Link href={`/chart/${symbol}`} className="flex-1 flex items-center gap-2 min-w-0">
        <Logo symbol={symbol} size={20} />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[11px] font-semibold text-text-primary leading-tight">
            {symbol}
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
        onClick={() => onRemove(symbol)}
        className="opacity-0 group-hover:opacity-100 w-4 h-4 rounded-sm flex items-center justify-center text-text-muted hover:text-down hover:bg-down/10 transition-all"
        aria-label={`Remove ${symbol}`}
      >
        <X size={10} />
      </button>
    </div>
  );
});
