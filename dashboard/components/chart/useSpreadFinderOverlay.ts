"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { IPriceLine, ISeriesApi, LineStyle } from "lightweight-charts";
import { api, type SpreadCandidate, type SpreadScanResult } from "@/lib/api";

const TYPE_COLORS: Record<string, string> = {
  rut: "#94a3b8",       // slate
  mars: "#60a5fa",      // blue
  marsmax: "#a78bfa",   // purple
  space: "#facc15",     // yellow
};

interface Args {
  candleSeries: RefObject<ISeriesApi<"Candlestick"> | null>;
  symbol: string;
  enabled: boolean;
}

/**
 * Overlay the TOP candidate from each Rule One trade type (rut/mars/marsmax/space)
 * onto the chart. Each type gets its own color; we draw three lines per type
 * (short strike solid, long strike thin dashed, 2% exit dotted) so a glance
 * tells you which trades fit on which expiries.
 *
 * Calls /api/options/spreads/scan and refreshes when the symbol changes or
 * the user toggles the overlay back on.
 */
export function useSpreadFinderOverlay({ candleSeries, symbol, enabled }: Args) {
  const linesRef = useRef<IPriceLine[]>([]);
  const [result, setResult] = useState<SpreadScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .spreadScan(symbol, "put")
      .then((r) => {
        if (!cancelled) setResult(r);
        if (r.error && !cancelled) setError(r.error);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, enabled]);

  useEffect(() => {
    const series = candleSeries.current;
    if (!series) return;

    for (const ln of linesRef.current) {
      try {
        series.removePriceLine(ln);
      } catch {}
    }
    linesRef.current = [];

    if (!enabled || !result?.trade_types) return;

    for (const [type, candidates] of Object.entries(result.trade_types)) {
      // Top candidate (first after sort) — only draw if it passes ALL checks,
      // otherwise the chart would advertise unsafe trades.
      const top = (candidates as SpreadCandidate[]).find((c) =>
        Object.values(c.passes).every(Boolean)
      );
      if (!top) continue;
      const color = TYPE_COLORS[type] ?? "#71717a";
      const label = type === "marsmax" ? "MarsMax" : type === "rut" ? "RUT" : type[0].toUpperCase() + type.slice(1);
      const expLabel = formatExpiry(top.expiry);

      linesRef.current.push(
        series.createPriceLine({
          price: top.short_strike,
          color,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `${label} short ${top.short_strike}P • ${expLabel} • AROC ${top.aroc_pct.toFixed(0)}%`,
        })
      );
      linesRef.current.push(
        series.createPriceLine({
          price: top.long_strike,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: `${label} long ${top.long_strike}P`,
        })
      );
      const exit2pct = top.side === "put" ? top.short_strike * 1.02 : top.short_strike * 0.98;
      linesRef.current.push(
        series.createPriceLine({
          price: exit2pct,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.SparseDotted,
          axisLabelVisible: false,
          title: `${label} 2% exit`,
        })
      );
    }

    return () => {
      const s = candleSeries.current;
      if (!s) return;
      for (const ln of linesRef.current) {
        try {
          s.removePriceLine(ln);
        } catch {}
      }
      linesRef.current = [];
    };
  }, [result, enabled, candleSeries]);

  return { result, loading, error };
}

function formatExpiry(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
