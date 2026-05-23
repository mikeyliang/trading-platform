/**
 * Chart color tokens. TypeScript mirror of the `colors.chart.*` palette in
 * `tailwind.config.ts`. Keep the two in lock-step — change here AND in the
 * tailwind config together, never just one.
 *
 * Why a mirror instead of reading CSS vars at runtime: lightweight-charts
 * accepts raw color strings synchronously at chart construction, and `addX`
 * series APIs don't observe CSS-var changes. A typed constant is simpler,
 * tree-shakeable, and works identically in SVG `stroke=`/`fill=` attrs.
 *
 * Tailwind classes (e.g. `text-chart-ema-fast`) and TS constants
 * (`CHART.ema.fast`) resolve to the same value.
 */
export const CHART = {
  // ── chrome ────────────────────────────────────────────────────────────
  grid: "#262629",
  axis: "#38383f",
  crosshair: "#52525b",
  axisText: "#71717a",

  // Background tones (mirror of the surface palette) used when a chart
  // needs to set its own bg explicitly (lightweight-charts requires this).
  bg: "#18181b",
  surface: "#1f1f23",

  // Foreground / primary text in chart annotations.
  text: "#f4f4f5",
  textMuted: "#71717a",

  // ── price series ──────────────────────────────────────────────────────
  candle: {
    up: "#26a69a",
    down: "#ef5350",
  },

  // ── overlay indicators ────────────────────────────────────────────────
  ema: {
    fast: "#60a5fa",
    slow: "#a78bfa",
  },
  vwap: "#facc15",

  // ── subpane indicators ────────────────────────────────────────────────
  rsi: "#22d3ee",
  macd: {
    line: "#60a5fa",
    signal: "#f59e0b",
    histUp: "#22c55e",
    histDown: "#ef4444",
  },
  smi: {
    line: "#60a5fa",
    signal: "#f59e0b",
  },

  // ── forecast cone + per-member paths ──────────────────────────────────
  forecast: {
    cone: "#38bdf8",
    chronos: "#38bdf8",
    momentum: "#fb923c",
    meanrev: "#34d399",
    martingale: "#94a3b8",
  },

  // ── reference lines on the underlying chart ───────────────────────────
  ref: {
    strike: "#fbbf24",
    be: "#38bdf8",
    sigma: "#38bdf8",
  },

  // ── P/L profile chart — single-hue ramp encodes time progression ──────
  // today (lightest) → ½ DTE → expiry (darkest). Same hue family so the
  // viewer reads "different moments in time", not "different ideas".
  pnl: {
    today: "#7dd3fc",
    halfway: "#38bdf8",
    expiry: "#0ea5e9",
    profit: "#10b981",
    loss: "#f43f5e",
    target: "#d946ef",
  },

  // ── semantic shortcuts (mirror of root tokens) ────────────────────────
  up: "#22c55e",
  down: "#ef4444",
  warning: "#f59e0b",
  accent: "#3b82f6",
} as const;

/**
 * Base `createChart` options shared by every chart in the app. Components
 * spread this and override pane-specific bits (height, scale margins).
 * Keeps grid/axis/crosshair/font consistent everywhere without each chart
 * re-declaring the same 30 lines.
 */
import { ColorType, CrosshairMode, LineStyle } from "lightweight-charts";

export const baseChartOptions = () => ({
  layout: {
    background: { type: ColorType.Solid, color: CHART.bg },
    textColor: CHART.axisText,
    fontSize: 11,
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  },
  grid: {
    vertLines: { color: CHART.grid },
    horzLines: { color: CHART.grid },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: CHART.crosshair, style: LineStyle.Dashed, width: 1 as const },
    horzLine: { color: CHART.crosshair, style: LineStyle.Dashed, width: 1 as const },
  },
  rightPriceScale: {
    borderColor: CHART.axis,
    scaleMargins: { top: 0.08, bottom: 0.18 },
  },
  timeScale: {
    borderColor: CHART.axis,
    timeVisible: true,
    secondsVisible: false,
    // Keep candles readable on wide screens — without this, 90+ bars
    // squashed across a 1300px pane produce hair-thin candles.
    barSpacing: 10,
    minBarSpacing: 6,
  },
  handleScroll: true,
  handleScale: true,
});
