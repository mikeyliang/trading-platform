"use client";

import { useEffect, useRef, type RefObject } from "react";
import { IChartApi, ISeriesApi, LineStyle, UTCTimestamp } from "lightweight-charts";

export interface PinnedSpread {
  shortStrike: number;
  longStrike: number;
  expiry: string;       // YYYYMMDD
  tradeType: string;    // rut / mars / marsmax / space (for label)
  side: "put" | "call";
}

const TYPE_COLOR: Record<string, string> = {
  rut: "#94a3b8",
  mars: "#60a5fa",
  marsmax: "#fbbf24",
  space: "#22c55e",
};

interface Args {
  chart: RefObject<IChartApi | null>;
  candleSeries: RefObject<ISeriesApi<"Candlestick"> | null>;
  pinned: PinnedSpread | null;
}

/**
 * Render the user's pinned bull-put spread as SHORT line segments
 * spanning today → expiration only — not horizontal lines across the
 * entire chart. Matches how a monthly RUT/SPY trade actually lives: a
 * 25-DTE bracket, not a forever-line.
 *
 * Four labelled levels per pin (all spec-driven, see lib/ruleone.ts):
 *   1. short strike   — solid, primary color
 *   2. long  strike   — dashed, same color
 *   3. rule-2 exit    — dotted: strike ± buffer% (3% trad RUT, 2% others).
 *                       On the last trade day, price here = close NOW.
 *   4. alert level    — sparse-dotted at half the buffer: "set your
 *                       broker alert here" pre-warning level.
 */
export function usePinnedSpreadOverlay({ chart, candleSeries, pinned }: Args) {
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    const c = chart.current;
    const cs = candleSeries.current;
    if (!c || !cs) return;

    // Clean up any series from a previous render.
    for (const s of seriesRef.current) {
      try { c.removeSeries(s); } catch {}
    }
    seriesRef.current = [];

    if (!pinned) return;

    const color = TYPE_COLOR[pinned.tradeType] ?? "#fb7185";
    const right = pinned.side === "put" ? "P" : "C";
    const label =
      pinned.tradeType === "marsmax"
        ? "Mars Max"
        : pinned.tradeType[0].toUpperCase() + pinned.tradeType.slice(1);
    const expLabel = `${pinned.expiry.slice(4, 6)}/${pinned.expiry.slice(6, 8)}`;

    // Anchor the segment from "today" (last candle time, so it doesn't jump
    // into the future on intraday timeframes that haven't printed yet) to the
    // expiration date.
    const tStart = lastBarTime(cs);
    const tEnd = expiryTimestamp(pinned.expiry);
    if (tStart == null || tEnd == null || tEnd <= tStart) return;

    // Spec-driven rule-2 buffer: traditional RUT closes within 3% of the
    // short strike on the last trade day; Mars / Mars Max / Space use 2%.
    const bufferPct = pinned.tradeType === "rut" ? 3 : 2;
    const dir = pinned.side === "put" ? 1 : -1; // puts: levels sit ABOVE strike
    const exitPrice = pinned.shortStrike * (1 + dir * bufferPct / 100);
    const alertPrice = pinned.shortStrike * (1 + dir * (bufferPct / 2) / 100);

    const segments: Array<{
      price: number;
      width: 1 | 2;
      style: LineStyle;
      title: string;
    }> = [
      { price: pinned.shortStrike, width: 2, style: LineStyle.Solid,
        title: `${label} short · ${pinned.shortStrike}${right} · ${expLabel}` },
      { price: pinned.longStrike,  width: 1, style: LineStyle.Dashed,
        title: `${label} long · ${pinned.longStrike}${right}` },
      { price: exitPrice, width: 1, style: LineStyle.Dotted,
        title: `${label} R2 exit · ${exitPrice.toFixed(0)} (${bufferPct}% buffer, last day)` },
      { price: alertPrice, width: 1, style: LineStyle.SparseDotted,
        title: `${label} alert · ${alertPrice.toFixed(0)}` },
    ];

    for (const seg of segments) {
      const s = c.addLineSeries({
        color,
        lineWidth: seg.width,
        lineStyle: seg.style,
        priceLineVisible: false,
        lastValueVisible: true,
        title: seg.title,
        crosshairMarkerVisible: false,
      });
      s.setData([
        { time: tStart, value: seg.price },
        { time: tEnd,   value: seg.price },
      ]);
      seriesRef.current.push(s);
    }

    return () => {
      const cc = chart.current;
      if (!cc) return;
      for (const s of seriesRef.current) {
        try { cc.removeSeries(s); } catch {}
      }
      seriesRef.current = [];
    };
  }, [chart, candleSeries, pinned]);
}

function expiryTimestamp(yyyymmdd: string): UTCTimestamp | null {
  if (yyyymmdd.length !== 8) return null;
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6) - 1;
  const d = +yyyymmdd.slice(6, 8);
  // Use UTC midnight — lightweight-charts treats times as UTC seconds.
  const ms = Date.UTC(y, m, d, 16, 0, 0); // 16:00 UTC ~ market close
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function lastBarTime(series: ISeriesApi<"Candlestick">): UTCTimestamp | null {
  const data = series.data() as { time: UTCTimestamp }[];
  if (!data || data.length === 0) return null;
  return data[data.length - 1].time;
}
