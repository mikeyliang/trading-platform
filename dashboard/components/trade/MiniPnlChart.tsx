"use client";

import { useMemo } from "react";
import { CHART } from "@/lib/chartTheme";
import { samplePriceAxis, expiryIntrinsicCurve, type PnlInputs } from "@/lib/bs";

interface Props {
  spot: number;
  strike: number;
  /** Years to expiry — drives the BS pricer for the "today" curve. */
  dteYears: number;
  iv: number;
  isCall: boolean;
  isLong: boolean;
  /** Premium per share (mid). */
  entryPrice: number;
  breakeven: number;
  /** Half-width of the price axis as a fraction of spot. Default ±35%. */
  range?: number;
  className?: string;
}

const W = 240;
const H = 60;
const PAD_Y = 6;

/**
 * Minimalist P/L-at-expiry sparkline. No axes, no interaction — just the
 * intrinsic-value curve split into profit (green) / loss (red) about the
 * zero line, with faint spot, strike, and break-even markers. Designed to
 * sit inside a "best pick" card and read at a glance.
 */
export function MiniPnlChart({
  spot,
  strike,
  dteYears,
  iv,
  isCall,
  isLong,
  entryPrice,
  breakeven,
  range = 0.35,
  className,
}: Props) {
  const { profitPath, lossPath, zeroY, spotX, strikeX, beX } = useMemo(() => {
    const prices = samplePriceAxis(spot, range, 121);
    const inputs: PnlInputs = {
      spot,
      strike,
      dteYears,
      iv: iv > 0 ? iv : 0.3,
      isCall,
      isLong,
      entryPrice,
      quantity: 1,
    };
    const pnl = expiryIntrinsicCurve(prices, inputs);

    const lo = prices[0];
    const hi = prices[prices.length - 1];
    const maxAbs = Math.max(1, ...pnl.map((v) => Math.abs(v)));

    const x = (p: number) => ((p - lo) / (hi - lo)) * W;
    const y = (v: number) => {
      const t = v / maxAbs; // -1..1
      return H / 2 - t * (H / 2 - PAD_Y);
    };

    // Build two clipped polylines so profit/loss can be coloured separately.
    // Insert zero-crossing points so the colour switches exactly at PnL=0.
    const profit: string[] = [];
    const loss: string[] = [];
    for (let i = 0; i < prices.length; i++) {
      const px = x(prices[i]);
      const v = pnl[i];
      const pt = `${px.toFixed(1)},${y(v).toFixed(1)}`;
      (v >= 0 ? profit : loss).push(pt);
      // crossing → add the zero point to both so segments meet the axis
      if (i > 0) {
        const prevV = pnl[i - 1];
        if ((prevV < 0 && v >= 0) || (prevV >= 0 && v < 0)) {
          const frac = Math.abs(prevV) / (Math.abs(prevV) + Math.abs(v) || 1);
          const cx = x(prices[i - 1]) + (px - x(prices[i - 1])) * frac;
          const cross = `${cx.toFixed(1)},${y(0).toFixed(1)}`;
          profit.push(cross);
          loss.push(cross);
        }
      }
    }

    const toPath = (pts: string[]) => (pts.length >= 2 ? `M ${pts.join(" L ")}` : "");
    const inRange = (p: number) => p >= lo && p <= hi;
    return {
      profitPath: toPath(profit),
      lossPath: toPath(loss),
      zeroY: y(0),
      spotX: inRange(spot) ? x(spot) : null,
      strikeX: inRange(strike) ? x(strike) : null,
      beX: inRange(breakeven) ? x(breakeven) : null,
    };
  }, [spot, strike, dteYears, iv, isCall, isLong, entryPrice, breakeven, range]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      style={{ width: "100%", height: H }}
      role="img"
      aria-label="Profit and loss at expiry"
    >
      {/* zero line */}
      <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke={CHART.axis} strokeWidth={1} />
      {/* strike marker */}
      {strikeX != null && (
        <line x1={strikeX} x2={strikeX} y1={0} y2={H} stroke={CHART.ref.strike} strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
      )}
      {/* break-even marker */}
      {beX != null && (
        <line x1={beX} x2={beX} y1={0} y2={H} stroke={CHART.ref.be} strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
      )}
      {/* P/L curve */}
      {lossPath && <path d={lossPath} fill="none" stroke={CHART.pnl.loss} strokeWidth={1.5} />}
      {profitPath && <path d={profitPath} fill="none" stroke={CHART.pnl.profit} strokeWidth={1.5} />}
      {/* spot marker */}
      {spotX != null && (
        <line x1={spotX} x2={spotX} y1={0} y2={H} stroke={CHART.text} strokeWidth={1} opacity={0.35} />
      )}
    </svg>
  );
}
