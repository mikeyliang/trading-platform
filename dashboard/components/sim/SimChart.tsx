"use client";

import {
  IChartApi,
  LineStyle,
  LogicalRange,
  SeriesMarker,
  Time,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SimChartPayload } from "@/lib/api";
import { cn } from "@/lib/utils";
import { COLORS, baseChartOptions } from "./chartTheme";

type PaneKey = "smi" | "rsi" | "macd" | "stoch" | "score";

const PANES: { key: PaneKey; label: string }[] = [
  { key: "smi", label: "SMI" },
  { key: "rsi", label: "RSI" },
  { key: "macd", label: "MACD" },
  { key: "stoch", label: "STOCH" },
  { key: "score", label: "SCORE" },
];

const OVERLAYS = [
  { key: "vwap", label: "VWAP", color: COLORS.amber },
  { key: "ema_fast", label: "EMA9", color: COLORS.blue },
  { key: "ema_slow", label: "EMA21", color: COLORS.purple },
  { key: "ema_trend", label: "EMA50", color: COLORS.pink },
] as const;

interface Props {
  payload: SimChartPayload;
}

/** Price chart + toggleable synced indicator panes + trade/structure markers. */
export function SimChart({ payload }: Props) {
  const priceRef = useRef<HTMLDivElement>(null);
  const paneRefs = {
    smi: useRef<HTMLDivElement>(null),
    rsi: useRef<HTMLDivElement>(null),
    macd: useRef<HTMLDivElement>(null),
    stoch: useRef<HTMLDivElement>(null),
    score: useRef<HTMLDivElement>(null),
  };
  const [activePanes, setActivePanes] = useState<PaneKey[]>(["smi", "macd"]);
  const [overlaysOn, setOverlaysOn] = useState<string[]>(["vwap", "ema_fast", "ema_slow"]);
  const [showStructure, setShowStructure] = useState(true);

  const times = useMemo(
    () => payload.chart.candles.map((c) => c.time as UTCTimestamp),
    [payload]
  );

  useEffect(() => {
    const priceEl = priceRef.current;
    if (!priceEl) return;
    const { chart } = payload;
    const charts: IChartApi[] = [];

    // ── price pane ──
    const priceChart = createChart(priceEl, baseChartOptions(priceEl));
    charts.push(priceChart);
    const candles = priceChart.addCandlestickSeries({
      upColor: COLORS.up, downColor: COLORS.down,
      borderUpColor: COLORS.up, borderDownColor: COLORS.down,
      wickUpColor: COLORS.up, wickDownColor: COLORS.down,
      priceLineColor: COLORS.slate, priceLineStyle: LineStyle.Dotted,
    });
    candles.setData(chart.candles.map((c) => ({
      time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close,
    })));

    const lineData = (vals: (number | null)[]) =>
      vals.flatMap((v, i) => (v == null ? [] : [{ time: times[i], value: v }]));

    for (const ov of OVERLAYS) {
      if (!overlaysOn.includes(ov.key)) continue;
      const s = priceChart.addLineSeries({
        color: ov.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      });
      s.setData(lineData(chart.overlays[ov.key]));
    }

    // volume profile levels on the price scale
    const vp = chart.volume_profile;
    for (const [price, title, color] of [
      [vp.poc, "POC", COLORS.amber],
      [vp.vah, "VAH", COLORS.slate],
      [vp.val, "VAL", COLORS.slate],
    ] as const) {
      candles.createPriceLine({
        price, color, lineWidth: 1, lineStyle: LineStyle.Dotted,
        axisLabelVisible: true, title,
      });
    }

    // ── markers: trades + structure ──
    const markers: SeriesMarker<Time>[] = [];
    for (const m of chart.markers) {
      if (m.type !== "entry") continue; // exits come from the trade log below
      markers.push({
        time: m.time as UTCTimestamp,
        position: m.side === "long" ? "belowBar" : "aboveBar",
        color: m.side === "long" ? COLORS.upBright : COLORS.downBright,
        shape: m.side === "long" ? "arrowUp" : "arrowDown",
        text: String(m.score ?? ""),
        size: 1,
      });
    }
    // exits from the trade log (also covers stop/target fills the signal
    // markers miss); ▼ colored by trade P&L, snapped to the nearest bar
    const snap = (ts: number) => {
      let lo = 0;
      let hi = times.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid] <= ts) lo = mid;
        else hi = mid - 1;
      }
      return times[lo];
    };
    for (const t of payload.trades) {
      if (!t.exit_time || t.pnl == null) continue;
      markers.push({
        time: snap(Math.floor(Date.parse(t.exit_time) / 1000)) as UTCTimestamp,
        position: "aboveBar",
        color: t.pnl >= 0 ? COLORS.upBright : COLORS.downBright,
        shape: "arrowDown",
        text: t.pnl_pct != null ? `${t.pnl_pct >= 0 ? "+" : ""}${t.pnl_pct.toFixed(1)}%` : "",
        size: 1,
      });
    }
    if (showStructure) {
      for (const ev of chart.structure.choch) {
        markers.push({
          time: ev.time as UTCTimestamp,
          position: ev.dir === 1 ? "belowBar" : "aboveBar",
          color: ev.dir === 1 ? COLORS.cyan : COLORS.pink,
          shape: "circle",
          size: 0,
        });
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    candles.setMarkers(markers);
    priceChart.timeScale().fitContent();

    // ── indicator panes ──
    const mk = (el: HTMLDivElement) => {
      const c = createChart(el, baseChartOptions(el));
      charts.push(c);
      return c;
    };

    if (activePanes.includes("smi") && paneRefs.smi.current) {
      const c = mk(paneRefs.smi.current);
      const l = c.addLineSeries({ color: COLORS.blue, lineWidth: 1, priceLineVisible: false });
      l.setData(lineData(chart.panes.smi));
      const sg = c.addLineSeries({ color: COLORS.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      sg.setData(lineData(chart.panes.smi_signal));
      for (const [p, t] of [[40, "OB"], [-40, "OS"]] as const) {
        l.createPriceLine({ price: p, color: p > 0 ? COLORS.downBright : COLORS.upBright, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: t });
      }
    }
    if (activePanes.includes("rsi") && paneRefs.rsi.current) {
      const c = mk(paneRefs.rsi.current);
      const l = c.addLineSeries({ color: COLORS.purple, lineWidth: 1, priceLineVisible: false });
      l.setData(lineData(chart.panes.rsi));
      for (const [p, t] of [[70, "70"], [50, ""], [30, "30"]] as const) {
        l.createPriceLine({ price: p, color: COLORS.slate, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: !!t, title: t });
      }
    }
    if (activePanes.includes("macd") && paneRefs.macd.current) {
      const c = mk(paneRefs.macd.current);
      const hist = c.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      hist.setData(chart.panes.macd_hist.flatMap((v, i) =>
        v == null ? [] : [{ time: times[i], value: v, color: v >= 0 ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)" }]
      ));
      const l = c.addLineSeries({ color: COLORS.blue, lineWidth: 1, priceLineVisible: false });
      l.setData(lineData(chart.panes.macd));
      const sg = c.addLineSeries({ color: COLORS.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      sg.setData(lineData(chart.panes.macd_signal));
    }
    if (activePanes.includes("stoch") && paneRefs.stoch.current) {
      const c = mk(paneRefs.stoch.current);
      const k = c.addLineSeries({ color: COLORS.cyan, lineWidth: 1, priceLineVisible: false });
      k.setData(lineData(chart.panes.stoch_k));
      const d = c.addLineSeries({ color: COLORS.pink, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      d.setData(lineData(chart.panes.stoch_d));
      for (const [p, t] of [[80, "80"], [20, "20"]] as const) {
        k.createPriceLine({ price: p, color: COLORS.slate, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: t });
      }
    }
    if (activePanes.includes("score") && paneRefs.score.current) {
      const c = mk(paneRefs.score.current);
      const ls = c.addHistogramSeries({ priceLineVisible: false, lastValueVisible: true });
      ls.setData(chart.panes.long_score.flatMap((v, i) =>
        v == null ? [] : [{ time: times[i], value: v, color: v >= 5 ? "rgba(34,197,94,0.7)" : "rgba(113,113,122,0.4)" }]
      ));
    }

    // ── time-scale sync across all panes ──
    let syncing = false;
    const subs = charts.map((c) => {
      const handler = (range: LogicalRange | null) => {
        if (!range || syncing) return;
        syncing = true;
        charts.forEach((other) => {
          if (other !== c) other.timeScale().setVisibleLogicalRange(range);
        });
        syncing = false;
      };
      c.timeScale().subscribeVisibleLogicalRangeChange(handler);
      return { c, handler };
    });

    const ro = new ResizeObserver(() => {
      charts.forEach((c, i) => {
        const el = i === 0 ? priceEl : null;
        if (el) c.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      });
      for (const p of PANES) {
        const el = paneRefs[p.key].current;
        if (el && activePanes.includes(p.key)) {
          const idx = activePanes.indexOf(p.key) + 1;
          charts[idx]?.applyOptions({ width: el.clientWidth, height: el.clientHeight });
        }
      }
    });
    ro.observe(priceEl);
    PANES.forEach((p) => paneRefs[p.key].current && ro.observe(paneRefs[p.key].current!));

    return () => {
      ro.disconnect();
      subs.forEach(({ c, handler }) => c.timeScale().unsubscribeVisibleLogicalRangeChange(handler));
      charts.forEach((c) => c.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, activePanes, overlaysOn, showStructure, times]);

  const togglePane = (k: PaneKey) =>
    setActivePanes((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const toggleOverlay = (k: string) =>
    setOverlaysOn((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-1 flex-wrap">
        <div className="flex items-center gap-1">
          {OVERLAYS.map((ov) => (
            <Toggle key={ov.key} on={overlaysOn.includes(ov.key)} onClick={() => toggleOverlay(ov.key)} swatch={ov.color}>
              {ov.label}
            </Toggle>
          ))}
          <Toggle on={showStructure} onClick={() => setShowStructure((v) => !v)} swatch={COLORS.cyan}>
            CHoCH
          </Toggle>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {PANES.map((p) => (
            <Toggle key={p.key} on={activePanes.includes(p.key)} onClick={() => togglePane(p.key)}>
              {p.label}
            </Toggle>
          ))}
        </div>
      </div>

      <div ref={priceRef} className="w-full h-80 bg-bg border border-border rounded-md overflow-hidden" />

      <div className="flex items-center gap-3 px-1 text-[9px] text-text-muted tabular">
        <span><span className="text-up">▲</span> entry · score 0–7</span>
        <span><span className="text-up">▼</span><span className="text-down">▼</span> exit ± P&L</span>
        {showStructure && <span><span style={{ color: COLORS.cyan }}>●</span> CHoCH</span>}
        <span className="ml-auto">dotted lines: POC / VAH / VAL</span>
      </div>

      {PANES.filter((p) => activePanes.includes(p.key)).map((p) => (
        <div key={p.key} className="border border-border rounded-md overflow-hidden bg-bg">
          <div className="flex items-center px-2 h-5 border-b border-border/60">
            <span className="text-[9px] uppercase tracking-wider text-text-muted">{p.label}</span>
          </div>
          <div ref={paneRefs[p.key]} className="w-full h-24" />
        </div>
      ))}
    </div>
  );
}

function Toggle({ on, onClick, swatch, children }: {
  on: boolean; onClick: () => void; swatch?: string; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-1.5 h-5 rounded text-[10px] uppercase tracking-wider transition-colors flex items-center gap-1",
        on ? "bg-surface-3 text-text-primary" : "text-text-muted hover:text-text-secondary"
      )}
    >
      {swatch && <span className="w-1.5 h-1.5 rounded-full" style={{ background: on ? swatch : "#3f3f46" }} />}
      {children}
    </button>
  );
}
