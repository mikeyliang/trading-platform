"use client";

import { useMemo } from "react";
import { fmt } from "@/lib/utils";

interface Props {
  spot: number;
  shortStrike: number;
  longStrike: number;
  credit: number;
  contracts: number;
  height?: number;
}

// Bull-put credit spread payoff at expiration, in dollars.
// Short put has the higher strike (the one we sell). Long put is lower
// and limits downside.
export function PayoffChart({
  spot,
  shortStrike,
  longStrike,
  credit,
  contracts,
  height = 200,
}: Props) {
  const data = useMemo(() => {
    if (!shortStrike || !longStrike || shortStrike <= longStrike) return null;

    const width = shortStrike - longStrike;
    const maxLossPerShare = Math.max(width - credit, 0.01);
    const maxProfit = credit * 100 * Math.max(contracts, 1);
    const maxLoss = -maxLossPerShare * 100 * Math.max(contracts, 1);
    const breakeven = shortStrike - credit;

    // x-domain: 15% below long strike to 10% above spot or short strike
    const xMin = longStrike * 0.85;
    const xMax = Math.max(spot, shortStrike) * 1.1;

    // Sample 4 keypoints for the broken-line payoff
    const points = [
      { x: xMin, pnl: maxLoss },
      { x: longStrike, pnl: maxLoss },
      { x: shortStrike, pnl: maxProfit },
      { x: xMax, pnl: maxProfit },
    ];

    return { points, xMin, xMax, maxProfit, maxLoss, breakeven, width };
  }, [spot, shortStrike, longStrike, credit, contracts]);

  if (!data) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-text-muted border border-dashed border-border rounded-md"
        style={{ height }}
      >
        enter strikes (short &gt; long) to render payoff
      </div>
    );
  }

  const { points, xMin, xMax, maxProfit, maxLoss, breakeven } = data;
  const yMin = maxLoss * 1.15;
  const yMax = maxProfit * 1.6;

  // SVG dimensions (will use viewBox so this scales)
  const W = 800;
  const H = height;
  const padL = 56;
  const padR = 16;
  const padT = 12;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const xs = (x: number) => padL + ((x - xMin) / (xMax - xMin)) * innerW;
  const ys = (y: number) => padT + ((yMax - y) / (yMax - yMin)) * innerH;

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xs(p.x).toFixed(2)} ${ys(p.pnl).toFixed(2)}`)
    .join(" ");

  // Fill area between line and zero, split into profit (green) and loss (red)
  const zeroY = ys(0);
  const profitArea =
    `M ${xs(breakeven).toFixed(2)} ${zeroY.toFixed(2)} ` +
    `L ${xs(shortStrike).toFixed(2)} ${ys(maxProfit).toFixed(2)} ` +
    `L ${xs(xMax).toFixed(2)} ${ys(maxProfit).toFixed(2)} ` +
    `L ${xs(xMax).toFixed(2)} ${zeroY.toFixed(2)} Z`;
  const lossArea =
    `M ${xs(xMin).toFixed(2)} ${zeroY.toFixed(2)} ` +
    `L ${xs(xMin).toFixed(2)} ${ys(maxLoss).toFixed(2)} ` +
    `L ${xs(longStrike).toFixed(2)} ${ys(maxLoss).toFixed(2)} ` +
    `L ${xs(breakeven).toFixed(2)} ${zeroY.toFixed(2)} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }}>
      {/* axes */}
      <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke="currentColor" strokeOpacity={0.3} strokeWidth={1} />
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="currentColor" strokeOpacity={0.3} strokeWidth={1} />

      {/* fills */}
      <path d={profitArea} className="fill-up/15" />
      <path d={lossArea} className="fill-down/15" />

      {/* zero line label */}
      <text x={padL - 6} y={zeroY + 3} textAnchor="end" className="fill-text-muted text-[9px]">0</text>
      <text x={padL - 6} y={ys(maxProfit) + 3} textAnchor="end" className="fill-up text-[9px]">
        ${fmt(maxProfit, 0)}
      </text>
      <text x={padL - 6} y={ys(maxLoss) + 3} textAnchor="end" className="fill-down text-[9px]">
        -${fmt(Math.abs(maxLoss), 0)}
      </text>

      {/* strike markers */}
      <line x1={xs(longStrike)} y1={padT} x2={xs(longStrike)} y2={H - padB} className="stroke-text-muted/30" strokeDasharray="3 3" />
      <line x1={xs(shortStrike)} y1={padT} x2={xs(shortStrike)} y2={H - padB} className="stroke-text-muted/30" strokeDasharray="3 3" />
      <line x1={xs(breakeven)} y1={padT} x2={xs(breakeven)} y2={H - padB} className="stroke-warning/60" strokeDasharray="2 2" />
      <line x1={xs(spot)} y1={padT} x2={xs(spot)} y2={H - padB} className="stroke-accent/70" strokeWidth={1.5} />

      <text x={xs(longStrike)} y={H - padB + 12} textAnchor="middle" className="fill-text-muted text-[9px]">
        L {fmt(longStrike, 0)}
      </text>
      <text x={xs(shortStrike)} y={H - padB + 12} textAnchor="middle" className="fill-text-muted text-[9px]">
        S {fmt(shortStrike, 0)}
      </text>
      <text x={xs(breakeven)} y={padT - 2} textAnchor="middle" className="fill-warning text-[9px]">
        BE {fmt(breakeven, 0)}
      </text>
      <text x={xs(spot)} y={padT - 2} textAnchor="middle" className="fill-accent text-[9px]">
        spot {fmt(spot, 0)}
      </text>

      {/* payoff line */}
      <path d={pathD} fill="none" className="stroke-text-primary" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}
