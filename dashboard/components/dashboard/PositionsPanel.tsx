"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { List, type RowComponentProps } from "react-window";
import { api, type Spread } from "@/lib/api";
import { useStore } from "@/lib/store";
import { fmtCurrency, fmtPct, pnlClass, cn } from "@/lib/utils";
import type { Position, Trade } from "@/types";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
  TableEmpty,
  SortableTableHead,
  useTableSort,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Logo } from "@/components/ui/logo";
import { Briefcase, Layers, Activity, Target, Search, X } from "lucide-react";

// Beyond this row count, virtual scrolling cuts DOM nodes by >10x. Below
// the threshold, real <table> rows still render so sticky headers + native
// scrollbars behave normally.
const VIRTUAL_THRESHOLD = 40;
const VIRTUAL_ROW_HEIGHT = 36;

type Tab = "positions" | "spreads" | "trades";
type SideFilter = "all" | "long" | "short";
type KindFilter = "all" | "stock" | "option" | "leg";

interface Props {
  /** When set, pre-fills the symbol filter so the panel narrows to this symbol.
   *  Use on /chart/[symbol] so the trader sees their exposure in that name. */
  symbolFilter?: string;
}

export const PositionsPanel = memo(function PositionsPanel({ symbolFilter: initialSymbol = "" }: Props = {}) {
  const [tab, setTab] = useState<Tab>("positions");
  // Positions are WS-pushed via the store snapshot. Slow REST poll is the
  // safety net for cold start + stale-WS recovery.
  const positions = useStore((s) => s.positions);
  const setStorePositions = useStore((s) => s.setPositions);
  const [spreads, setSpreads] = useState<Spread[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);

  // Filter state — reset when the parent re-feeds a different symbol prop.
  const [symbolQ, setSymbolQ] = useState(initialSymbol.toUpperCase());
  const [side, setSide] = useState<SideFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");

  useEffect(() => {
    setSymbolQ(initialSymbol.toUpperCase());
  }, [initialSymbol]);

  useEffect(() => {
    const load = () => {
      api.positions().then(setStorePositions).catch(() => null);
      api.spreads().then(setSpreads).catch(() => null);
      api.trades().then(setTrades).catch(() => null);
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [setStorePositions]);

  const kinds = useMemo(() => classifyPositions(positions), [positions]);

  const filteredPositions = useMemo(() => {
    return positions.filter((p, i) => {
      if (symbolQ && !p.symbol.toUpperCase().includes(symbolQ)) return false;
      if (side === "long" && p.quantity <= 0) return false;
      if (side === "short" && p.quantity >= 0) return false;
      if (kind !== "all" && kinds[i] !== kind) return false;
      return true;
    });
  }, [positions, kinds, symbolQ, side, kind]);
  const filteredKinds = useMemo(
    () =>
      positions
        .map((_, i) => kinds[i])
        .filter((_, i) => filteredPositions.includes(positions[i])),
    [positions, kinds, filteredPositions]
  );
  const filteredSpreads = useMemo(
    () => spreads.filter((s) => !symbolQ || s.symbol.toUpperCase().includes(symbolQ)),
    [spreads, symbolQ]
  );
  const filteredTrades = useMemo(
    () => trades.filter((t) => !symbolQ || t.symbol.toUpperCase().includes(symbolQ)),
    [trades, symbolQ]
  );

  const activeFilterCount =
    (symbolQ ? 1 : 0) + (side !== "all" ? 1 : 0) + (kind !== "all" ? 1 : 0);

  const clearAll = () => {
    setSymbolQ("");
    setSide("all");
    setKind("all");
  };

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as Tab)}
      className="flex flex-col h-full border-t border-border"
    >
      {/* Tab strip — left. Filter status — right. */}
      <div className="flex items-stretch border-b border-border bg-surface/40">
        <TabsList className="shrink-0 border-0">
          <TabTriggerWithCount value="positions" label="positions" count={filteredPositions.length} total={positions.length} />
          <TabTriggerWithCount value="spreads" label="spreads" count={filteredSpreads.length} total={spreads.length} />
          <TabTriggerWithCount value="trades" label="trades" count={filteredTrades.length} total={trades.length} />
        </TabsList>

        {activeFilterCount > 0 && (
          <div className="ml-auto flex items-center gap-2 pr-2 text-[10px] text-text-muted">
            <span className="tabular">
              {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} on
            </span>
            <button
              onClick={clearAll}
              className="inline-flex items-center gap-1 h-5 px-2 rounded-sm border border-border bg-surface-2/60 hover:bg-surface-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              <X size={9} />
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Filter row — dedicated line so groups breathe and stay readable.
          Each filter group is labeled; no cryptic abbreviations. "Any" is
          a real choice in the segmented control so the off-state is clear. */}
      <div className="flex items-center flex-wrap gap-x-4 gap-y-1.5 px-2 py-1.5 border-b border-border/60 bg-surface/30">
        {/* Symbol search — magnifier + input + inline clear */}
        <div className={cn(
          "flex items-center gap-1.5 h-6 px-2 rounded-sm border border-border bg-surface-2/40 transition-colors",
          symbolQ ? "border-accent/50" : "hover:bg-surface-2/70"
        )}>
          <Search size={11} className="text-text-muted shrink-0" />
          <input
            value={symbolQ}
            onChange={(e) => setSymbolQ(e.target.value.toUpperCase())}
            placeholder="Symbol"
            className="w-20 bg-transparent text-[11px] tabular text-text-primary placeholder:text-text-muted/60 outline-none"
          />
          {symbolQ && (
            <button
              onClick={() => setSymbolQ("")}
              className="text-text-muted hover:text-text-primary"
              aria-label="Clear symbol filter"
            >
              <X size={10} />
            </button>
          )}
        </div>

        <FilterGroup
          label="Side"
          value={side}
          options={[
            { v: "all", label: "Any" },
            { v: "long", label: "Long" },
            { v: "short", label: "Short" },
          ]}
          onChange={(v) => setSide(v as SideFilter)}
        />

        <FilterGroup
          label="Type"
          value={kind}
          options={[
            { v: "all", label: "Any" },
            { v: "stock", label: "Stock" },
            { v: "option", label: "Option" },
            { v: "leg", label: "Spread leg" },
          ]}
          onChange={(v) => setKind(v as KindFilter)}
        />
      </div>

      <TabsContent value="positions" className="flex-1 overflow-auto mt-0">
        {positions.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="No open positions"
            description="Positions sync from IBKR Gateway once you have any open."
          />
        ) : filteredPositions.length === 0 ? (
          <FilterEmpty label={`No positions match "${symbolQ}"${side !== "all" ? ` · ${side}` : ""}${kind !== "all" ? ` · ${kind}` : ""}`} />
        ) : (
          <PositionsTable positions={filteredPositions} kinds={filteredKinds} />
        )}
      </TabsContent>
      <TabsContent value="spreads" className="flex-1 overflow-auto mt-0">
        {spreads.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No open spreads"
            description="Load RUT or SPY on the chart — the Rule One cycle card shows the next short strike for each strategy."
            action={
              <Link
                href="/chart/RUT"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent hover:bg-accent/90 text-white text-xs"
              >
                View RUT cycle →
              </Link>
            }
          />
        ) : filteredSpreads.length === 0 ? (
          <FilterEmpty label={`No spreads in ${symbolQ}`} />
        ) : (
          <SpreadsTable spreads={filteredSpreads} />
        )}
      </TabsContent>
      <TabsContent value="trades" className="flex-1 overflow-auto mt-0">
        {trades.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No trades yet"
            description="Trade history will populate once orders fill via your connected broker."
          />
        ) : filteredTrades.length === 0 ? (
          <FilterEmpty label={`No trades in ${symbolQ}`} />
        ) : (
          <TradesTable trades={filteredTrades} />
        )}
      </TabsContent>
    </Tabs>
  );
}

/**
 * Labeled segmented control: a small uppercase label sits to the left of a
 * row of segment buttons. The label tells the user what dimension is being
 * filtered (Side, Type…) so segment values don't have to carry that meaning
 * by themselves — no more "stk/opt/leg" cipher.
 *
 * The first option (typically "Any") is the no-filter state; it stays in
 * the segmented control rather than being implicit so the off-state is
 * always visible and clickable.
 */
function FilterGroup<T extends string>({
  label, value, options, onChange,
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

function FilterEmpty({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-full text-[11px] text-text-muted px-3 py-6">
      {label}
    </div>
  );
}

function TabTriggerWithCount({
  value, label, count, total,
}: {
  value: string;
  label: string;
  count: number;
  total?: number;
}) {
  const showTotal = total != null && total !== count;
  return (
    <TabsTrigger value={value}>
      {label}
      {(count > 0 || showTotal) && (
        <span className="px-1 rounded-sm bg-surface-3 text-[10px] text-text-secondary tabular">
          {showTotal ? `${count}/${total}` : count}
        </span>
      )}
    </TabsTrigger>
  );
}

type PositionKind = "stock" | "option" | "leg";

function classifyPositions(positions: Position[]): PositionKind[] {
  // Two or more option positions sharing the same underlying + expiry are
  // treated as legs of a spread. Single options remain "option".
  const groupCounts = new Map<string, number>();
  for (const p of positions) {
    if (!p.is_option || !p.expiry) continue;
    const key = `${p.symbol}|${p.expiry}`;
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }
  return positions.map((p) => {
    if (!p.is_option) return "stock";
    const key = `${p.symbol}|${p.expiry ?? ""}`;
    return (groupCounts.get(key) ?? 0) >= 2 ? "leg" : "option";
  });
}

type PositionSortKey =
  | "symbol"
  | "type"
  | "sector"
  | "qty"
  | "avg"
  | "price"
  | "pnl"
  | "pnl_pct";

const POSITION_ACCESSORS: Record<
  PositionSortKey,
  (row: { p: Position; kind: PositionKind }) => string | number | null | undefined
> = {
  symbol: (r) => r.p.symbol,
  type: (r) => r.kind,
  sector: (r) => r.p.sector ?? null,
  qty: (r) => r.p.quantity,
  avg: (r) => r.p.avg_price,
  price: (r) => r.p.current_price,
  pnl: (r) => r.p.unrealized_pnl,
  pnl_pct: (r) => r.p.unrealized_pnl_pct,
};

const POSITION_NUMERIC: PositionSortKey[] = ["qty", "avg", "price", "pnl", "pnl_pct"];

function PositionsTable({ positions, kinds }: { positions: Position[]; kinds: PositionKind[] }) {
  const router = useRouter();
  const rows = useMemo(
    () => positions.map((p, i) => ({ p, kind: kinds[i] })),
    [positions, kinds]
  );
  const { sorted, sort, toggleSort } = useTableSort<typeof rows[number], PositionSortKey>(
    rows,
    POSITION_ACCESSORS,
    { key: "pnl", direction: "desc" },
    POSITION_NUMERIC
  );
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortableTableHead sortKey="symbol" sort={sort} onSort={toggleSort}>symbol</SortableTableHead>
          <SortableTableHead sortKey="type" sort={sort} onSort={toggleSort}>type</SortableTableHead>
          <SortableTableHead sortKey="sector" sort={sort} onSort={toggleSort}>sector</SortableTableHead>
          <SortableTableHead sortKey="qty" sort={sort} onSort={toggleSort} align="right">qty</SortableTableHead>
          <SortableTableHead sortKey="avg" sort={sort} onSort={toggleSort} align="right">avg</SortableTableHead>
          <SortableTableHead sortKey="price" sort={sort} onSort={toggleSort} align="right">price</SortableTableHead>
          <SortableTableHead sortKey="pnl" sort={sort} onSort={toggleSort} align="right">unr. P&amp;L</SortableTableHead>
          <SortableTableHead sortKey="pnl_pct" sort={sort} onSort={toggleSort} align="right">unr. %</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.length === 0 ? (
          <TableEmpty colSpan={8}>no open positions</TableEmpty>
        ) : (
          sorted.map(({ p, kind }, i) => {
            return (
            <TableRow
              key={`${p.symbol}-${p.strike ?? ""}-${p.expiry ?? ""}-${p.right ?? ""}-${i}`}
              onClick={() => router.push(positionHref(p))}
              className="cursor-pointer group"
              title={p.is_option ? "Open in option analyzer" : "Analyze position"}
            >
              <TableCell className="font-medium">
                <div className="inline-flex items-center gap-2">
                  <Logo symbol={p.symbol} size={16} />
                  <div className="flex flex-col leading-tight">
                    <span className="inline-flex items-center gap-1.5">
                      {p.symbol}
                      {p.is_option && (
                        <span className={cn(
                          "text-[9px] uppercase tracking-wider px-1 py-px rounded-sm",
                          p.right === "C" ? "bg-up/15 text-up" : "bg-down/15 text-down",
                        )}>
                          {p.right === "C" ? "Call" : "Put"}
                        </span>
                      )}
                      <Target size={9} className="opacity-0 group-hover:opacity-100 text-accent transition-opacity" />
                    </span>
                    {p.is_option && (
                      <span className="text-[10px] text-text-muted tabular">
                        {formatExpiry(p.expiry)} · {Number(p.strike ?? 0).toFixed(0)}{p.right}
                      </span>
                    )}
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <KindPill kind={kind} />
              </TableCell>
              <TableCell className="text-text-muted">{p.sector ?? "—"}</TableCell>
              <TableCell className="text-right tabular">{p.quantity}</TableCell>
              <TableCell className="text-right tabular">{p.avg_price.toFixed(2)}</TableCell>
              <TableCell className="text-right tabular">{p.current_price.toFixed(2)}</TableCell>
              <TableCell className={cn("text-right tabular font-medium", pnlClass(p.unrealized_pnl))}>
                {fmtCurrency(p.unrealized_pnl)}
              </TableCell>
              <TableCell className="text-right">
                <Badge variant={p.unrealized_pnl_pct >= 0 ? "up" : "down"} className="tabular">
                  {fmtPct(p.unrealized_pnl_pct)}
                </Badge>
              </TableCell>
            </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

function KindPill({ kind }: { kind: PositionKind }) {
  const styles: Record<PositionKind, string> = {
    stock: "border-border text-text-secondary",
    option: "border-accent/40 text-accent",
    leg: "border-amber-500/40 text-amber-500",
  };
  const label = kind === "stock" ? "Stock" : kind === "option" ? "Option" : "Leg";
  return (
    <span
      className={cn(
        "text-[9px] uppercase tracking-wider px-1.5 py-px rounded-sm border bg-transparent",
        styles[kind],
      )}
    >
      {label}
    </span>
  );
}

type SpreadSortKey =
  | "symbol"
  | "spread_type"
  | "expiry"
  | "short_strike"
  | "qty"
  | "credit"
  | "max_profit"
  | "max_loss";

const SPREAD_ACCESSORS: Record<
  SpreadSortKey,
  (row: Spread) => string | number | null | undefined
> = {
  symbol: (s) => s.symbol,
  spread_type: (s) => s.spread_type,
  expiry: (s) => s.expiry,
  short_strike: (s) => s.short_strike,
  qty: (s) => s.quantity,
  credit: (s) => s.credit_received,
  max_profit: (s) => s.max_profit,
  max_loss: (s) => s.max_loss,
};

const SPREAD_NUMERIC: SpreadSortKey[] = [
  "short_strike",
  "qty",
  "credit",
  "max_profit",
  "max_loss",
];

function SpreadsTable({ spreads }: { spreads: Spread[] }) {
  const router = useRouter();
  const { sorted, sort, toggleSort } = useTableSort<Spread, SpreadSortKey>(
    spreads,
    SPREAD_ACCESSORS,
    { key: "expiry", direction: "asc" },
    SPREAD_NUMERIC
  );
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortableTableHead sortKey="symbol" sort={sort} onSort={toggleSort}>symbol</SortableTableHead>
          <SortableTableHead sortKey="spread_type" sort={sort} onSort={toggleSort}>type</SortableTableHead>
          <SortableTableHead sortKey="expiry" sort={sort} onSort={toggleSort}>expiry</SortableTableHead>
          <SortableTableHead sortKey="short_strike" sort={sort} onSort={toggleSort}>strikes</SortableTableHead>
          <SortableTableHead sortKey="qty" sort={sort} onSort={toggleSort} align="right">qty</SortableTableHead>
          <SortableTableHead sortKey="credit" sort={sort} onSort={toggleSort} align="right">credit</SortableTableHead>
          <SortableTableHead sortKey="max_profit" sort={sort} onSort={toggleSort} align="right">max profit</SortableTableHead>
          <SortableTableHead sortKey="max_loss" sort={sort} onSort={toggleSort} align="right">max loss</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.length === 0 ? (
          <TableEmpty colSpan={8}>no open spreads</TableEmpty>
        ) : (
          sorted.map((s) => (
            <TableRow
              key={s.id}
              onClick={() => router.push(`/chart/${s.symbol}`)}
              className="cursor-pointer group"
              title="Open chart with cycle overlay"
            >
              <TableCell className="font-medium">
                <span className="inline-flex items-center gap-2">
                  <Logo symbol={s.symbol} size={16} />
                  {s.symbol}
                  <Target size={9} className="opacity-0 group-hover:opacity-100 text-accent transition-opacity" />
                </span>
              </TableCell>
              <TableCell>
                <Badge variant="accent">{s.spread_type}</Badge>
              </TableCell>
              <TableCell className="tabular text-text-secondary">{formatExpiry(s.expiry)}</TableCell>
              <TableCell className="tabular">
                <span className="text-down">{s.long_strike}</span>
                <span className="text-text-muted mx-1">/</span>
                <span className="text-up">{s.short_strike}</span>
              </TableCell>
              <TableCell className="text-right tabular">{s.quantity}</TableCell>
              <TableCell className="text-right tabular text-up">{s.credit_received.toFixed(2)}</TableCell>
              <TableCell className="text-right tabular text-up">{fmtCurrency(s.max_profit)}</TableCell>
              <TableCell className="text-right tabular text-down">
                {fmtCurrency(-Math.abs(s.max_loss))}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

type TradeSortKey =
  | "symbol"
  | "side"
  | "qty"
  | "price"
  | "pnl"
  | "strategy"
  | "timestamp";

const TRADE_ACCESSORS: Record<
  TradeSortKey,
  (row: Trade) => string | number | null | undefined
> = {
  symbol: (t) => t.symbol,
  side: (t) => t.side,
  qty: (t) => t.quantity,
  price: (t) => t.price,
  pnl: (t) => t.pnl ?? null,
  strategy: (t) => t.strategy ?? null,
  timestamp: (t) => Date.parse(t.timestamp) || 0,
};

const TRADE_NUMERIC: TradeSortKey[] = ["qty", "price", "pnl", "timestamp"];

function TradesTable({ trades }: { trades: Trade[] }) {
  const { sorted, sort, toggleSort } = useTableSort<Trade, TradeSortKey>(
    trades,
    TRADE_ACCESSORS,
    { key: "timestamp", direction: "desc" },
    TRADE_NUMERIC
  );
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortableTableHead sortKey="symbol" sort={sort} onSort={toggleSort}>symbol</SortableTableHead>
          <SortableTableHead sortKey="side" sort={sort} onSort={toggleSort}>side</SortableTableHead>
          <SortableTableHead sortKey="qty" sort={sort} onSort={toggleSort} align="right">qty</SortableTableHead>
          <SortableTableHead sortKey="price" sort={sort} onSort={toggleSort} align="right">price</SortableTableHead>
          <SortableTableHead sortKey="pnl" sort={sort} onSort={toggleSort} align="right">P&amp;L</SortableTableHead>
          <SortableTableHead sortKey="strategy" sort={sort} onSort={toggleSort}>strategy</SortableTableHead>
          <SortableTableHead sortKey="timestamp" sort={sort} onSort={toggleSort}>time</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.length === 0 ? (
          <TableEmpty colSpan={7}>no trades yet</TableEmpty>
        ) : (
          sorted.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="font-medium">{t.symbol}</TableCell>
              <TableCell>
                <Badge variant={t.side === "BUY" ? "up" : "down"}>{t.side}</Badge>
              </TableCell>
              <TableCell className="text-right tabular">{t.quantity}</TableCell>
              <TableCell className="text-right tabular">{t.price.toFixed(2)}</TableCell>
              <TableCell className={cn("text-right tabular", pnlClass(t.pnl ?? 0))}>
                {t.pnl != null ? fmtCurrency(t.pnl) : "—"}
              </TableCell>
              <TableCell className="text-text-muted">{t.strategy ?? "—"}</TableCell>
              <TableCell className="text-text-muted">{new Date(t.timestamp).toLocaleString()}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function formatExpiry(yyyymmdd: string | undefined): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd ?? "";
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(2, 4)}`;
}

function positionHref(p: Position): string {
  if (p.is_option && p.expiry && p.strike != null && p.right) {
    const qty = Math.abs(p.quantity);
    return `/monitor/analyzer?symbol=${encodeURIComponent(p.symbol)}` +
      `&expiry=${p.expiry}&strike=${p.strike}&right=${p.right}` +
      `&qty=${qty}&entry=${p.avg_price}`;
  }
  return `/chart/${encodeURIComponent(p.symbol)}`;
}
