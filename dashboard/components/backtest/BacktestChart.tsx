"use client";

import {
  ColorType,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  LineStyle,
  SeriesMarker,
  Time,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { BacktestResult, Bar } from "@/types";
import { cn } from "@/lib/utils";

const SMI_OB = 40;
const SMI_OS = -40;

interface Props {
  result: BacktestResult;
}

export function BacktestChart({ result }: Props) {
  const priceRef = useRef<HTMLDivElement>(null);
  const smiRef = useRef<HTMLDivElement>(null);
  const eqRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [showSmi, setShowSmi] = useState(true);
  const [showEma, setShowEma] = useState(true);

  useEffect(() => {
    const priceEl = priceRef.current;
    const smiEl = smiRef.current;
    const eqEl = eqRef.current;
    if (!priceEl || !eqEl) return;

    let priceChart: IChartApi | null = null;
    let smiChart: IChartApi | null = null;
    let eqChart: IChartApi | null = null;
    let cancelled = false;

    (async () => {
      setLoading(true);
      const daysBetween = Math.max(
        1,
        Math.ceil(
          (new Date(result.end_date).getTime() - new Date(result.start_date).getTime()) /
            86_400_000
        )
      );

      const barsResp = await api.bars(result.symbol, result.timeframe, daysBetween).catch(() => null);
      if (cancelled) return;
      const bars: Bar[] = barsResp?.bars ?? [];

      // --- price chart ---
      priceChart = createChart(priceEl, {
        width: priceEl.clientWidth,
        height: priceEl.clientHeight,
        layout: {
          background: { type: ColorType.Solid, color: "#0a0a0a" },
          textColor: "#71717a",
          fontSize: 10,
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
        },
        grid: {
          vertLines: { color: "#161616" },
          horzLines: { color: "#161616" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "#3c3c3c", style: LineStyle.Dashed, width: 1 as 1 },
          horzLine: { color: "#3c3c3c", style: LineStyle.Dashed, width: 1 as 1 },
        },
        rightPriceScale: { borderColor: "#1f1f1f" },
        timeScale: { borderColor: "#1f1f1f", timeVisible: true, secondsVisible: false },
      });

      const candles = priceChart.addCandlestickSeries({
        upColor: "#26a69a",
        downColor: "#ef5350",
        borderUpColor: "#26a69a",
        borderDownColor: "#ef5350",
        wickUpColor: "#26a69a",
        wickDownColor: "#ef5350",
        priceLineColor: "#3f3f46",
        priceLineStyle: LineStyle.Dotted,
      });
      candles.setData(
        bars.map((b) => ({
          time: b.time as UTCTimestamp,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        }))
      );

      // EMA overlay using fetched indicators (matches backtest defaults)
      if (showEma) {
        const ind = await api
          .indicators(result.symbol, result.timeframe, daysBetween)
          .catch(() => null);
        if (ind && priceChart) {
          const fast = priceChart.addLineSeries({
            color: "#60a5fa",
            lineWidth: 1 as 1,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          fast.setData(
            ind.ema_fast.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
          );
          const slow = priceChart.addLineSeries({
            color: "#a78bfa",
            lineWidth: 1 as 1,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          slow.setData(
            ind.ema_slow.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
          );
        }
      }

      // Trade markers — entry up arrow, exit down arrow with PnL
      const markers: SeriesMarker<Time>[] = [];
      for (const t of result.trades) {
        const entryTs = Math.floor(new Date(t.entry_time).getTime() / 1000);
        markers.push({
          time: entryTs as UTCTimestamp,
          position: "belowBar",
          color: "#22c55e",
          shape: "arrowUp",
          text: `B ${t.entry_price.toFixed(2)}`,
          size: 1,
        });
        if (t.exit_time && t.exit_price != null) {
          const exitTs = Math.floor(new Date(t.exit_time).getTime() / 1000);
          const positive = (t.pnl ?? 0) >= 0;
          markers.push({
            time: exitTs as UTCTimestamp,
            position: "aboveBar",
            color: positive ? "#22c55e" : "#ef4444",
            shape: "arrowDown",
            text: `S ${t.exit_price.toFixed(2)}${t.pnl != null ? ` (${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)})` : ""}`,
            size: 1,
          });
        }
      }
      candles.setMarkers(markers);
      priceChart.timeScale().fitContent();

      // --- SMI subpane ---
      if (showSmi && smiEl && result.smi_data && result.smi_data.length) {
        smiChart = createChart(smiEl, {
          width: smiEl.clientWidth,
          height: smiEl.clientHeight,
          layout: {
            background: { type: ColorType.Solid, color: "#0a0a0a" },
            textColor: "#71717a",
            fontSize: 10,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
          },
          grid: { vertLines: { color: "#161616" }, horzLines: { color: "#161616" } },
          crosshair: { mode: CrosshairMode.Normal },
          rightPriceScale: { borderColor: "#1f1f1f" },
          timeScale: { borderColor: "#1f1f1f", timeVisible: true, secondsVisible: false },
        });
        const smiLine = smiChart.addLineSeries({
          color: "#60a5fa",
          lineWidth: 1.5 as 1,
          priceLineVisible: false,
          lastValueVisible: true,
        });
        smiLine.setData(
          result.smi_data
            .filter((p) => p.smi != null)
            .map((p) => ({ time: p.time as UTCTimestamp, value: p.smi }))
        );
        const sigLine = smiChart.addLineSeries({
          color: "#f59e0b",
          lineWidth: 1 as 1,
          priceLineVisible: false,
          lastValueVisible: true,
        });
        sigLine.setData(
          result.smi_data
            .filter((p) => p.signal != null)
            .map((p) => ({ time: p.time as UTCTimestamp, value: p.signal }))
        );
        smiLine.createPriceLine({
          price: SMI_OB,
          color: "#ef4444",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "OB",
        });
        smiLine.createPriceLine({
          price: SMI_OS,
          color: "#22c55e",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "OS",
        });
        smiLine.createPriceLine({ price: 0, color: "#3c3c3c", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false });

        // sync time range between price and smi
        const onPrice = (range: any) => range && smiChart!.timeScale().setVisibleLogicalRange(range);
        const onSmi = (range: any) => range && priceChart!.timeScale().setVisibleLogicalRange(range);
        priceChart.timeScale().subscribeVisibleLogicalRangeChange(onPrice);
        smiChart.timeScale().subscribeVisibleLogicalRangeChange(onSmi);
      }

      // --- equity sparkline ---
      if (eqEl && result.equity_curve.length > 1) {
        eqChart = createChart(eqEl, {
          width: eqEl.clientWidth,
          height: eqEl.clientHeight,
          layout: {
            background: { type: ColorType.Solid, color: "#0a0a0a" },
            textColor: "#71717a",
            fontSize: 9,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
          },
          grid: { vertLines: { color: "#0f0f0f" }, horzLines: { color: "#0f0f0f" } },
          crosshair: { mode: CrosshairMode.Normal },
          rightPriceScale: { borderColor: "#1f1f1f" },
          timeScale: { borderColor: "#1f1f1f", timeVisible: false, secondsVisible: false },
          handleScroll: false,
          handleScale: false,
        });
        const eqLast = result.equity_curve[result.equity_curve.length - 1].value;
        const eqFirst = result.equity_curve[0].value;
        const positive = eqLast >= eqFirst;
        const area = eqChart.addAreaSeries({
          lineColor: positive ? "#22c55e" : "#ef4444",
          topColor: positive ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
          bottomColor: "rgba(0,0,0,0)",
          lineWidth: 2,
          priceLineVisible: false,
        });
        area.setData(
          result.equity_curve.map((d) => ({
            time: d.time as UTCTimestamp,
            value: d.value,
          }))
        );
        eqChart.timeScale().fitContent();
      }

      setLoading(false);
    })();

    const ro = new ResizeObserver(() => {
      if (priceChart) priceChart.applyOptions({ width: priceEl.clientWidth, height: priceEl.clientHeight });
      if (smiChart && smiEl) smiChart.applyOptions({ width: smiEl.clientWidth, height: smiEl.clientHeight });
      if (eqChart && eqEl) eqChart.applyOptions({ width: eqEl.clientWidth, height: eqEl.clientHeight });
    });
    ro.observe(priceEl);
    if (smiEl) ro.observe(smiEl);
    if (eqEl) ro.observe(eqEl);

    return () => {
      cancelled = true;
      ro.disconnect();
      priceChart?.remove();
      smiChart?.remove();
      eqChart?.remove();
    };
  }, [result, showSmi, showEma]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 px-1">
        <div className="text-[10px] uppercase tracking-wider text-text-muted">
          {result.symbol} · {result.timeframe} · {result.start_date} → {result.end_date}
        </div>
        <div className="ml-auto flex items-center gap-2 text-[10px]">
          <button
            onClick={() => setShowEma((v) => !v)}
            className={cn(
              "px-1.5 h-5 rounded transition-colors uppercase tracking-wider",
              showEma ? "bg-surface-3 text-text-primary" : "text-text-muted hover:text-text-secondary"
            )}
          >
            EMA
          </button>
          <button
            onClick={() => setShowSmi((v) => !v)}
            className={cn(
              "px-1.5 h-5 rounded transition-colors uppercase tracking-wider",
              showSmi ? "bg-surface-3 text-text-primary" : "text-text-muted hover:text-text-secondary"
            )}
          >
            SMI
          </button>
        </div>
      </div>

      <div ref={priceRef} className="w-full h-72 bg-bg border border-border rounded-md overflow-hidden" />

      {showSmi && (
        <div className="border border-border rounded-md overflow-hidden bg-bg">
          <div className="flex items-center gap-3 px-3 h-6 border-b border-border/60">
            <span className="text-[10px] uppercase tracking-wider text-text-muted">SMI</span>
            <div className="ml-auto flex items-center gap-3 text-[10px] tabular text-text-muted">
              <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-[#60a5fa]" /> smi</span>
              <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-[#f59e0b]" /> signal</span>
            </div>
          </div>
          <div ref={smiRef} className="w-full h-32" />
        </div>
      )}

      <div className="border border-border rounded-md overflow-hidden bg-bg">
        <div className="flex items-center gap-3 px-3 h-6 border-b border-border/60">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Equity</span>
          <span className="ml-auto text-[10px] tabular text-text-muted">
            ${result.initial_capital.toLocaleString()} → ${result.final_capital.toLocaleString()}
          </span>
        </div>
        <div ref={eqRef} className="w-full h-28" />
      </div>

      {loading && <div className="text-[10px] text-text-muted text-center">loading bars…</div>}
    </div>
  );
}
