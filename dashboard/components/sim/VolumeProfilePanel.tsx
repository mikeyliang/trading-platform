"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface Props {
  bins: number[];      // lower edge of each price bin (ascending)
  volumes: number[];
  poc: number;
  vah: number;
  val: number;
  lastPrice?: number;
}

const HEIGHT = 200; // px — all bins always fit, no scrolling

/** Compact horizontal volume-by-price histogram. All bins render in a fixed
 *  height; price labels only at the key levels (high / POC / last / low). */
export function VolumeProfilePanel({ bins, volumes, poc, vah, val, lastPrice }: Props) {
  const { rows, pocIdx, lastIdx } = useMemo(() => {
    const maxV = Math.max(...volumes, 1);
    const rows = bins
      .map((price, i) => ({
        price,
        frac: volumes[i] / maxV,
        inVA: price >= val && price <= vah,
      }))
      .reverse(); // top = highest price
    const nearest = (target: number) => {
      let best = 0;
      let bestD = Infinity;
      rows.forEach((r, i) => {
        const d = Math.abs(r.price - target);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    };
    return {
      rows,
      pocIdx: nearest(poc),
      lastIdx: lastPrice != null ? nearest(lastPrice) : null,
    };
  }, [bins, volumes, poc, vah, val, lastPrice]);

  if (!rows.length) return null;

  const yPct = (i: number) => ((i + 0.5) / rows.length) * 100;
  // suppress a label when it would overlap another one
  const clearOf = (i: number, others: (number | null)[]) =>
    others.every((o) => o == null || Math.abs(yPct(i) - yPct(o)) > 7);

  const axisLabel = (i: number, value: string, cls: string) => (
    <span
      className={cn("absolute right-0 leading-none", cls)}
      style={{ top: `${yPct(i)}%`, transform: "translateY(-50%)" }}
    >
      {value}
    </span>
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-text-muted px-0.5">
        <span>vol · price</span>
        <span className="tabular text-amber-400">POC {poc.toFixed(2)}</span>
      </div>

      <div className="flex gap-1.5">
        {/* bars */}
        <div className="relative flex-1 flex flex-col" style={{ height: HEIGHT }}>
          {rows.map((r, i) => (
            <div key={r.price} className="flex-1 min-h-0 flex items-center">
              <div
                className={cn(
                  "h-[70%] min-h-px rounded-r-[1px]",
                  i === pocIdx ? "bg-amber-500/90" : r.inVA ? "bg-accent/55" : "bg-surface-3"
                )}
                style={{ width: `${Math.max(r.frac * 100, 2)}%` }}
              />
            </div>
          ))}
          {lastIdx != null && (
            <div
              className="absolute inset-x-0 border-t border-dashed border-text-secondary/60 pointer-events-none"
              style={{ top: `${yPct(lastIdx)}%` }}
            />
          )}
        </div>

        {/* price axis — only the levels that matter */}
        <div className="relative w-11 shrink-0 text-[9px] tabular text-right" style={{ height: HEIGHT }}>
          {clearOf(0, [pocIdx, lastIdx]) &&
            axisLabel(0, rows[0].price.toFixed(2), "text-text-muted")}
          {(lastIdx == null || clearOf(pocIdx, [lastIdx])) &&
            axisLabel(pocIdx, rows[pocIdx].price.toFixed(2), "text-amber-400")}
          {lastIdx != null && lastPrice != null &&
            axisLabel(lastIdx, lastPrice.toFixed(2), "text-text-primary")}
          {clearOf(rows.length - 1, [pocIdx, lastIdx]) &&
            axisLabel(rows.length - 1, rows[rows.length - 1].price.toFixed(2), "text-text-muted")}
        </div>
      </div>

      <div className="flex items-center justify-between text-[9px] tabular text-text-muted px-0.5">
        <span>VAL {val.toFixed(2)}</span>
        <span>VAH {vah.toFixed(2)}</span>
      </div>
    </div>
  );
}
