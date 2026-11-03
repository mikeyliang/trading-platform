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
  grid: "#1c222b",
  axis: "#2a3341",
  crosshair: "#677385",
  axisText: "#7c8798",

  // Background tones (mirror of the surface palette) used when a chart
  // needs to set its own bg explicitly (lightweight-charts requires this).
  bg: "#151a21",
  surface: "#1c222b",

  // Foreground / primary text in chart annotations.
  text: "#e6ebf2",
  textMuted: "#7c8798",

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
  up: "#46c46e",
  down: "#f45e68",
  warning: "#e8ac38",
  accent: "#8b96ff",
} as const;

/**
 * Base `createChart` options shared by every chart in the app. Components
 * spread this and override pane-specific bits (height, scale margins).
 * Keeps grid/axis/crosshair/font consistent everywhere without each chart
 * re-declaring the same 30 lines.
 */
import { ColorType, CrosshairMode, LineStyle } from "lightweight-charts";

/**
 * Chart chrome follows the active theme. The series palette above is fixed
 * (it is tuned to read on both surfaces), but background, grid, axis and
 * label colors come from the CSS variables in globals.css so a chart built
 * in light mode is not a dark rectangle. Read at creation time only.
 */
export function chartChrome() {
  if (typeof window === "undefined") {
    return {
      bg: CHART.bg,
      grid: CHART.grid,
      axis: CHART.axis,
      crosshair: CHART.crosshair,
      axisText: CHART.axisText,
      text: CHART.text,
      up: CHART.candle.up,
      down: CHART.candle.down,
      upSoft: CHART.candle.up,
      downSoft: CHART.candle.down,
      accent: CHART.accent,
    };
  }
  // Tokens resolve through var() chains to oklch and color-mix(), which
  // lightweight-charts cannot parse. A canvas context normalises any CSS
  // colour the browser understands to #rrggbb.
  // Paint one pixel and read it back: the only way to turn an oklch or
  // color-mix() value into the rgb() string lightweight-charts accepts.
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const probe = canvas.getContext("2d", { willReadFrequently: true });
  const resolve = (value: string, fallback: string): string => {
    if (!value || !probe) return fallback;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    if (a === 0) return fallback;
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  };
  const el = document.createElement("span");
  el.style.position = "absolute";
  el.style.visibility = "hidden";
  document.body.appendChild(el);
  const read = (name: string, fallback: string) => {
    el.style.color = `var(${name})`;
    const c = getComputedStyle(el).color;
    return resolve(c, fallback);
  };
  const withAlpha = (hex: string, alpha: number) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
  };
  const out = {
    bg: read("--chart-bg", CHART.bg),
    grid: read("--chart-grid", CHART.grid),
    axis: read("--chart-axis", CHART.axis),
    crosshair: read("--chart-crosshair", CHART.crosshair),
    axisText: read("--chart-axis-text", CHART.axisText),
    text: read("--chart-text", CHART.text),
    up: read("--c-up", CHART.candle.up),
    down: read("--c-down", CHART.candle.down),
    upSoft: "",
    downSoft: "",
    accent: read("--color-accent-500", CHART.accent),
  };
  out.upSoft = withAlpha(out.up, 0.35);
  out.downSoft = withAlpha(out.down, 0.35);
  el.remove();
  return out;
}

export const baseChartOptions = () => {
  const c = chartChrome();
  return {
    layout: {
      background: { type: ColorType.Solid, color: c.bg },
      textColor: c.axisText,
      fontSize: 11,
      fontFamily: "var(--font-inter), Inter, system-ui, sans-serif",
    },
    grid: {
      vertLines: { color: c.grid },
      horzLines: { color: c.grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: c.crosshair, style: LineStyle.Dashed, width: 1 as const },
      horzLine: { color: c.crosshair, style: LineStyle.Dashed, width: 1 as const },
    },
    rightPriceScale: {
      borderColor: c.axis,
      scaleMargins: { top: 0.08, bottom: 0.18 },
    },
    timeScale: {
      borderColor: c.axis,
      timeVisible: true,
      secondsVisible: false,
      // Keep candles readable on wide screens — without this, 90+ bars
      // squashed across a 1300px pane produce hair-thin candles.
      barSpacing: 10,
      minBarSpacing: 6,
    },
    handleScroll: true,
    handleScale: true,
  };
};
