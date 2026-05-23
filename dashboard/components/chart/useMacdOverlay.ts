"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ColorType,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  LineStyle,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { api } from "@/lib/api";

interface IndicatorPoint {
  time: number;
  value: number;
}

export interface MacdSnapshot {
  macd: number | null;
  signal: number | null;
  hist: number | null;
  cross: "bullish" | "bearish" | null;
}

interface UseMacdOverlayOpts {
  mainChart: RefObject<IChartApi | null>;
  subpaneContainer: RefObject<HTMLDivElement | null>;
  symbol: string;
  timeframe: string;
  days: number;
  enabled: boolean;
}

export function useMacdOverlay({
  mainChart,
  subpaneContainer,
  symbol,
  timeframe,
  days,
  enabled,
}: UseMacdOverlayOpts) {
  const subChartRef = useRef<IChartApi | null>(null);
  const macdSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const signalSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const histSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [snapshot, setSnapshot] = useState<MacdSnapshot | null>(null);

  useEffect(() => {
    const el = subpaneContainer.current;
    if (!el) return;

    if (!enabled) {
      if (subChartRef.current) {
        subChartRef.current.remove();
        subChartRef.current = null;
        macdSeriesRef.current = null;
        signalSeriesRef.current = null;
        histSeriesRef.current = null;
      }
      setSnapshot(null);
      return;
    }

    if (subChartRef.current) return;

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

    histSeriesRef.current = chart.addHistogramSeries({
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    macdSeriesRef.current = chart.addLineSeries({
      color: "#60a5fa",
      lineWidth: 1.5 as 1,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "MACD",
    });
    signalSeriesRef.current = chart.addLineSeries({
      color: "#f59e0b",
      lineWidth: 1 as 1,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "Signal",
    });

    macdSeriesRef.current.createPriceLine({
      price: 0,
      color: "#3c3c3c",
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: false,
    });

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
        macdSeriesRef.current = null;
        signalSeriesRef.current = null;
        histSeriesRef.current = null;
      }
    };
  }, [enabled, subpaneContainer, mainChart]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    (async () => {
      const data = await api.indicators(symbol, timeframe, days).catch(() => null);
      if (cancelled || !data || !data.macd || !data.macd_signal || !data.macd_hist) return;

      const macdSeries = macdSeriesRef.current;
      const signalSeries = signalSeriesRef.current;
      const histSeries = histSeriesRef.current;
      if (!macdSeries || !signalSeries || !histSeries) return;

      const macdData: IndicatorPoint[] = data.macd;
      const sigData: IndicatorPoint[] = data.macd_signal;
      const histData: IndicatorPoint[] = data.macd_hist;

      macdSeries.setData(
        macdData.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
      );
      signalSeries.setData(
        sigData.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
      );
      histSeries.setData(
        histData.map((p) => ({
          time: p.time as UTCTimestamp,
          value: p.value,
          color: p.value >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)",
        }))
      );

      const lastMacd = macdData[macdData.length - 1]?.value ?? null;
      const lastSig = sigData[sigData.length - 1]?.value ?? null;
      const lastHist = histData[histData.length - 1]?.value ?? null;
      let cross: MacdSnapshot["cross"] = null;
      if (lastMacd != null && lastSig != null) {
        cross = lastMacd >= lastSig ? "bullish" : "bearish";
      }
      setSnapshot({ macd: lastMacd, signal: lastSig, hist: lastHist, cross });
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, days, enabled]);

  return { snapshot };
}
