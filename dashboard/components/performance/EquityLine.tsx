"use client";

import { useEffect, useRef } from "react";
import {
  ColorType,
  LineStyle,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";

interface Props {
  data: { time: number; value: number }[];
  height?: number;
}

export function EquityLine({ data, height = 200 }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || data.length < 2) return;

    const positive = data[data.length - 1].value >= data[0].value;
    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0a" },
        textColor: "#71717a",
        fontSize: 10,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
      },
      grid: {
        vertLines: { color: "#0f0f0f" },
        horzLines: { color: "#0f0f0f" },
      },
      rightPriceScale: { borderColor: "#1f1f1f" },
      timeScale: { borderColor: "#1f1f1f", timeVisible: true },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        vertLine: { color: "#3c3c3c", style: LineStyle.Dashed, width: 1 as 1 },
        horzLine: { color: "#3c3c3c", style: LineStyle.Dashed, width: 1 as 1 },
      },
    });

    const area = chart.addAreaSeries({
      lineColor: positive ? "#22c55e" : "#ef4444",
      topColor: positive ? "rgba(34,197,94,0.18)" : "rgba(239,68,68,0.18)",
      bottomColor: "rgba(0,0,0,0)",
      lineWidth: 2,
      priceLineVisible: false,
    });
    area.setData(
      data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })),
    );
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() =>
      chart.applyOptions({ width: el.clientWidth }),
    );
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [data, height]);

  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-text-muted text-[11px]"
        style={{ height }}
      >
        not enough data
      </div>
    );
  }

  return <div ref={ref} className="w-full" style={{ height }} />;
}
