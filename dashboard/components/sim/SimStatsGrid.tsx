"use client";

import type { SimStats } from "@/lib/api";
import { fmtCurrency } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Stat, StatGroup } from "@/components/ui/stat";

type Tone = "default" | "up" | "down" | "muted";

/** One card of stat tiles for the active symbol, signed and toned. */
export function SimStatsGrid({ stats }: { stats: SimStats }) {
  const cells: { label: string; value: string; tone?: Tone }[] = [
    {
      label: "Return",
      value: `${stats.total_return_pct >= 0 ? "+" : ""}${stats.total_return_pct.toFixed(2)}%`,
      tone: stats.total_return_pct >= 0 ? "up" : "down",
    },
    { label: "P&L", value: fmtCurrency(stats.total_return), tone: stats.total_return >= 0 ? "up" : "down" },
    { label: "Final capital", value: fmtCurrency(stats.final_capital) },
    { label: "Max drawdown", value: `-${Math.abs(stats.max_drawdown_pct).toFixed(2)}%`, tone: "down" },
    { label: "Sharpe", value: stats.sharpe_ratio.toFixed(2), tone: stats.sharpe_ratio >= 1 ? "up" : "muted" },
    { label: "Sortino", value: stats.sortino_ratio.toFixed(2), tone: "muted" },
    { label: "Trades", value: String(stats.total_trades) },
    { label: "Win rate", value: `${stats.win_rate.toFixed(1)}%`, tone: stats.win_rate >= 50 ? "up" : "muted" },
    {
      label: "Profit factor",
      value: stats.profit_factor.toFixed(2),
      tone: stats.profit_factor >= 1.3 ? "up" : stats.profit_factor < 1 ? "down" : "muted",
    },
    { label: "Avg win", value: fmtCurrency(stats.avg_win), tone: "up" },
    { label: "Avg loss", value: fmtCurrency(stats.avg_loss), tone: "down" },
    { label: "Expectancy", value: fmtCurrency(stats.expectancy), tone: stats.expectancy >= 0 ? "up" : "down" },
    {
      label: "Avg hold",
      value: stats.avg_trade_hours != null
        ? stats.avg_trade_hours >= 48
          ? `${(stats.avg_trade_hours / 24).toFixed(1)}d`
          : `${stats.avg_trade_hours.toFixed(1)}h`
        : "n/a",
    },
  ];
  if (stats.buy_hold_return_pct != null) {
    cells.push({
      label: "Buy and hold",
      value: `${stats.buy_hold_return_pct >= 0 ? "+" : ""}${stats.buy_hold_return_pct.toFixed(1)}%`,
      tone: stats.total_return_pct >= stats.buy_hold_return_pct ? "up" : "muted",
    });
  }

  return (
    <Card className="shrink-0">
      <CardContent>
        <StatGroup>
          {cells.map((c) => (
            <Stat key={c.label} label={c.label} value={c.value} tone={c.tone ?? "default"} />
          ))}
        </StatGroup>
      </CardContent>
    </Card>
  );
}
