"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, type OptionRow, type OptionsChain } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { TableSkeletonRows } from "@/components/ui/skeleton";

const DEFAULT_SYMBOL = "RUT";
const STRIKE_WINDOW = 16; // strikes per side of spot

interface ChainRow {
  strike: number;
  call: OptionRow | null;
  put: OptionRow | null;
}

export function OptionChain() {
  // Allow ?symbol=X to seed the chain — consolidated from the old
  // /options/[symbol] route, which now redirects here.
  const params = useSearchParams();
  const initial = (params?.get("symbol") || DEFAULT_SYMBOL).toUpperCase();

  const [pendingSymbol, setPendingSymbol] = useState(initial);
  const [symbol, setSymbol] = useState(initial);
  const [expirations, setExpirations] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string | null>(null);
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [loading, setLoading] = useState(false);

  // Step 1: fetch the list of expirations.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setChain(null);
    api.optionsChain(symbol)
      .then((r) => {
        if (!alive) return;
        setExpirations(r.expirations);
        setExpiry(r.expirations[0] ?? null);
      })
      .catch(() => { if (alive) setExpirations([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol]);

  // Step 2: fetch the chain for the chosen expiry.
  useEffect(() => {
    if (!expiry) return;
    let alive = true;
    setLoading(true);
    api.optionsChain(symbol, expiry)
      .then((r) => { if (alive) setChain(r); })
      .catch(() => { if (alive) setChain(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol, expiry]);

  const rows = useMemo(() => mergeRows(chain), [chain]);
  const atmStrike = useMemo(
    () => (chain?.underlying_price ? closestStrike(rows, chain.underlying_price) : null),
    [chain, rows]
  );

  // Center the table window around spot.
  const windowed = useMemo(() => {
    if (atmStrike == null || rows.length === 0) return rows;
    const idx = rows.findIndex((r) => r.strike === atmStrike);
    if (idx < 0) return rows;
    const lo = Math.max(0, idx - STRIKE_WINDOW);
    const hi = Math.min(rows.length, idx + STRIKE_WINDOW + 1);
    return rows.slice(lo, hi);
  }, [rows, atmStrike]);

  const onSymbolSubmit = () => {
    const sym = pendingSymbol.trim().toUpperCase();
    if (!sym) return;
    setSymbol(sym);
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow="Options · chain"
        title={`${symbol} option chain`}
        description={chain?.underlying_price
          ? `Spot ${chain.underlying_price.toFixed(2)} · ${rows.length} strikes loaded`
          : "Bid / ask / Δ / IV per strike. Click a strike to chart-pin it."}
        actions={
          <div className="flex items-end gap-2 flex-wrap">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Symbol</span>
              <Input
                value={pendingSymbol}
                onChange={(e) => setPendingSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === "Enter") onSymbolSubmit(); }}
                placeholder="RUT"
                className="h-8 w-24 uppercase tabular"
              />
            </label>
          </div>
        }
      />

      <ExpiryTabs
        expirations={expirations}
        active={expiry}
        onChoose={setExpiry}
        spot={chain?.underlying_price ?? null}
      />

      {loading && !chain && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[11px] tabular">
            <tbody>
              <TableSkeletonRows rows={12} cols={11} />
            </tbody>
          </table>
        </div>
      )}

      {!loading && (!chain || windowed.length === 0) && (
        <div className="py-16 text-center text-sm text-text-secondary">
          No strikes loaded for this expiry yet. The chain may still be hydrating from IBKR.
        </div>
      )}

      {chain && windowed.length > 0 && (
        <ChainTable
          rows={windowed}
          atmStrike={atmStrike}
          spot={chain.underlying_price}
          symbol={chain.symbol}
          expiry={expiry!}
        />
      )}
    </PageShell>
  );
}

// ─── Expiry tabs ──────────────────────────────────────────────────────────────
function ExpiryTabs({
  expirations,
  active,
  onChoose,
  spot,
}: {
  expirations: string[];
  active: string | null;
  onChoose: (e: string) => void;
  spot: number | null;
}) {
  if (expirations.length === 0) return null;
  const today = new Date();
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto pb-1 -mx-1 px-1">
      {expirations.map((e) => {
        const isActive = e === active;
        const dt = parseExp(e);
        const dte = dt ? Math.ceil((dt.getTime() - today.getTime()) / 86400_000) : null;
        return (
          <button
            key={e}
            type="button"
            onClick={() => onChoose(e)}
            className={cn(
              "shrink-0 h-7 px-3 text-[11px] tabular rounded-sm transition-colors flex items-baseline gap-1.5",
              isActive
                ? "text-text-primary bg-surface-2"
                : "text-text-muted hover:text-text-secondary hover:bg-surface-2/60"
            )}
          >
            <span>{formatExp(e)}</span>
            {dte != null && <span className="text-[10px] text-text-muted">{dte}d</span>}
          </button>
        );
      })}
    </div>
  );
}

// ─── Chain table ──────────────────────────────────────────────────────────────
function ChainTable({
  rows,
  atmStrike,
  spot,
  symbol,
  expiry,
}: {
  rows: ChainRow[];
  atmStrike: number | null;
  spot: number | null;
  symbol: string;
  expiry: string;
}) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-[11px] tabular">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-text-muted">
            <Th align="right" tone="call">Δ</Th>
            <Th align="right" tone="call">IV</Th>
            <Th align="right" tone="call">Bid</Th>
            <Th align="right" tone="call">Ask</Th>
            <Th align="right" tone="call">Mid</Th>
            <th className="px-3 py-2 text-center text-text-secondary font-medium">Strike</th>
            <Th align="left" tone="put">Mid</Th>
            <Th align="left" tone="put">Bid</Th>
            <Th align="left" tone="put">Ask</Th>
            <Th align="left" tone="put">IV</Th>
            <Th align="left" tone="put">Δ</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isAtm = r.strike === atmStrike;
            const callItm = spot != null && spot > r.strike;
            const putItm = spot != null && spot < r.strike;
            return (
              <tr
                key={r.strike}
                className={cn(
                  "border-t border-border/30 group transition-colors",
                  isAtm
                    ? "bg-accent/[0.06] hover:bg-accent/[0.10]"
                    : "hover:bg-surface-2/40",
                  i % 2 === 0 && !isAtm && "bg-surface-2/15"
                )}
              >
                <SideCell row={r.call} field="delta" tone="call" itm={callItm} align="right" />
                <SideCell row={r.call} field="iv" tone="call" itm={callItm} align="right" />
                <SideCell row={r.call} field="bid" tone="call" itm={callItm} align="right" />
                <SideCell row={r.call} field="ask" tone="call" itm={callItm} align="right" />
                <SideCell row={r.call} field="mid" tone="call" itm={callItm} align="right" />
                <td className="px-3 py-1.5 text-center">
                  <StrikeButton
                    strike={r.strike}
                    isAtm={isAtm}
                    symbol={symbol}
                    expiry={expiry}
                  />
                </td>
                <SideCell row={r.put} field="mid" tone="put" itm={putItm} align="left" />
                <SideCell row={r.put} field="bid" tone="put" itm={putItm} align="left" />
                <SideCell row={r.put} field="ask" tone="put" itm={putItm} align="left" />
                <SideCell row={r.put} field="iv" tone="put" itm={putItm} align="left" />
                <SideCell row={r.put} field="delta" tone="put" itm={putItm} align="left" />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children, align, tone,
}: { children: React.ReactNode; align: "left" | "right" | "center"; tone: "call" | "put" }) {
  return (
    <th
      className={cn(
        "px-2 py-2 font-medium",
        align === "left" ? "text-left" : align === "right" ? "text-right" : "text-center",
        tone === "call" ? "text-text-muted" : "text-text-muted",
      )}
    >
      {children}
    </th>
  );
}

function SideCell({
  row, field, tone, itm, align,
}: {
  row: OptionRow | null;
  field: "delta" | "iv" | "bid" | "ask" | "mid";
  tone: "call" | "put";
  itm: boolean;
  align: "left" | "right";
}) {
  const value = useCellValue(row, field);
  const textAlign = align === "left" ? "text-left" : "text-right";
  return (
    <td
      className={cn(
        "px-2 py-1.5",
        textAlign,
        itm ? "bg-surface-2/40" : "",
        value == null ? "text-text-muted/40" : "text-text-secondary",
        tone === "call" && itm && "text-text-primary",
        tone === "put"  && itm && "text-text-primary",
      )}
    >
      {value ?? "—"}
    </td>
  );
}

function useCellValue(
  row: OptionRow | null,
  field: "delta" | "iv" | "bid" | "ask" | "mid",
): string | null {
  if (!row) return null;
  if (field === "delta") {
    return row.delta != null ? Math.round(Math.abs(row.delta) * 100).toString() : null;
  }
  if (field === "iv") {
    return row.iv != null ? `${Math.round(row.iv * 100)}` : null;
  }
  if (field === "bid") return row.bid != null ? row.bid.toFixed(2) : null;
  if (field === "ask") return row.ask != null ? row.ask.toFixed(2) : null;
  if (field === "mid") {
    if (row.bid != null && row.ask != null) return ((row.bid + row.ask) / 2).toFixed(2);
    if (row.last != null) return row.last.toFixed(2);
    return null;
  }
  return null;
}

function StrikeButton({
  strike, isAtm, symbol, expiry,
}: { strike: number; isAtm: boolean; symbol: string; expiry: string }) {
  // Default behaviour: clicking the strike pins it on the chart with this
  // strike as the short leg and the next lower strike as the long leg (bull put).
  const pinHref =
    `/chart/${symbol}?pinShort=${strike}&pinLong=${strike - 5}` +
    `&pinExpiry=${expiry}&pinType=manual&pinSide=put`;
  return (
    <Link
      href={pinHref}
      className={cn(
        "inline-flex items-center justify-center min-w-[60px] h-6 px-2 rounded-sm tabular text-[12px] font-medium transition-colors",
        isAtm
          ? "text-accent bg-accent/10 hover:bg-accent/20"
          : "text-text-primary hover:bg-surface-2"
      )}
      title={`Pin ${strike}/${strike - 5}P on chart`}
    >
      {strike}
    </Link>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function mergeRows(chain: OptionsChain | null): ChainRow[] {
  if (!chain) return [];
  const byStrike = new Map<number, ChainRow>();
  for (const c of chain.calls) {
    if (!byStrike.has(c.strike)) byStrike.set(c.strike, { strike: c.strike, call: null, put: null });
    byStrike.get(c.strike)!.call = c;
  }
  for (const p of chain.puts) {
    if (!byStrike.has(p.strike)) byStrike.set(p.strike, { strike: p.strike, call: null, put: null });
    byStrike.get(p.strike)!.put = p;
  }
  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

function closestStrike(rows: ChainRow[], spot: number): number | null {
  if (rows.length === 0) return null;
  let best = rows[0].strike;
  let bestDist = Math.abs(best - spot);
  for (const r of rows) {
    const d = Math.abs(r.strike - spot);
    if (d < bestDist) { best = r.strike; bestDist = d; }
  }
  return best;
}

function parseExp(yyyymmdd: string): Date | null {
  if (yyyymmdd.length !== 8) return null;
  return new Date(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8));
}

function formatExp(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  const mo = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  return `${mo}/${d}`;
}
