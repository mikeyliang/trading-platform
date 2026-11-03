"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, type Fundamentals } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  SortableTableHead,
  type SortState,
} from "@/components/ui/table";
import { TableSkeletonRows } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Logo } from "@/components/ui/logo";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { FilterBar } from "@/components/ui/filter-bar";
import { cn, fmtCompact } from "@/lib/utils";
import {
  RiFocus3Line as Target,
  RiFilterOffLine as FilterOff,
  RiRefreshLine as Refresh,
  RiErrorWarningFill as ErrorDot,
} from "@remixicon/react";

// Curated universe, same anchor list as the logo map, expanded slightly
const UNIVERSE = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA", "AVGO", "ORCL",
  "CRM", "ADBE", "NFLX", "CSCO", "AMD", "INTC", "QCOM", "IBM", "TXN", "MU",
  "PYPL", "SHOP", "PLTR", "SNOW", "UBER", "ABNB", "RBLX", "COIN", "SOFI",
  "JPM", "BAC", "WFC", "GS", "MS", "C", "BLK", "V", "MA", "AXP", "SCHW",
  "WMT", "COST", "HD", "LOW", "TGT", "NKE", "SBUX", "MCD", "KO", "PEP",
  "PG", "DIS", "LULU",
  "JNJ", "UNH", "PFE", "MRK", "ABBV", "LLY", "TMO", "ABT",
  "XOM", "CVX", "COP", "SLB",
  "BA", "CAT", "GE", "HON", "UPS", "FDX", "RTX", "LMT",
  "SPY", "QQQ", "IWM", "DIA", "VOO", "GLD", "TLT", "HYG", "XLE", "XLF", "XLK",
];

const SECTORS = [
  "All",
  "Technology",
  "Financial Services",
  "Consumer Cyclical",
  "Consumer Defensive",
  "Healthcare",
  "Communication Services",
  "Energy",
  "Industrials",
  "Real Estate",
  "Utilities",
  "Basic Materials",
];

const TIERS = [
  { label: "Any size", value: "any" },
  { label: "Mega ($200B+)", value: "mega" },
  { label: "Large ($10B+)", value: "large" },
  { label: "Mid ($2B+)", value: "mid" },
  { label: "Small ($300M+)", value: "small" },
];

type SortKey =
  | "symbol"
  | "market_cap"
  | "pe_trailing"
  | "dividend_yield"
  | "beta"
  | "fifty_two_week_position";

const COLS = 8;

export default function ScreenerPage() {
  const [data, setData] = useState<Fundamentals[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("All");
  const [tier, setTier] = useState("any");
  const [maxPE, setMaxPE] = useState<string>("");
  const [minDiv, setMinDiv] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("market_cap");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    api
      .fundamentalsBulk(UNIVERSE)
      .then((d) => setData(d))
      .catch(() => {
        setData([]);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    let rows = data.filter((r) => r.market_cap || r.price); // drop fully-empty
    const q = query.trim().toUpperCase();
    if (q) rows = rows.filter((r) => r.symbol.includes(q) || (r.name ?? "").toUpperCase().includes(q));
    if (sector !== "All") rows = rows.filter((r) => r.sector === sector);
    if (tier !== "any") rows = rows.filter((r) => r.market_cap_tier === tier);
    const pe = Number(maxPE);
    if (Number.isFinite(pe) && pe > 0) {
      rows = rows.filter((r) => (r.pe_trailing ?? Infinity) <= pe);
    }
    const dv = Number(minDiv);
    if (Number.isFinite(dv) && dv > 0) {
      rows = rows.filter((r) => (r.dividend_yield ?? 0) * 100 >= dv);
    }

    rows = rows.slice().sort((a, b) => {
      const av = (a as any)[sortKey];
      const bv = (b as any)[sortKey];
      const aN = av == null ? -Infinity : av;
      const bN = bv == null ? -Infinity : bv;
      if (sortKey === "symbol") {
        return (sortDir === "asc" ? 1 : -1) * a.symbol.localeCompare(b.symbol);
      }
      return (sortDir === "asc" ? 1 : -1) * (aN - bN);
    });
    return rows;
  }, [data, query, sector, tier, maxPE, minDiv, sortKey, sortDir]);

  const sectorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data) if (r.sector) m.set(r.sector, (m.get(r.sector) ?? 0) + 1);
    return m;
  }, [data]);

  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "symbol" ? "asc" : "desc");
    }
  };
  const sort: SortState<SortKey> = { key: sortKey, direction: sortDir };

  const hasFilters = query.trim() !== "" || sector !== "All" || tier !== "any" || !!maxPE || !!minDiv;
  const clearFilters = () => {
    setQuery("");
    setSector("All");
    setTier("any");
    setMaxPE("");
    setMinDiv("");
  };

  const countChip = loading ? (
    <Badge variant="muted">Loading</Badge>
  ) : error ? (
    <Badge variant="down">Fetch failed</Badge>
  ) : (
    <Badge variant="muted" className="tabular">
      {filtered.length} of {data.length} shown
    </Badge>
  );

  return (
    <PageShell>
      <PageHeader
        title="Screener"
        description="Fundamentals across the curated universe. Click a symbol to chart it."
        actions={countChip}
      />

      {/* Filters: search always visible, advanced behind disclosure, active filters as chips */}
      <Card className="shrink-0">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <FilterOff />
              Clear
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-3">
          <FilterBar
            search={{ value: query, onChange: setQuery, placeholder: "Symbol or name" }}
            chips={[
              ...(sector !== "All"
                ? [{ key: "sector", label: `Sector: ${sector}`, onRemove: () => setSector("All") }]
                : []),
              ...(tier !== "any"
                ? [
                    {
                      key: "tier",
                      label: `Cap: ${TIERS.find((t) => t.value === tier)?.label ?? tier}`,
                      onRemove: () => setTier("any"),
                    },
                  ]
                : []),
              ...(maxPE
                ? [{ key: "pe", label: `P/E up to ${maxPE}`, onRemove: () => setMaxPE("") }]
                : []),
              ...(minDiv
                ? [{ key: "div", label: `Dividend from ${minDiv}%`, onRemove: () => setMinDiv("") }]
                : []),
            ]}
            advanced={
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field label="Sector">
                  <Select value={sector} onValueChange={setSector}>
                    <SelectTrigger className="bg-background-primary-default">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SECTORS.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                          {s !== "All" && sectorCounts.get(s) ? ` (${sectorCounts.get(s)})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Market cap">
                  <Select value={tier} onValueChange={setTier}>
                    <SelectTrigger className="bg-background-primary-default">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIERS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Max P/E">
                  <Input
                    value={maxPE}
                    onChange={(e) => setMaxPE(e.target.value)}
                    placeholder="e.g. 25"
                    type="number"
                    className="tabular bg-background-primary-default"
                  />
                </Field>
                <Field label="Min dividend %">
                  <Input
                    value={minDiv}
                    onChange={(e) => setMinDiv(e.target.value)}
                    placeholder="e.g. 2"
                    type="number"
                    className="tabular bg-background-primary-default"
                  />
                </Field>
              </div>
            }
          />
        </CardContent>
      </Card>

      {/* Results */}
      <Card className="shrink-0">
        <CardHeader>
          <CardTitle>Results</CardTitle>
          <span className="text-caption-1-medium text-text-tertiary">Sorted by market cap unless you pick a column</span>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <SortableTableHead sortKey="symbol" sort={sort} onSort={onSort}>
                Symbol
              </SortableTableHead>
              <TableHead>Sector</TableHead>
              <SortableTableHead sortKey="market_cap" sort={sort} onSort={onSort} align="right">
                Market cap
              </SortableTableHead>
              <SortableTableHead sortKey="pe_trailing" sort={sort} onSort={onSort} align="right">
                P/E
              </SortableTableHead>
              <SortableTableHead sortKey="dividend_yield" sort={sort} onSort={onSort} align="right">
                Dividend
              </SortableTableHead>
              <SortableTableHead sortKey="beta" sort={sort} onSort={onSort} align="right">
                Beta
              </SortableTableHead>
              <SortableTableHead sortKey="fifty_two_week_position" sort={sort} onSort={onSort} align="right">
                52w position
              </SortableTableHead>
              <TableHead className="w-10" aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableSkeletonRows
                rows={8}
                cols={COLS}
                widths={["w-32", "w-24", "w-16", "w-10", "w-12", "w-10", "w-24", "w-4"]}
              />
            ) : error ? (
              <tr>
                <td colSpan={COLS}>
                  <EmptyState
                    icon={ErrorDot}
                    title="Fundamentals failed to load"
                    description="The fundamentals service did not answer. Retry when the API is back."
                    action={
                      <div className="flex items-center gap-2">
                        <Badge variant="down">Error</Badge>
                        <Button variant="secondary" size="sm" onClick={load}>
                          <Refresh />
                          Retry
                        </Button>
                      </div>
                    }
                  />
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={COLS}>
                  <EmptyState
                    icon={FilterOff}
                    title={data.length === 0 ? "No fundamentals yet" : "No matches"}
                    description={
                      data.length === 0
                        ? "The universe returned no rows. Try again once the data service has warmed up."
                        : "Nothing in the universe passes every filter. Remove one to widen the net."
                    }
                    action={
                      hasFilters ? (
                        <Button variant="secondary" size="sm" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={load}>
                          <Refresh />
                          Reload
                        </Button>
                      )
                    }
                  />
                </td>
              </tr>
            ) : (
              filtered.map((r) => <Row key={r.symbol} r={r} />)
            )}
          </TableBody>
        </Table>
      </Card>
    </PageShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-caption-1-medium text-text-tertiary">{label}</label>
      {children}
    </div>
  );
}

function Row({ r }: { r: Fundamentals }) {
  return (
    <TableRow className="group">
      <TableCell>
        <Link href={`/chart/${r.symbol}`} className="flex items-center gap-2 min-w-0">
          <Logo symbol={r.symbol} size={18} />
          <div className="flex flex-col min-w-0 leading-tight">
            <span className="text-body-2-medium text-text-primary">{r.symbol}</span>
            {r.name && (
              <span className="text-caption-1-regular text-text-tertiary truncate max-w-[180px]">{r.name}</span>
            )}
          </div>
        </Link>
      </TableCell>
      <TableCell className="text-text-secondary">{r.sector ?? "n/a"}</TableCell>
      <TableCell className="text-right">
        {r.market_cap ? `$${fmtCompact(r.market_cap)}` : "n/a"}
      </TableCell>
      <TableCell className="text-right">
        {r.pe_trailing ? r.pe_trailing.toFixed(1) : "n/a"}
      </TableCell>
      <TableCell className="text-right">
        {r.dividend_yield ? `${(r.dividend_yield * 100).toFixed(2)}%` : "n/a"}
      </TableCell>
      <TableCell className="text-right">
        {r.beta != null ? r.beta.toFixed(2) : "n/a"}
      </TableCell>
      <TableCell className="text-right">
        {r.fifty_two_week_position != null ? (
          <Bar value={r.fifty_two_week_position} />
        ) : (
          <span className="text-text-tertiary">n/a</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Link
          href={`/analyzer?symbol=${r.symbol}`}
          className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity inline-flex"
          title="Analyze"
        >
          <Button variant="ghost" size="icon-sm" aria-label={`Analyze ${r.symbol}`}>
            <Target />
          </Button>
        </Link>
      </TableCell>
    </TableRow>
  );
}

function Bar({ value }: { value: number }) {
  // value 0..1
  const v = Math.max(0, Math.min(1, value));
  const pct = Math.round(v * 100);
  const tone = v >= 0.85 ? "down" : v <= 0.15 ? "up" : "neutral";
  return (
    <div className="inline-flex items-center gap-1.5">
      <div className="relative w-16 h-1.5 rounded-full bg-background-tertiary-default overflow-hidden">
        <div
          className={cn(
            "absolute top-0 left-0 h-full rounded-full",
            tone === "up" ? "bg-status-lime-text" : tone === "down" ? "bg-status-rose-text" : "bg-foreground-icon-tertiary"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular text-caption-1-regular text-text-tertiary w-8 text-right">{pct}%</span>
    </div>
  );
}
