import { useEffect } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import type { RuleOneHistoryCycle } from "@/lib/api";

// Draws short horizontal segments at past cycles' short strikes, one per
// (expiry, strategy). The segment spans the trade window (~25 DTE) so
// you can scan back across the chart and see, at a glance, the strike
// each strategy landed on each month.
//
// Why SVG instead of lightweight-charts price lines: price lines go full
// chart width. We want segments — bounded to the cycle's calendar window
// — so the chart doesn't turn into spaghetti.

interface Args {
  chart: React.RefObject<IChartApi | null>;
  candleSeries: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  container: React.RefObject<HTMLDivElement | null>;
  cycles: RuleOneHistoryCycle[];
  enabled: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const STRATEGY_COLORS: Record<RuleOneHistoryCycle["strategy_id"], string> = {
  rut: "#3b82f6",      // blue
  mars: "#a78bfa",     // violet
  marsmax: "#f97316",  // orange
  space: "#22d3ee",    // cyan
};

const STRATEGY_LABELS: Record<RuleOneHistoryCycle["strategy_id"], string> = {
  rut: "TRAD",
  mars: "MARS",
  marsmax: "MAX",
  space: "SPACE",
};

// How wide the segment is, in trading days, measured back from the expiry.
const CYCLE_WINDOW_DAYS = 25;

export function useHistoricalStrikesOverlay({
  chart,
  candleSeries,
  container,
  cycles,
  enabled,
}: Args) {
  useEffect(() => {
    if (!enabled) return;
    const c = chart.current;
    const series = candleSeries.current;
    const el = container.current;
    if (!c || !series || !el || cycles.length === 0) return;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute(
      "style",
      "position:absolute;inset:0;pointer-events:none;z-index:5;overflow:visible;"
    );
    svg.classList.add("hist-strikes-overlay");
    el.appendChild(svg);

    // Pre-compute the segment timestamps for each cycle (entry → expiry).
    const segments = cycles
      .map((cy) => {
        const expiryTs = parseYYYYMMDD(cy.expiry);
        if (expiryTs == null) return null;
        const entryTs = expiryTs - CYCLE_WINDOW_DAYS * 86_400;
        return { cy, entryTs, expiryTs };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const render = () => {
      const range = c.timeScale().getVisibleRange();
      const W = el.clientWidth;
      const H = el.clientHeight;
      svg.setAttribute("width", String(W));
      svg.setAttribute("height", String(H));
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      if (!range) return;

      const from = typeof range.from === "number" ? range.from : NaN;
      const to = typeof range.to === "number" ? range.to : NaN;
      if (!isFinite(from) || !isFinite(to)) return;

      const ts = c.timeScale();
      for (const { cy, entryTs, expiryTs } of segments) {
        if (expiryTs < from || entryTs > to) continue;
        const x1 = ts.timeToCoordinate(entryTs as UTCTimestamp);
        const x2 = ts.timeToCoordinate(expiryTs as UTCTimestamp);
        const y = series.priceToCoordinate(cy.short_strike);
        if (x1 == null || x2 == null || y == null) continue;

        const color = STRATEGY_COLORS[cy.strategy_id];
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(x1));
        line.setAttribute("x2", String(x2));
        line.setAttribute("y1", String(y));
        line.setAttribute("y2", String(y));
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-opacity", "0.55");
        line.setAttribute("stroke-width", "1.5");
        svg.appendChild(line);

        // Small label at the right end (over the expiry day) for context.
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(x2 + 3));
        label.setAttribute("y", String(y - 2));
        label.setAttribute("fill", color);
        label.setAttribute("fill-opacity", "0.85");
        label.setAttribute("font-size", "9");
        label.setAttribute(
          "font-family",
          "ui-monospace, SFMono-Regular, monospace"
        );
        label.textContent = `${STRATEGY_LABELS[cy.strategy_id]} ${Math.round(cy.short_strike)}`;
        svg.appendChild(label);
      }
    };

    render();
    const unsubTime = c.timeScale().subscribeVisibleTimeRangeChange(render);
    const ro = new ResizeObserver(render);
    ro.observe(el);

    return () => {
      try {
        unsubTime?.();
      } catch {}
      ro.disconnect();
      if (svg.parentNode) svg.parentNode.removeChild(svg);
    };
  }, [chart, candleSeries, container, cycles, enabled]);
}

function parseYYYYMMDD(s: string): number | null {
  if (s.length !== 8) return null;
  const y = +s.slice(0, 4);
  const m = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  if (!y || !m || !d) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}
