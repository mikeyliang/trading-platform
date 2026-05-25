import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);
}

export function fmtPct(n: number | null | undefined, showSign = true): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = Math.abs(n).toFixed(2) + "%";
  if (!showSign) return s;
  return (n >= 0 ? "+" : "-") + s;
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}

export function pnlClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "text-text-secondary";
  if (n > 0) return "text-up";
  if (n < 0) return "text-down";
  return "text-text-secondary";
}

export function signalColor(signal: string): string {
  if (signal === "BUY") return "text-up";
  if (signal === "SELL") return "text-down";
  return "text-text-muted";
}
