import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Calm dark grey — less inky than pure black, less elevated than a true mid-grey.
        bg: "#18181b",
        surface: "#1f1f23",
        "surface-2": "#28282d",
        "surface-3": "#313137",
        border: "#38383f",
        "text-primary": "#f4f4f5",
        "text-secondary": "#a1a1aa",
        "text-muted": "#52525b",
        accent: "#3b82f6",
        up: "#22c55e",
        down: "#ef4444",
        warning: "#f59e0b",

        // Chart-specific semantic palette. Keep in lock-step with
        // lib/chartTheme.ts — both are read by chart code (Tailwind classes
        // for JSX, the TS constant for lightweight-charts / SVG attrs).
        chart: {
          grid: "#262629",
          axis: "#38383f",
          crosshair: "#52525b",
          axisText: "#71717a",
          candle: { up: "#26a69a", down: "#ef5350" },
          ema: { fast: "#60a5fa", slow: "#a78bfa" },
          vwap: "#facc15",
          rsi: "#22d3ee",
          macd: { line: "#60a5fa", signal: "#f59e0b" },
          smi: { line: "#60a5fa", signal: "#f59e0b" },
          forecast: {
            cone: "#38bdf8",
            chronos: "#38bdf8",
            momentum: "#fb923c",
            meanrev: "#34d399",
            martingale: "#94a3b8",
          },
          ref: { strike: "#fbbf24", be: "#38bdf8", sigma: "#38bdf8" },
          pnl: {
            today: "#7dd3fc",
            halfway: "#38bdf8",
            expiry: "#0ea5e9",
            profit: "#10b981",
            loss: "#f43f5e",
            target: "#d946ef",
          },
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        lg: "0.5rem",
        md: "0.375rem",
        sm: "0.25rem",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.15s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
