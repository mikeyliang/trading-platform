"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Activity, LineChart as LineChartIcon, RefreshCw, Search, Table as TableIcon, X } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, type TradeHistoryRecord, type TradeStats, type TradeStatus } from "@/lib/api";
import { CHART } from "@/lib/chartTheme";
import { cn, fmt, fmtCompact, fmtCurrency, fmtPct, pnlClass } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
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
// API caps page_size at 500 — large enough for an equity curve in any
// realistic session, and lets us avoid multi-page chart fetches.
const CHART_PAGE_SIZE = 500;
const REFRESH_MS = 30_000;

type View = "table" | "chart";

export const TradeHistoryPanel = memo(function TradeHistoryPanel() {
  const [symbolQ, setSymbolQ] = useState("");
  const [side, setSide] = useState<SideFilter>("all");
  const [strategyQ, setStrategyQ] = useState("");
  const [view, setView] = useState<View>("table");

  const [trades, setTrades] = useState<TradeHistoryRecord[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [chartTrades, setChartTrades] = useState<TradeHistoryRecord[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);

  // IBKR fill sync — pulls today's executions from the gateway into the
  // store. The server also runs this every 10 min during RTH; the button is
  // "sync right now". refreshKey re-fires the list effect after new inserts.
  const [syncing, setSyncing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const syncIbkr = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await api.tradeHistorySyncIbkr();
      if (res.error === "ibkr_unavailable") {
        toast.error("IBKR gateway unreachable — is TWS/Gateway running?");
      } else if (res.error === "db_unavailable") {
        toast.error("Trade store unavailable — fills fetched but not logged");
      } else if (res.inserted > 0) {
        toast.success(`Logged ${res.inserted} new fill${res.inserted === 1 ? "" : "s"} from IBKR`);
        setRefreshKey((k) => k + 1);
      } else {
        toast(`Up to date — ${res.fetched} fill${res.fetched === 1 ? "" : "s"} today, all logged`);
      }
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  }, []);

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
  }, [symbolQ, strategyQ, side, refreshKey]);

  // Chart view pulls a larger, unpaginated slice so the equity curve covers
  // the full filtered set rather than just the first table page. Skipped
  // while the table view is active to avoid pointless API traffic.
  useEffect(() => {
    if (view !== "chart") return;
    let cancelled = false;
    const symbolParam = symbolQ.trim().toUpperCase() || undefined;
    const strategyParam = strategyQ.trim() || undefined;
    const sideParam = side === "all" ? undefined : side;

    const load = async () => {
      try {
        const list = await api.tradeHistory({
          symbol: symbolParam,
          side: sideParam,
          strategy: strategyParam,
          page: 1,
          page_size: CHART_PAGE_SIZE,
        });
        if (cancelled) return;
        setChartTrades(list.trades);
        setChartError(null);
      } catch (e) {
        if (cancelled) return;
        setChartError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    };

    setChartLoading(true);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [view, symbolQ, strategyQ, side]);

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

        <div className={cn("flex items-center gap-2", activeFilterCount > 0 ? "" : "ml-auto")}>
          {activeFilterCount > 0 && (
            <button
              onClick={clearAll}
              className="ml-auto inline-flex items-center gap-1 h-5 px-2 rounded-sm border border-border bg-surface-2/60 hover:bg-surface-2 text-text-secondary hover:text-text-primary text-[10px] transition-colors"
            >
              <X size={9} />
              Clear all
            </button>
          )}
          <button
            onClick={syncIbkr}
            disabled={syncing}
            title="Pull today's fills from the IBKR gateway (auto-syncs every 10 min during market hours)"
            className={cn(
              "inline-flex items-center gap-1.5 h-6 px-2 rounded-sm border border-border text-[10px] transition-colors",
              syncing
                ? "text-text-muted bg-surface-2/40 cursor-wait"
                : "text-text-secondary bg-surface-2/60 hover:bg-surface-2 hover:text-text-primary"
            )}
          >
            <RefreshCw size={10} className={syncing ? "animate-spin" : undefined} />
            {syncing ? "Syncing…" : "Sync IBKR"}
          </button>
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>

      <div className={cn("flex-1", view === "chart" ? "overflow-hidden" : "overflow-auto")}>
        {view === "chart" ? (
          chartError ? (
            <EmptyState
              icon={Activity}
              title="Couldn't load equity curve"
              description={chartError}
            />
          ) : chartLoading && chartTrades.length === 0 ? (
            <ChartSkeleton />
          ) : (
            <EquityCurveChart
              trades={chartTrades}
              emptyHint={activeFilterCount > 0}
            />
          )
        ) : error ? (
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

// --- view toggle -------------------------------------------------------------

function ViewToggle({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  const opts: { v: View; label: string; Icon: typeof TableIcon }[] = [
    { v: "table", label: "Table", Icon: TableIcon },
    { v: "chart", label: "Chart", Icon: LineChartIcon },
  ];
  return (
    <div className="flex h-6 rounded-sm border border-border overflow-hidden">
      {opts.map((o, i) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
          className={cn(
            "inline-flex items-center gap-1 px-2 text-[10px] transition-colors whitespace-nowrap",
            i > 0 && "border-l border-border",
            value === o.v
              ? "bg-accent/15 text-accent font-medium"
              : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
          )}
        >
          <o.Icon size={10} />
          {o.label}
        </button>
      ))}
    </div>
  );
}

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

// --- equity curve ------------------------------------------------------------

interface EquityPoint {
  t: number;
  cum: number;
  pnl: number;
  symbol: string;
}

function EquityCurveChart({
  trades,
  emptyHint,
}: {
  trades: TradeHistoryRecord[];
  emptyHint: boolean;
}) {
  const data = useMemo<EquityPoint[]>(() => {
    const pts = trades
      .filter((t) => t.pnl != null && Number.isFinite(t.pnl))
      .map((t) => ({ t: Date.parse(t.timestamp), pnl: t.pnl as number, symbol: t.symbol }))
      .filter((p) => Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t);
    let cum = 0;
    return pts.map((p) => {
      cum += p.pnl;
      return { t: p.t, cum, pnl: p.pnl, symbol: p.symbol };
    });
  }, [trades]);

  if (data.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title={emptyHint ? "No P&L to chart" : "Equity curve will appear here"}
        description={
          emptyHint
            ? "No realized P&L in the filtered set — try widening filters or switch back to the table."
            : "Once trades close with realized P&L the equity curve will plot here."
        }
      />
    );
  }

  const final = data[data.length - 1].cum;
  const stroke = final >= 0 ? CHART.up : CHART.down;
  const gradId = "equity-curve-fill";

  return (
    <div className="h-full w-full p-2">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 8, left: 4 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tick={{ fill: CHART.axisText, fontSize: 10 }}
            stroke={CHART.axis}
            tickLine={false}
            tickFormatter={fmtAxisDate}
            minTickGap={48}
          />
          <YAxis
            tick={{ fill: CHART.axisText, fontSize: 10 }}
            stroke={CHART.axis}
            tickLine={false}
            width={56}
            tickFormatter={(v: number) => "$" + fmtCompact(v)}
          />
          <ReferenceLine y={0} stroke={CHART.axis} strokeDasharray="2 4" />
          <Tooltip
            cursor={{ stroke: CHART.crosshair, strokeDasharray: "3 3" }}
            contentStyle={{
              backgroundColor: CHART.surface,
              border: `1px solid ${CHART.axis}`,
              borderRadius: 4,
              fontSize: 11,
              padding: "6px 8px",
            }}
            labelStyle={{ color: CHART.textMuted, marginBottom: 2 }}
            itemStyle={{ color: CHART.text }}
            labelFormatter={(v) => new Date(v as number).toLocaleString()}
            formatter={(value: number, _name, item: { payload?: unknown }) => {
              const p = (item?.payload ?? {}) as Partial<EquityPoint>;
              const trade =
                p.symbol && p.pnl != null
                  ? `${p.symbol}  ${p.pnl >= 0 ? "+" : ""}${fmtCurrency(p.pnl)}`
                  : null;
              return [
                <span key="v" className={value >= 0 ? "text-up" : "text-down"}>
                  {fmtCurrency(value)}
                </span>,
                trade ?? "Cumulative",
              ];
            }}
          />
          <Line
            type="monotone"
            dataKey="cum"
            stroke={stroke}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, fill: stroke, stroke: CHART.bg, strokeWidth: 1 }}
            isAnimationActive={false}
            fill={`url(#${gradId})`}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function fmtAxisDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ChartSkeleton() {
  return (
    <div className="h-full w-full p-2">
      <Skeleton className="h-full w-full" />
    </div>
  );
}
