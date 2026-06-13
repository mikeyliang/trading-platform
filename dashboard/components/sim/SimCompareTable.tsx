"use client";

import type { SimRunSummary } from "@/lib/api";
import { cn, pnlClass } from "@/lib/utils";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";

interface Props {
  runs: SimRunSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** Dense cross-run comparison — every completed run side by side. */
export function SimCompareTable({ runs, selectedId, onSelect }: Props) {
  const completed = runs
    .filter((r) => r.aggregate)
    .sort((a, b) => (b.aggregate!.avg_sharpe - a.aggregate!.avg_sharpe));

  if (completed.length === 0) {
    return <p className="text-[11px] text-text-muted px-3 py-2">no completed runs to compare</p>;
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
          <TableHead>run</TableHead>
          <TableHead>preset</TableHead>
          <TableHead>tf</TableHead>
          <TableHead className="text-right">return</TableHead>
          <TableHead className="text-right">PF</TableHead>
          <TableHead className="text-right">Sharpe</TableHead>
          <TableHead className="text-right">max DD</TableHead>
          <TableHead className="text-right">trades</TableHead>
          <TableHead className="text-right">win</TableHead>
          <TableHead>best / worst</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {completed.map((r) => {
          const a = r.aggregate!;
          return (
            <TableRow
              key={r.id}
              onClick={() => onSelect(r.id)}
              className={cn("cursor-pointer", selectedId === r.id && "bg-surface-2")}
            >
              <TableCell className="max-w-44 truncate" title={r.label}>{r.label}</TableCell>
              <TableCell className="text-text-muted">{r.preset.replace("confluence-", "")}</TableCell>
              <TableCell className="tabular text-text-muted">{r.timeframe}</TableCell>
              <TableCell className={cn("text-right tabular", pnlClass(a.avg_return_pct), a.avg_return_pct === best.ret && "font-semibold")}>
                {a.avg_return_pct >= 0 ? "+" : ""}{a.avg_return_pct.toFixed(2)}%
              </TableCell>
              <TableCell className={cn("text-right tabular", a.profit_factor >= 1 ? "text-up" : "text-down", a.profit_factor === best.pf && "font-semibold")}>
                {a.profit_factor.toFixed(2)}
              </TableCell>
              <TableCell className={cn("text-right tabular", a.avg_sharpe === best.sharpe && "font-semibold text-up")}>
                {a.avg_sharpe.toFixed(2)}
              </TableCell>
              <TableCell className={cn("text-right tabular text-down/90", a.avg_max_drawdown_pct === best.dd && "font-semibold")}>
                {a.avg_max_drawdown_pct.toFixed(1)}%
              </TableCell>
              <TableCell className="text-right tabular">{a.total_trades}</TableCell>
              <TableCell className="text-right tabular">{a.win_rate.toFixed(0)}%</TableCell>
              <TableCell className="text-[10px] tabular whitespace-nowrap">
                <span className="text-up">{a.best_symbol.symbol} {a.best_symbol.return_pct >= 0 ? "+" : ""}{a.best_symbol.return_pct.toFixed(1)}%</span>
                <span className="text-text-muted"> / </span>
                <span className="text-down">{a.worst_symbol.symbol} {a.worst_symbol.return_pct >= 0 ? "+" : ""}{a.worst_symbol.return_pct.toFixed(1)}%</span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
