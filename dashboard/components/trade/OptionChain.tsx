"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, type EarningsInfo, type OptionRow, type OptionsChain } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  RiAlertFill as AlertTriangle,
  RiStarFill as Star,
  RiListUnordered as ListIcon,
  RiRefreshLine as Refresh,
  RiErrorWarningFill as ErrorDot,
  RiEyeLine as Eye,
  RiEyeOffLine as EyeOff,
} from "@remixicon/react";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/components/ui/logo";
import { EmptyState } from "@/components/ui/empty-state";
import { TableSkeletonRows, Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableHead } from "@/components/ui/table";
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
const CHAIN_COLS = 13;

interface ChainRow {
  strike: number;
  call: OptionRow | null;
  put: OptionRow | null;
}

export function OptionChain() {
  // Allow ?symbol=X to seed the chain, consolidated from the old
  // /options/[symbol] route, which now redirects here.
  const params = useSearchParams();
  const initial = (params?.get("symbol") || DEFAULT_SYMBOL).toUpperCase();

  const [pendingSymbol, setPendingSymbol] = useState(initial);
  const [symbol, setSymbol] = useState(initial);
  const [expirations, setExpirations] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string | null>(null);
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [earnings, setEarnings] = useState<EarningsInfo | null>(null);
  const [showPicks, setShowPicks] = useState(true);

  // Earnings date (IBKR WSH), fetched per symbol, independent of expiry.
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
    setError(false);
    setChain(null);
    api.optionsChain(symbol)
      .then((r) => {
        if (!alive) return;
        setExpirations(r.expirations);
        setExpiry(r.expirations[0] ?? null);
      })
      .catch(() => { if (alive) { setExpirations([]); setError(true); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol, reloadTick]);

  // Step 2: fetch the chain for the chosen expiry.
  useEffect(() => {
    if (!expiry) return;
    let alive = true;
    setLoading(true);
    setError(false);
    api.optionsChain(symbol, expiry)
      .then((r) => { if (alive) setChain(r); })
      .catch(() => { if (alive) { setChain(null); setError(true); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol, expiry, reloadTick]);

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

  // Rank the loaded chain for the active expiry, surfaces a best call to buy
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

  const retry = () => setReloadTick((t) => t + 1);
  const hasPicks = !!chain && !!(ranking.bestBuy || ranking.bestSell);

  return (
    <PageShell>
      <PageHeader
        title={`${symbol} option chain`}
        description={chain?.underlying_price
          ? `Spot ${chain.underlying_price.toFixed(2)}, ${rows.length} strikes loaded`
          : "Bid, ask, delta and IV per strike. Click a strike to pin it on the chart."}
        actions={
          loading ? (
            <Badge variant="muted">Loading</Badge>
          ) : error ? (
            <Badge variant="down">Fetch failed</Badge>
          ) : chain ? (
            <Badge variant="muted" className="tabular">{windowed.length} strikes shown</Badge>
          ) : null
        }
      />

      {/* Toolbar: symbol, expiry, and the context chips for the chosen expiry. */}
      <Card className="shrink-0">
        <CardContent className="p-3 flex flex-col gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); onSymbolSubmit(); }}
            >
              <Logo symbol={symbol} size={20} />
              <label className="flex items-center gap-2">
                <span className="text-caption-1-medium text-text-tertiary">Symbol</span>
                <Input
                  value={pendingSymbol}
                  onChange={(e) => setPendingSymbol(e.target.value.toUpperCase())}
                  placeholder="RUT"
                  className="w-24 tabular"
                  aria-label="Symbol"
                />
              </label>
              <Button type="submit" variant="secondary" disabled={pendingSymbol.trim().toUpperCase() === symbol}>
                Load
              </Button>
            </form>

            <span aria-hidden="true" className="hidden sm:block w-px h-6 bg-separator-border" />

            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-caption-1-medium text-text-tertiary shrink-0">Expiry</span>
              {loading && expirations.length === 0 ? (
                <Skeleton className="h-8 w-64" />
              ) : expirations.length === 0 ? (
                <span className="text-body-2-regular text-text-tertiary">n/a</span>
              ) : (
                <ExpiryTabs expirations={expirations} active={expiry} onChoose={setExpiry} />
              )}
            </div>
          </div>

          {chain && expiry && (
            <div className="flex items-center gap-2 flex-wrap">
              {ranking.ltcgEligible ? (
                <Badge variant="up">LTCG eligible, {ranking.dte}d to expiry</Badge>
              ) : (
                <Badge variant="muted">
                  {ranking.dte}d to expiry ({ranking.dte > 0 ? `${(ranking.dte / 365).toFixed(1)}y` : "0y"}), LTCG needs a hold over 1y
                </Badge>
              )}
              {earningsInfo && (
                <Badge
                  variant={earningsInfo.beforeExpiry ? "warning" : "muted"}
                  title={earningsInfo.beforeExpiry ? "Earnings falls before this expiry. Expect an IV and price gap" : "Next earnings"}
                >
                  {earningsInfo.beforeExpiry && <AlertTriangle size={14} aria-hidden="true" />}
                  Earnings {formatExp(earningsInfo.date)}, {earningsInfo.dte}d
                </Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Best picks: the ranked LEAPS call to buy and put to sell. */}
      {hasPicks && (
        <Card className="shrink-0">
          <CardHeader>
            <div className="flex items-center gap-2 min-w-0">
              <CardTitle>Best picks</CardTitle>
              <Badge variant="muted">{formatExp(expiry!)} expiry</Badge>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setShowPicks((v) => !v)} aria-expanded={showPicks}>
              {showPicks ? <EyeOff /> : <Eye />}
              {showPicks ? "Hide picks" : "Show picks"}
            </Button>
          </CardHeader>
          {showPicks && (
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <PickColumn
                best={ranking.bestBuy}
                alternates={ranking.rankedCalls.slice(1, 4)}
                heading="Best LEAPS call to buy"
                sub="Deep in the money stock replacement"
                spot={ranking.spot!}
                dte={ranking.dte}
                symbol={chain!.symbol}
                expiry={expiry!}
              />
              <PickColumn
                best={ranking.bestSell}
                alternates={ranking.rankedPuts.slice(1, 4)}
                heading="Best put to sell"
                sub="Cash secured, bullish income"
                spot={ranking.spot!}
                dte={ranking.dte}
                symbol={chain!.symbol}
                expiry={expiry!}
              />
            </CardContent>
          )}
        </Card>
      )}

      {/* The chain itself: calls left, strike centre, puts right. */}
      <Card className="shrink-0">
        <CardHeader>
          <div className="flex items-center gap-2 min-w-0">
            <CardTitle>Chain</CardTitle>
            {chain?.underlying_price != null && (
              <Badge variant="muted" className="tabular">Spot {chain.underlying_price.toFixed(2)}</Badge>
            )}
          </div>
          <span className="text-caption-1-medium text-text-tertiary">Calls left, puts right</span>
        </CardHeader>

        {loading && !chain && (
          <Table>
            <ChainHead />
            <TableBody>
              <TableSkeletonRows rows={12} cols={CHAIN_COLS} />
            </TableBody>
          </Table>
        )}

        {!loading && error && (
          <EmptyState
            icon={ErrorDot}
            title="Chain failed to load"
            description="IBKR did not answer the chain request. Retry once the gateway is back."
            action={
              <Button variant="secondary" size="sm" onClick={retry}>
                <Refresh />
                Retry
              </Button>
            }
          />
        )}

        {!loading && !error && (!chain || windowed.length === 0) && (
          <EmptyState
            icon={ListIcon}
            title="No strikes loaded"
            description="Nothing came back for this expiry yet. The chain may still be hydrating from IBKR."
            action={
              <Button variant="secondary" size="sm" onClick={retry}>
                <Refresh />
                Reload
              </Button>
            }
          />
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
      </Card>
    </PageShell>
  );
}

// ─── Expiry tabs ──────────────────────────────────────────────────────────────
// Segmented control on a tertiary track, scrolls sideways when a name has
// many expiries. Each segment carries the date and days-to-expiry.
function ExpiryTabs({
  expirations,
  active,
  onChoose,
}: {
  expirations: string[];
  active: string | null;
  onChoose: (e: string) => void;
}) {
  const today = new Date();
  return (
    <div className="min-w-0 overflow-x-auto">
      <div
        role="radiogroup"
        aria-label="Expiry"
        className="inline-flex items-center gap-0.5 rounded-2lg bg-background-tertiary-default p-0.5"
      >
        {expirations.map((e) => {
          const isActive = e === active;
          const dt = parseExp(e);
          const dte = dt ? Math.ceil((dt.getTime() - today.getTime()) / 86400_000) : null;
          return (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => onChoose(e)}
              className={cn(
                "shrink-0 inline-flex items-baseline gap-1 h-7 px-2.5 rounded-md tabular text-body-2-medium transition-[background-color,color,box-shadow] duration-150",
                "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                isActive
                  ? "bg-segmented-control-selected-background text-text-primary shadow-2xs"
                  : "text-text-secondary hover:text-text-primary"
              )}
            >
              <span>{formatExp(e)}</span>
              {dte != null && <span className="text-caption-1-regular text-text-tertiary">{dte}d</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Chain table ──────────────────────────────────────────────────────────────
function ChainHead() {
  return (
    <TableHeader>
      <tr>
        <TableHead className="text-right">Delta</TableHead>
        <TableHead className="text-right">IV</TableHead>
        <TableHead className="text-right">Bid</TableHead>
        <TableHead className="text-right">Ask</TableHead>
        <TableHead className="text-right">Mid</TableHead>
        <TableHead className="text-right">Rank</TableHead>
        <TableHead className="text-center text-text-secondary">Strike</TableHead>
        <TableHead>Rank</TableHead>
        <TableHead>Mid</TableHead>
        <TableHead>Bid</TableHead>
        <TableHead>Ask</TableHead>
        <TableHead>IV</TableHead>
        <TableHead>Delta</TableHead>
      </tr>
    </TableHeader>
  );
}

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
    <Table className="tabular">
      <ChainHead />
      <TableBody>
        {rows.map((r) => {
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
              data-state={isAtm ? "selected" : undefined}
              className={cn(
                "border-b border-separator-border group transition-colors hover:bg-background-secondary-hover",
                isAtm && "bg-status-blue-background"
              )}
            >
              <SideCell row={r.call} field="delta" itm={callItm} align="right" />
              <SideCell row={r.call} field="iv" itm={callItm} align="right" />
              <SideCell row={r.call} field="bid" itm={callItm} align="right" />
              <SideCell row={r.call} field="ask" itm={callItm} align="right" />
              <SideCell row={r.call} field="mid" itm={callItm} align="right" mark={isBestCall} />
              <RankCell score={callRk} align="right" isBest={isBestCall} />
              <td className="px-3 h-9 text-center">
                <StrikeButton
                  strike={r.strike}
                  isAtm={isAtm}
                  symbol={symbol}
                  expiry={expiry}
                />
              </td>
              <RankCell score={putRk} align="left" isBest={isBestPut} />
              <SideCell row={r.put} field="mid" itm={putItm} align="left" mark={isBestPut} />
              <SideCell row={r.put} field="bid" itm={putItm} align="left" />
              <SideCell row={r.put} field="ask" itm={putItm} align="left" />
              <SideCell row={r.put} field="iv" itm={putItm} align="left" />
              <SideCell row={r.put} field="delta" itm={putItm} align="left" />
            </tr>
          );
        })}
      </TableBody>
    </Table>
  );
}

function SideCell({
  row, field, itm, align, mark = false,
}: {
  row: OptionRow | null;
  field: "delta" | "iv" | "bid" | "ask" | "mid";
  itm: boolean;
  align: "left" | "right";
  /** Flag the recommended contract's mid cell with a star. */
  mark?: boolean;
}) {
  const value = useCellValue(row, field);
  const textAlign = align === "left" ? "text-left" : "text-right";
  const star = mark ? <Star size={14} className="text-accent-500 shrink-0" aria-label="Top pick" /> : null;
  return (
    <td
      className={cn(
        "px-3 h-9 align-middle text-body-2-medium",
        textAlign,
        itm && "bg-background-secondary-default",
        mark && "bg-status-blue-background",
        value == null ? "text-text-tertiary" : itm ? "text-text-primary" : "text-text-secondary",
      )}
    >
      {align === "left" ? (
        <span className="inline-flex items-center gap-1">{star}{value ?? "n/a"}</span>
      ) : (
        <span className="inline-flex items-center gap-1 justify-end">{value ?? "n/a"}{star}</span>
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
    return <td className={cn("px-3 h-9 align-middle text-body-2-medium text-text-tertiary", textAlign)}>n/a</td>;
  }
  const tone = scoreTone(score);
  return (
    <td className={cn("px-3 h-9 align-middle", textAlign)}>
      <span
        className={cn(
          "inline-flex items-center justify-center min-w-[26px] h-5 px-1.5 rounded-md text-caption-1-medium tabular",
          tone.bg,
          tone.text,
          isBest && "ring-2 ring-inset ring-accent-500",
        )}
        title={`Rating ${score} of 100`}
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
      <div className="rounded-2lg bg-background-secondary-default p-3 flex flex-col gap-1">
        <div className="text-body-2-medium text-text-primary">{heading}</div>
        <div className="text-caption-1-regular text-text-tertiary">No suitable contract in the loaded strikes.</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
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
    <div className="rounded-2lg bg-background-secondary-default p-3 flex flex-col gap-3">
      {/* Heading + score */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-body-2-medium text-text-primary">{heading}</div>
          <div className="text-caption-1-regular text-text-tertiary">{sub}</div>
        </div>
        <div className="flex items-baseline gap-1 shrink-0 tabular">
          <span className={cn("inline-flex items-center h-6 px-2 rounded-md text-body-2-medium", tone.bg, tone.text)}>
            {pick.score}
          </span>
          <span className="text-caption-1-regular text-text-tertiary">of 100</span>
        </div>
      </div>

      {/* Score meter, visual 0..100 bar with a 50-baseline tick. */}
      <ScoreMeter score={pick.score} tone={tone} />

      {/* Component breakdown strip, what drove the score. */}
      <BreakdownStrip breakdown={pick.breakdown} />

      {/* Action chip + contract identity. */}
      <div className="flex items-center gap-2 tabular flex-wrap">
        <ActionChip lens={pick.lens} />
        <span className="text-body-medium text-text-primary">
          {pick.row.strike}{right}
        </span>
        <span className="text-body-2-regular text-text-secondary">
          at {pick.mid.toFixed(2)}
        </span>
        <span className="text-caption-1-regular text-text-tertiary">
          Breakeven {pick.breakeven.toFixed(2)}
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

      {/* Numeric stat strip, tabular row. */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-caption-1-medium text-text-tertiary tabular">
        <span>Delta {pick.absDelta.toFixed(2)}</span>
        {pick.row.iv != null && <span>IV {(pick.row.iv * 100).toFixed(0)}%</span>}
        {pick.extrinsicPct != null && <span>{pick.extrinsicPct.toFixed(0)}% time value</span>}
        {pick.spreadPct != null && <span>{pick.spreadPct.toFixed(1)}% spread</span>}
        {pick.row.oi != null && <span>OI {pick.row.oi}</span>}
      </div>

      {/* Reasons, split into positive vs negative chips so the user can
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

      <Button asChild variant="secondary" className="mt-auto w-full">
        <Link href={analyzeHref}>Open full analysis</Link>
      </Button>
    </div>
  );
}

// ── Sub-components for the pick card ──────────────────────────────────────

function ActionChip({ lens }: { lens: "buy" | "sell" }) {
  const isBuy = lens === "buy";
  return <Badge variant={isBuy ? "up" : "down"}>{isBuy ? "Buy" : "Sell"}</Badge>;
}

function ScoreMeter({
  score, tone,
}: { score: number; tone: { bar: string } }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="relative h-1.5 w-full rounded-full bg-background-tertiary-default overflow-hidden">
      <div
        className={cn("absolute inset-y-0 left-0 rounded-full", tone.bar)}
        style={{ width: `${pct}%` }}
      />
      {/* 50-baseline tick, shows whether the score is above/below "neutral". */}
      <div className="absolute inset-y-0 left-1/2 w-px bg-separator-border" />
    </div>
  );
}

// Compact 5-cell strip showing each factor's contribution. Each cell is
// labelled and tinted: lime for positive, rose for negative, muted for zero.
function BreakdownStrip({ breakdown }: { breakdown: Record<BreakdownKey, number> }) {
  const labels: Record<BreakdownKey, string> = {
    delta: "Delta",
    extrinsic: "Ext",
    liquidity: "Liq",
    horizon: "Hor",
    iv: "IV",
  };
  return (
    <div className="grid grid-cols-5 gap-1 tabular">
      {BREAKDOWN_KEYS.map((k) => {
        const v = breakdown[k] ?? 0;
        const tone =
          v > 0 ? "bg-status-lime-background text-status-lime-text"
          : v < 0 ? "bg-status-rose-background text-status-rose-text"
          : "bg-background-tertiary-default text-text-tertiary";
        const sign = v > 0 ? "+" : "";
        return (
          <div
            key={k}
            className={cn(
              "flex flex-col items-center justify-center h-10 rounded-md",
              tone,
            )}
            title={`${labels[k]} contribution`}
          >
            <span className="text-caption-2-regular opacity-70">{labels[k]}</span>
            <span className="text-caption-1-medium leading-none">
              {v === 0 ? "0" : `${sign}${v}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ReasonChip({ sign, text }: { sign: ReasonSignType; text: string }) {
  const variant = sign === 1 ? "up" : sign === -1 ? "down" : "muted";
  const glyph = sign === 1 ? "+" : sign === -1 ? "−" : null;
  // Reason copy comes from lib/leaps; fold its dash separators into commas so
  // the chip reads as one clause without an em dash.
  const copy = text.replace(/\s[\u2014\u2013]\s/g, ", ");
  return (
    <Badge variant={variant} className="h-auto py-0.5 whitespace-normal text-left">
      {glyph && <span className="tabular">{glyph}</span>}
      <span>{copy}</span>
    </Badge>
  );
}

type ReasonSignType = 1 | 0 | -1;

// Alternates, top picks 2-4, rendered as one-line rows so the user can
// jump straight to a runner-up without scrolling the chain.
function Alternates({
  picks, symbol, expiry,
}: { picks: RankedContract[]; symbol: string; expiry: string }) {
  return (
    <div className="rounded-2lg bg-background-secondary-default p-2 flex flex-col gap-1">
      <div className="text-caption-1-medium text-text-tertiary px-1">
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
      className="flex items-center gap-2 px-1 h-8 rounded-md tabular hover:bg-background-secondary-hover transition-colors"
    >
      <span
        className={cn(
          "inline-flex items-center justify-center min-w-[26px] h-5 px-1.5 rounded-md text-caption-1-medium",
          tone.bg, tone.text,
        )}
      >
        {pick.score}
      </span>
      <span className="text-body-2-medium text-text-primary">
        {pick.row.strike}{right}
      </span>
      <span className="text-body-2-regular text-text-secondary">at {pick.mid.toFixed(2)}</span>
      <span className="text-caption-1-regular text-text-tertiary ml-auto">
        Breakeven {pick.breakeven.toFixed(2)}
      </span>
      <span className="text-caption-1-regular text-text-tertiary">
        Delta {pick.absDelta.toFixed(2)}
      </span>
    </Link>
  );
}

// Shared tone mapping for any score-bearing element (badges, meter, pills).
function scoreTone(score: number): { bg: string; text: string; bar: string } {
  if (score >= 70) return { bg: "bg-status-lime-background", text: "text-status-lime-text", bar: "bg-status-lime-text" };
  if (score >= 45) return { bg: "bg-status-blue-background", text: "text-status-blue-text", bar: "bg-status-blue-text" };
  return { bg: "bg-status-yellow-background", text: "text-status-yellow-text", bar: "bg-status-yellow-text" };
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
        "inline-flex items-center justify-center min-w-[64px] h-6 px-2 rounded-md tabular text-body-2-medium transition-colors",
        isAtm
          ? "bg-status-blue-background text-status-blue-text"
          : "text-text-primary hover:bg-background-tertiary-hover"
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
