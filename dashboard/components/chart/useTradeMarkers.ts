"use client";

// Hook: render this symbol's executed trades as arrow markers on the
// candle series, with a click handler that maps a chart click back to
// the underlying trade row. Lets the parent open a popover for journal
// entry and detail review without leaving the chart.
//
// Markers attach via `series.setMarkers(...)` — the lightweight-charts
// way. Trades from the Flex backfill carry 00:00:00 timestamps, so we
// snap each trade time to the start of its day (UTC) which lines up
// reliably with daily bars and falls within the visible window of any
// intraday timeframe.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  ISeriesApi,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import { api, type TradeHistoryRecord } from "@/lib/api";
import type { Bar } from "@/types";

interface UseTradeMarkersOpts {
  candleSeries: RefObject<ISeriesApi<"Candlestick"> | null>;
  symbol: string;
  enabled: boolean;
  /**
   * Bars currently on the series. Marker time must match an existing bar
   * time (lightweight-charts contract), and ``setData`` clears any prior
   * markers — so we re-set markers whenever ``bars`` change, and snap
   * each trade timestamp to the closest bar's time.
   */
  bars: Bar[] | null;
}

interface TradeBucket {
  /** Bar time (UTC seconds, day-aligned) that the marker is pinned to. */
  time: UTCTimestamp;
  trades: TradeHistoryRecord[];
}

export interface UseTradeMarkersResult {
  trades: TradeHistoryRecord[];
  /** Buckets keyed by day-aligned UTC seconds; multiple trades same day → one marker. */
  buckets: Map<number, TradeBucket>;
  /**
   * Map a chart-click time back to the bucket of trades on that bar, or
   * null if no trade matches. Used by the popover to know what to show.
   */
  bucketAt: (time: Time) => TradeBucket | null;
  /** Re-fetch — call after a trade update so markers refresh. */
  refresh: () => void;
  loading: boolean;
  error: string | null;
  /** Markers actually pushed to the chart on the last apply (zero if
   *  bars hadn't loaded yet). Surfaced so the toolbar can show a badge. */
  renderedCount: number;
}

export function useTradeMarkers({
  candleSeries,
  symbol,
  enabled,
  bars,
}: UseTradeMarkersOpts): UseTradeMarkersResult {
  const [trades, setTrades] = useState<TradeHistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Fetch on symbol change. Server-side filter on symbol; one big page
  // (500) easily covers any realistic per-symbol trade count for now.
  useEffect(() => {
    if (!enabled || !symbol) {
      setTrades([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.tradeHistory({ symbol, page: 1, page_size: 500 })
      .then((r) => {
        if (cancelled) return;
        setTrades(r.trades);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [symbol, enabled, nonce]);

  // Snap each trade time to the closest available bar time so markers
  // line up with what's actually rendered. On daily charts (bars at
  // midnight UTC) Flex's 00:00:00 timestamps land exactly; on intraday
  // (bars at 09:30 ET etc.) trades snap to the first bar of their day.
  // Without this, intraday charts would silently drop every marker.
  const barTimesSorted = useMemo(() => {
    if (!bars || bars.length === 0) return [] as number[];
    const ts = bars.map((b) => b.time);
    return ts.slice().sort((a, b) => a - b);
  }, [bars]);

  const buckets = useMemo(() => {
    const m = new Map<number, TradeBucket>();
    if (barTimesSorted.length === 0) return m;
    for (const t of trades) {
      const tradeSec = Math.floor(Date.parse(t.timestamp) / 1000);
      if (!Number.isFinite(tradeSec)) continue;
      const snapped = snapToBarTime(tradeSec, barTimesSorted);
      if (snapped == null) continue;
      const existing = m.get(snapped);
      if (existing) {
        existing.trades.push(t);
      } else {
        m.set(snapped, { time: snapped as UTCTimestamp, trades: [t] });
      }
    }
    return m;
  }, [trades, barTimesSorted]);

  const [renderedCount, setRenderedCount] = useState(0);

  // Push markers into the candle series whenever buckets change. We
  // dedupe direction per bucket: a "mixed" day (both buy and sell)
  // gets a neutral circle so it doesn't lie about the action.
  //
  // setMarkers is deferred to the next animation frame so it runs AFTER
  // any concurrent setData() call (which wipes markers). Trying to set
  // markers synchronously was racing with the bars fetcher; the rAF
  // hop costs nothing and is the simplest robust fix.
  useEffect(() => {
    const series = candleSeries.current;
    if (!series) return;
    if (!enabled) {
      try { series.setMarkers([]); } catch {}
      setRenderedCount(0);
      return;
    }
    const markers: SeriesMarker<Time>[] = [];
    const ordered = Array.from(buckets.values()).sort(
      (a, b) => (a.time as number) - (b.time as number),
    );
    for (const b of ordered) {
      const dir = directionOf(b);
      const count = b.trades.length;
      markers.push({
        time: b.time,
        position: dir === "sell" ? "aboveBar" : "belowBar",
        color: dir === "buy" ? "#26a69a" : dir === "sell" ? "#ef5350" : "#a78bfa",
        shape: dir === "buy" ? "arrowUp" : dir === "sell" ? "arrowDown" : "circle",
        text: count > 1 ? String(count) : undefined,
        size: 2,
      });
    }
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      try {
        series.setMarkers(markers);
        setRenderedCount(markers.length);
        if (typeof window !== "undefined") {
          // eslint-disable-next-line no-console
          console.debug("[trade-markers] applied", {
            symbol,
            markers: markers.length,
            bars: barTimesSorted.length,
            trades: trades.length,
          });
        }
      } catch (e) {
        if (typeof window !== "undefined") {
          // eslint-disable-next-line no-console
          console.warn("[trade-markers] setMarkers threw", e);
        }
      }
    };
    // Two-pass: apply once immediately, then re-apply on the next frame
    // to win the race against any setData() that React batches after us.
    apply();
    const raf = typeof requestAnimationFrame !== "undefined"
      ? requestAnimationFrame(apply)
      : null;
    return () => {
      cancelled = true;
      if (raf != null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(raf);
      }
    };
  }, [buckets, enabled, candleSeries, symbol, barTimesSorted.length, trades.length]);

  // Quick lookup keyed on UTC seconds. Lightweight-charts may give
  // either a number or a business-day object — we only care about
  // the numeric form (set by setData on candle bars).
  const bucketAt = useMemo(() => {
    return (time: Time): TradeBucket | null => {
      const t = typeof time === "number" ? time : null;
      if (t == null) return null;
      // Exact bar-time match first (intraday).
      const direct = buckets.get(t);
      if (direct) return direct;
      // Otherwise snap the clicked time to its day and try again.
      const snapped = Math.floor(t / 86400) * 86400;
      return buckets.get(snapped) ?? null;
    };
  }, [buckets]);

  return {
    trades,
    buckets,
    bucketAt,
    refresh: () => setNonce((n) => n + 1),
    loading,
    error,
    renderedCount,
  };
}

/** Find the bar time that best represents this trade time. Prefer the
 *  same-day bar if one exists; otherwise the nearest bar by absolute
 *  distance. Returns null if the trade falls outside the loaded range
 *  by more than 7 days (likely a chart that doesn't cover the trade). */
function snapToBarTime(tradeSec: number, sortedBars: number[]): number | null {
  if (sortedBars.length === 0) return null;
  const dayStart = Math.floor(tradeSec / 86400) * 86400;
  const dayEnd = dayStart + 86400;
  // Linear-ish scan is fine — bars are sorted and capped at ~bars.length.
  // For 10y of daily bars (~2500) the constant cost is negligible.
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of sortedBars) {
    // Prefer the first bar that falls on the trade's calendar day.
    if (t >= dayStart && t < dayEnd) return t;
    const d = Math.abs(t - tradeSec);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  if (best == null) return null;
  // Discard "too far" matches so we don't pin a 2026 trade onto a 2025
  // bar at the edge of the loaded window.
  return bestDist <= 7 * 86400 ? best : null;
}

function directionOf(bucket: TradeBucket): "buy" | "sell" | "mixed" {
  let buys = 0;
  let sells = 0;
  for (const t of bucket.trades) {
    const s = (t.side || "").toString().toUpperCase();
    if (s.startsWith("B")) buys++;
    else if (s.startsWith("S")) sells++;
  }
  if (buys > 0 && sells === 0) return "buy";
  if (sells > 0 && buys === 0) return "sell";
  return "mixed";
}
