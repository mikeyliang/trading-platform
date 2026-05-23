"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
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
import { api } from "@/lib/api";

interface IndicatorPoint {
  time: number;
  value: number;
}

interface IndicatorsResponse {
  smi: IndicatorPoint[];
  smi_signal: IndicatorPoint[];
  ema_fast: IndicatorPoint[];
  ema_slow: IndicatorPoint[];
}

export interface SmiSignal {
  time: number;
  type: "BUY" | "SELL";
  smi: number;
  price?: number;
}

export interface SmiSnapshot {
  smi: number | null;
  signal: number | null;
  zone: "overbought" | "oversold" | "neutral";
  cross: "bullish" | "bearish" | null;
  lastSignal: SmiSignal | null;
}

interface UseSmiOverlayOpts {
  mainChart: RefObject<IChartApi | null>;
  candleSeries: RefObject<ISeriesApi<"Candlestick"> | null>;
  subpaneContainer: RefObject<HTMLDivElement | null>;
  symbol: string;
  timeframe: string;
  days: number;
  enabled: boolean;
}

const SMI_OB = 40;
const SMI_OS = -40;

export function useSmiOverlay({
  mainChart,
  candleSeries,
  subpaneContainer,
  symbol,
  timeframe,
  days,
  enabled,
}: UseSmiOverlayOpts) {
  const subChartRef = useRef<IChartApi | null>(null);
  const smiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const sigSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const [snapshot, setSnapshot] = useState<SmiSnapshot | null>(null);

  // Build / tear down the subpane chart when `enabled` flips
  useEffect(() => {
    const el = subpaneContainer.current;
    if (!el) return;

    if (!enabled) {
      // tear down if it exists
      if (subChartRef.current) {
        subChartRef.current.remove();
        subChartRef.current = null;
        smiSeriesRef.current = null;
        sigSeriesRef.current = null;
      }
      candleSeries.current?.setMarkers([]);
      setSnapshot(null);
      return;
    }

    if (subChartRef.current) return; // already built

    const chart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
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
      rightPriceScale: {
        borderColor: "#1f1f1f",
      },
      timeScale: {
        borderColor: "#1f1f1f",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });
    subChartRef.current = chart;

    smiSeriesRef.current = chart.addLineSeries({
      color: "#60a5fa",
      lineWidth: 1.5 as 1,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "SMI",
    });
    sigSeriesRef.current = chart.addLineSeries({
      color: "#f59e0b",
      lineWidth: 1 as 1,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "Signal",
    });

    // reference lines for overbought/oversold and zero
    smiSeriesRef.current.createPriceLine({
      price: SMI_OB,
      color: "#ef4444",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "OB",
    });
    smiSeriesRef.current.createPriceLine({
      price: SMI_OS,
      color: "#22c55e",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "OS",
    });
    smiSeriesRef.current.createPriceLine({
      price: 0,
      color: "#3c3c3c",
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: false,
    });

    // sync timescale to main chart
    const main = mainChart.current;
    let unsubA: (() => void) | undefined;
    let unsubB: (() => void) | undefined;
    if (main) {
      const onMainRange = (range: any) => {
        if (range) chart.timeScale().setVisibleLogicalRange(range);
      };
      const onSubRange = (range: any) => {
        if (range) main.timeScale().setVisibleLogicalRange(range);
      };
      main.timeScale().subscribeVisibleLogicalRangeChange(onMainRange);
      chart.timeScale().subscribeVisibleLogicalRangeChange(onSubRange);
      unsubA = () => main.timeScale().unsubscribeVisibleLogicalRangeChange(onMainRange);
      unsubB = () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(onSubRange);
    }

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      unsubA?.();
      unsubB?.();
      if (subChartRef.current) {
        subChartRef.current.remove();
        subChartRef.current = null;
        smiSeriesRef.current = null;
        sigSeriesRef.current = null;
      }
    };
  }, [enabled, subpaneContainer, mainChart, candleSeries]);

  // Fetch data when symbol/timeframe changes (and overlay is on)
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    (async () => {
      const data = await api
        .indicators(symbol, timeframe, days)
        .catch(() => null as IndicatorsResponse | null);
      if (cancelled || !data) return;

      const smiSeries = smiSeriesRef.current;
      const sigSeries = sigSeriesRef.current;
      const candles = candleSeries.current;
      if (!smiSeries || !sigSeries || !candles) return;

      smiSeries.setData(
        data.smi.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
      );
      sigSeries.setData(
        data.smi_signal.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
      );

      // compute signal markers client-side using the same logic as smi.py
      const markers: SeriesMarker<Time>[] = [];
      const signals: SmiSignal[] = [];
      const smi = data.smi;
      const sig = data.smi_signal;
      const emaF = data.ema_fast;
      const emaS = data.ema_slow;
      const minLen = Math.min(smi.length, sig.length, emaF.length, emaS.length);

      for (let i = 1; i < minLen; i++) {
        const smiPrev = smi[i - 1].value;
        const smiNow = smi[i].value;
        const sigPrev = sig[i - 1].value;
        const sigNow = sig[i].value;
        const ef = emaF[i].value;
        const es = emaS[i].value;

        // BUY: bullish cross from below midpoint + uptrend filter
        if (smiPrev < sigPrev && smiNow >= sigNow && smiPrev < SMI_OB * 0.5 && ef > es) {
          markers.push({
            time: smi[i].time as UTCTimestamp,
            position: "belowBar",
            color: "#22c55e",
            shape: "arrowUp",
            text: "BUY",
            size: 1,
          });
          signals.push({ time: smi[i].time, type: "BUY", smi: smiNow });
        }
        // SELL: bearish cross from above midpoint
        else if (smiPrev > sigPrev && smiNow <= sigNow && smiPrev > SMI_OS * 0.5) {
          markers.push({
            time: smi[i].time as UTCTimestamp,
            position: "aboveBar",
            color: "#ef4444",
            shape: "arrowDown",
            text: "SELL",
            size: 1,
          });
          signals.push({ time: smi[i].time, type: "SELL", smi: smiNow });
        }
      }
      candles.setMarkers(markers);

      // build snapshot for the legend card
      const lastSmi = smi[smi.length - 1]?.value ?? null;
      const lastSig = sig[sig.length - 1]?.value ?? null;
      const lastSignal = signals[signals.length - 1] ?? null;
      let zone: SmiSnapshot["zone"] = "neutral";
      if (lastSmi != null) {
        if (lastSmi >= SMI_OB) zone = "overbought";
        else if (lastSmi <= SMI_OS) zone = "oversold";
      }
      let cross: SmiSnapshot["cross"] = null;
      if (lastSmi != null && lastSig != null) {
        cross = lastSmi >= lastSig ? "bullish" : "bearish";
      }
      setSnapshot({ smi: lastSmi, signal: lastSig, zone, cross, lastSignal });
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, days, enabled, candleSeries]);

  return { snapshot };
}
