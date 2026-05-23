"use client";

import {
  ColorType,
  CrosshairMode,
  IChartApi,
  LineStyle,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import { fmtCurrency, fmtPct } from "@/lib/utils";

interface Point {
  time: number;
  value: number;
}

interface Props {
  equity: Point[];
  initialCapital: number;
  height?: number;
  ddHeight?: number;
}

// Equity-curve area chart with a synchronized drawdown subpane underneath.
// The drawdown series is computed from the running peak so the chart works
// for any equity_curve payload — server doesn't have to send it pre-computed.
export function EquityCurveChart({
  equity,
  initialCapital,
  height = 240,
  ddHeight = 100,
}: Props) {
  const eqRef = useRef<HTMLDivElement>(null);
  const ddRef = useRef<HTMLDivElement>(null);

  const drawdown = useMemo(() => {
    let peak = -Infinity;
    return equity.map((p) => {
      if (p.value > peak) peak = p.value;
      const ddPct = peak > 0 ? ((p.value - peak) / peak) * 100 : 0;
      return { time: p.time, value: ddPct };
    });
  }, [equity]);

  const stats = useMemo(() => {
    if (!equity.length) return null;
    const first = equity[0].value;
    const last = equity[equity.length - 1].value;
    const positive = last >= first;
    const maxDd = drawdown.reduce((acc, d) => (d.value < acc ? d.value : acc), 0);
    return { positive, last, first, maxDd };
  }, [equity, drawdown]);

  useEffect(() => {
    const eqEl = eqRef.current;
    const ddEl = ddRef.current;
    if (!eqEl || !ddEl || !equity.length) return;

    const baseLayout = {
      background: { type: ColorType.Solid, color: "#0a0a0a" },
      textColor: "#71717a",
      fontSize: 10,
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
    };
    const grid = { vertLines: { color: "#161616" }, horzLines: { color: "#161616" } };
    const crosshair = {
      mode: CrosshairMode.Normal,
      vertLine: { color: "#3c3c3c", style: LineStyle.Dashed, width: 1 as 1 },
      horzLine: { color: "#3c3c3c", style: LineStyle.Dashed, width: 1 as 1 },
    };

    const eqChart: IChartApi = createChart(eqEl, {
      width: eqEl.clientWidth,
      height,
      layout: baseLayout,
      grid,
      crosshair,
      rightPriceScale: { borderColor: "#1f1f1f" },
      timeScale: { borderColor: "#1f1f1f", timeVisible: true, secondsVisible: false },
    });
    const positive = stats?.positive ?? true;
    const eqSeries = eqChart.addAreaSeries({
      lineColor: positive ? "#22c55e" : "#ef4444",
      topColor: positive ? "rgba(34,197,94,0.20)" : "rgba(239,68,68,0.20)",
      bottomColor: "rgba(0,0,0,0)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    eqSeries.setData(
      equity.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
    );
    eqSeries.createPriceLine({
      price: initialCapital,
      color: "#3c3c3c",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "start",
    });

    const ddChart: IChartApi = createChart(ddEl, {
      width: ddEl.clientWidth,
      height: ddHeight,
      layout: baseLayout,
      grid,
      crosshair,
      rightPriceScale: {
        borderColor: "#1f1f1f",
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
      timeScale: { borderColor: "#1f1f1f", timeVisible: true, secondsVisible: false },
    });
    const ddSeries = ddChart.addAreaSeries({
      lineColor: "#ef4444",
      topColor: "rgba(239,68,68,0.05)",
      bottomColor: "rgba(239,68,68,0.35)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      invertFilledArea: true,
    });
    ddSeries.setData(
      drawdown.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
    );
    ddSeries.createPriceLine({
      price: 0,
      color: "#3c3c3c",
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: false,
    });

    eqChart.timeScale().fitContent();
    ddChart.timeScale().fitContent();

    let syncing = false;
    const sync = (src: IChartApi, dst: IChartApi) => (range: any) => {
      if (!range || syncing) return;
      syncing = true;
      dst.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    };
    eqChart.timeScale().subscribeVisibleLogicalRangeChange(sync(eqChart, ddChart));
    ddChart.timeScale().subscribeVisibleLogicalRangeChange(sync(ddChart, eqChart));

    const ro = new ResizeObserver(() => {
      eqChart.applyOptions({ width: eqEl.clientWidth });
      ddChart.applyOptions({ width: ddEl.clientWidth });
    });
    ro.observe(eqEl);
    ro.observe(ddEl);

    return () => {
      ro.disconnect();
      eqChart.remove();
      ddChart.remove();
    };
  }, [equity, drawdown, initialCapital, height, ddHeight, stats?.positive]);

  if (!equity.length) {
    return (
      <div className="text-[11px] text-text-muted text-center py-8">
        No equity data
      </div>
    );
  }

  const retPct = stats ? ((stats.last - stats.first) / stats.first) * 100 : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="border border-border rounded-md overflow-hidden bg-bg">
        <div className="flex items-center gap-3 px-3 h-6 border-b border-border/60">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            Equity
          </span>
          <span className="text-[10px] tabular text-text-muted">
            {fmtCurrency(stats?.first ?? 0)} → {fmtCurrency(stats?.last ?? 0)}
          </span>
          <span
            className={`ml-auto text-[10px] tabular ${
              retPct >= 0 ? "text-up" : "text-down"
            }`}
          >
            {fmtPct(retPct)}
          </span>
        </div>
        <div ref={eqRef} style={{ height }} className="w-full" />
      </div>

      <div className="border border-border rounded-md overflow-hidden bg-bg">
        <div className="flex items-center gap-3 px-3 h-6 border-b border-border/60">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            Drawdown
          </span>
          <span className="ml-auto text-[10px] tabular text-down">
            max {stats ? fmtPct(stats.maxDd) : "—"}
          </span>
        </div>
        <div ref={ddRef} style={{ height: ddHeight }} className="w-full" />
      </div>
    </div>
  );
}
