"use client";

import type { SimRunSummary } from "@/lib/api";
import { cn, pnlClass } from "@/lib/utils";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { RiFlaskLine } from "@remixicon/react";

interface Props {
  runs: SimRunSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** Dense cross-run comparison, every completed run side by side. */
export function SimCompareTable({ runs, selectedId, onSelect }: Props) {
  const completed = runs
    .filter((r) => r.aggregate)
    .sort((a, b) => (b.aggregate!.avg_sharpe - a.aggregate!.avg_sharpe));

  if (completed.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={RiFlaskLine}
        title="Nothing to compare"
        description="Completed runs line up here side by side."
      />
    );
  }

  const best = {
    ret: Math.max(...completed.map((r) => r.aggregate!.avg_return_pct)),
    pf: Math.max(...completed.map((r) => r.aggregate!.profit_factor)),
    sharpe: Math.max(...completed.map((r) => r.aggregate!.avg_sharpe)),
    dd: Math.min(...completed.map((r) => r.aggregate!.avg_max_drawdown_pct)),
  };

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Run</TableHead>
          <TableHead>Preset</TableHead>
          <TableHead>Timeframe</TableHead>
          <TableHead className="text-right">Return</TableHead>
          <TableHead className="text-right">Profit factor</TableHead>
          <TableHead className="text-right">Sharpe</TableHead>
          <TableHead className="text-right">Max drawdown</TableHead>
          <TableHead className="text-right">Trades</TableHead>
          <TableHead className="text-right">Win rate</TableHead>
          <TableHead>Best / worst</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {completed.map((r) => {
          const a = r.aggregate!;
          return (
            <TableRow
              key={r.id}
              onClick={() => onSelect(r.id)}
              data-state={selectedId === r.id ? "selected" : undefined}
              className="cursor-pointer"
            >
              <TableCell className="max-w-44 truncate" title={r.label}>{r.label}</TableCell>
              <TableCell className="text-text-tertiary">{r.preset.replace("confluence-", "")}</TableCell>
              <TableCell className="text-text-tertiary">{r.timeframe}</TableCell>
              <TableCell className={cn("text-right", pnlClass(a.avg_return_pct), a.avg_return_pct === best.ret && "text-body-2-semibold")}>
                {a.avg_return_pct >= 0 ? "+" : ""}{a.avg_return_pct.toFixed(2)}%
              </TableCell>
              <TableCell className={cn("text-right", a.profit_factor >= 1 ? "text-status-lime-text" : "text-status-rose-text", a.profit_factor === best.pf && "text-body-2-semibold")}>
                {a.profit_factor.toFixed(2)}
              </TableCell>
              <TableCell className={cn("text-right", a.avg_sharpe === best.sharpe && "text-body-2-semibold text-status-lime-text")}>
                {a.avg_sharpe.toFixed(2)}
              </TableCell>
              <TableCell className={cn("text-right text-status-rose-text", a.avg_max_drawdown_pct === best.dd && "text-body-2-semibold")}>
                -{Math.abs(a.avg_max_drawdown_pct).toFixed(1)}%
              </TableCell>
              <TableCell className="text-right">{a.total_trades}</TableCell>
              <TableCell className="text-right">{a.win_rate.toFixed(0)}%</TableCell>
              <TableCell className="whitespace-nowrap">
                <span className="inline-flex items-center gap-3 text-caption-1-medium">
                  <span className="text-status-lime-text">{a.best_symbol.symbol} {a.best_symbol.return_pct >= 0 ? "+" : ""}{a.best_symbol.return_pct.toFixed(1)}%</span>
                  <span className="text-status-rose-text">{a.worst_symbol.symbol} {a.worst_symbol.return_pct >= 0 ? "+" : ""}{a.worst_symbol.return_pct.toFixed(1)}%</span>
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
