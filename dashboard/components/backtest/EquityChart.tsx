"use client";

import { useEffect, useRef } from "react";
import { createChart, ColorType, LineStyle, UTCTimestamp } from "lightweight-charts";

interface Props {
  data: { time: number; value: number }[];
  height?: number;
}

export function EquityChart({ data, height = 180 }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !data.length) return;

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#111111" },
        textColor: "#71717a",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "#1a1a1a" },
        horzLines: { color: "#1a1a1a" },
      },
      rightPriceScale: { borderColor: "#2c2c2c" },
      timeScale: { borderColor: "#2c2c2c", timeVisible: true },
      handleScroll: false,
      handleScale: false,
    });

    const first = data[0].value;
    const last = data[data.length - 1].value;
    const positive = last >= first;

    const series = chart.addAreaSeries({
      lineColor: positive ? "#22c55e" : "#ef4444",
      topColor: positive ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
      bottomColor: "rgba(0,0,0,0)",
      lineWidth: 2,
      priceLineVisible: false,
    });

    series.setData(data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current!.clientWidth }));
    ro.observe(ref.current);

    return () => { ro.disconnect(); chart.remove(); };
  }, [data, height]);

  return <div ref={ref} />;
}
