"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { cn } from "@/lib/utils";
import { CHART } from "@/lib/chartTheme";
import {
  expiryIntrinsicCurve,
  pnlCurve,
  samplePriceAxis,
  type PnlInputs,
} from "@/lib/bs";

interface Props {
  /** Live underlying price — drives the spot marker and centres the axis. */
  spot: number;
  /** Break-even at expiry. Annotated on the zero line. */
  breakeven: number;
  /** Strike. Annotated as a vertical line. */
  strike: number;
  /** ±1σ band from the backend forecast — drawn as a shaded vertical band. */
  sigma1Low: number | null;
  sigma1High: number | null;
  /** ±2σ (unused but kept in the API for future widening). */
  sigma2Low: number | null;
  sigma2High: number | null;
  /** Static max/min reference lines. */
  maxProfit: number | null;
  maxLoss: number | null;
  /** Position + contract details — fed to the Black-Scholes pricer. */
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
 *  The signature interaction is a **draggable price cursor**: grab anywhere on
 *  the chart and slide to read the position's P/L at that underlying price,
 *  for the date + IV the sliders below are set to. Two curves: the bright
 *  "live" curve (today, or whatever future date the Date slider picks) and a
 *  faded dashed expiry-intrinsic reference behind it. Profit is shaded green
 *  above the zero line, loss red below.
 *
 *  All curves are Black-Scholes, computed client-side (lib/bs.ts), so dragging
 *  any control redraws instantly with no backend round-trip.
 */
export function PnlProfileChart({
  spot, breakeven, strike,
  sigma1Low, sigma1High, sigma2Low: _s2Lo, sigma2High: _s2Hi,
  maxProfit, maxLoss,
  iv, dteYears,
  right, entryPrice, quantity, isLong,
  pop, probItm,
  height = 340,
}: Props) {
  const W = 920;
  const H = height;
  const PAD_L = 58;
  const PAD_R = 16;
  const PAD_T = 30;
  const PAD_B = 34;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  // ── scenario state ─────────────────────────────────────────────────────
  const dteDays = Math.max(1, Math.round(dteYears * 365.25));
  const [daysFromNow, setDaysFromNow] = useState(0);
  const [ivMult, setIvMult] = useState(1);
  const [range, setRange] = useState(0.25);

  // Reset scenario when the contract changes (stale slider values otherwise
  // produce nonsense curves once the DTE bound shifts).
  useEffect(() => {
    setDaysFromNow(0);
    setIvMult(1);
  }, [strike, right, entryPrice, dteYears, iv]);

  // ── curves ───────────────────────────────────────────────────────────
  const inputs: PnlInputs = useMemo(() => ({
    spot, strike, dteYears, iv,
    isCall: right === "C", isLong, entryPrice, quantity,
  }), [spot, strike, dteYears, iv, right, isLong, entryPrice, quantity]);

  const prices = useMemo(() => samplePriceAxis(spot, range, 161), [spot, range]);
  const liveCurve = useMemo(
    () => pnlCurve(prices, daysFromNow, ivMult, inputs),
    [prices, daysFromNow, ivMult, inputs],
  );
  const expiryCurve = useMemo(() => expiryIntrinsicCurve(prices, inputs), [prices, inputs]);

  // Cost basis (net debit/credit) for % return readouts.
  const costBasis = Math.abs(entryPrice * Math.abs(quantity) * 100) || 0;

  // ── axes ─────────────────────────────────────────────────────────────
  const { xOf, yOf, yZero, yTicks, xMin, xMax, sd } = useMemo(() => {
    const all = [...liveCurve, ...expiryCurve];
    const minPnl = all.length ? Math.min(...all, 0) : 0;
    const maxPnl = all.length ? Math.max(...all, 0) : 0;
    const padY = Math.max(1, (maxPnl - minPnl) * 0.14);
    const yMn = minPnl - padY;
    const yMx = maxPnl + padY;
    const xMn = Math.min(...prices);
    const xMx = Math.max(...prices);

    const xOf = (p: number) => PAD_L + ((p - xMn) / (xMx - xMn)) * innerW;
    const yOf = (v: number) => PAD_T + innerH - ((v - yMn) / (yMx - yMn)) * innerH;

    const rng = yMx - yMn;
    const rawStep = rng / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const step = Math.max(1, Math.ceil(rawStep / mag) * mag);
    const ticks: number[] = [];
    const start = Math.ceil(yMn / step) * step;
    for (let v = start; v <= yMx; v += step) ticks.push(v);

    const sd = iv > 0 && dteYears > 0 ? iv * Math.sqrt(dteYears) : 0;
    return { xOf, yOf, yZero: yOf(0), yTicks: ticks, xMin: xMn, xMax: xMx, sd };
  }, [prices, liveCurve, expiryCurve, innerW, innerH, iv, dteYears]);

  // Catmull-Rom → cubic-bezier smoothing for the curves.
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

  // Green-above-zero / red-below-zero fills under the live curve.
  const { profitArea, lossArea } = useMemo(() => {
    const build = (test: (v: number) => boolean) => {
      const segs: string[] = [];
      let inSeg = false;
      for (let i = 0; i < prices.length; i++) {
        const v = liveCurve[i];
        const x = xOf(prices[i]);
        const y = yOf(v);
        if (test(v) && !inSeg) { inSeg = true; segs.push(`M${x.toFixed(1)},${yZero.toFixed(1)} L${x.toFixed(1)},${y.toFixed(1)}`); }
        else if (test(v) && inSeg) { segs.push(`L${x.toFixed(1)},${y.toFixed(1)}`); }
        else if (!test(v) && inSeg) { inSeg = false; segs.push(`L${x.toFixed(1)},${yZero.toFixed(1)} Z`); }
      }
      if (inSeg) segs.push(`L${xOf(prices[prices.length - 1]).toFixed(1)},${yZero.toFixed(1)} Z`);
      return segs.join(" ");
    };
    return { profitArea: build((v) => v >= 0), lossArea: build((v) => v < 0) };
  }, [prices, liveCurve, xOf, yOf, yZero]);

  const xTicks = useMemo(() => {
    const n = 6;
    return Array.from({ length: n + 1 }, (_, i) => xMin + ((xMax - xMin) * i) / n);
  }, [xMin, xMax]);

  // ── draggable price cursor (the OptionStrat scrubber) ──────────────────
  const svgRef = useRef<SVGSVGElement>(null);
  const [cursor, setCursor] = useState<number>(spot); // price the cursor sits on
  const [dragging, setDragging] = useState(false);
  // Re-centre the cursor on spot whenever the contract / spot changes.
  useEffect(() => { setCursor(spot); }, [spot, strike]);

  const clientXToPrice = (clientX: number): number => {
    const el = svgRef.current;
    if (!el) return cursor;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return cursor;
    const padLpx = (PAD_L / W) * rect.width;
    const dataWpx = ((W - PAD_L - PAD_R) / W) * rect.width;
    let rel = (clientX - rect.left - padLpx) / dataWpx;
    rel = Math.max(0, Math.min(1, rel));
    return xMin + rel * (xMax - xMin);
  };
  const onPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    setDragging(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    setCursor(clientXToPrice(e.clientX));
  };
  const onPointerMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!dragging) return;
    setCursor(clientXToPrice(e.clientX));
  };
  const endDrag = () => setDragging(false);

  // Interpolated curve value at an arbitrary price.
  const interpAt = (price: number, curve: number[]): number => {
    if (price <= prices[0]) return curve[0];
    if (price >= prices[prices.length - 1]) return curve[curve.length - 1];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] >= price) {
        const t = (price - prices[i - 1]) / (prices[i] - prices[i - 1] || 1);
        return curve[i - 1] + t * (curve[i] - curve[i - 1]);
      }
    }
    return curve[curve.length - 1];
  };

  const cur = useMemo(() => {
    const cp = Math.max(xMin, Math.min(xMax, cursor));
    const live = interpAt(cp, liveCurve);
    const exp = interpAt(cp, expiryCurve);
    const movePct = spot > 0 ? ((cp - spot) / spot) * 100 : 0;
    const retPct = costBasis > 0 ? (live / costBasis) * 100 : null;
    return { price: cp, live, exp, movePct, retPct };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, liveCurve, expiryCurve, xMin, xMax, spot, costBasis]);

  // ── scenario labels ────────────────────────────────────────────────────
  const tRemainingDays = Math.max(0, dteDays - daysFromNow);
  const dateLabel = daysFromNow === 0 ? "Today" : daysFromNow >= dteDays ? "Expiry" : `+${daysFromNow}d`;
  const scenarioActive = daysFromNow !== 0 || ivMult !== 1;
  const resetAll = () => { setDaysFromNow(0); setIvMult(1); setRange(0.25); };

  // ── render ───────────────────────────────────────────────────────────
  return (
    <div className="relative w-full select-none">
      {/* ── Headline: P/L at the cursor price, for the chosen date ─────── */}
      <div className="flex items-end gap-5 px-1 mb-2.5 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            P/L at ${cur.price.toFixed(2)}
            <span className="ml-1 text-text-muted/70">
              ({cur.movePct >= 0 ? "+" : ""}{cur.movePct.toFixed(1)}%)
            </span>
            <span className="ml-1.5 px-1 rounded bg-surface-2 text-text-secondary">{dateLabel}</span>
          </span>
          <div className="flex items-baseline gap-2">
            <span className={cn("text-[26px] tabular font-bold leading-none", cur.live >= 0 ? "text-up" : "text-down")}>
              {fmtPnl(cur.live)}
            </span>
            {cur.retPct != null && (
              <span className={cn("text-[12px] tabular font-semibold", cur.live >= 0 ? "text-up" : "text-down")}>
                {cur.retPct >= 0 ? "+" : ""}{cur.retPct.toFixed(0)}%
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">at expiry</span>
          <span className={cn("text-[15px] tabular font-semibold leading-tight", cur.exp >= 0 ? "text-up" : "text-down")}>
            {fmtPnl(cur.exp)}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {(pop != null || probItm != null) && (
            <div className="flex items-center gap-2 text-[10px] tabular">
              {pop != null && (
                <span><span className="text-text-muted">POP </span>
                  <span className={cn("font-semibold", pop >= 0.6 ? "text-up" : pop >= 0.4 ? "text-warning" : "text-down")}>
                    {(pop * 100).toFixed(0)}%</span></span>
              )}
              {probItm != null && (
                <span><span className="text-text-muted">P(ITM) </span>
                  <span className="text-text-primary font-semibold">{(probItm * 100).toFixed(0)}%</span></span>
              )}
            </div>
          )}
          {scenarioActive && (
            <button type="button" onClick={resetAll}
              className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-warning hover:text-text-primary transition-colors"
              title="Reset date + IV to now">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning" />
              reset
            </button>
          )}
        </div>
      </div>

      <svg
        ref={svgRef}
        width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        className={cn("block touch-none", dragging ? "cursor-grabbing" : "cursor-grab")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <linearGradient id="pnlProfitGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART.pnl.profit} stopOpacity="0.34" />
            <stop offset="100%" stopColor={CHART.pnl.profit} stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="pnlLossGrad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={CHART.pnl.loss} stopOpacity="0.30" />
            <stop offset="100%" stopColor={CHART.pnl.loss} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* ±1σ expected-range band */}
        {sd > 0 && sigma1Low != null && sigma1High != null &&
          sigma1High > xMin && sigma1Low < xMax && (
          <rect
            x={xOf(Math.max(xMin, sigma1Low))}
            y={PAD_T}
            width={Math.max(0, xOf(Math.min(xMax, sigma1High)) - xOf(Math.max(xMin, sigma1Low)))}
            height={innerH}
            fill={CHART.axisText} fillOpacity={0.04}
          />
        )}

        {/* Y gridlines + labels */}
        {yTicks.map((t, i) => (
          <g key={`gy-${i}`}>
            <line x1={PAD_L} x2={W - PAD_R} y1={yOf(t)} y2={yOf(t)}
              stroke={CHART.axisText} strokeOpacity={t === 0 ? 0.5 : 0.05} />
            <text x={PAD_L - 8} y={yOf(t) + 4} fontSize="11"
              fill={t === 0 ? CHART.axisText : CHART.textMuted} textAnchor="end" className="tabular-nums">
              {fmtPnl(t)}
            </text>
          </g>
        ))}

        {/* X ticks: price + %-from-spot */}
        {xTicks.map((p, i) => (
          <g key={`xt-${i}`}>
            <text x={xOf(p)} y={H - 9} fontSize="11" fill={CHART.axisText} textAnchor="middle" className="tabular-nums">
              {p < 100 ? p.toFixed(2) : p.toFixed(0)}
            </text>
            <text x={xOf(p)} y={H + 2} fontSize="9" fill={CHART.textMuted} textAnchor="middle" className="tabular-nums">
              {pctFromSpot(p, spot)}
            </text>
          </g>
        ))}

        {/* Fills under the live curve */}
        <path d={profitArea} fill="url(#pnlProfitGrad)" />
        <path d={lossArea} fill="url(#pnlLossGrad)" />

        {/* Max profit / loss reference lines */}
        {maxProfit != null && isFinite(maxProfit) && maxProfit > 0 && (
          <line x1={PAD_L} x2={W - PAD_R} y1={yOf(maxProfit)} y2={yOf(maxProfit)}
            stroke={CHART.pnl.profit} strokeOpacity={0.25} strokeDasharray="2 6" />
        )}
        {maxLoss != null && isFinite(maxLoss) && maxLoss < 0 && (
          <line x1={PAD_L} x2={W - PAD_R} y1={yOf(maxLoss)} y2={yOf(maxLoss)}
            stroke={CHART.pnl.loss} strokeOpacity={0.25} strokeDasharray="2 6" />
        )}

        {/* Expiry intrinsic — faded dashed reference */}
        <path d={expiryPath} stroke={CHART.pnl.expiry} strokeOpacity={0.4}
          strokeWidth="1.5" strokeDasharray="5 4" fill="none" />
        {/* Live curve — bright, bold, foreground */}
        <path d={livePath} stroke={CHART.pnl.today} strokeWidth="2.5" fill="none" />

        {/* Strike marker */}
        {strike >= xMin && strike <= xMax && (
          <g>
            <line x1={xOf(strike)} x2={xOf(strike)} y1={PAD_T} y2={H - PAD_B}
              stroke={CHART.ref.strike} strokeOpacity={0.5} strokeDasharray="3 4" />
            <text x={xOf(strike)} y={PAD_T - 4} fontSize="9" fill={CHART.ref.strike}
              textAnchor="middle" fontWeight="600">K {strike}</text>
          </g>
        )}

        {/* Breakeven on the zero line */}
        {breakeven >= xMin && breakeven <= xMax && (
          <g>
            <circle cx={xOf(breakeven)} cy={yZero} r={3} fill={CHART.text} />
            <text x={xOf(breakeven)} y={yZero - 7} fontSize="9" fill={CHART.text}
              textAnchor="middle" fontWeight="500">BE {breakeven.toFixed(2)}</text>
          </g>
        )}

        {/* Spot marker (subtle — the cursor is the hero) */}
        {spot >= xMin && spot <= xMax && (
          <g>
            <line x1={xOf(spot)} x2={xOf(spot)} y1={PAD_T} y2={H - PAD_B}
              stroke={CHART.text} strokeOpacity={0.18} strokeWidth={1} />
            <text x={xOf(spot)} y={H - PAD_B + 0} fontSize="8" fill={CHART.text} fillOpacity={0.5}
              textAnchor="middle">spot</text>
          </g>
        )}

        {/* ── Draggable price cursor ──────────────────────────────────── */}
        {cur.price >= xMin && cur.price <= xMax && (
          <g pointerEvents="none">
            <line x1={xOf(cur.price)} x2={xOf(cur.price)} y1={PAD_T - 8} y2={H - PAD_B}
              stroke={CHART.pnl.today} strokeOpacity={dragging ? 0.9 : 0.6} strokeWidth={1.5} />
            {/* dot on the expiry reference */}
            <circle cx={xOf(cur.price)} cy={yOf(cur.exp)} r={3}
              fill="none" stroke={CHART.pnl.expiry} strokeWidth={1.2} strokeOpacity={0.7} />
            {/* dot on the live curve */}
            <circle cx={xOf(cur.price)} cy={yOf(cur.live)} r={5}
              fill={CHART.pnl.today} stroke={CHART.bg} strokeWidth={2} />
            {/* grab handle pill at the top with the price */}
            <g transform={`translate(${xOf(cur.price)}, ${PAD_T - 8})`}>
              <rect x={-30} y={-15} width="60" height="15" rx="7.5"
                fill={CHART.pnl.today} />
              <text x={0} y={-4.5} fontSize="10" fill={CHART.bg} textAnchor="middle" fontWeight="700">
                {cur.price.toFixed(2)}
              </text>
            </g>
          </g>
        )}
      </svg>
      <p className="text-[9px] text-text-muted text-center -mt-1 mb-1">
        drag anywhere on the chart to read P/L at any price
      </p>

      {/* ── Scenario controls — Date is the hero, IV + Range secondary ── */}
      <div className="mt-2 pt-3 border-t border-border/40 flex flex-col gap-3.5 px-1">
        <ScenarioSlider
          label="Date" accent={CHART.pnl.today}
          valueText={dateLabel} subText={`${tRemainingDays}d to expiry`}
          min={0} max={dteDays} step={1} value={daysFromNow} onChange={setDaysFromNow}
          isDefault={daysFromNow === 0} onReset={() => setDaysFromNow(0)}
          presets={[
            { label: "Now", value: 0 },
            { label: "¼", value: Math.round(dteDays * 0.25) },
            { label: "½", value: Math.round(dteDays * 0.5) },
            { label: "¾", value: Math.round(dteDays * 0.75) },
            { label: "Exp", value: dteDays },
          ]}
        />
        <ScenarioSlider
          label="IV" accent={CHART.forecast.cone}
          valueText={`${(ivMult * iv * 100).toFixed(1)}%`} subText={`${ivMult.toFixed(2)}× current`}
          min={0.3} max={3} step={0.05} value={ivMult} onChange={setIvMult}
          isDefault={ivMult === 1} onReset={() => setIvMult(1)}
          presets={[
            { label: "−40%", value: 0.6 },
            { label: "Now", value: 1 },
            { label: "+40%", value: 1.4 },
          ]}
        />
        <ScenarioSlider
          label="Zoom" accent={CHART.ref.strike}
          valueText={`±${(range * 100).toFixed(0)}%`} subText="price range"
          min={0.05} max={0.6} step={0.05} value={range} onChange={setRange}
          isDefault={range === 0.25} onReset={() => setRange(0.25)}
          presets={[
            { label: "±10%", value: 0.10 },
            { label: "±25%", value: 0.25 },
            { label: "±50%", value: 0.50 },
          ]}
        />
      </div>
    </div>
  );
}

// ── ScenarioSlider ──────────────────────────────────────────────────────
//   A tactile slider: a fat track, a clear draggable thumb with a value
//   bubble that rides on it, and clickable preset ticks under the track. A
//   transparent native <input type=range> sits on top for reliable drag +
//   keyboard. ~34px tall including the tick labels.
function ScenarioSlider({
  label, accent, valueText, subText, min, max, step, value, onChange,
  isDefault, onReset, presets,
}: {
  label: string;
  accent: string;
  valueText: string;
  subText?: string;
  min: number; max: number; step: number;
  value: number;
  onChange: (v: number) => void;
  isDefault: boolean;
  onReset: () => void;
  presets?: { label: string; value: number }[];
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const clamp = (p: number) => Math.max(0, Math.min(100, p));
  const isActive = (pv: number) => Math.abs(value - pv) < step / 2;

  return (
    <div className="flex flex-col gap-1">
      {/* header line */}
      <div className="flex items-baseline gap-2">
        <span className="w-10 shrink-0 text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
        <span className="text-[13px] tabular font-semibold leading-none" style={{ color: accent }}>{valueText}</span>
        {subText && <span className="text-[10px] tabular text-text-muted leading-none">{subText}</span>}
        <button
          type="button" onClick={onReset}
          tabIndex={isDefault ? -1 : 0} aria-hidden={isDefault}
          className={cn(
            "ml-auto text-[10px] uppercase tracking-wider transition-colors",
            isDefault ? "invisible pointer-events-none" : "text-text-muted hover:text-text-primary",
          )}
        >
          reset
        </button>
      </div>

      {/* track + thumb + transparent input */}
      <div className="relative h-5">
        {/* base track */}
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[5px] rounded-full"
          style={{ background: CHART.surface }} />
        {/* filled portion */}
        <div className="absolute left-0 top-1/2 -translate-y-1/2 h-[5px] rounded-full"
          style={{ width: `${clamp(pct)}%`, background: accent, opacity: 0.85 }} />
        {/* preset ticks */}
        {presets?.map((p) => {
          const tpct = max > min ? ((p.value - min) / (max - min)) * 100 : 0;
          return (
            <span key={`tick-${p.label}`}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-[2px] h-[9px] rounded-full"
              style={{ left: `${clamp(tpct)}%`, background: isActive(p.value) ? accent : CHART.axisText, opacity: isActive(p.value) ? 1 : 0.3 }} />
          );
        })}
        {/* visible thumb + value bubble */}
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 pointer-events-none"
          style={{ left: `${clamp(pct)}%` }}>
          <div className="w-[15px] h-[15px] rounded-full border-2"
            style={{ background: CHART.bg, borderColor: accent, boxShadow: `0 0 0 3px ${accent}22` }} />
        </div>
        {/* transparent native range on top for interaction */}
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          className="pnl-scrub absolute inset-0"
        />
      </div>

      {/* preset labels — clickable, aligned under their ticks */}
      {presets && presets.length > 0 && (
        <div className="relative h-3">
          {presets.map((p) => {
            const tpct = max > min ? ((p.value - min) / (max - min)) * 100 : 0;
            const active = isActive(p.value);
            // Nudge the edge labels inward so they don't clip the track ends.
            const anchor = tpct <= 2 ? "left-0 translate-x-0" : tpct >= 98 ? "right-0 left-auto translate-x-0" : "-translate-x-1/2";
            return (
              <button
                key={`lbl-${p.label}`} type="button" onClick={() => onChange(p.value)}
                className={cn(
                  "absolute top-0 text-[9px] tabular leading-none transition-colors",
                  anchor,
                  active ? "font-semibold" : "text-text-muted hover:text-text-secondary",
                )}
                style={{ left: anchor === "-translate-x-1/2" ? `${tpct}%` : undefined, color: active ? accent : undefined }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fmtPnl(v: number): string {
  if (!isFinite(v)) return v > 0 ? "∞" : "−∞";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${v < 0 ? "−" : ""}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${v < 0 ? "−" : ""}$${(a / 1_000).toFixed(1)}k`;
  return `${v < 0 ? "−" : ""}$${a.toFixed(0)}`;
}

function pctFromSpot(p: number, spot: number): string {
  if (!spot) return "";
  const d = ((p - spot) / spot) * 100;
  if (Math.abs(d) < 0.5) return "spot";
  return `${d >= 0 ? "+" : ""}${d.toFixed(0)}%`;
}
