import { ColorType, CrosshairMode, LineStyle } from "lightweight-charts";

/** Shared lightweight-charts options matching the app's dark terminal theme. */
export function baseChartOptions(el: HTMLElement, height?: number) {
  return {
    width: el.clientWidth,
    height: height ?? el.clientHeight,
    layout: {
      background: { type: ColorType.Solid, color: "#0a0a0a" },
      textColor: "#71717a",
      fontSize: 10,
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
    },
    grid: { vertLines: { color: "#161616" }, horzLines: { color: "#161616" } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: "#3c3c3c", style: LineStyle.Dashed, width: 1 as const },
      horzLine: { color: "#3c3c3c", style: LineStyle.Dashed, width: 1 as const },
    },
    rightPriceScale: { borderColor: "#1f1f1f" },
    timeScale: { borderColor: "#1f1f1f", timeVisible: true, secondsVisible: false },
  };
}

export const COLORS = {
  up: "#26a69a",
  down: "#ef5350",
  upBright: "#22c55e",
  downBright: "#ef4444",
  blue: "#60a5fa",
  purple: "#a78bfa",
  amber: "#f59e0b",
  slate: "#3c3c3c",
  cyan: "#22d3ee",
  pink: "#f472b6",
};
