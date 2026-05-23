"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChartHover } from "@/lib/useChartHover";
import { cn } from "@/lib/utils";
import { CHART } from "@/lib/chartTheme";
import {
  expiryIntrinsicCurve,
  pnlCurve,
  samplePriceAxis,
  type PnlInputs,
} from "@/lib/bs";

interface Props {
  /** Live underlying price — drives the spot marker and is the center of
   *  the sampled price axis. */
  spot: number;
  /** Break-even at expiry. Annotated on the zero line. */
  breakeven: number;
  /** Strike. Annotated as a vertical line. */
  strike: number;
  /** ±1σ band from the backend forecast — drawn as faint top-edge ticks. */
  sigma1Low: number | null;
  sigma1High: number | null;
  /** ±2σ (unused but kept in the API for future widening). */
  sigma2Low: number | null;
  sigma2High: number | null;
  /** Static max/min reference lines. */
  maxProfit: number | null;
  maxLoss: number | null;
  /** Position + contract details — fed to the Black-Scholes pricer when
   *  the user drags the sliders. */
  iv: number;
  dteYears: number;
  right: "C" | "P";
  entryPrice: number;
  quantity: number;
  isLong: boolean;
  /** POP / P(ITM) — chip displayed in the top-right corner. */
  pop?: number | null;
  probItm?: number | null;
  height?: number;
}

/** OptionStrat-style interactive P/L profile.
 *
 *  Three sliders below the chart drive the curve:
 *   - **Date**       (0d → DTE): which future date the curve evaluates at.
 *                    0 = today; DTE = expiry intrinsic.
 *   - **IV**         (50% → 200% of current): what-if implied vol moved.
 *   - **Range**      (±10% → ±50% of spot): X-axis zoom.
 *
 *  Curves are computed client-side via Black-Scholes (lib/bs.ts), so
 *  dragging is instant — no backend round-trip. A faint at-expiry
 *  intrinsic curve sits behind the live curve as a reference shape.
 *
 *  Replaces the old three-discrete-curves (today / halfway / expiry)
 *  pre-computed by the backend, which couldn't answer "what about day
 *  18 at IV 150%?" without scrolling back to ask.
 */
export function PnlProfileChart({
  spot, breakeven, strike,
  sigma1Low, sigma1High, sigma2Low: _s2Lo, sigma2High: _s2Hi,
  maxProfit, maxLoss,
  iv, dteYears,
  right, entryPrice, quantity, isLong,
  pop, probItm,
  height = 360,
}: Props) {
  // Chart-only height now. Sliders sit OUTSIDE the SVG (as real DOM
  // controls below the chart), which lets them be properly interactive
  // and accessible — the previous in-SVG approach mixed render space.
  const W = 920;
  const H = height;
  const PAD_L = 60;
  const PAD_R = 18;
  const PAD_T = 32;
  const PAD_B = 36;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  // ── slider state ─────────────────────────────────────────────────────
  const dteDays = Math.max(1, Math.round(dteYears * 365.25));
  const [daysFromNow, setDaysFromNow] = useState(0);
  const [ivMult, setIvMult] = useState(1);
  const [range, setRange] = useState(0.25);

  // Reset sliders when the contract changes — the absolute DTE bound
  // can shift and stale slider values produce nonsense curves.
  useEffect(() => {
    setDaysFromNow(0);
    setIvMult(1);
  }, [strike, right, entryPrice, dteYears, iv]);

  // Pinned target price (click on chart).
  const [target, setTarget] = useState<number | null>(null);
  useEffect(() => { setTarget(null); }, [strike, spot]);

  // ── curve computation ────────────────────────────────────────────────
  const inputs: PnlInputs = useMemo(() => ({
    spot, strike, dteYears, iv,
    isCall: right === "C",
    isLong,
    entryPrice,
    quantity,
  }), [spot, strike, dteYears, iv, right, isLong, entryPrice, quantity]);

  const prices = useMemo(() => samplePriceAxis(spot, range, 161), [spot, range]);
  const liveCurve = useMemo(
    () => pnlCurve(prices, daysFromNow, ivMult, inputs),
    [prices, daysFromNow, ivMult, inputs],
  );
  const expiryCurve = useMemo(
    () => expiryIntrinsicCurve(prices, inputs),
    [prices, inputs],
  );

  // ── axes ─────────────────────────────────────────────────────────────
  const { xOf, yOf, yZero, yTicks, xMin, xMax, mu, sd } = useMemo(() => {
    const all = [...liveCurve, ...expiryCurve];
    const minPnl = all.length ? Math.min(...all, 0) : 0;
    const maxPnl = all.length ? Math.max(...all, 0) : 0;
    const padY = Math.max(1, (maxPnl - minPnl) * 0.12);
    const yMn = minPnl - padY;
    const yMx = maxPnl + padY;
    const xMn = Math.min(...prices);
    const xMx = Math.max(...prices);

    const xOf = (p: number) => PAD_L + ((p - xMn) / (xMx - xMn)) * innerW;
    const yOf = (v: number) => PAD_T + innerH - ((v - yMn) / (yMx - yMn)) * innerH;
    const yZero = yOf(0);

    const rng = yMx - yMn;
    const target = 5;
    const rawStep = rng / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = Math.ceil(rawStep / mag) * mag;
    const ticks: number[] = [];
    const start = Math.ceil(yMn / step) * step;
    for (let v = start; v <= yMx; v += step) ticks.push(v);

    // Lognormal density backdrop (still here as a subtle hint of where
    // the realized return is likely to land).
    const sd = iv > 0 && dteYears > 0 ? iv * Math.sqrt(dteYears) : 0;
    const mu = spot > 0 ? Math.log(spot) - 0.5 * sd * sd : 0;

    return { xOf, yOf, yZero, yTicks: ticks, xMin: xMn, xMax: xMx, mu, sd };
  }, [prices, liveCurve, expiryCurve, innerW, innerH, iv, dteYears, spot]);

  // Smooth cubic-Bezier curve generator (Catmull-Rom interpolation).
  const smoothPath = (vals: number[]) => {
    const pts = prices.map((p, i) => [xOf(p), yOf(vals[i])] as [number, number]);
    if (pts.length < 2) return "";
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || pts[i + 1];
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  };

  const livePath = useMemo(() => smoothPath(liveCurve), [prices, liveCurve, xOf, yOf]);
  const expiryPath = useMemo(() => smoothPath(expiryCurve), [prices, expiryCurve, xOf, yOf]);

  // Profit/loss fills under the LIVE curve (the slider-driven one).
  const { profitArea, lossArea } = useMemo(() => {
    const build = (test: (v: number) => boolean) => {
      const segs: string[] = [];
      let inSeg = false;
      for (let i = 0; i < prices.length; i++) {
        const v = liveCurve[i];
        const x = xOf(prices[i]);
        const y = yOf(v);
        if (test(v) && !inSeg) {
          inSeg = true;
          segs.push(`M${x.toFixed(1)},${yZero.toFixed(1)} L${x.toFixed(1)},${y.toFixed(1)}`);
        } else if (test(v) && inSeg) {
          segs.push(`L${x.toFixed(1)},${y.toFixed(1)}`);
        } else if (!test(v) && inSeg) {
          inSeg = false;
          segs.push(`L${x.toFixed(1)},${yZero.toFixed(1)} Z`);
        }
      }
      if (inSeg) {
        const x = xOf(prices[prices.length - 1]);
        segs.push(`L${x.toFixed(1)},${yZero.toFixed(1)} Z`);
      }
      return segs.join(" ");
    };
    return { profitArea: build((v) => v >= 0), lossArea: build((v) => v < 0) };
  }, [prices, liveCurve, xOf, yOf, yZero]);

  const densityStops = useMemo(() => {
    if (sd <= 0 || spot <= 0) return [] as { offset: number; opacity: number }[];
    const n = 50;
    const samples: { offset: number; pdf: number }[] = [];
    let maxPdf = 0;
    for (let i = 0; i <= n; i++) {
      const offset = i / n;
      const p = xMin + offset * (xMax - xMin);
      if (p <= 0) { samples.push({ offset, pdf: 0 }); continue; }
      const z = (Math.log(p) - mu) / sd;
      const pdf = (1 / (p * sd * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * z * z);
      samples.push({ offset, pdf });
      if (pdf > maxPdf) maxPdf = pdf;
    }
    if (maxPdf <= 0) return [];
    return samples.map((s) => ({ offset: s.offset, opacity: (s.pdf / maxPdf) * 0.1 }));
  }, [sd, mu, spot, xMin, xMax]);

  const cdf = (price: number): number | null => {
    if (sd <= 0 || price <= 0) return null;
    const z = (Math.log(price) - mu) / sd;
    return 0.5 * (1 + erf(z / Math.sqrt(2)));
  };

  const xTicks = useMemo(() => {
    const n = 6;
    const out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(xMin + ((xMax - xMin) * i) / n);
    return out;
  }, [xMin, xMax]);

  const { activeIndex, onMouseMove, onMouseLeave } = useChartHover({
    count: prices.length, svgWidth: W, padLeft: PAD_L, padRight: PAD_R,
  });
  const hover = activeIndex != null
    ? {
        price: prices[activeIndex],
        live: liveCurve[activeIndex],
        expiry: expiryCurve[activeIndex],
        cumProb: cdf(prices[activeIndex]),
      }
    : null;

  const targetData = useMemo(() => {
    if (target == null) return null;
    let best = 0; let bestDiff = Infinity;
    for (let i = 0; i < prices.length; i++) {
      const d = Math.abs(prices[i] - target);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return {
      price: target,
      live: liveCurve[best],
      expiry: expiryCurve[best],
      cumProb: cdf(target),
    };
  }, [target, prices, liveCurve, expiryCurve]);

  const readout = hover ?? targetData;
  const readoutLabel = hover ? "hover" : targetData ? "target" : null;

  // Derived display labels for slider state.
  const tRemainingDays = Math.max(0, dteDays - daysFromNow);
  const dateLabel = daysFromNow === 0
    ? "today"
    : daysFromNow >= dteDays
      ? "expiry"
      : `+${daysFromNow}d`;

  // What's the position worth RIGHT NOW at current sliders? This is the
  // single most useful number on the chart — surfaces as a big tabular
  // headline above the curve. Recomputed on every slider drag via BS.
  const spotPnlNow = useMemo(() => {
    // Find the closest sampled price to spot (linear scan is fine for
    // 161-sample axes).
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < prices.length; i++) {
      const d = Math.abs(prices[i] - spot);
      if (d < bd) { bd = d; bi = i; }
    }
    return { live: liveCurve[bi], expiry: expiryCurve[bi] };
  }, [prices, spot, liveCurve, expiryCurve]);

  // ── render ───────────────────────────────────────────────────────────
  return (
    <div className="relative w-full">
      {/* Position-at-spot summary — the headline reading. Big tabular
          number on the left ("P/L if spot stays here at <date>, IV=<×>"),
          comparison to expiry-intrinsic on the right. Both live curves
          are surfaced so the user immediately sees the time-value vs
          intrinsic split. */}
      <div className="flex items-baseline gap-4 px-1 mb-3 flex-wrap">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            at spot @ {dateLabel}
          </span>
          <span className={cn(
            "text-[18px] tabular font-bold leading-none",
            spotPnlNow.live >= 0 ? "text-up" : "text-down",
          )}>
            {fmtPnl(spotPnlNow.live)}
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">if expiry</span>
          <span className={cn(
            "text-[14px] tabular font-semibold",
            spotPnlNow.expiry >= 0 ? "text-up" : "text-down",
          )}>
            {fmtPnl(spotPnlNow.expiry)}
          </span>
        </div>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-text-muted">
          {(ivMult * 100).toFixed(0)}% IV · ±{(range * 100).toFixed(0)}% range
        </span>
      </div>

      <svg
        width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        className="block cursor-crosshair"
        onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}
        onClick={() => { if (hover) setTarget(hover.price === target ? null : hover.price); }}
      >
        <defs>
          <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART.pnl.profit} stopOpacity="0.42" />
            <stop offset="100%" stopColor={CHART.pnl.profit} stopOpacity="0.04" />
          </linearGradient>
          <linearGradient id="lossGrad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={CHART.pnl.loss} stopOpacity="0.38" />
            <stop offset="100%" stopColor={CHART.pnl.loss} stopOpacity="0.04" />
          </linearGradient>
          {densityStops.length > 0 && (
            <linearGradient id="densityGrad" x1="0" y1="0" x2="1" y2="0">
              {densityStops.map((s, i) => (
                <stop key={i} offset={`${(s.offset * 100).toFixed(1)}%`}
                      stopColor={CHART.axisText} stopOpacity={s.opacity} />
              ))}
            </linearGradient>
          )}
        </defs>

        {/* Probability density backdrop */}
        {densityStops.length > 0 && (
          <rect x={PAD_L} y={PAD_T} width={innerW} height={innerH} fill="url(#densityGrad)" />
        )}

        {/* Y gridlines */}
        {yTicks.map((t, i) => (
          <g key={`gy-${i}`}>
            <line x1={PAD_L} x2={W - PAD_R} y1={yOf(t)} y2={yOf(t)}
                  stroke={CHART.axisText}
                  strokeOpacity={t === 0 ? 0.45 : 0.05}
                  strokeWidth={t === 0 ? 1 : 1} />
            <text x={PAD_L - 8} y={yOf(t) + 4} fontSize="11"
                  fill={t === 0 ? CHART.axisText : CHART.textMuted}
                  textAnchor="end" className="tabular-nums">
              {fmtPnl(t)}
            </text>
          </g>
        ))}

        {/* X ticks */}
        {xTicks.map((p, i) => (
          <g key={`xt-${i}`}>
            <text x={xOf(p)} y={H - 8} fontSize="11" fill={CHART.axisText}
                  textAnchor="middle" className="tabular-nums">
              {p < 100 ? p.toFixed(2) : p.toFixed(0)}
            </text>
            <text x={xOf(p)} y={H + 4} fontSize="9" fill={CHART.textMuted}
                  textAnchor="middle" className="tabular-nums">
              {pctFromSpot(p, spot)}
            </text>
          </g>
        ))}

        {/* Profit/loss fills under the LIVE curve */}
        <path d={profitArea} fill="url(#profitGrad)" />
        <path d={lossArea}   fill="url(#lossGrad)" />

        {/* Max profit / loss horizontal references */}
        {maxProfit != null && isFinite(maxProfit) && maxProfit > 0 && (
          <line x1={PAD_L} x2={W - PAD_R} y1={yOf(maxProfit)} y2={yOf(maxProfit)}
                stroke={CHART.pnl.profit} strokeOpacity={0.30} strokeDasharray="3 5" />
        )}
        {maxLoss != null && isFinite(maxLoss) && maxLoss < 0 && (
          <line x1={PAD_L} x2={W - PAD_R} y1={yOf(maxLoss)} y2={yOf(maxLoss)}
                stroke={CHART.pnl.loss} strokeOpacity={0.30} strokeDasharray="3 5" />
        )}

        {/* Expiry intrinsic reference — faded, behind the live curve. */}
        <path d={expiryPath} stroke={CHART.pnl.expiry}
              strokeOpacity={0.32} strokeWidth="1.5"
              strokeDasharray="6 4" fill="none" />

        {/* Live curve — slider-driven, bold, foreground. */}
        <path d={livePath} stroke={CHART.pnl.expiry} strokeWidth="2.5"
              fill="none" />

        {/* Spot vertical line + chip */}
        {spot >= xMin && spot <= xMax && (
          <g>
            <line x1={xOf(spot)} x2={xOf(spot)} y1={PAD_T} y2={H - 16}
                  stroke={CHART.text} strokeOpacity={0.45} strokeWidth={1} />
            <g transform={`translate(${xOf(spot)}, ${PAD_T - 4})`}>
              <rect x={-32} y={-18} width="64" height="16" rx="3" fill={CHART.text} />
              <text x={0} y={-7} fontSize="10" fill={CHART.bg} textAnchor="middle" fontWeight="600">
                SPOT {spot.toFixed(2)}
              </text>
            </g>
          </g>
        )}

        {/* Strike marker */}
        {strike >= xMin && strike <= xMax && (
          <g>
            <line x1={xOf(strike)} x2={xOf(strike)} y1={PAD_T} y2={H - 16}
                  stroke={CHART.ref.strike} strokeOpacity={0.55} strokeDasharray="4 3" />
            <text x={xOf(strike)} y={H - 24} fontSize="10" fill={CHART.ref.strike}
                  textAnchor="middle" fontWeight="600">K {strike}</text>
          </g>
        )}

        {/* Breakeven dot on zero line */}
        {breakeven >= xMin && breakeven <= xMax && (
          <g>
            <line x1={xOf(breakeven)} x2={xOf(breakeven)} y1={yZero - 7} y2={yZero + 7}
                  stroke={CHART.text} strokeWidth={1.5} />
            <circle cx={xOf(breakeven)} cy={yZero} r={3.5} fill={CHART.text} />
            <text x={xOf(breakeven)} y={yZero - 11} fontSize="10" fill={CHART.text}
                  textAnchor="middle" fontWeight="500">BE {breakeven.toFixed(2)}</text>
          </g>
        )}

        {/* ±1σ ticks at the top */}
        {sigma1Low != null && sigma1Low >= xMin && sigma1Low <= xMax && (
          <g>
            <line x1={xOf(sigma1Low)} x2={xOf(sigma1Low)} y1={PAD_T} y2={PAD_T + 5}
                  stroke={CHART.axisText} strokeOpacity={0.7} />
            <text x={xOf(sigma1Low)} y={PAD_T - 18} fontSize="9" fill={CHART.axisText}
                  textAnchor="middle">−1σ</text>
          </g>
        )}
        {sigma1High != null && sigma1High >= xMin && sigma1High <= xMax && (
          <g>
            <line x1={xOf(sigma1High)} x2={xOf(sigma1High)} y1={PAD_T} y2={PAD_T + 5}
                  stroke={CHART.axisText} strokeOpacity={0.7} />
            <text x={xOf(sigma1High)} y={PAD_T - 18} fontSize="9" fill={CHART.axisText}
                  textAnchor="middle">+1σ</text>
          </g>
        )}

        {/* Pinned target */}
        {targetData && targetData.price >= xMin && targetData.price <= xMax && (
          <g>
            <line x1={xOf(targetData.price)} x2={xOf(targetData.price)}
                  y1={PAD_T} y2={H - 16}
                  stroke={CHART.pnl.target} strokeWidth={1.5} />
            <g transform={`translate(${xOf(targetData.price)}, ${H - 12})`}>
              <rect x={-32} y={0} width="64" height="14" rx="3" fill={CHART.pnl.target} />
              <text x={0} y={10} fontSize="10" fill="white" textAnchor="middle" fontWeight="600">
                TGT {targetData.price.toFixed(2)}
              </text>
            </g>
          </g>
        )}

        {/* Hover crosshair */}
        {hover && (
          <g pointerEvents="none">
            <line x1={xOf(hover.price)} x2={xOf(hover.price)} y1={PAD_T} y2={H - 16}
                  stroke={CHART.text} strokeOpacity={0.3} strokeDasharray="3 3" />
            <circle cx={xOf(hover.price)} cy={yOf(hover.live)} r={4}
                    fill={CHART.pnl.expiry} stroke={CHART.bg} strokeWidth={1.5} />
            <circle cx={xOf(hover.price)} cy={yOf(hover.expiry)} r={3}
                    fill="none" stroke={CHART.pnl.expiry} strokeWidth={1}
                    strokeOpacity={0.65} strokeDasharray="2 2" />
          </g>
        )}
      </svg>

      {/* ── Sliders: Date · IV · Range ────────────────────────────────
          OptionStrat-style. Each slider drives a useMemo recompute via
          BS so the curves above redraw instantly. Preset chips next to
          each slider snap to common values without dragging. */}
      <div className="mt-3 pt-3 border-t border-border/40 grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-3 px-1">
        <SliderRow
          label="Date"
          accent={CHART.pnl.expiry}
          valueText={dateLabel}
          subText={`${tRemainingDays}d to expiry`}
          min={0} max={dteDays} step={1}
          value={daysFromNow}
          onChange={setDaysFromNow}
          minLabel="today"
          maxLabel="expiry"
          onReset={() => setDaysFromNow(0)}
          isDefault={daysFromNow === 0}
          presets={[
            { label: "today", value: 0 },
            { label: "¼", value: Math.round(dteDays * 0.25) },
            { label: "½", value: Math.round(dteDays * 0.5) },
            { label: "¾", value: Math.round(dteDays * 0.75) },
            { label: "exp", value: dteDays },
          ]}
        />
        <SliderRow
          label="IV"
          accent={CHART.forecast.cone}
          valueText={`${(ivMult * iv * 100).toFixed(1)}%`}
          subText={`${(ivMult * 100).toFixed(0)}% of current`}
          min={0.3} max={3} step={0.05}
          value={ivMult}
          onChange={setIvMult}
          minLabel="30%"
          maxLabel="300%"
          onReset={() => setIvMult(1)}
          isDefault={ivMult === 1}
          presets={[
            { label: "−40%", value: 0.6 },
            { label: "−20%", value: 0.8 },
            { label: "now", value: 1 },
            { label: "+20%", value: 1.2 },
            { label: "+40%", value: 1.4 },
          ]}
        />
        <SliderRow
          label="Range"
          accent={CHART.ref.strike}
          valueText={`±${(range * 100).toFixed(0)}%`}
          subText="window around spot"
          min={0.05} max={0.6} step={0.05}
          value={range}
          onChange={setRange}
          minLabel="±5%"
          maxLabel="±60%"
          onReset={() => setRange(0.25)}
          isDefault={range === 0.25}
          presets={[
            { label: "±10%", value: 0.10 },
            { label: "±25%", value: 0.25 },
            { label: "±50%", value: 0.50 },
          ]}
        />
      </div>

      {/* Top-right: POP chip */}
      <div className="absolute top-3 right-3 flex items-center gap-2">
        {(pop != null || probItm != null) && (
          <div className="flex items-center gap-2 text-[10px] tabular bg-surface/90 backdrop-blur rounded-md px-2 py-1 border border-border/40">
            {pop != null && (
              <span>
                <span className="text-text-muted">POP </span>
                <span className={cn(
                  "font-semibold",
                  pop >= 0.6 ? "text-up" : pop >= 0.4 ? "text-warning" : "text-down"
                )}>
                  {(pop * 100).toFixed(0)}%
                </span>
              </span>
            )}
            {probItm != null && (
              <span>
                <span className="text-text-muted">P(ITM) </span>
                <span className="text-text-primary font-semibold">{(probItm * 100).toFixed(0)}%</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Bottom hover/target readout strip */}
      {readout && (
        <div className="absolute top-3 left-[68px] flex items-center gap-4 text-[11px] tabular bg-surface/90 backdrop-blur rounded-md px-3 py-1.5 border border-border/40">
          <span className="text-text-muted uppercase tracking-wider text-[9px]">
            {readoutLabel}
          </span>
          <span>
            <span className="text-text-muted">price </span>
            <span className="text-text-primary font-semibold">{readout.price.toFixed(2)}</span>
          </span>
          {readout.cumProb != null && (
            <span>
              <span className="text-text-muted">P(≤) </span>
              <span className="text-text-primary font-semibold">{(readout.cumProb * 100).toFixed(0)}%</span>
            </span>
          )}
          <span style={{ color: CHART.pnl.expiry }}>
            {dateLabel}{" "}
            <span className={pnlClass(readout.live)}>{fmtPnl(readout.live)}</span>
          </span>
          <span className="text-text-muted">
            expiry{" "}
            <span className={pnlClass(readout.expiry)}>{fmtPnl(readout.expiry)}</span>
          </span>
          {targetData && !hover && (
            <button onClick={(e) => { e.stopPropagation(); setTarget(null); }}
                    className="text-text-muted hover:text-text-primary ml-1">✕</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── SliderRow ─────────────────────────────────────────────────────────
//   Dense pro-terminal styling: uppercase label, big tabular current
//   value (the headline), small secondary description below, then the
//   track with min/max endpoint anchors. Reset link surfaces when the
//   slider is off its default so a user always knows the way back.
function SliderRow({
  label,
  accent,
  valueText,
  subText,
  min,
  max,
  step,
  value,
  onChange,
  minLabel,
  maxLabel,
  onReset,
  isDefault,
  presets,
}: {
  label: string;
  accent: string;
  valueText: string;
  subText?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  minLabel: string;
  maxLabel: string;
  onReset: () => void;
  isDefault: boolean;
  presets?: { label: string; value: number }[];
}) {
  const pct = ((value - min) / (max - min)) * 100;
  // A preset chip is "active" when the current value matches it within a
  // half-step — important for floating-point sliders like IV multiplier
  // where 1.0 + drift wouldn't strictly equal 1.0.
  const isPresetActive = (pv: number) => Math.abs(value - pv) < step / 2;

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          {label}
        </span>
        <span
          className="text-[14px] tabular font-semibold leading-none"
          style={{ color: accent }}
        >
          {valueText}
        </span>
        {!isDefault && (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto text-[10px] uppercase tracking-wider text-text-muted hover:text-text-secondary transition-colors"
            title="Reset to default"
          >
            reset
          </button>
        )}
      </div>
      {subText && (
        <span className="text-[11px] tabular text-text-muted leading-none">
          {subText}
        </span>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider-range w-full mt-1"
        style={{
          background: `linear-gradient(to right, ${accent} 0%, ${accent} ${pct}%, ${CHART.surface} ${pct}%, ${CHART.surface} 100%)`,
        }}
      />
      {presets && presets.length > 0 ? (
        <div className="flex items-center gap-1 mt-0.5">
          {presets.map((p) => {
            const active = isPresetActive(p.value);
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => onChange(p.value)}
                className={cn(
                  "px-2 py-0.5 rounded text-[10px] tabular border transition-colors",
                  active
                    ? "border-transparent text-bg font-semibold"
                    : "border-border text-text-muted hover:text-text-secondary hover:border-text-muted/50",
                )}
                style={active ? { backgroundColor: accent } : undefined}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex justify-between text-[10px] tabular text-text-muted/70 leading-none">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
    </div>
  );
}

function pnlClass(v: number) {
  return v >= 0 ? "text-up font-semibold" : "text-down font-semibold";
}

function fmtPnl(v: number): string {
  if (!isFinite(v)) return v > 0 ? "∞" : "−∞";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${v < 0 ? "-" : ""}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${v < 0 ? "-" : ""}$${(a / 1_000).toFixed(1)}k`;
  return `${v < 0 ? "-" : ""}$${a.toFixed(0)}`;
}

function pctFromSpot(p: number, spot: number): string {
  if (!spot) return "";
  const d = (p - spot) / spot * 100;
  if (Math.abs(d) < 0.5) return "spot";
  return `${d >= 0 ? "+" : ""}${d.toFixed(0)}%`;
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429;
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}
