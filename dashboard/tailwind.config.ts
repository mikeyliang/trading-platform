import type { Config } from "tailwindcss";

// Every UI color resolves to a CSS variable defined in app/globals.css, so the
// same class renders correctly in both the dark (default) and light themes.
// Variables hold space-separated RGB triplets, which keeps Tailwind opacity
// modifiers (`bg-accent/15`) working.
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

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
        bg: v("c-bg"),
        surface: v("c-surface"),
        "surface-2": v("c-surface-2"),
        "surface-3": v("c-surface-3"),
        border: v("c-border"),
        "border-strong": v("c-border-strong"),
        "text-primary": v("c-text"),
        "text-secondary": v("c-text-2"),
        "text-muted": v("c-text-3"),
        accent: v("c-accent"),
        "accent-fg": v("c-accent-fg"),
        up: v("c-up"),
        down: v("c-down"),
        warning: v("c-warning"),
        // Ink used on top of a solid accent / status fill.
        "on-fill": v("c-on-fill"),
        ink: v("c-ink"),
        amber: v("c-amber"),

        // Chart-specific semantic palette. Keep in lock-step with
        // lib/chartTheme.ts — both are read by chart code (Tailwind classes
        // for JSX, the TS constant for lightweight-charts / SVG attrs).
        chart: {
          grid: "#1c222b",
          axis: "#2a3341",
          crosshair: "#677385",
          axisText: "#7c8798",
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
        // Inter for labels and copy, Chivo Mono for figures and display heads.
        sans: ["var(--font-sans)", "Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["var(--font-mono)", "Chivo Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        // Dense app scale, ratio ~1.15, nothing under 11px.
        "2xs": ["11px", { lineHeight: "14px" }],
        xs: ["12px", { lineHeight: "16px" }],
        sm: ["13px", { lineHeight: "18px" }],
        base: ["14px", { lineHeight: "20px" }],
        lg: ["16px", { lineHeight: "22px" }],
        xl: ["20px", { lineHeight: "24px" }],
        "2xl": ["26px", { lineHeight: "28px" }],
      },
      fontWeight: {
        normal: "400",
        medium: "500",
        semibold: "600",
        bold: "700",
      },
      borderRadius: {
        // Wayfind is bordered and square. Only pills keep a radius.
        none: "0",
        sm: "0",
        DEFAULT: "0",
        md: "0",
        lg: "0",
        xl: "0",
        "2xl": "0",
        full: "999px",
      },
      borderWidth: {
        DEFAULT: "1px",
        bar: "2px",
      },
      boxShadow: {
        // Overlay cards and popovers. Tuned per theme in globals.css.
        pop: "var(--shadow-pop)",
        ring: "0 0 0 1px rgb(var(--c-border))",
        bar: "inset 0 0 0 2px rgb(var(--c-border-strong))",
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
        "slide-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.15s ease-out",
        "slide-up": "slide-up 0.18s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
