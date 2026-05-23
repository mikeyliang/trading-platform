"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { IPriceLine, ISeriesApi, LineStyle } from "lightweight-charts";
import { api, type Spread } from "@/lib/api";

export interface ProjectedSpread {
  symbol: string;
  expiry: string;
  expiryLabel: string;
  shortStrike: number;
  longStrike: number;
  shortDelta: number;
  shortBid: number | null;
  shortAsk: number | null;
  estCredit: number | null;
  underlying: number;
  dte: number;
}

// per-underlying wing width defaults (matches backend bull_put_spread.py heuristics)
const WING_WIDTH: Record<string, number> = {
  SPY: 5,
  QQQ: 5,
  IWM: 2,
  RUT: 10,
  SPX: 10,
  NDX: 25,
};

export const SUPPORTED_OVERLAY_SYMBOLS = new Set(["SPY", "QQQ", "IWM", "RUT", "SPX", "NDX"]);

interface UseSpreadOverlayOpts {
  candleSeries: RefObject<ISeriesApi<"Candlestick"> | null>;
  symbol: string;
  enabled: boolean;
}

export function useSpreadOverlay({ candleSeries, symbol, enabled }: UseSpreadOverlayOpts) {
  const linesRef = useRef<IPriceLine[]>([]);
  const [openSpreads, setOpenSpreads] = useState<Spread[]>([]);
  const [projected, setProjected] = useState<ProjectedSpread | null>(null);
  const [loading, setLoading] = useState(false);

  // fetch data when symbol or enabled changes
  useEffect(() => {
    if (!enabled) {
      setOpenSpreads([]);
      setProjected(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        // Projected entry was driven by a generic Δ 0.25 / DTE 38 probe
        // which does not match any Rule One spec (caps: 0.10/0.12/0.14,
        // DTE 25). The cycle card + short-strike overlay now drive
        // per-strategy projections, so this only fetches live open spreads.
        const allSpreads = await api.spreads().catch(() => [] as Spread[]);
        if (cancelled) return;
        setOpenSpreads(allSpreads.filter((s) => s.symbol === symbol));
        setProjected(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol, enabled]);

  // (re)draw price lines whenever data or series change
  useEffect(() => {
    const series = candleSeries.current;
    if (!series) return;

    // tear down old lines
    for (const line of linesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        /* series may have been replaced */
      }
    }
    linesRef.current = [];

    if (!enabled) return;

    // open spreads: draw one labeled line per leg using the generic legs[] array.
    // BUY legs in green (our protection / what we own), SELL legs in red
    // (where we want price to STAY AWAY from). Calls and puts get a P/C suffix.
    // For each SELL leg we also draw a soft amber "2% exit" line — that's
    // the course's final-Thursday exit trigger (price within 2% of the short).
    for (const s of openSpreads) {
      const expLabel = formatExpiry(s.expiry);
      const legs = (s.legs && s.legs.length > 0)
        ? s.legs
        : ([
            // legacy fallback: synthesize legs from short_strike/long_strike if
            // backend didn't fill in legs[] for older spread records
            { strike: s.short_strike, right: "P" as const, action: "SELL" as const, con_id: 0 },
            { strike: s.long_strike, right: "P" as const, action: "BUY" as const, con_id: 0 },
          ]);
      for (const leg of legs) {
        const isSell = leg.action === "SELL";
        linesRef.current.push(
          series.createPriceLine({
            price: leg.strike,
            color: isSell ? "#ef4444" : "#22c55e",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `${leg.action} ${leg.strike}${leg.right} • ${expLabel}`,
          })
        );
        if (isSell) {
          const exitPrice = twoPercentExit(leg.strike, leg.right);
          linesRef.current.push(
            series.createPriceLine({
              price: exitPrice,
              color: "#f59e0b",
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: `2% exit ${exitPrice.toFixed(2)}${leg.right} • ${expLabel}`,
            })
          );
        }
      }
    }

    // projected next-entry: dotted, warning color
    if (projected) {
      linesRef.current.push(
        series.createPriceLine({
          price: projected.shortStrike,
          color: "#f59e0b",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `PROJ SHORT ${projected.shortStrike}P • ${projected.expiryLabel} (${projected.dte}d)`,
        })
      );
      linesRef.current.push(
        series.createPriceLine({
          price: projected.longStrike,
          color: "#3b82f6",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `PROJ LONG ${projected.longStrike}P`,
        })
      );
      const projExit = twoPercentExit(projected.shortStrike, "P");
      linesRef.current.push(
        series.createPriceLine({
          price: projExit,
          color: "#f59e0b",
          lineWidth: 1,
          lineStyle: LineStyle.SparseDotted,
          axisLabelVisible: true,
          title: `PROJ 2% exit ${projExit.toFixed(2)}P`,
        })
      );
    }

    return () => {
      const s = candleSeries.current;
      if (!s) return;
      for (const line of linesRef.current) {
        try {
          s.removePriceLine(line);
        } catch {
          /* ignore */
        }
      }
      linesRef.current = [];
    };
  }, [openSpreads, projected, enabled, candleSeries]);

  return { openSpreads, projected, loading };
}

async function computeProjected(symbol: string): Promise<ProjectedSpread | null> {
  // 1. discover the next 3rd-Friday expiration in the 30-45 DTE window
  const root = await api.optionsChain(symbol).catch(() => null);
  if (!root?.expirations?.length) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const candidates = root.expirations
    .map((e) => {
      const d = parseYYYYMMDD(e);
      if (!d) return null;
      const dte = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      return { exp: e, date: d, dte, thirdFriday: isThirdFriday(d) };
    })
    .filter((x): x is { exp: string; date: Date; dte: number; thirdFriday: boolean } => x !== null)
    .filter((x) => x.dte >= 21 && x.dte <= 60);

  // prefer 3rd-friday monthlies in 30-45 DTE
  const monthly = candidates
    .filter((c) => c.thirdFriday && c.dte >= 30 && c.dte <= 45)
    .sort((a, b) => a.dte - b.dte)[0];
  const nearest = candidates.sort((a, b) => Math.abs(a.dte - 38) - Math.abs(b.dte - 38))[0];
  const pick = monthly ?? nearest;
  if (!pick) return null;

  // 2. fetch chain for that expiry
  const chain = await api.optionsChain(symbol, pick.exp).catch(() => null);
  if (!chain || chain.underlying_price == null) return null;

  // 3. find the put whose |delta| is closest to 0.25 (the strategy's short_delta)
  const withDelta = chain.puts.filter((p) => p.delta != null);
  if (!withDelta.length) return null;
  const target = 0.25;
  const shortPut = withDelta.reduce((best, p) =>
    Math.abs(Math.abs(p.delta!) - target) < Math.abs(Math.abs(best.delta!) - target) ? p : best
  );

  // 4. long strike = short - wing_width
  const wing = WING_WIDTH[symbol] ?? 5;
  const longStrike = shortPut.strike - wing;
  const longPut = chain.puts.find((p) => Math.abs(p.strike - longStrike) < 0.01);

  // 5. estimated credit (mid - 5c slippage, matching the strategy)
  const mid = (o: { bid: number | null; ask: number | null }) =>
    o.bid != null && o.ask != null && o.ask > 0 ? (o.bid + o.ask) / 2 : null;
  const shortMid = mid(shortPut);
  const longMid = longPut ? mid(longPut) : null;
  const estCredit =
    shortMid != null && longMid != null ? Math.max(0, +(shortMid - longMid - 0.05).toFixed(2)) : null;

  return {
    symbol,
    expiry: pick.exp,
    expiryLabel: formatExpiry(pick.exp),
    shortStrike: shortPut.strike,
    longStrike,
    shortDelta: shortPut.delta!,
    shortBid: shortPut.bid,
    shortAsk: shortPut.ask,
    estCredit,
    underlying: chain.underlying_price,
    dte: pick.dte,
  };
}

function parseYYYYMMDD(s: string): Date | null {
  if (s.length !== 8) return null;
  const y = +s.slice(0, 4);
  const m = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function isThirdFriday(d: Date): boolean {
  return d.getDay() === 5 && d.getDate() >= 15 && d.getDate() <= 21;
}

/**
 * The course's "final-Thursday 2% rule": when price comes within 2% of the
 * short strike on the last week, exit. For a bull-put (short put) that's
 * 2% ABOVE the short strike — the line we want price to stay above; for a
 * bear-call (short call) it's 2% BELOW the short.
 */
function twoPercentExit(shortStrike: number, right: "P" | "C"): number {
  return right === "P" ? shortStrike * 1.02 : shortStrike * 0.98;
}

function formatExpiry(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
