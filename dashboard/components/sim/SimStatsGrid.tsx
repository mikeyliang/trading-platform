"use client";

import type { SimStats } from "@/lib/api";
import { cn, fmtCurrency } from "@/lib/utils";

/** Dense stat grid — one row of small labeled cells, IBKR-style. */
export function SimStatsGrid({ stats }: { stats: SimStats }) {
  const cells: { label: string; value: string; tone?: "up" | "down" | "muted" }[] = [
    {
      label: "Return",
      value: `${stats.total_return_pct >= 0 ? "+" : ""}${stats.total_return_pct.toFixed(2)}%`,
      tone: stats.total_return_pct >= 0 ? "up" : "down",
    },
    { label: "P&L", value: fmtCurrency(stats.total_return), tone: stats.total_return >= 0 ? "up" : "down" },
    { label: "Final", value: fmtCurrency(stats.final_capital) },
    { label: "Max DD", value: `${stats.max_drawdown_pct.toFixed(2)}%`, tone: "down" },
    { label: "Sharpe", value: stats.sharpe_ratio.toFixed(2), tone: stats.sharpe_ratio >= 1 ? "up" : "muted" },
    { label: "Sortino", value: stats.sortino_ratio.toFixed(2), tone: "muted" },
    { label: "Trades", value: String(stats.total_trades) },
    { label: "Win rate", value: `${stats.win_rate.toFixed(1)}%`, tone: stats.win_rate >= 50 ? "up" : "muted" },
    { label: "PF", value: stats.profit_factor.toFixed(2), tone: stats.profit_factor >= 1.3 ? "up" : stats.profit_factor < 1 ? "down" : "muted" },
    { label: "Avg win", value: fmtCurrency(stats.avg_win), tone: "up" },
    { label: "Avg loss", value: fmtCurrency(stats.avg_loss), tone: "down" },
    { label: "Expectancy", value: fmtCurrency(stats.expectancy), tone: stats.expectancy >= 0 ? "up" : "down" },
    {
      label: "Avg hold",
      value: stats.avg_trade_hours != null
        ? stats.avg_trade_hours >= 48
          ? `${(stats.avg_trade_hours / 24).toFixed(1)}d`
          : `${stats.avg_trade_hours.toFixed(1)}h`
        : "—",
    },
  ];
  if (stats.buy_hold_return_pct != null) {
    cells.push({
      label: "Buy & hold",
      value: `${stats.buy_hold_return_pct >= 0 ? "+" : ""}${stats.buy_hold_return_pct.toFixed(1)}%`,
      tone: stats.total_return_pct >= stats.buy_hold_return_pct ? "up" : "muted",
    });
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(86px,1fr))] border border-border rounded-md overflow-hidden bg-surface-1">
      {cells.map((c) => (
        <div key={c.label} className="px-2 py-1.5 border-r border-b border-border/50 last:border-r-0">
          <div className="text-[9px] uppercase tracking-wider text-text-muted leading-tight">{c.label}</div>
          <div
            className={cn(
              "text-xs tabular leading-tight mt-0.5",
              c.tone === "up" && "text-up",
              c.tone === "down" && "text-down",
              c.tone === "muted" && "text-text-secondary",
              !c.tone && "text-text-primary"
            )}
          >
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}
