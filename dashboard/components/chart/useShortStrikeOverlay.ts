import { useEffect, useRef } from "react";
import type { ISeriesApi, IPriceLine, LineStyle } from "lightweight-charts";
import type { RuleOneCandidate } from "@/lib/api";

// Draws one horizontal price line per Rule One strategy at its **short strike**.
// All three RUT strategies (TRAD/MARS/MAX) typically sit on the same chain +
// expiry; what differs is the strike. The short strike is the one that
// matters — it's the breakeven anchor and where the exit-delta trigger fires.

interface Args {
  candleSeries: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  candidates: RuleOneCandidate[];
  enabled: boolean;
}

const STRATEGY_COLORS: Record<RuleOneCandidate["strategy_id"], string> = {
  rut: "#3b82f6",      // blue — traditional, conservative
  mars: "#a78bfa",     // violet — more aggressive
  marsmax: "#f97316",  // orange — most aggressive
  space: "#22d3ee",    // cyan — SPX
};

const STRATEGY_LABELS: Record<RuleOneCandidate["strategy_id"], string> = {
  rut: "TRAD",
  mars: "MARS",
  marsmax: "MAX",
  space: "SPACE",
};

export function useShortStrikeOverlay({ candleSeries, candidates, enabled }: Args) {
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    const series = candleSeries.current;
    if (!series) return;

    // Tear down previous lines first — series.removePriceLine is the only
    // safe way; setData doesn't clear them.
    for (const ln of linesRef.current) {
      try {
        series.removePriceLine(ln);
      } catch {
        // series was disposed mid-clear; safe to ignore.
      }
    }
    linesRef.current = [];

    if (!enabled || candidates.length === 0) return;

    for (const c of candidates) {
      if (c.short_strike == null) continue;
      try {
        const line = series.createPriceLine({
          price: c.short_strike,
          color: STRATEGY_COLORS[c.strategy_id],
          lineWidth: 1,
          lineStyle: 2 as LineStyle,  // dashed
          axisLabelVisible: true,
          title: `${STRATEGY_LABELS[c.strategy_id]} ${Math.round(c.short_strike)}${c.side === "put" ? "P" : "C"}`,
        });
        linesRef.current.push(line);
      } catch {
        // series disposed between candidate iterations.
      }
    }

    return () => {
      for (const ln of linesRef.current) {
        try {
          series.removePriceLine(ln);
        } catch {
          // ignore
        }
      }
      linesRef.current = [];
    };
  }, [candleSeries, candidates, enabled]);
}
