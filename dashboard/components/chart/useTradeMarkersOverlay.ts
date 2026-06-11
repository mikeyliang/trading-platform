import { useEffect, useState } from "react";
import type { ISeriesApi, SeriesMarker, Time, UTCTimestamp } from "lightweight-charts";
import { api, type TradeMarker } from "@/lib/api";
import { CHART } from "@/lib/chartTheme";

// Draws the user's own fills (logged from IBKR into trade_history) as
// arrow markers on the price pane: BUY = green arrow-up below the bar,
// SELL = red arrow-down above it, labelled with qty @ price (and the
// option contract when the fill was an option). Answers "where did I
// actually trade?" directly on the chart instead of in a separate table.

interface Args {
  candleSeries: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  symbol: string;
  /** Loaded chart bars — markers snap to the bar containing the fill, since
   *  lightweight-charts only renders markers on times present in the series. */
  bars: { time: number }[] | null;
  enabled: boolean;
}

export function useTradeMarkersOverlay({ candleSeries, symbol, bars, enabled }: Args) {
  const [trades, setTrades] = useState<TradeMarker[]>([]);
  const [visibleCount, setVisibleCount] = useState(0);

  // Fetch fills for the symbol. 365d window — the chart itself limits what's
  // visible; fills before the loaded bar range are dropped at render time.
  useEffect(() => {
    if (!enabled) {
      setTrades([]);
      return;
    }
    let cancelled = false;
    api
      .tradeMarkers(symbol, 365)
      .then((r) => {
        if (!cancelled) setTrades(r.trades);
      })
      .catch(() => {
        if (!cancelled) setTrades([]);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, enabled]);

  useEffect(() => {
    const series = candleSeries.current;
    if (!series) return;
    if (!enabled || trades.length === 0 || !bars || bars.length === 0) {
      try {
        series.setMarkers([]);
      } catch {
        // series disposed; ignore
      }
      setVisibleCount(0);
      return;
    }

    const times = bars.map((b) => b.time);
    const markers: SeriesMarker<Time>[] = [];
    for (const t of trades) {
      const snapped = snapToBar(times, t.time);
      if (snapped == null) continue; // fill predates the loaded bars
      const buy = t.side === "BUY";
      markers.push({
        time: snapped as UTCTimestamp,
        position: buy ? "belowBar" : "aboveBar",
        shape: buy ? "arrowUp" : "arrowDown",
        color: buy ? CHART.candle.up : CHART.candle.down,
        size: 1,
        text: markerText(t),
      });
    }
    // setMarkers requires ascending time order; equal times keep insert order.
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    try {
      series.setMarkers(markers);
    } catch {
      // series disposed mid-update; ignore
    }
    setVisibleCount(markers.length);

    return () => {
      try {
        series.setMarkers([]);
      } catch {
        // ignore
      }
    };
  }, [candleSeries, trades, bars, enabled]);

  return { trades, visibleCount };
}

/** Greatest bar time ≤ t (binary search); null when t predates all bars. */
function snapToBar(times: number[], t: number): number | null {
  if (times.length === 0 || t < times[0]) return null;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return times[lo];
}

function markerText(t: TradeMarker): string {
  const side = t.side === "BUY" ? "B" : "S";
  const qty = t.quantity != null ? fmtQty(t.quantity) : "";
  const px = t.price != null ? `@${t.price >= 100 ? t.price.toFixed(0) : t.price.toFixed(2)}` : "";
  if (t.is_option && t.strike != null && t.right) {
    return `${side} ${qty}×${fmtQty(t.strike)}${t.right} ${px}`.trim();
  }
  return `${side} ${qty} ${px}`.trim();
}

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
