"use client";

import { useMemo } from "react";
import { cn, fmt, fmtCurrency, fmtPct } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InfoIcon } from "@/components/ui/info-icon";
import type { BacktestResult } from "@/types";

interface Props {
  result: BacktestResult;
}

interface DerivedMetrics {
  sortino: number;
  calmar: number;
  cagr: number;
  volatility: number;
  bestTrade: number;
  worstTrade: number;
  avgTradePnl: number;
  expectancy: number;
  // bar-level (not annualised) — for completeness when the equity curve is
  // short or daily granularity is unclear.
  rfFreeNote: string;
}

// Periods-per-year lookup for annualisation when the timeframe is known.
// The backend already produces Sharpe; we use this for Sortino/vol/CAGR so
// the metrics line up apples-to-apples with what the user sees there.
const PERIODS_PER_YEAR: Record<string, number> = {
  "1m": 252 * 6.5 * 60,
  "5m": 252 * 6.5 * 12,
  "15m": 252 * 6.5 * 4,
  "30m": 252 * 6.5 * 2,
  "1h": 252 * 6.5,
  "4h": 252 * 1.625,
  "1d": 252,
};

export function MetricsTable({ result }: Props) {
  const derived = useMemo<DerivedMetrics>(() => {
    const curve = result.equity_curve ?? [];
    const periods = PERIODS_PER_YEAR[result.timeframe] ?? 252;

    let sortino = 0;
    let volatility = 0;
    if (curve.length > 1) {
      const rets: number[] = [];
      for (let i = 1; i < curve.length; i++) {
        const prev = curve[i - 1].value;
        const cur = curve[i].value;
        if (prev > 0) rets.push((cur - prev) / prev);
      }
      if (rets.length > 1) {
        const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
        const variance =
          rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
        const std = Math.sqrt(variance);
        volatility = std * Math.sqrt(periods) * 100;

        const downside = rets.filter((r) => r < 0);
        if (downside.length > 0) {
          const dsVar =
            downside.reduce((s, r) => s + r * r, 0) / downside.length;
          const dsStd = Math.sqrt(dsVar);
          sortino = dsStd > 0 ? (mean / dsStd) * Math.sqrt(periods) : 0;
        }
      }
    }

    const cagr = (() => {
      if (curve.length < 2) return 0;
      const start = curve[0].value;
      const end = curve[curve.length - 1].value;
      if (start <= 0) return 0;
      const startT = curve[0].time;
      const endT = curve[curve.length - 1].time;
      const years = Math.max(1 / 365, (endT - startT) / (365.25 * 86_400));
      return (Math.pow(end / start, 1 / years) - 1) * 100;
    })();

    const calmar =
      Math.abs(result.max_drawdown_pct) > 1e-6
        ? cagr / Math.abs(result.max_drawdown_pct)
        : 0;

    const tradePnls = result.trades
      .map((t) => t.pnl)
      .filter((p): p is number => p != null);
    const bestTrade = tradePnls.length ? Math.max(...tradePnls) : 0;
    const worstTrade = tradePnls.length ? Math.min(...tradePnls) : 0;
    const avgTradePnl = tradePnls.length
      ? tradePnls.reduce((s, p) => s + p, 0) / tradePnls.length
      : 0;

    const winRateFrac = result.win_rate / 100;
    const expectancy =
      winRateFrac * result.avg_win + (1 - winRateFrac) * result.avg_loss;

    return {
      sortino,
      calmar,
      cagr,
      volatility,
      bestTrade,
      worstTrade,
      avgTradePnl,
      expectancy,
      rfFreeNote: "rf=0",
    };
  }, [result]);

  const rows: MetricRow[] = [
    {
      group: "Returns",
      items: [
        {
          label: "Total return",
          value: fmtPct(result.total_return_pct),
          hint: fmtCurrency(result.total_return),
          tone: result.total_return_pct >= 0 ? "up" : "down",
        },
        {
          label: "CAGR",
          value: fmtPct(derived.cagr),
          tone: derived.cagr >= 0 ? "up" : "down",
          info: "Compound annual growth rate inferred from equity-curve timestamps.",
        },
        {
          label: "Final equity",
          value: fmtCurrency(result.final_capital),
          hint: `from ${fmtCurrency(result.initial_capital)}`,
        },
        {
          label: "Volatility",
          value: fmt(derived.volatility, 2) + "%",
          info: "Annualised stdev of bar-level returns.",
        },
      ],
    },
    {
      group: "Risk-adjusted",
      items: [
        {
          label: "Sharpe",
          value: fmt(result.sharpe_ratio, 2),
          tone:
            result.sharpe_ratio > 1
              ? "up"
              : result.sharpe_ratio < 0
              ? "down"
              : "default",
          hint: derived.rfFreeNote,
          info: "Annualised return / annualised stdev. From server.",
        },
        {
          label: "Sortino",
          value: fmt(derived.sortino, 2),
          tone:
            derived.sortino > 1
              ? "up"
              : derived.sortino < 0
              ? "down"
              : "default",
          info: "Return / downside-only stdev — penalises only losing bars.",
        },
        {
          label: "Calmar",
          value: fmt(derived.calmar, 2),
          tone:
            derived.calmar > 1
              ? "up"
              : derived.calmar < 0
              ? "down"
              : "default",
          info: "CAGR / |max drawdown|. Higher is better.",
        },
        {
          label: "Max drawdown",
          value: fmtPct(result.max_drawdown_pct),
          hint: fmtCurrency(result.max_drawdown),
          tone: "down",
        },
      ],
    },
    {
      group: "Trade quality",
      items: [
        {
          label: "Win rate",
          value: fmt(result.win_rate, 1) + "%",
          hint: `${result.winning_trades}W / ${result.losing_trades}L`,
          tone: result.win_rate >= 50 ? "up" : "down",
        },
        {
          label: "Profit factor",
          value: fmt(result.profit_factor, 2),
          tone:
            result.profit_factor > 1
              ? "up"
              : result.profit_factor < 1
              ? "down"
              : "default",
          info: "Gross wins / gross losses. >1 means net profitable.",
        },
        {
          label: "Expectancy",
          value: fmtCurrency(derived.expectancy),
          tone: derived.expectancy >= 0 ? "up" : "down",
          info: "Average $ per trade: winRate·avgWin + lossRate·avgLoss.",
        },
        {
          label: "Avg trade",
          value: fmtCurrency(derived.avgTradePnl),
          tone: derived.avgTradePnl >= 0 ? "up" : "down",
        },
      ],
    },
    {
      group: "Trade extrema",
      items: [
        {
          label: "Avg win",
          value: fmtCurrency(result.avg_win),
          tone: "up",
        },
        {
          label: "Avg loss",
          value: fmtCurrency(result.avg_loss),
          tone: "down",
        },
        {
          label: "Best trade",
          value: fmtCurrency(derived.bestTrade),
          tone: "up",
        },
        {
          label: "Worst trade",
          value: fmtCurrency(derived.worstTrade),
          tone: "down",
        },
      ],
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Performance metrics</CardTitle>
        <Badge variant="muted">{result.total_trades} trades</Badge>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          {rows.map((group) => (
            <div
              key={group.group}
              className="border-r last:border-r-0 border-border/40 p-3"
            >
              <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">
                {group.group}
              </div>
              <dl className="flex flex-col gap-1.5">
                {group.items.map((m) => (
                  <div
                    key={m.label}
                    className="flex items-baseline justify-between gap-2"
                  >
                    <dt className="text-[11px] text-text-secondary flex items-center gap-1 min-w-0 truncate">
                      <span className="truncate">{m.label}</span>
                      {m.info && <InfoIcon hint={m.info} />}
                    </dt>
                    <dd className="flex flex-col items-end shrink-0">
                      <span
                        className={cn(
                          "text-[12px] font-semibold tabular",
                          m.tone === "up" && "text-up",
                          m.tone === "down" && "text-down",
                          m.tone === "warning" && "text-warning",
                          (!m.tone || m.tone === "default") &&
                            "text-text-primary"
                        )}
                      >
                        {m.value}
                      </span>
                      {m.hint && (
                        <span className="text-[10px] text-text-muted tabular leading-none">
                          {m.hint}
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface Metric {
  label: string;
  value: string;
  hint?: string;
  info?: string;
  tone?: "default" | "up" | "down" | "warning";
}

interface MetricRow {
  group: string;
  items: Metric[];
}
