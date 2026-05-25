"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, type Fundamentals } from "@/lib/api";
import { Card } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Logo } from "@/components/ui/logo";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { FilterBar } from "@/components/ui/filter-bar";
import { cn, fmtCompact } from "@/lib/utils";
import { ArrowUpDown, Target } from "lucide-react";

// Curated universe — same anchor list as the logo map, expanded slightly
const UNIVERSE = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "META",
  "NVDA",
  "TSLA",
  "AVGO",
  "ORCL",
  "CRM",
  "ADBE",
  "NFLX",
  "CSCO",
  "AMD",
  "INTC",
  "QCOM",
  "IBM",
  "TXN",
  "MU",
  "PYPL",
  "SHOP",
  "PLTR",
  "SNOW",
  "UBER",
  "ABNB",
  "RBLX",
  "COIN",
  "SOFI",
  "JPM",
  "BAC",
  "WFC",
  "GS",
  "MS",
  "C",
  "BLK",
  "V",
  "MA",
  "AXP",
  "SCHW",
  "WMT",
  "COST",
  "HD",
  "LOW",
  "TGT",
  "NKE",
  "SBUX",
  "MCD",
  "KO",
  "PEP",
  "PG",
  "DIS",
  "LULU",
  "JNJ",
  "UNH",
  "PFE",
  "MRK",
  "ABBV",
  "LLY",
  "TMO",
  "ABT",
  "XOM",
  "CVX",
  "COP",
  "SLB",
  "BA",
  "CAT",
  "GE",
  "HON",
  "UPS",
  "FDX",
  "RTX",
  "LMT",
  "SPY",
  "QQQ",
  "IWM",
  "DIA",
  "VOO",
  "GLD",
  "TLT",
  "HYG",
  "XLE",
  "XLF",
  "XLK",
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

export default function ScreenerPage() {
  const [data, setData] = useState<Fundamentals[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("All");
  const [tier, setTier] = useState("any");
  const [maxPE, setMaxPE] = useState<string>("");
  const [minDiv, setMinDiv] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("market_cap");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    setLoading(true);
    api
      .fundamentalsBulk(UNIVERSE)
      .then((d) => setData(d))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let rows = data.filter((r) => r.market_cap || r.price); // drop fully-empty
    const q = query.trim().toUpperCase();
    if (q)
      rows = rows.filter(
        (r) => r.symbol.includes(q) || (r.name ?? "").toUpperCase().includes(q),
      );
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
    for (const r of data)
      if (r.sector) m.set(r.sector, (m.get(r.sector) ?? 0) + 1);
    return m;
  }, [data]);

  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "symbol" ? "asc" : "desc");
    }
  };

  return (
    <PageShell>
      <PageHeader
        title="Screener"
        actions={
          <>
            <Badge variant="muted">
              {loading ? "loading…" : `${filtered.length} / ${data.length}`}
            </Badge>
          </>
        }
      />

      {/* filters — search always visible, advanced behind disclosure, active filters as chips */}
      <FilterBar
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Symbol or name…",
        }}
        chips={[
          ...(sector !== "All"
            ? [
                {
                  key: "sector",
                  label: `Sector: ${sector}`,
                  onRemove: () => setSector("All"),
                },
              ]
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
            ? [
                {
                  key: "pe",
                  label: `P/E ≤ ${maxPE}`,
                  onRemove: () => setMaxPE(""),
                },
              ]
            : []),
          ...(minDiv
            ? [
                {
                  key: "div",
                  label: `Div ≥ ${minDiv}%`,
                  onRemove: () => setMinDiv(""),
                },
              ]
            : []),
        ]}
        advanced={
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Field label="Sector">
              <Select value={sector} onValueChange={setSector}>
                <SelectTrigger className="h-7">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SECTORS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                      {s !== "All" && sectorCounts.get(s)
                        ? ` · ${sectorCounts.get(s)}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Market cap">
              <Select value={tier} onValueChange={setTier}>
                <SelectTrigger className="h-7">
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
                className="h-7 tabular"
              />
            </Field>
            <Field label="Min dividend %">
              <Input
                value={minDiv}
                onChange={(e) => setMinDiv(e.target.value)}
                placeholder="e.g. 2"
                type="number"
                className="h-7 tabular"
              />
            </Field>
          </div>
        }
      />

      {/* table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-text-muted border-b border-border/40 text-[10px] uppercase tracking-wider">
                <Th
                  onClick={() => onSort("symbol")}
                  active={sortKey === "symbol"}
                  dir={sortDir}
                >
                  Symbol
                </Th>
                <Th>Sector</Th>
                <Th
                  onClick={() => onSort("market_cap")}
                  active={sortKey === "market_cap"}
                  dir={sortDir}
                  align="right"
                >
                  Mkt cap
                </Th>
                <Th
                  onClick={() => onSort("pe_trailing")}
                  active={sortKey === "pe_trailing"}
                  dir={sortDir}
                  align="right"
                >
                  P/E
                </Th>
                <Th
                  onClick={() => onSort("dividend_yield")}
                  active={sortKey === "dividend_yield"}
                  dir={sortDir}
                  align="right"
                >
                  Div %
                </Th>
                <Th
                  onClick={() => onSort("beta")}
                  active={sortKey === "beta"}
                  dir={sortDir}
                  align="right"
                >
                  Beta
                </Th>
                <Th
                  onClick={() => onSort("fifty_two_week_position")}
                  active={sortKey === "fifty_two_week_position"}
                  dir={sortDir}
                  align="right"
                >
                  52w pos
                </Th>
                <Th align="right" />
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b border-border/30">
                      {Array.from({ length: 8 }).map((__, j) => (
                        <td key={j} className="px-2 py-1">
                          <Skeleton className="h-3 w-16" />
                        </td>
                      ))}
                    </tr>
                  ))
                : filtered.map((r) => <Row key={r.symbol} r={r} />)}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="text-center py-10 text-text-muted text-[11px]"
                  >
                    No matches. Try removing filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </PageShell>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] text-text-muted uppercase tracking-wider">
        {label}
      </label>
      {children}
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  dir,
  align,
}: {
  children?: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  dir?: "asc" | "desc";
  align?: "right";
}) {
  return (
    <th
      className={cn(
        "px-2 py-1 font-normal",
        align === "right" ? "text-right" : "text-left",
        onClick && "cursor-pointer hover:text-text-secondary select-none",
      )}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {onClick && (
          <ArrowUpDown
            size={9}
            className={cn(
              "transition-colors",
              active ? "text-accent" : "text-text-muted/50",
            )}
          />
        )}
      </span>
    </th>
  );
}

function Row({ r }: { r: Fundamentals }) {
  return (
    <tr className="group border-b border-border/30 hover:bg-surface-2 transition-colors">
      <td className="px-2 py-1">
        <Link
          href={`/chart/${r.symbol}`}
          className="flex items-center gap-2 min-w-0"
        >
          <Logo symbol={r.symbol} size={18} />
          <div className="flex flex-col min-w-0">
            <span className="font-medium text-text-primary">{r.symbol}</span>
            {r.name && (
              <span className="text-[10px] text-text-muted truncate max-w-[180px]">
                {r.name}
              </span>
            )}
          </div>
        </Link>
      </td>
      <td className="px-2 py-1 text-text-muted">{r.sector ?? "—"}</td>
      <td className="px-2 py-1 text-right tabular">
        {r.market_cap ? `$${fmtCompact(r.market_cap)}` : "—"}
      </td>
      <td className="px-2 py-1 text-right tabular">
        {r.pe_trailing ? r.pe_trailing.toFixed(1) : "—"}
      </td>
      <td className="px-2 py-1 text-right tabular">
        {r.dividend_yield ? `${(r.dividend_yield * 100).toFixed(2)}%` : "—"}
      </td>
      <td className="px-2 py-1 text-right tabular">
        {r.beta != null ? r.beta.toFixed(2) : "—"}
      </td>
      <td className="px-2 py-1 text-right">
        {r.fifty_two_week_position != null ? (
          <Bar value={r.fifty_two_week_position} />
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </td>
      <td className="px-2 py-1 text-right">
        <Link
          href={`/analyzer?symbol=${r.symbol}`}
          className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex"
          title="Analyze"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Analyze ${r.symbol}`}
          >
            <Target />
          </Button>
        </Link>
      </td>
    </tr>
  );
}

function Bar({ value }: { value: number }) {
  // value 0..1
  const v = Math.max(0, Math.min(1, value));
  const pct = Math.round(v * 100);
  const tone = v >= 0.85 ? "down" : v <= 0.15 ? "up" : "neutral";
  return (
    <div className="inline-flex items-center gap-1.5">
      <div className="relative w-16 h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div
          className={cn(
            "absolute top-0 left-0 h-full",
            tone === "up"
              ? "bg-up/70"
              : tone === "down"
                ? "bg-down/70"
                : "bg-text-secondary/70",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular text-[10px] text-text-muted w-8 text-right">
        {pct}%
      </span>
    </div>
  );
}
