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
 * Render the user's pinned bull-put spread as three SHORT line segments
 * spanning today → expiration only — not horizontal lines across the
 * entire chart. Matches how a monthly RUT/SPY trade actually lives: a
 * 25-DTE bracket, not a forever-line.
 *
 * Three lines per pin:
 *   1. short strike  — solid, primary color
 *   2. long  strike  — dashed, same color
 *   3. 2% exit       — dotted, same color (Jamal's final-day exit rule)
 *
 * The lightweight-charts time axis auto-extends to fit the expiry data
 * point, so the chart shows the runway out to the trade's last day.
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
      { price: pinned.side === "put" ? pinned.shortStrike * 1.02 : pinned.shortStrike * 0.98,
        width: 1, style: LineStyle.Dotted,
        title: `${label} 2% exit` },
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
