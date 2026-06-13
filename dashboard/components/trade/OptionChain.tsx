"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, type EarningsInfo, type OptionRow, type OptionsChain } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { TableSkeletonRows } from "@/components/ui/skeleton";
import { MiniPnlChart } from "@/components/trade/MiniPnlChart";
import {
  rankContracts,
  daysToExpiry,
  BREAKDOWN_KEYS,
  type RankedContract,
  type BreakdownKey,
} from "@/lib/leaps";

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
  const [earnings, setEarnings] = useState<EarningsInfo | null>(null);
  const [showPicks, setShowPicks] = useState(true);

  // Earnings date (IBKR WSH) — fetched per symbol, independent of expiry.
  // source="unavailable" just means we hide the badge; never a hard error.
  useEffect(() => {
    let alive = true;
    setEarnings(null);
    api.optionsEarnings(symbol)
      .then((r) => { if (alive) setEarnings(r); })
      .catch(() => { if (alive) setEarnings(null); });
    return () => { alive = false; };
  }, [symbol]);

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

  // Rank the loaded chain for the active expiry — surfaces a best call to buy
  // and a best put to sell, plus the strikes to highlight in the table.
  const ranking = useMemo(() => rankContracts(chain, expiry), [chain, expiry]);

  // Per-strike score lookups so every chain row can display its rating, not
  // just the top pick.
  const callScores = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of ranking.rankedCalls) m.set(c.row.strike, c.score);
    return m;
  }, [ranking.rankedCalls]);
  const putScores = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of ranking.rankedPuts) m.set(c.row.strike, c.score);
    return m;
  }, [ranking.rankedPuts]);

  // Earnings landing between now and this expiry is the key LEAPS caveat.
  const earningsInfo = useMemo(() => {
    if (!earnings?.next_date || earnings.source === "unavailable") return null;
    const eDte = daysToExpiry(earnings.next_date);
    return { date: earnings.next_date, dte: eDte, beforeExpiry: expiry ? earnings.next_date <= expiry : false };
  }, [earnings, expiry]);

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
                className="h-7 w-24 uppercase tabular"
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

      {/* Context badges: LTCG eligibility for this expiry + next earnings. */}
      {chain && expiry && (
        <div className="flex items-center gap-2 flex-wrap text-[10px]">
          {ranking.ltcgEligible ? (
            <span className="px-2 py-0.5 rounded-sm bg-up/10 text-up">
              LTCG-eligible · {ranking.dte}d to expiry
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-sm bg-surface-2 text-text-muted">
              {ranking.dte}d to expiry · {ranking.dte > 0 ? `${(ranking.dte / 365).toFixed(1)}y` : "—"} hold for LTCG needs &gt;1y
            </span>
          )}
          {earningsInfo && (
            <span
              className={cn(
                "px-2 py-0.5 rounded-sm",
                earningsInfo.beforeExpiry ? "bg-warning/10 text-warning" : "bg-surface-2 text-text-secondary"
              )}
              title={earningsInfo.beforeExpiry ? "Earnings falls before this expiry — expect an IV/price gap" : "Next earnings"}
            >
              {earningsInfo.beforeExpiry ? "⚠ " : ""}Earnings {formatExp(earningsInfo.date)} · {earningsInfo.dte}d
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowPicks((v) => !v)}
            className="ml-auto px-2 py-0.5 rounded-sm text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
          >
            {showPicks ? "Hide best picks" : "Show best picks"}
          </button>
        </div>
      )}

      {showPicks && chain && (ranking.bestBuy || ranking.bestSell) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <PickColumn
            best={ranking.bestBuy}
            alternates={ranking.rankedCalls.slice(1, 4)}
            heading="Best LEAPS call to buy"
            sub="Deep-ITM stock replacement"
            spot={ranking.spot!}
            dte={ranking.dte}
            symbol={chain.symbol}
            expiry={expiry!}
          />
          <PickColumn
            best={ranking.bestSell}
            alternates={ranking.rankedPuts.slice(1, 4)}
            heading="Best put to sell"
            sub="Cash-secured · bullish income"
            spot={ranking.spot!}
            dte={ranking.dte}
            symbol={chain.symbol}
            expiry={expiry!}
          />
        </div>
      )}

      {loading && !chain && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[11px] tabular">
            <tbody>
              <TableSkeletonRows rows={12} cols={13} />
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
          bestCallStrike={showPicks ? ranking.bestBuy?.row.strike ?? null : null}
          bestPutStrike={showPicks ? ranking.bestSell?.row.strike ?? null : null}
          callScores={callScores}
          putScores={putScores}
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
  bestCallStrike,
  bestPutStrike,
  callScores,
  putScores,
}: {
  rows: ChainRow[];
  atmStrike: number | null;
  spot: number | null;
  symbol: string;
  expiry: string;
  bestCallStrike: number | null;
  bestPutStrike: number | null;
  callScores: Map<number, number>;
  putScores: Map<number, number>;
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
            <Th align="right" tone="call">Rk</Th>
            <th className="px-3 py-2 text-center text-text-secondary font-medium">Strike</th>
            <Th align="left" tone="put">Rk</Th>
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
            const isBestCall = bestCallStrike != null && r.strike === bestCallStrike;
            const isBestPut = bestPutStrike != null && r.strike === bestPutStrike;
            const callRk = callScores.get(r.strike);
            const putRk = putScores.get(r.strike);
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
                <SideCell row={r.call} field="mid" tone="call" itm={callItm} align="right" mark={isBestCall} />
                <RankCell score={callRk} align="right" isBest={isBestCall} />
                <td className="px-3 py-1.5 text-center">
                  <StrikeButton
                    strike={r.strike}
                    isAtm={isAtm}
                    symbol={symbol}
                    expiry={expiry}
                  />
                </td>
                <RankCell score={putRk} align="left" isBest={isBestPut} />
                <SideCell row={r.put} field="mid" tone="put" itm={putItm} align="left" mark={isBestPut} />
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
  row, field, tone, itm, align, mark = false,
}: {
  row: OptionRow | null;
  field: "delta" | "iv" | "bid" | "ask" | "mid";
  tone: "call" | "put";
  itm: boolean;
  align: "left" | "right";
  /** Flag the recommended contract's mid cell with a ★. */
  mark?: boolean;
}) {
  const value = useCellValue(row, field);
  const textAlign = align === "left" ? "text-left" : "text-right";
  const star = mark ? <span className="text-accent" title="Top pick">★</span> : null;
  return (
    <td
      className={cn(
        "px-2 py-1.5",
        textAlign,
        itm ? "bg-surface-2/40" : "",
        mark && "bg-accent/10 text-text-primary font-medium",
        value == null ? "text-text-muted/40" : "text-text-secondary",
        tone === "call" && itm && "text-text-primary",
        tone === "put"  && itm && "text-text-primary",
      )}
    >
      {align === "left" ? (
        <span className="inline-flex items-center gap-1">{star}{value ?? "—"}</span>
      ) : (
        <span className="inline-flex items-center gap-1 justify-end">{value ?? "—"}{star}</span>
      )}
    </td>
  );
}

// Tiny score pill rendered per-strike in the chain. Tonal threshold matches
// the pick card meter so the colours read consistently.
function RankCell({
  score, align, isBest,
}: { score: number | undefined; align: "left" | "right"; isBest: boolean }) {
  const textAlign = align === "left" ? "text-left" : "text-right";
  if (score == null) {
    return <td className={cn("px-2 py-1.5 text-text-muted/40", textAlign)}>—</td>;
  }
  const tone = scoreTone(score);
  return (
    <td className={cn("px-2 py-1.5", textAlign)}>
      <span
        className={cn(
          "inline-block min-w-[22px] px-1.5 py-[1px] rounded-sm text-[10px] tabular text-center",
          tone.bg,
          tone.text,
          isBest && "ring-1 ring-accent/60",
        )}
        title={`Rating ${score} / 100`}
      >
        {score}
      </span>
    </td>
  );
}

// ─── Best-pick column (card + alternates) ───────────────────────────────────
function PickColumn({
  best,
  alternates,
  heading,
  sub,
  spot,
  dte,
  symbol,
  expiry,
}: {
  best: RankedContract | null;
  alternates: RankedContract[];
  heading: string;
  sub: string;
  spot: number;
  dte: number;
  symbol: string;
  expiry: string;
}) {
  if (!best) {
    return (
      <div className="rounded-md border border-border/40 bg-surface p-3 text-[11px] text-text-muted">
        <div className="text-text-secondary font-medium mb-1">{heading}</div>
        No suitable contract in the loaded strikes.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <PickCard
        pick={best}
        heading={heading}
        sub={sub}
        spot={spot}
        dte={dte}
        symbol={symbol}
        expiry={expiry}
      />
      {alternates.length > 0 && (
        <Alternates
          picks={alternates}
          symbol={symbol}
          expiry={expiry}
        />
      )}
    </div>
  );
}

function PickCard({
  pick, heading, sub, spot, dte, symbol, expiry,
}: {
  pick: RankedContract;
  heading: string;
  sub: string;
  spot: number;
  dte: number;
  symbol: string;
  expiry: string;
}) {
  const right = pick.side === "call" ? "C" : "P";
  const analyzeHref =
    `/monitor/analyzer?symbol=${symbol}&expiry=${expiry}&strike=${pick.row.strike}` +
    `&right=${right}&quantity=${pick.lens === "sell" ? -1 : 1}`;
  const tone = scoreTone(pick.score);
  const positives = pick.reasons.filter((r) => r.sign === 1);
  const negatives = pick.reasons.filter((r) => r.sign === -1);
  const neutrals = pick.reasons.filter((r) => r.sign === 0);

  return (
    <div className="rounded-md border border-border/40 bg-surface p-3 flex flex-col gap-2.5">
      {/* Heading + score */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] text-text-secondary font-medium leading-tight">{heading}</div>
          <div className="text-[10px] text-text-muted leading-tight">{sub}</div>
        </div>
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <span className={cn("px-2 py-0.5 rounded-sm text-[12px] tabular font-medium", tone.bg, tone.text)}>
            {pick.score}
          </span>
          <span className="text-[9px] uppercase tracking-wider text-text-muted">/ 100</span>
        </div>
      </div>

      {/* Score meter — visual 0..100 bar with a 50-baseline tick. */}
      <ScoreMeter score={pick.score} tone={tone} />

      {/* Component breakdown strip — what drove the score. */}
      <BreakdownStrip breakdown={pick.breakdown} />

      {/* Action chip + contract identity. */}
      <div className="flex items-baseline gap-2 tabular flex-wrap">
        <ActionChip lens={pick.lens} />
        <span className="text-text-primary text-sm font-medium">
          {pick.row.strike}{right}
        </span>
        <span className="text-[11px] text-text-secondary">
          @ {pick.mid.toFixed(2)}
        </span>
        <span className="text-[10px] text-text-muted">
          BE {pick.breakeven.toFixed(2)}
        </span>
      </div>

      <MiniPnlChart
        spot={spot}
        strike={pick.row.strike}
        dteYears={Math.max(dte, 1) / 365.25}
        iv={pick.row.iv ?? 0.3}
        isCall={pick.side === "call"}
        isLong={pick.lens === "buy"}
        entryPrice={pick.mid}
        breakeven={pick.breakeven}
      />

      {/* Numeric stat strip — IBKR-style tabular row. */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-text-muted tabular">
        <span>Δ {pick.absDelta.toFixed(2)}</span>
        {pick.row.iv != null && <span>IV {(pick.row.iv * 100).toFixed(0)}%</span>}
        {pick.extrinsicPct != null && <span>{pick.extrinsicPct.toFixed(0)}% time val</span>}
        {pick.spreadPct != null && <span>{pick.spreadPct.toFixed(1)}% spread</span>}
        {pick.row.oi != null && <span>OI {pick.row.oi}</span>}
      </div>

      {/* Reasons — split into positive vs negative chips so the user can
          scan what's helping vs hurting without re-reading sentences. */}
      {(positives.length > 0 || negatives.length > 0 || neutrals.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {positives.map((r, i) => (
            <ReasonChip key={`p-${i}`} sign={1} text={r.text} />
          ))}
          {negatives.map((r, i) => (
            <ReasonChip key={`n-${i}`} sign={-1} text={r.text} />
          ))}
          {neutrals.map((r, i) => (
            <ReasonChip key={`z-${i}`} sign={0} text={r.text} />
          ))}
        </div>
      )}

      <Link
        href={analyzeHref}
        className="mt-auto inline-flex items-center justify-center h-7 rounded-sm bg-surface-2 hover:bg-surface-3 text-[11px] text-text-primary transition-colors"
      >
        Full analysis →
      </Link>
    </div>
  );
}

// ── Sub-components for the pick card ──────────────────────────────────────

function ActionChip({ lens }: { lens: "buy" | "sell" }) {
  const isBuy = lens === "buy";
  return (
    <span
      className={cn(
        "px-1.5 py-0.5 rounded-sm text-[10px] uppercase tracking-wider font-medium tabular",
        isBuy ? "bg-up/15 text-up" : "bg-down/15 text-down",
      )}
    >
      {isBuy ? "BUY" : "SELL"}
    </span>
  );
}

function ScoreMeter({
  score, tone,
}: { score: number; tone: { bar: string } }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="relative h-1 w-full rounded-sm bg-surface-2 overflow-hidden">
      <div
        className={cn("absolute inset-y-0 left-0 transition-[width]", tone.bar)}
        style={{ width: `${pct}%` }}
      />
      {/* 50-baseline tick — shows whether the score is above/below "neutral". */}
      <div className="absolute inset-y-0 left-1/2 w-px bg-border/70" />
    </div>
  );
}

// Compact 5-cell strip showing each factor's contribution. Each cell is
// labelled and tinted: green for positive, red for negative, muted for zero.
function BreakdownStrip({ breakdown }: { breakdown: Record<BreakdownKey, number> }) {
  const labels: Record<BreakdownKey, string> = {
    delta: "Δ",
    extrinsic: "ext",
    liquidity: "liq",
    horizon: "hor",
    iv: "iv",
  };
  return (
    <div className="grid grid-cols-5 gap-1 tabular">
      {BREAKDOWN_KEYS.map((k) => {
        const v = breakdown[k] ?? 0;
        const tone =
          v > 0 ? "bg-up/10 text-up"
          : v < 0 ? "bg-down/10 text-down"
          : "bg-surface-2 text-text-muted";
        const sign = v > 0 ? "+" : "";
        return (
          <div
            key={k}
            className={cn(
              "flex flex-col items-center justify-center h-9 rounded-sm",
              tone,
            )}
            title={`${labels[k]} contribution`}
          >
            <span className="text-[8px] uppercase tracking-wider opacity-70">{labels[k]}</span>
            <span className="text-[10px] font-medium leading-none">
              {v === 0 ? "0" : `${sign}${v}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ReasonChip({ sign, text }: { sign: ReasonSignType; text: string }) {
  const cls =
    sign === 1 ? "bg-up/10 text-up border-up/20"
    : sign === -1 ? "bg-down/10 text-down border-down/20"
    : "bg-surface-2 text-text-secondary border-border/40";
  const glyph = sign === 1 ? "+" : sign === -1 ? "−" : "·";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border text-[10px] tabular",
        cls,
      )}
    >
      <span className="font-medium">{glyph}</span>
      <span>{text}</span>
    </span>
  );
}

type ReasonSignType = 1 | 0 | -1;

// Alternates — top picks 2-4, rendered as one-line rows so the user can
// jump straight to a runner-up without scrolling the chain.
function Alternates({
  picks, symbol, expiry,
}: { picks: RankedContract[]; symbol: string; expiry: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-surface px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-text-muted px-1 pb-1">
        Alternates
      </div>
      <ul className="flex flex-col">
        {picks.map((p) => (
          <li key={`${p.row.strike}-${p.side}`}>
            <AlternateRow pick={p} symbol={symbol} expiry={expiry} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AlternateRow({
  pick, symbol, expiry,
}: { pick: RankedContract; symbol: string; expiry: string }) {
  const right = pick.side === "call" ? "C" : "P";
  const tone = scoreTone(pick.score);
  const analyzeHref =
    `/monitor/analyzer?symbol=${symbol}&expiry=${expiry}&strike=${pick.row.strike}` +
    `&right=${right}&quantity=${pick.lens === "sell" ? -1 : 1}`;
  return (
    <Link
      href={analyzeHref}
      className="flex items-center gap-2 px-1 py-1 rounded-sm text-[11px] tabular hover:bg-surface-2/60 transition-colors"
    >
      <span
        className={cn(
          "min-w-[26px] text-center px-1 py-[1px] rounded-sm text-[10px] font-medium",
          tone.bg, tone.text,
        )}
      >
        {pick.score}
      </span>
      <span className="text-text-primary font-medium">
        {pick.row.strike}{right}
      </span>
      <span className="text-text-secondary">@ {pick.mid.toFixed(2)}</span>
      <span className="text-text-muted text-[10px] ml-auto">
        BE {pick.breakeven.toFixed(2)}
      </span>
      <span className="text-text-muted text-[10px]">
        Δ {pick.absDelta.toFixed(2)}
      </span>
    </Link>
  );
}

// Shared tone mapping for any score-bearing element (badges, meter, pills).
function scoreTone(score: number): { bg: string; text: string; bar: string } {
  if (score >= 70) return { bg: "bg-up/15", text: "text-up", bar: "bg-up" };
  if (score >= 45) return { bg: "bg-accent/15", text: "text-accent", bar: "bg-accent" };
  return { bg: "bg-warning/15", text: "text-warning", bar: "bg-warning" };
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
