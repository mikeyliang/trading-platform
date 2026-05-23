import { useEffect } from "react";
import type { IChartApi, UTCTimestamp } from "lightweight-charts";

// Symbols where standard monthly options expire on the 3rd Friday (US listed).
// For these the overlay defaults ON; for others it's still available but off.
export const MONTHLY_OPEX_SYMBOLS = new Set([
  "RUT",
  "SPY",
  "SPX",
  "IWM",
  "QQQ",
  "NDX",
  "DIA",
]);

interface Args {
  chart: React.RefObject<IChartApi | null>;
  container: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function useMonthlyExpiryOverlay({ chart, container, enabled }: Args) {
  useEffect(() => {
    if (!enabled) return;
    const c = chart.current;
    const el = container.current;
    if (!c || !el) return;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute(
      "style",
      "position:absolute;inset:0;pointer-events:none;z-index:6;overflow:visible;"
    );
    svg.classList.add("opex-overlay");
    el.appendChild(svg);

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

      const expiries = thirdFridaysBetween(from, to);
      const ts = c.timeScale();
      for (const t of expiries) {
        const x = ts.timeToCoordinate(t as UTCTimestamp);
        if (x == null) continue;
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(x));
        line.setAttribute("x2", String(x));
        line.setAttribute("y1", "0");
        line.setAttribute("y2", String(H));
        line.setAttribute("stroke", "#f59e0b");
        line.setAttribute("stroke-opacity", "0.55");
        line.setAttribute("stroke-dasharray", "2 4");
        line.setAttribute("stroke-width", "1");
        svg.appendChild(line);

        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(x + 3));
        label.setAttribute("y", "11");
        label.setAttribute("fill", "#f59e0b");
        label.setAttribute("fill-opacity", "0.85");
        label.setAttribute("font-size", "9");
        label.setAttribute(
          "font-family",
          "ui-monospace, SFMono-Regular, monospace"
        );
        label.setAttribute("font-weight", "500");
        label.textContent = monthLabel(t);
        svg.appendChild(label);
      }
    };

    render();
    c.timeScale().subscribeVisibleTimeRangeChange(render);
    const ro = new ResizeObserver(render);
    ro.observe(el);

    return () => {
      try {
        c.timeScale().unsubscribeVisibleTimeRangeChange(render);
      } catch {
        // chart already disposed
      }
      ro.disconnect();
      if (svg.parentNode) svg.parentNode.removeChild(svg);
    };
  }, [chart, container, enabled]);
}

function thirdFridaysBetween(fromTs: number, toTs: number): number[] {
  // Inputs are UTCTimestamps (seconds since epoch).
  const out: number[] = [];
  const start = new Date(fromTs * 1000);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  // Step back one month so we don't miss a line near the left edge.
  m -= 1;
  if (m < 0) {
    m = 11;
    y -= 1;
  }
  // Bound the loop to avoid runaway iteration; ~10 years of months is plenty.
  for (let i = 0; i < 130; i++) {
    const ts = thirdFridayUTC(y, m);
    if (ts > toTs) break;
    if (ts >= fromTs) out.push(ts);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

function thirdFridayUTC(year: number, month0: number): number {
  // month0: 0=Jan .. 11=Dec
  const first = new Date(Date.UTC(year, month0, 1));
  const dow = first.getUTCDay(); // 0=Sun .. 5=Fri .. 6=Sat
  const offset = (5 - dow + 7) % 7; // days to first Friday
  const day = 1 + offset + 14; // 3rd Friday
  return Math.floor(Date.UTC(year, month0, day) / 1000);
}

function monthLabel(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d
    .toLocaleString("en-US", { month: "short", timeZone: "UTC" })
    .toUpperCase();
}
