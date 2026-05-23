import { useEffect, useRef } from "react";
import type { IPriceLine, ISeriesApi } from "lightweight-charts";
import { LineStyle } from "lightweight-charts";
import type { Bar } from "@/types";

// Standard Fibonacci retracement levels. In Rule One lingo each level is a
// "floor"; the trade rule is "short strike at least 2 floors below money".
const FIB_LEVELS: { ratio: number; label: string }[] = [
  { ratio: 0.0, label: "0  floor" },
  { ratio: 0.236, label: "23.6" },
  { ratio: 0.382, label: "38.2" },
  { ratio: 0.5, label: "50" },
  { ratio: 0.618, label: "61.8" },
  { ratio: 0.786, label: "78.6" },
  { ratio: 1.0, label: "100  ceiling" },
];

/** Lookback window for the fib high/low calc. ``"all"`` uses every loaded
 * bar; numeric values are calendar days. Jamal teaches 6-12 month windows,
 * so 9m is a reasonable default. */
export type FibRange = "3m" | "6m" | "9m" | "12m" | "all";

const RANGE_DAYS: Record<Exclude<FibRange, "all">, number> = {
  "3m": 90, "6m": 180, "9m": 270, "12m": 365,
};

interface Args {
  candleSeries: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  bars: Bar[] | null;
  spot: number | null;
  enabled: boolean;
  // Per-strategy hint: when `floorRequired` is true the "2↓ short" line is
  // rendered as a hard target (solid green); when false it's drawn as a soft
  // guide (amber dashed) — matches the RUT vs Mars/MarsMax/Space rule.
  floorRequired?: boolean;
  // Label suffix for the target line (e.g. "rut", "mars", "space").
  strategyLabel?: string;
  // Lookback range — defaults to 9 months (Jamal's middle of the 6-12mo zone).
  range?: FibRange;
}

export function useFibLevelsOverlay({
  candleSeries,
  bars,
  spot,
  enabled,
  floorRequired = true,
  strategyLabel,
  range = "9m",
}: Args) {
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    const series = candleSeries.current;
    if (!series) return;

    // clear any previous lines
    for (const ln of linesRef.current) {
      try {
        series.removePriceLine(ln);
      } catch {}
    }
    linesRef.current = [];

    if (!enabled || !bars || bars.length === 0) return;

    // Slice bars by calendar days from the latest bar — works across any
    // timeframe (daily, 4h, 1h, 15m, etc.) without needing to know bars/day.
    let slice: Bar[];
    if (range === "all") {
      slice = bars;
    } else {
      const lookbackSec = RANGE_DAYS[range] * 86400;
      const latestT = bars[bars.length - 1].time;
      const cutoff = latestT - lookbackSec;
      let startIdx = 0;
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].time < cutoff) {
          startIdx = i + 1;
          break;
        }
      }
      slice = bars.slice(startIdx);
      // If the slice is too thin (intraday timeframe with not enough history)
      // fall back to last 2/3 of loaded bars so we still draw something useful.
      if (slice.length < 20 && bars.length >= 30) {
        slice = bars.slice(Math.max(0, bars.length - Math.floor(bars.length * 0.67)));
      }
    }

    let hi = -Infinity;
    let lo = Infinity;
    for (const b of slice) {
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
    }
    if (!isFinite(hi) || !isFinite(lo) || hi <= lo) return;

    const priceRange = hi - lo;
    // Identify the "money" band: the floor immediately at-or-below spot.
    // Short strike rule: ≤ 2 floors below money.
    const levels = FIB_LEVELS.map((f) => ({ ...f, price: lo + f.ratio * priceRange }));

    let moneyIdx = -1;
    if (spot != null) {
      for (let i = levels.length - 1; i >= 0; i--) {
        if (levels[i].price <= spot) {
          moneyIdx = i;
          break;
        }
      }
    }
    const targetIdx = moneyIdx >= 2 ? moneyIdx - 2 : -1;

    const targetColor = floorRequired ? "#22c55e" : "#f59e0b";
    const targetStyle = floorRequired ? LineStyle.Solid : LineStyle.Dashed;
    const targetWidth = floorRequired ? 2 : 1;
    const targetSuffix = floorRequired ? "2↓ short" : "2↓ soft";

    for (let i = 0; i < levels.length; i++) {
      const lvl = levels[i];
      const isTarget = i === targetIdx;
      const isMoney = i === moneyIdx;
      const labelSuffix = isTarget
        ? strategyLabel
          ? `${targetSuffix} · ${strategyLabel}`
          : targetSuffix
        : isMoney
        ? "money"
        : null;
      const line = series.createPriceLine({
        price: lvl.price,
        color: isTarget ? targetColor : isMoney ? "#3b82f6" : "#52525b",
        lineWidth: (isTarget ? targetWidth : 1) as 1 | 2,
        lineStyle: isTarget ? targetStyle : LineStyle.Dashed,
        axisLabelVisible: true,
        title: labelSuffix ? `${lvl.label} · ${labelSuffix}` : lvl.label,
      });
      linesRef.current.push(line);
    }

    return () => {
      for (const ln of linesRef.current) {
        try {
          series.removePriceLine(ln);
        } catch {}
      }
      linesRef.current = [];
    };
  }, [candleSeries, bars, spot, enabled, floorRequired, strategyLabel, range]);
}
