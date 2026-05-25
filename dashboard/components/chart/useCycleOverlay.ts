import { useEffect } from "react";
import type { IChartApi, UTCTimestamp } from "lightweight-charts";

// Draws two vertical guide lines on the chart: today's Rule One cycle
// entry day and expiry day. Scoped to a single cycle — the broader
// monthly OPEX overlay (useMonthlyExpiryOverlay) is for the multi-year
// view. This one says "this is your trade window."

interface Args {
  chart: React.RefObject<IChartApi | null>;
  container: React.RefObject<HTMLDivElement | null>;
  entryDate: string | null;   // YYYY-MM-DD
  expiryDate: string | null;  // YYYY-MM-DD
  enabled: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function useCycleOverlay({ chart, container, entryDate, expiryDate, enabled }: Args) {
  useEffect(() => {
    if (!enabled) return;
    const c = chart.current;
    const el = container.current;
    if (!c || !el) return;
    if (!entryDate && !expiryDate) return;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute(
      "style",
      "position:absolute;inset:0;pointer-events:none;z-index:7;overflow:visible;"
    );
    svg.classList.add("cycle-overlay");
    el.appendChild(svg);

    const markers: { ts: number; label: string }[] = [];
    const entryTs = parseLocalISO(entryDate);
    const expiryTs = parseLocalISO(expiryDate);
    if (entryTs != null) markers.push({ ts: entryTs, label: "ENTER" });
    if (expiryTs != null) markers.push({ ts: expiryTs, label: "EXPIRE" });

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
      for (const m of markers) {
        if (m.ts < from || m.ts > to) continue;
        const x = ts.timeToCoordinate(m.ts as UTCTimestamp);
        if (x == null) continue;
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(x));
        line.setAttribute("x2", String(x));
        line.setAttribute("y1", "0");
        line.setAttribute("y2", String(H));
        line.setAttribute("stroke", "#f59e0b");
        line.setAttribute("stroke-opacity", "0.7");
        line.setAttribute("stroke-dasharray", "3 4");
        line.setAttribute("stroke-width", "1");
        svg.appendChild(line);

        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(x + 4));
        label.setAttribute("y", "11");
        label.setAttribute("fill", "#f59e0b");
        label.setAttribute("fill-opacity", "0.95");
        label.setAttribute("font-size", "9");
        label.setAttribute(
          "font-family",
          "ui-monospace, SFMono-Regular, monospace"
        );
        label.setAttribute("font-weight", "600");
        label.textContent = m.label;
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
  }, [chart, container, entryDate, expiryDate, enabled]);
}

function parseLocalISO(s: string | null): number | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  // Lightweight-charts uses UTC seconds for daily bars (midnight UTC),
  // so we anchor the line at the same instant.
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}
