"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  RiPulseLine,
  RiCalendarLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiErrorWarningFill,
  RiLineChartLine,
  RiChat1Line,
  RiTableLine,
} from "@remixicon/react";
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
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { Skeleton, TableSkeletonRows } from "@/components/ui/skeleton";
import { Stat, StatGroup } from "@/components/ui/stat";
import { ToggleGroup } from "@/components/ui/toggle-group";
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
type AssetFilter = "all" | "stock" | "option";
type TxFilter = "all" | "ExchTrade" | "BookTrade" | "EXPIRATION" | "EXERCISE" | "ASSIGNMENT";
type NotesFilter = "all" | "with" | "without";

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
// API caps page_size at 500, large enough for an equity curve in any
// realistic session, and lets us avoid multi-page chart fetches.
const CHART_PAGE_SIZE = 500;
const REFRESH_MS = 30_000;

type View = "table" | "chart" | "daily";

export const TradeHistoryPanel = memo(function TradeHistoryPanel() {
  const [symbolQ, setSymbolQ] = useState("");
  const [side, setSide] = useState<SideFilter>("all");
  const [strategyQ, setStrategyQ] = useState("");
  const [asset, setAsset] = useState<AssetFilter>("all");
  const [accountQ, setAccountQ] = useState("");
  const [tx, setTx] = useState<TxFilter>("all");
  const [notes, setNotes] = useState<NotesFilter>("all");
  const [view, setView] = useState<View>("table");

  const [trades, setTrades] = useState<TradeHistoryRecord[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [chartTrades, setChartTrades] = useState<TradeHistoryRecord[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Server-side filters: symbol / side / strategy / asset / account / tx
  // go to the API so paging is accurate and stats reflect the filtered set.
  // Resetting page state is unnecessary, we always pull the first page
  // and cap at PAGE_SIZE.
  useEffect(() => {
    let cancelled = false;
    const symbolParam = symbolQ.trim().toUpperCase() || undefined;
    const strategyParam = strategyQ.trim() || undefined;
    const sideParam = side === "all" ? undefined : side;
    const assetParam = asset === "all" ? undefined : asset;
    const accountParam = accountQ.trim().toUpperCase() || undefined;
    const txParam = tx === "all" ? undefined : tx;
    const notesParam = notes === "all" ? undefined : notes === "with";

    const load = async () => {
      try {
        const [list, agg] = await Promise.all([
          api.tradeHistory({
            symbol: symbolParam,
            side: sideParam,
            strategy: strategyParam,
            asset_class: assetParam,
            account_id: accountParam,
            transaction_type: txParam,
            has_note: notesParam,
            page: 1,
            page_size: PAGE_SIZE,
          }),
          api.tradeHistoryStats({
            symbol: symbolParam,
            strategy: strategyParam,
          }),
        ]);
        if (cancelled) return;
        setTrades(Array.isArray(list?.trades) ? list.trades : []);
        // The stats endpoint answers with a bare object; treat a missing
        // count as "no stats" rather than painting undefined into the strip.
        setStats(agg && typeof agg.total_trades === "number" ? agg : null);
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
  }, [symbolQ, strategyQ, side, asset, accountQ, tx, notes, nonce]);

  // Chart view pulls a larger, unpaginated slice so the equity curve covers
  // the full filtered set rather than just the first table page. Skipped
  // while the table view is active to avoid pointless API traffic.
  useEffect(() => {
    if (view !== "chart") return;
    let cancelled = false;
    const symbolParam = symbolQ.trim().toUpperCase() || undefined;
    const strategyParam = strategyQ.trim() || undefined;
    const sideParam = side === "all" ? undefined : side;
    const assetParam = asset === "all" ? undefined : asset;
    const accountParam = accountQ.trim().toUpperCase() || undefined;
    const txParam = tx === "all" ? undefined : tx;
    const notesParam = notes === "all" ? undefined : notes === "with";

    const load = async () => {
      try {
        const list = await api.tradeHistory({
          symbol: symbolParam,
          side: sideParam,
          strategy: strategyParam,
          asset_class: assetParam,
          account_id: accountParam,
          transaction_type: txParam,
          has_note: notesParam,
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
  }, [view, symbolQ, strategyQ, side, asset, accountQ, tx, notes]);

  const activeFilterCount =
    (symbolQ ? 1 : 0)
    + (side !== "all" ? 1 : 0)
    + (strategyQ ? 1 : 0)
    + (asset !== "all" ? 1 : 0)
    + (accountQ ? 1 : 0)
    + (tx !== "all" ? 1 : 0)
    + (notes !== "all" ? 1 : 0);

  const clearAll = () => {
    setSymbolQ("");
    setSide("all");
    setStrategyQ("");
    setAsset("all");
    setAccountQ("");
    setTx("all");
    setNotes("all");
  };

  const SIDE_LABEL: Record<SideFilter, string> = { all: "Any", BUY: "Buy", SELL: "Sell" };
  const ASSET_LABEL: Record<AssetFilter, string> = { all: "Any", stock: "Stock", option: "Option" };
  const TX_LABEL: Record<TxFilter, string> = {
    all: "Any", ExchTrade: "Fill", BookTrade: "Book", EXPIRATION: "Expiration", EXERCISE: "Exercise", ASSIGNMENT: "Assignment",
  };
  const NOTES_LABEL: Record<NotesFilter, string> = { all: "Any", with: "With notes", without: "Without notes" };

  const chips = [
    ...(side !== "all" ? [{ key: "side", label: `Side: ${SIDE_LABEL[side]}`, onRemove: () => setSide("all") }] : []),
    ...(strategyQ ? [{ key: "strategy", label: `Strategy: ${strategyQ}`, onRemove: () => setStrategyQ("") }] : []),
    ...(asset !== "all" ? [{ key: "asset", label: `Asset: ${ASSET_LABEL[asset]}`, onRemove: () => setAsset("all") }] : []),
    ...(tx !== "all" ? [{ key: "tx", label: `Type: ${TX_LABEL[tx]}`, onRemove: () => setTx("all") }] : []),
    ...(accountQ ? [{ key: "account", label: `Account: ${accountQ}`, onRemove: () => setAccountQ("") }] : []),
    ...(notes !== "all" ? [{ key: "notes", label: NOTES_LABEL[notes], onRemove: () => setNotes("all") }] : []),
  ];

  const retry = () => {
    setLoading(true);
    setError(null);
    setNonce((n) => n + 1);
  };

  return (
    <>
      <StatsCard stats={stats} loading={loading && !stats} />

      <Card className="shrink-0">
        <CardContent className="p-1">
          <FilterBar
            className="bg-transparent"
            search={{
              value: symbolQ,
              onChange: (v) => setSymbolQ(v.toUpperCase()),
              placeholder: "Symbol",
            }}
            chips={chips}
            actions={
              activeFilterCount > 0 ? (
                <Button variant="secondary" onClick={clearAll}>Clear all</Button>
              ) : undefined
            }
            advanced={
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                <Field label="Side">
                  <Select value={side} onValueChange={(v) => setSide(v as SideFilter)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(SIDE_LABEL) as SideFilter[]).map((k) => (
                        <SelectItem key={k} value={k}>{SIDE_LABEL[k]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Asset">
                  <Select value={asset} onValueChange={(v) => setAsset(v as AssetFilter)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ASSET_LABEL) as AssetFilter[]).map((k) => (
                        <SelectItem key={k} value={k}>{ASSET_LABEL[k]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Transaction">
                  <Select value={tx} onValueChange={(v) => setTx(v as TxFilter)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(["all", "ExchTrade", "EXPIRATION", "EXERCISE", "ASSIGNMENT"] as TxFilter[]).map((k) => (
                        <SelectItem key={k} value={k}>{TX_LABEL[k]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Notes">
                  <Select value={notes} onValueChange={(v) => setNotes(v as NotesFilter)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(NOTES_LABEL) as NotesFilter[]).map((k) => (
                        <SelectItem key={k} value={k}>{NOTES_LABEL[k]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Strategy">
                  <Input value={strategyQ} onChange={(e) => setStrategyQ(e.target.value)} placeholder="Any strategy" />
                </Field>
                <Field label="Account">
                  <Input
                    value={accountQ}
                    onChange={(e) => setAccountQ(e.target.value.toUpperCase())}
                    placeholder="Any account"
                    className="tabular"
                  />
                </Field>
              </div>
            }
          />
        </CardContent>
      </Card>

      <Card className="flex flex-col shrink-0">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Trades</CardTitle>
            {!loading && !error && <Badge variant="muted">{trades.length}</Badge>}
          </div>
          <ToggleGroup
            ariaLabel="Trade view"
            value={view}
            onChange={setView}
            options={[
              { value: "table", label: <ViewLabel icon={RiTableLine} text="Table" /> },
              { value: "daily", label: <ViewLabel icon={RiCalendarLine} text="Daily" /> },
              { value: "chart", label: <ViewLabel icon={RiLineChartLine} text="Chart" /> },
            ]}
          />
        </CardHeader>

        <div className={cn(view === "chart" ? "h-80 overflow-hidden" : "max-h-[640px] overflow-auto")}>
          {view === "chart" ? (
            chartError ? (
              <EmptyState
                icon={RiErrorWarningFill}
                title="Equity curve unavailable"
                description={chartError}
                action={<Button onClick={() => setView("table")}>Back to table</Button>}
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
              icon={RiErrorWarningFill}
              title="Trade history unavailable"
              description={error}
              action={<Button onClick={retry}>Retry</Button>}
            />
          ) : loading && trades.length === 0 ? (
            <LoadingRows />
          ) : trades.length === 0 ? (
            <EmptyState
              icon={RiPulseLine}
              title={activeFilterCount > 0 ? "No trades match your filters" : "No trades yet"}
              description={
                activeFilterCount > 0
                  ? "Try clearing filters or widening the symbol search."
                  : "Trade rows will appear here as orders fill."
              }
              action={activeFilterCount > 0 ? <Button onClick={clearAll}>Clear filters</Button> : undefined}
            />
          ) : view === "daily" ? (
            <DailyRollupView trades={trades} />
          ) : (
            <TradeHistoryTable trades={trades} />
          )}
        </div>
      </Card>
    </>
  );
});

function ViewLabel({ icon: Icon, text }: { icon: typeof RiTableLine; text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon size={14} aria-hidden />
      {text}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <span className="text-caption-1-medium text-text-tertiary">{label}</span>
      {children}
    </div>
  );
}

// --- stats card ----------------------------------------------------------------

function StatsCard({ stats, loading }: { stats: TradeStats | null; loading: boolean }) {
  const v = (fn: (s: TradeStats) => string) => (stats ? fn(stats) : "n/a");
  const value = (fn: (s: TradeStats) => string) => (loading ? <Skeleton className="h-4 w-16" /> : v(fn));
  return (
    <Card className="shrink-0">
      <CardContent>
        <StatGroup>
          <Stat label="Trades" value={value((s) => String(s.total_trades))} />
          <Stat
            label="Win rate"
            value={value((s) => (s.win_rate * 100).toFixed(1) + "%")}
            tone={
              stats
                ? stats.win_rate >= 0.5
                  ? "up"
                  : stats.win_rate >= 0.3
                  ? "warning"
                  : "down"
                : "default"
            }
          />
          <Stat label="Wins and losses" value={value((s) => `${s.winning_trades} / ${s.losing_trades}`)} />
          <Stat
            label="Total P&L"
            value={value((s) => fmtCurrency(s.total_pnl))}
            tone={stats ? (stats.total_pnl > 0 ? "up" : stats.total_pnl < 0 ? "down" : "default") : "default"}
          />
          <Stat
            label="Avg P&L"
            value={value((s) => fmtCurrency(s.avg_pnl))}
            tone={stats ? (stats.avg_pnl > 0 ? "up" : stats.avg_pnl < 0 ? "down" : "default") : "default"}
          />
          <Stat label="Profit factor" value={value((s) => fmt(s.profit_factor, 2))} />
        </StatGroup>
      </CardContent>
    </Card>
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
          <SortableTableHead sortKey="timestamp" sort={sort} onSort={toggleSort}>Time</SortableTableHead>
          <SortableTableHead sortKey="symbol" sort={sort} onSort={toggleSort}>Symbol</SortableTableHead>
          <SortableTableHead sortKey="side" sort={sort} onSort={toggleSort}>Side</SortableTableHead>
          <SortableTableHead sortKey="qty" sort={sort} onSort={toggleSort} align="right">Qty</SortableTableHead>
          <SortableTableHead sortKey="price" sort={sort} onSort={toggleSort} align="right">Price</SortableTableHead>
          <SortableTableHead sortKey="pnl" sort={sort} onSort={toggleSort} align="right">P&amp;L</SortableTableHead>
          <SortableTableHead sortKey="strategy" sort={sort} onSort={toggleSort}>Strategy</SortableTableHead>
          <SortableTableHead sortKey="status" sort={sort} onSort={toggleSort}>Status</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.length === 0 ? (
          <TableEmpty colSpan={8}>No trades</TableEmpty>
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
    if (Number.isNaN(d.getTime())) return { rel: "n/a", abs: t.timestamp };
    return {
      rel: formatDistanceToNow(d, { addSuffix: true }),
      abs: d.toLocaleString(),
    };
  }, [t.timestamp]);

  const pnl = t.pnl;
  const pnlPct = t.pnl_percentage;
  const contract = useMemo(() => readContractMeta(t), [t]);

  return (
    <TableRow>
      <TableCell className="text-text-tertiary whitespace-nowrap" title={time.abs}>
        {time.rel}
      </TableCell>
      <TableCell>
        <div className="inline-flex items-center gap-1.5">
          <ContractCell symbol={t.symbol} contract={contract} />
          <NoteIndicator note={contract.note} />
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={t.side === "BUY" ? "up" : "down"}>{t.side === "BUY" ? "Buy" : t.side === "SELL" ? "Sell" : t.side}</Badge>
      </TableCell>
      <TableCell className="text-right">{fmt(t.quantity, 0)}</TableCell>
      <TableCell className="text-right">{fmt(t.price, 2)}</TableCell>
      <TableCell className={cn("text-right", pnl != null ? pnlClass(pnl) : "text-text-tertiary")}>
        {pnl != null ? (
          <span className="inline-flex items-baseline gap-1 justify-end">
            {fmtCurrency(pnl)}
            {pnlPct != null && (
              <span className="text-caption-1-regular text-text-tertiary">
                ({fmtPct(pnlPct)})
              </span>
            )}
          </span>
        ) : (
          "n/a"
        )}
      </TableCell>
      <TableCell className="text-text-tertiary">{t.strategy ?? "n/a"}</TableCell>
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
  const label = status.replace(/_/g, " ").toLowerCase();
  return <Badge variant={variant}>{label.charAt(0).toUpperCase() + label.slice(1)}</Badge>;
}

// --- loading -----------------------------------------------------------------

function LoadingRows() {
  return (
    <Table>
      <TableBody>
        <TableSkeletonRows rows={8} cols={8} widths={["w-20", "w-16", "w-10", "w-8", "w-14", "w-16", "w-20", "w-12"]} />
      </TableBody>
    </Table>
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
        icon={RiLineChartLine}
        title={emptyHint ? "No P&L to chart" : "Equity curve will appear here"}
        description={
          emptyHint
            ? "No realized P&L in the filtered set, try widening filters or switch back to the table."
            : "Once trades close with realized P&L the equity curve will plot here."
        }
      />
    );
  }

  const final = data[data.length - 1].cum;
  const stroke = final >= 0 ? CHART.up : CHART.down;
  const gradId = "equity-curve-fill";

  return (
    <div className="h-full w-full p-3">
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
            formatter={(value, _name, item: any) => {
              const v = value as number;
              const p = (item?.payload ?? {}) as Partial<EquityPoint>;
              const trade =
                p.symbol && p.pnl != null
                  ? `${p.symbol}  ${p.pnl >= 0 ? "+" : ""}${fmtCurrency(p.pnl)}`
                  : null;
              return [
                <span key="v" className={v >= 0 ? "text-status-lime-text" : "text-status-rose-text"}>
                  {fmtCurrency(v)}
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

// --- daily roll-up view --------------------------------------------------------

interface DayGroup {
  /** yyyy-mm-dd in user local time so adjacent rows are visually 1 day apart. */
  key: string;
  /** Day label, e.g. "Mon, May 20". */
  label: string;
  /** ISO date for sorting (yyyy-mm-dd, lexicographic). */
  sortKey: string;
  trades: TradeHistoryRecord[];
  netPnl: number;
  buys: number;
  sells: number;
  wins: number;
  losses: number;
  /** Distinct symbols traded that day, sized to hint diversification. */
  symbols: string[];
}

function DailyRollupView({ trades }: { trades: TradeHistoryRecord[] }) {
  const groups = useMemo(() => groupByDay(trades), [trades]);
  // Open the most recent day by default, the rest are collapsed so the
  // page loads compactly. User clicks to expand others.
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => {
    if (groups.length === 0) return new Set();
    return new Set([groups[0].key]);
  });
  // Re-seed once when the underlying data shape changes (new filter,
  // new page). Using a length+first-key fingerprint as the seed signal
  // avoids the infinite-set-state loop a plain `groups` dep would cause.
  const fingerprint = `${groups.length}:${groups[0]?.key ?? ""}`;
  useEffect(() => {
    if (groups.length > 0) setOpenKeys(new Set([groups[0].key]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={RiCalendarLine}
        title="No trades to group by day"
        description="Adjust filters or switch back to the table view."
      />
    );
  }

  return (
    <ul className="flex flex-col">
      {groups.map((g) => {
        const open = openKeys.has(g.key);
        return (
          <li key={g.key} className="border-b border-separator-border">
            <button
              type="button"
              onClick={() =>
                setOpenKeys((prev) => {
                  const next = new Set(prev);
                  if (next.has(g.key)) next.delete(g.key);
                  else next.add(g.key);
                  return next;
                })
              }
              aria-expanded={open}
              className="w-full flex items-center gap-3 px-4 h-9 text-body-2-medium tabular hover:bg-background-secondary-hover transition-colors"
            >
              <span className="text-foreground-icon-tertiary shrink-0">
                {open ? <RiArrowDownSLine size={16} aria-hidden /> : <RiArrowRightSLine size={16} aria-hidden />}
              </span>
              <span className="text-text-primary min-w-[110px] text-left">
                {g.label}
              </span>
              <span className="text-text-tertiary text-caption-1-regular">
                {g.trades.length} trade{g.trades.length === 1 ? "" : "s"}
              </span>
              <span className="text-text-tertiary text-caption-1-regular">
                {g.buys} buy {g.sells} sell
              </span>
              <span
                className={cn(
                  "ml-auto",
                  g.netPnl === 0 ? "text-text-tertiary" : pnlClass(g.netPnl),
                )}
                title={`${g.wins} winning, ${g.losses} losing trades`}
              >
                {g.netPnl === 0 ? "n/a" : fmtCurrency(g.netPnl)}
              </span>
              <span
                className="text-caption-1-regular text-text-tertiary max-w-[160px] truncate hidden md:inline-block"
                title={g.symbols.join(", ")}
              >
                {g.symbols.slice(0, 4).join(", ")}
                {g.symbols.length > 4 && ` +${g.symbols.length - 4}`}
              </span>
            </button>
            {open && (
              <div className="border-t border-separator-border">
                <Table>
                  <TableBody>
                    {g.trades.map((t) => (
                      <TradeRow key={t.id} trade={t} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function groupByDay(trades: TradeHistoryRecord[]): DayGroup[] {
  // Group keyed by yyyy-mm-dd in the user's local time so a 22:00 ET
  // fill doesn't end up under the next UTC day.
  const m = new Map<string, DayGroup>();
  for (const t of trades) {
    const d = new Date(t.timestamp);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    let g = m.get(key);
    if (!g) {
      g = {
        key,
        label: d.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
        sortKey: key,
        trades: [],
        netPnl: 0,
        buys: 0,
        sells: 0,
        wins: 0,
        losses: 0,
        symbols: [],
      };
      m.set(key, g);
    }
    g.trades.push(t);
    const side = (t.side || "").toString().toUpperCase();
    if (side.startsWith("B")) g.buys++;
    else if (side.startsWith("S")) g.sells++;
    if (t.pnl != null && Number.isFinite(t.pnl)) {
      g.netPnl += t.pnl;
      if (t.pnl > 0) g.wins++;
      else if (t.pnl < 0) g.losses++;
    }
    if (t.symbol && !g.symbols.includes(t.symbol)) g.symbols.push(t.symbol);
  }
  return Array.from(m.values()).sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1));
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// --- contract metadata --------------------------------------------------------

interface ContractMeta {
  isOption: boolean;
  isExpiration: boolean;       // EAE row: EXPIRATION / EXERCISE / ASSIGNMENT
  txType: string | null;       // ExchTrade / BookTrade / EXPIRATION / EXERCISE / ASSIGNMENT
  strike: number | null;
  expiry: string | null;       // yyyymmdd or yyyy-mm-dd
  right: "C" | "P" | null;
  account: string | null;
  note: string | null;         // metadata.note, set via the chart-marker journal
}

function readContractMeta(t: TradeHistoryRecord): ContractMeta {
  const m = (t.metadata ?? {}) as Record<string, unknown>;
  const asset = typeof m.asset_category === "string" ? (m.asset_category as string).toUpperCase() : "";
  const isOption = asset === "OPT" || asset === "FOP";
  const txType = typeof m.transaction_type === "string" ? (m.transaction_type as string) : null;
  const isExpiration = !!txType && /EXPIRATION|EXERCISE|ASSIGNMENT/i.test(txType);
  const strikeRaw = m.option_strike;
  const expiryRaw = m.option_expiry;
  const rightRaw = m.option_right;
  const strike = typeof strikeRaw === "number" ? strikeRaw : null;
  const expiry = typeof expiryRaw === "string" && expiryRaw.length >= 6 ? expiryRaw : null;
  const right = rightRaw === "C" || rightRaw === "P" ? rightRaw : null;
  const account = typeof m.account_id === "string" ? (m.account_id as string) : null;
  const noteRaw = m.note;
  const note = typeof noteRaw === "string" && noteRaw.trim().length > 0 ? (noteRaw as string) : null;
  return { isOption, isExpiration, txType, strike, expiry, right, account, note };
}

function NoteIndicator({ note }: { note: string | null }) {
  if (!note) return null;
  // Truncate the tooltip preview so a 3-paragraph journal entry doesn't
  // produce an absurd hover label.
  const preview = note.length > 200 ? note.slice(0, 200) + "…" : note;
  return (
    <span
      className="inline-flex items-center text-foreground-icon-tertiary hover:text-text-primary transition-colors cursor-help"
      title={preview}
    >
      <RiChat1Line size={14} aria-hidden />
    </span>
  );
}

function ContractCell({
  symbol, contract,
}: { symbol: string; contract: ContractMeta }) {
  if (!contract.isOption) {
    return <span>{symbol}</span>;
  }
  const exp = contract.expiry ? fmtOptionExpiry(contract.expiry) : null;
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-text-primary">{symbol}</span>
      {contract.strike != null && contract.right && (
        <span className="text-text-secondary tabular text-caption-1-medium">
          {formatStrike(contract.strike)}{contract.right}
        </span>
      )}
      {exp && (
        <span className="text-text-tertiary text-caption-1-regular tabular">{exp}</span>
      )}
      {contract.isExpiration && contract.txType && (
        <Badge variant="muted" title={`Transaction type: ${contract.txType}`}>
          {shortTxLabel(contract.txType)}
        </Badge>
      )}
    </span>
  );
}

function formatStrike(s: number): string {
  // Drop trailing .00 / .0 for cleaner display.
  if (Number.isInteger(s)) return s.toString();
  return s.toFixed(2).replace(/\.?0+$/, "");
}

function fmtOptionExpiry(s: string): string {
  // Accept yyyymmdd or yyyy-mm-dd; emit "MMM dd" or "MMM dd 'YY".
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length < 8) return s;
  const y = digits.slice(2, 4);
  const m = parseInt(digits.slice(4, 6), 10);
  const d = digits.slice(6, 8);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mo = months[m - 1] ?? digits.slice(4, 6);
  const now = new Date();
  const yyyy = parseInt(digits.slice(0, 4), 10);
  return yyyy === now.getFullYear() ? `${mo} ${d}` : `${mo} ${d} '${y}`;
}

function shortTxLabel(tx: string): string {
  const u = tx.toUpperCase();
  if (u.startsWith("EXPIR")) return "Expired";
  if (u.startsWith("EXER")) return "Exercised";
  if (u.startsWith("ASSIGN")) return "Assigned";
  return tx.charAt(0).toUpperCase() + tx.slice(1).toLowerCase();
}

function fmtAxisDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ChartSkeleton() {
  return (
    <div className="h-full w-full p-4">
      <Skeleton className="h-full w-full rounded-2lg" />
    </div>
  );
}
