"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Activity, Search, X } from "lucide-react";
import { api, type TradeHistoryRecord, type TradeStats, type TradeStatus } from "@/lib/api";
import { cn, fmt, fmtCurrency, fmtPct, pnlClass } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHeader,
  TableRow,
  SortableTableHead,
  useTableSort,
} from "@/components/ui/table";

type SideFilter = "all" | "BUY" | "SELL";

type SortKey =
  | "timestamp"
  | "symbol"
  | "side"
  | "qty"
  | "price"
  | "pnl"
  | "strategy"
  | "status";

const ACCESSORS: Record<SortKey, (t: TradeHistoryRecord) => string | number | null | undefined> = {
  timestamp: (t) => Date.parse(t.timestamp) || 0,
  symbol: (t) => t.symbol,
  side: (t) => t.side,
  qty: (t) => t.quantity,
  price: (t) => t.price,
  pnl: (t) => t.pnl ?? null,
  strategy: (t) => t.strategy ?? null,
  status: (t) => t.status,
};

const NUMERIC: SortKey[] = ["timestamp", "qty", "price", "pnl"];

const PAGE_SIZE = 200;
const REFRESH_MS = 30_000;

export const TradeHistoryPanel = memo(function TradeHistoryPanel() {
  const [symbolQ, setSymbolQ] = useState("");
  const [side, setSide] = useState<SideFilter>("all");
  const [strategyQ, setStrategyQ] = useState("");

  const [trades, setTrades] = useState<TradeHistoryRecord[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Server-side filters: symbol / side / strategy go to the API so paging is
  // accurate and stats reflect the filtered set. Resetting page state is
  // unnecessary — we always pull the first page and cap at PAGE_SIZE.
  useEffect(() => {
    let cancelled = false;
    const symbolParam = symbolQ.trim().toUpperCase() || undefined;
    const strategyParam = strategyQ.trim() || undefined;
    const sideParam = side === "all" ? undefined : side;

    const load = async () => {
      try {
        const [list, agg] = await Promise.all([
          api.tradeHistory({
            symbol: symbolParam,
            side: sideParam,
            strategy: strategyParam,
            page: 1,
            page_size: PAGE_SIZE,
          }),
          api.tradeHistoryStats({
            symbol: symbolParam,
            strategy: strategyParam,
          }),
        ]);
        if (cancelled) return;
        setTrades(list.trades);
        setStats(agg);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbolQ, strategyQ, side]);

  const activeFilterCount =
    (symbolQ ? 1 : 0) + (side !== "all" ? 1 : 0) + (strategyQ ? 1 : 0);

  const clearAll = () => {
    setSymbolQ("");
    setSide("all");
    setStrategyQ("");
  };

  return (
    <div className="flex flex-col h-full border-t border-border">
      <StatsStrip stats={stats} loading={loading && !stats} />

      <div className="flex items-center flex-wrap gap-x-4 gap-y-1.5 px-2 py-1.5 border-b border-border/60 bg-surface/30">
        <SearchInput
          value={symbolQ}
          onChange={(v) => setSymbolQ(v.toUpperCase())}
          placeholder="Symbol"
          width="w-20"
        />

        <FilterGroup
          label="Side"
          value={side}
          options={[
            { v: "all", label: "Any" },
            { v: "BUY", label: "Buy" },
            { v: "SELL", label: "Sell" },
          ]}
          onChange={(v) => setSide(v as SideFilter)}
        />

        <SearchInput
          value={strategyQ}
          onChange={setStrategyQ}
          placeholder="Strategy"
          width="w-32"
        />

        {activeFilterCount > 0 && (
          <button
            onClick={clearAll}
            className="ml-auto inline-flex items-center gap-1 h-5 px-2 rounded-sm border border-border bg-surface-2/60 hover:bg-surface-2 text-text-secondary hover:text-text-primary text-[10px] transition-colors"
          >
            <X size={9} />
            Clear all
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {error ? (
          <EmptyState
            icon={Activity}
            title="Couldn't load trade history"
            description={error}
          />
        ) : loading && trades.length === 0 ? (
          <LoadingRows />
        ) : trades.length === 0 ? (
          <EmptyState
            icon={Activity}
            title={activeFilterCount > 0 ? "No trades match your filters" : "No trades yet"}
            description={
              activeFilterCount > 0
                ? "Try clearing filters or widening the symbol search."
                : "Trade rows will appear here as orders fill."
            }
          />
        ) : (
          <TradeHistoryTable trades={trades} />
        )}
      </div>
    </div>
  );
});

// --- stats strip -------------------------------------------------------------

function StatsStrip({ stats, loading }: { stats: TradeStats | null; loading: boolean }) {
  return (
    <div className="flex items-center bg-surface border-b border-border px-3 h-8 overflow-x-auto shrink-0">
      <StatGroup>
        <StatItem
          label="Trades"
          value={stats ? String(stats.total_trades) : null}
          loading={loading}
          primary
        />
      </StatGroup>
      <StatGroup>
        <StatItem
          label="Win rate"
          value={stats ? (stats.win_rate * 100).toFixed(1) + "%" : null}
          valueClassName={
            stats
              ? stats.win_rate >= 0.5
                ? "text-up"
                : stats.win_rate >= 0.3
                ? "text-warning"
                : "text-down"
              : undefined
          }
          loading={loading}
        />
        <StatItem
          label="Wins"
          value={stats ? `${stats.winning_trades}/${stats.losing_trades}` : null}
          loading={loading}
          muted
        />
      </StatGroup>
      <StatGroup>
        <StatItem
          label="Total P&L"
          value={stats ? fmtCurrency(stats.total_pnl) : null}
          valueClassName={stats ? pnlClass(stats.total_pnl) : undefined}
          loading={loading}
        />
        <StatItem
          label="Avg P&L"
          value={stats ? fmtCurrency(stats.avg_pnl) : null}
          valueClassName={stats ? pnlClass(stats.avg_pnl) : undefined}
          loading={loading}
        />
      </StatGroup>
      <StatGroup last>
        <StatItem
          label="Profit factor"
          value={stats ? fmt(stats.profit_factor, 2) : null}
          loading={loading}
          muted
        />
      </StatGroup>
    </div>
  );
}

function StatGroup({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 first:pl-0",
        !last && "border-r border-border/40"
      )}
    >
      {children}
    </div>
  );
}

interface StatItemProps {
  label: string;
  value: string | null;
  valueClassName?: string;
  loading?: boolean;
  primary?: boolean;
  muted?: boolean;
}

function StatItem({ label, value, valueClassName, loading, primary, muted }: StatItemProps) {
  return (
    <div className="flex items-baseline gap-1.5 shrink-0">
      <span
        className={cn(
          "text-[10px] uppercase tracking-wider",
          muted ? "text-text-muted/70" : "text-text-muted"
        )}
      >
        {label}
      </span>
      {loading ? (
        <Skeleton className="h-3 w-14" />
      ) : value === null ? (
        <span className="tabular text-xs font-medium text-text-muted">—</span>
      ) : (
        <span
          className={cn(
            "tabular tabular-nums font-medium",
            primary ? "text-sm text-text-primary" : "text-xs text-text-primary",
            muted && !valueClassName && "text-text-secondary",
            valueClassName
          )}
        >
          {value}
        </span>
      )}
    </div>
  );
}

// --- filters -----------------------------------------------------------------

function SearchInput({
  value,
  onChange,
  placeholder,
  width,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  width: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 h-6 px-2 rounded-sm border border-border bg-surface-2/40 transition-colors",
        value ? "border-accent/50" : "hover:bg-surface-2/70"
      )}
    >
      <Search size={11} className="text-text-muted shrink-0" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "bg-transparent text-[11px] tabular text-text-primary placeholder:text-text-muted/60 outline-none",
          width
        )}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="text-text-muted hover:text-text-primary"
          aria-label={`Clear ${placeholder.toLowerCase()} filter`}
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-text-muted">{label}</span>
      <div className="flex h-6 rounded-sm border border-border overflow-hidden">
        {options.map((o, i) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            className={cn(
              "px-2 text-[10px] transition-colors whitespace-nowrap",
              i > 0 && "border-l border-border",
              value === o.v
                ? "bg-accent/15 text-accent font-medium"
                : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- table -------------------------------------------------------------------

function TradeHistoryTable({ trades }: { trades: TradeHistoryRecord[] }) {
  const { sorted, sort, toggleSort } = useTableSort<TradeHistoryRecord, SortKey>(
    trades,
    ACCESSORS,
    { key: "timestamp", direction: "desc" },
    NUMERIC
  );

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortableTableHead sortKey="timestamp" sort={sort} onSort={toggleSort}>time</SortableTableHead>
          <SortableTableHead sortKey="symbol" sort={sort} onSort={toggleSort}>symbol</SortableTableHead>
          <SortableTableHead sortKey="side" sort={sort} onSort={toggleSort}>side</SortableTableHead>
          <SortableTableHead sortKey="qty" sort={sort} onSort={toggleSort} align="right">qty</SortableTableHead>
          <SortableTableHead sortKey="price" sort={sort} onSort={toggleSort} align="right">price</SortableTableHead>
          <SortableTableHead sortKey="pnl" sort={sort} onSort={toggleSort} align="right">P&amp;L</SortableTableHead>
          <SortableTableHead sortKey="strategy" sort={sort} onSort={toggleSort}>strategy</SortableTableHead>
          <SortableTableHead sortKey="status" sort={sort} onSort={toggleSort}>status</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.length === 0 ? (
          <TableEmpty colSpan={8}>no trades</TableEmpty>
        ) : (
          sorted.map((t) => <TradeRow key={t.id} trade={t} />)
        )}
      </TableBody>
    </Table>
  );
}

function TradeRow({ trade: t }: { trade: TradeHistoryRecord }) {
  const time = useMemo(() => {
    const d = new Date(t.timestamp);
    if (Number.isNaN(d.getTime())) return { rel: "—", abs: t.timestamp };
    return {
      rel: formatDistanceToNow(d, { addSuffix: true }),
      abs: d.toLocaleString(),
    };
  }, [t.timestamp]);

  const pnl = t.pnl;
  const pnlPct = t.pnl_percentage;

  return (
    <TableRow>
      <TableCell className="text-text-muted whitespace-nowrap" title={time.abs}>
        {time.rel}
      </TableCell>
      <TableCell className="font-medium">{t.symbol}</TableCell>
      <TableCell>
        <Badge variant={t.side === "BUY" ? "up" : "down"}>{t.side}</Badge>
      </TableCell>
      <TableCell className="text-right tabular">{fmt(t.quantity, 0)}</TableCell>
      <TableCell className="text-right tabular">{fmt(t.price, 2)}</TableCell>
      <TableCell className={cn("text-right tabular font-medium", pnl != null ? pnlClass(pnl) : "text-text-muted")}>
        {pnl != null ? (
          <span className="inline-flex items-baseline gap-1 justify-end">
            {fmtCurrency(pnl)}
            {pnlPct != null && (
              <span className="text-[10px] text-text-muted">
                ({fmtPct(pnlPct)})
              </span>
            )}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="text-text-muted">{t.strategy ?? "—"}</TableCell>
      <TableCell>
        <StatusBadge status={t.status} />
      </TableCell>
    </TableRow>
  );
}

function StatusBadge({ status }: { status: TradeStatus }) {
  const variant: React.ComponentProps<typeof Badge>["variant"] = (() => {
    switch (status) {
      case "FILLED":
        return "up";
      case "CLOSED":
        return "accent";
      case "PARTIALLY_FILLED":
        return "warning";
      case "PENDING":
        return "muted";
      case "CANCELLED":
        return "outline";
      case "REJECTED":
        return "down";
      default:
        return "default";
    }
  })();
  return <Badge variant={variant}>{status.replace(/_/g, " ")}</Badge>;
}

// --- loading -----------------------------------------------------------------

function LoadingRows() {
  return (
    <div className="p-2 space-y-1.5">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  );
}
