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

export interface RsiSnapshot {
  rsi: number | null;
  zone: "overbought" | "oversold" | "neutral";
}

interface UseRsiOverlayOpts {
  mainChart: RefObject<IChartApi | null>;
  subpaneContainer: RefObject<HTMLDivElement | null>;
  symbol: string;
  timeframe: string;
  days: number;
  enabled: boolean;
}

const RSI_OB = 70;
const RSI_OS = 30;

export function useRsiOverlay({
  mainChart,
  subpaneContainer,
  symbol,
  timeframe,
  days,
  enabled,
}: UseRsiOverlayOpts) {
  const subChartRef = useRef<IChartApi | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const [snapshot, setSnapshot] = useState<RsiSnapshot | null>(null);

  useEffect(() => {
    const el = subpaneContainer.current;
    if (!el) return;

    if (!enabled) {
      if (subChartRef.current) {
        subChartRef.current.remove();
        subChartRef.current = null;
        rsiSeriesRef.current = null;
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

    rsiSeriesRef.current = chart.addLineSeries({
      color: "#a855f7",
      lineWidth: 1.5 as 1,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "RSI",
    });

    rsiSeriesRef.current.createPriceLine({
      price: RSI_OB,
      color: "#ef4444",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "OB",
    });
    rsiSeriesRef.current.createPriceLine({
      price: RSI_OS,
      color: "#22c55e",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "OS",
    });
    rsiSeriesRef.current.createPriceLine({
      price: 50,
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
        rsiSeriesRef.current = null;
      }
    };
  }, [enabled, subpaneContainer, mainChart]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    (async () => {
      const data = await api.indicators(symbol, timeframe, days).catch(() => null);
      if (cancelled || !data || !data.rsi) return;

      const rsiSeries = rsiSeriesRef.current;
      if (!rsiSeries) return;

      const rsiData: IndicatorPoint[] = data.rsi;
      rsiSeries.setData(
        rsiData.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
      );

      const lastRsi = rsiData[rsiData.length - 1]?.value ?? null;
      let zone: RsiSnapshot["zone"] = "neutral";
      if (lastRsi != null) {
        if (lastRsi >= RSI_OB) zone = "overbought";
        else if (lastRsi <= RSI_OS) zone = "oversold";
      }
      setSnapshot({ rsi: lastRsi, zone });
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, days, enabled]);

  return { snapshot };
}
