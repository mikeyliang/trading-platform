"use client";

import { useEffect, useMemo, useState } from "react";
import { CHART } from "@/lib/chartTheme";
import { cn } from "@/lib/utils";
import {
  samplePriceAxis,
  strategyExpiryCurve,
  strategyPnlCurve,
  type StrategyLeg,
} from "@/lib/bs";

interface Props {
  /** Live underlying — anchors the price axis and strike-snap presets. */
  spot: number;
  /** Current implied vol from the ATM contract (used as the baseline IV
   *  the IV slider multiplies on). */
  iv: number;
  /** Days to expiry — drives the time slider's upper bound. */
  dteDays: number;
  /** Symbol + expiry for the header label only. */
  symbol: string;
  expiry: string;
  /** Strike grid for snapping legs to real strikes (5/1/2.5 ladder etc.) */
  strikes?: number[];
  height?: number;
}

type StrategyKey =
  | "long_call" | "long_put"
  | "covered_call" | "csp"
  | "bull_call" | "bear_put"
  | "bull_put" | "bear_call"
  | "long_straddle" | "long_strangle"
  | "iron_condor" | "iron_butterfly";

interface Preset {
  key: StrategyKey;
  label: string;
  desc: string;
  /** Given spot + a base width, produce the initial legs. */
  build: (spot: number, atmStrike: number, w: number, iv: number, t: number) => StrategyLeg[];
}

const PRESETS: Preset[] = [
  {
    key: "long_call", label: "Long call",
    desc: "Bullish, defined risk. Pays for upside above strike + premium.",
    build: (s, k, _w, iv, t) => [
      { strike: k, isCall: true, action: "BUY", entry: estPrice(s, k, iv, t, true), qty: 1 },
    ],
  },
  {
    key: "long_put", label: "Long put",
    desc: "Bearish, defined risk. Pays for downside below strike − premium.",
    build: (s, k, _w, iv, t) => [
      { strike: k, isCall: false, action: "BUY", entry: estPrice(s, k, iv, t, false), qty: 1 },
    ],
  },
  {
    key: "bull_call", label: "Bull call spread",
    desc: "Debit spread. Cheaper than long call, capped upside above long+width.",
    build: (s, k, w, iv, t) => [
      { strike: k, isCall: true, action: "BUY", entry: estPrice(s, k, iv, t, true), qty: 1 },
      { strike: k + w, isCall: true, action: "SELL", entry: estPrice(s, k + w, iv, t, true), qty: 1 },
    ],
  },
  {
    key: "bear_put", label: "Bear put spread",
    desc: "Debit spread. Bearish view with capped downside profit.",
    build: (s, k, w, iv, t) => [
      { strike: k, isCall: false, action: "BUY", entry: estPrice(s, k, iv, t, false), qty: 1 },
      { strike: k - w, isCall: false, action: "SELL", entry: estPrice(s, k - w, iv, t, false), qty: 1 },
    ],
  },
  {
    key: "bull_put", label: "Bull put spread",
    desc: "Credit spread. Bullish/neutral, theta positive, defined risk.",
    build: (s, k, w, iv, t) => [
      { strike: k, isCall: false, action: "SELL", entry: estPrice(s, k, iv, t, false), qty: 1 },
      { strike: k - w, isCall: false, action: "BUY", entry: estPrice(s, k - w, iv, t, false), qty: 1 },
    ],
  },
  {
    key: "bear_call", label: "Bear call spread",
    desc: "Credit spread. Bearish/neutral, theta positive, defined risk.",
    build: (s, k, w, iv, t) => [
      { strike: k, isCall: true, action: "SELL", entry: estPrice(s, k, iv, t, true), qty: 1 },
      { strike: k + w, isCall: true, action: "BUY", entry: estPrice(s, k + w, iv, t, true), qty: 1 },
    ],
  },
  {
    key: "long_straddle", label: "Long straddle",
    desc: "Vol play. Profits on large move either direction.",
    build: (s, k, _w, iv, t) => [
      { strike: k, isCall: true,  action: "BUY", entry: estPrice(s, k, iv, t, true),  qty: 1 },
      { strike: k, isCall: false, action: "BUY", entry: estPrice(s, k, iv, t, false), qty: 1 },
    ],
  },
  {
    key: "long_strangle", label: "Long strangle",
    desc: "Cheaper vol play. Wider breakevens than the straddle.",
    build: (s, k, w, iv, t) => [
      { strike: k + w, isCall: true,  action: "BUY", entry: estPrice(s, k + w, iv, t, true),  qty: 1 },
      { strike: k - w, isCall: false, action: "BUY", entry: estPrice(s, k - w, iv, t, false), qty: 1 },
    ],
  },
  {
    key: "iron_condor", label: "Iron condor",
    desc: "Range-bound. Credit, theta-positive, defined risk both wings.",
    build: (s, k, w, iv, t) => [
      // Put credit wing
      { strike: k - w,     isCall: false, action: "SELL", entry: estPrice(s, k - w,     iv, t, false), qty: 1 },
      { strike: k - 2 * w, isCall: false, action: "BUY",  entry: estPrice(s, k - 2 * w, iv, t, false), qty: 1 },
      // Call credit wing
      { strike: k + w,     isCall: true,  action: "SELL", entry: estPrice(s, k + w,     iv, t, true),  qty: 1 },
      { strike: k + 2 * w, isCall: true,  action: "BUY",  entry: estPrice(s, k + 2 * w, iv, t, true),  qty: 1 },
    ],
  },
  {
    key: "iron_butterfly", label: "Iron butterfly",
    desc: "Pinned at strike. Higher credit, narrower profit zone than IC.",
    build: (s, k, w, iv, t) => [
      { strike: k,     isCall: false, action: "SELL", entry: estPrice(s, k,     iv, t, false), qty: 1 },
      { strike: k - w, isCall: false, action: "BUY",  entry: estPrice(s, k - w, iv, t, false), qty: 1 },
      { strike: k,     isCall: true,  action: "SELL", entry: estPrice(s, k,     iv, t, true),  qty: 1 },
      { strike: k + w, isCall: true,  action: "BUY",  entry: estPrice(s, k + w, iv, t, true),  qty: 1 },
    ],
  },
];

/** Cheap BS-ish entry price estimate so legs are seeded with sensible
 *  premiums. Uses the analytic BS pricer transitively via `bsPrice` —
 *  imported lazily here to avoid bloating the import surface. */
function estPrice(s: number, k: number, iv: number, tYears: number, isCall: boolean): number {
  // Inline copy of the BS formula (kept in lib/bs.ts; we just re-derive
  // for the seed value here). Round to nearest cent.
  if (tYears <= 0 || iv <= 0 || s <= 0) return Math.max(0, isCall ? s - k : k - s);
  const r = 0.05;
  const sqrtT = Math.sqrt(tYears);
  const d1 = (Math.log(s / k) + (r + (iv * iv) / 2) * tYears) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const N = (x: number) => 0.5 * (1 + erfApprox(x / Math.SQRT2));
  const price = isCall
    ? s * N(d1) - k * Math.exp(-r * tYears) * N(d2)
    : k * Math.exp(-r * tYears) * N(-d2) - s * N(-d1);
  return Math.max(0.01, +price.toFixed(2));
}

function erfApprox(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Snap an arbitrary strike to the nearest available strike on the chain. */
function snapStrike(k: number, strikes?: number[]): number {
  if (!strikes || strikes.length === 0) return Math.round(k * 2) / 2;
  let best = strikes[0];
  let bestDiff = Math.abs(k - best);
  for (const s of strikes) {
    const d = Math.abs(k - s);
    if (d < bestDiff) { best = s; bestDiff = d; }
  }
  return best;
}

/**
 * Multi-leg strategy P/L chart. Pick a preset, the legs are seeded
 * around spot; tweak strikes / qty / action per leg; the curve recomputes
 * live via BS. Companion to PnlProfileChart (which is single-leg only).
 */
export function StrategyPnlChart({
  spot, iv, dteDays, symbol, expiry, strikes, height = 360,
}: Props) {
  const dteYears = Math.max(1 / 365.25, dteDays / 365.25);
  const atmStrike = useMemo(
    () => (strikes && strikes.length > 0 ? snapStrike(spot, strikes) : Math.round(spot)),
    [spot, strikes],
  );
  // Width = step between adjacent strikes (5 for SPX, 1 for SPY etc).
  // Falls back to 5% of spot when no strike grid is known.
  const baseWidth = useMemo(() => {
    if (strikes && strikes.length >= 2) {
      const sorted = [...strikes].sort((a, b) => a - b);
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
      gaps.sort((a, b) => a - b);
      return gaps[Math.floor(gaps.length / 2)] || 5;
    }
    return Math.max(0.5, Math.round(spot * 0.05));
  }, [strikes]);

  const [presetKey, setPresetKey] = useState<StrategyKey>("bull_call");
  const [legs, setLegs] = useState<StrategyLeg[]>(() =>
    PRESETS.find((p) => p.key === "bull_call")!.build(spot, atmStrike, baseWidth, iv, dteYears),
  );

  // Rebuild legs whenever preset OR position context changes (new spot,
  // new IV, new expiry). Strikes auto-snap to the chain grid.
  useEffect(() => {
    const preset = PRESETS.find((p) => p.key === presetKey)!;
    const fresh = preset.build(spot, atmStrike, baseWidth, iv, dteYears).map((l) => ({
      ...l, strike: snapStrike(l.strike, strikes),
    }));
    setLegs(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetKey, spot, atmStrike, baseWidth, iv, dteYears]);

  const [daysFromNow, setDaysFromNow] = useState(0);
  const [ivMult, setIvMult] = useState(1);
  const [range, setRange] = useState(0.25);

  const prices = useMemo(() => samplePriceAxis(spot, range, 161), [spot, range]);
  const liveCurve = useMemo(
    () => strategyPnlCurve(prices, daysFromNow, ivMult, legs, dteYears, iv),
    [prices, daysFromNow, ivMult, legs, dteYears, iv],
  );
  const expiryCurve = useMemo(
    () => strategyExpiryCurve(prices, legs),
    [prices, legs],
  );

  // ── axes ────────────────────────────────────────────────────────────
  const W = 920;
  const H = height;
  const PAD_L = 60;
  const PAD_R = 18;
  const PAD_T = 28;
  const PAD_B = 36;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const { xOf, yOf, yZero, yTicks, xMin, xMax } = useMemo(() => {
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
    const rawStep = rng / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = Math.ceil(rawStep / mag) * mag;
    const ticks: number[] = [];
    const start = Math.ceil(yMn / step) * step;
    for (let v = start; v <= yMx; v += step) ticks.push(v);

    return { xOf, yOf, yZero, yTicks: ticks, xMin: xMn, xMax: xMx };
  }, [prices, liveCurve, expiryCurve, innerW, innerH]);

  const linePath = (vals: number[]) => {
    const pts = prices.map((p, i) => [xOf(p), yOf(vals[i])] as [number, number]);
    if (pts.length < 2) return "";
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)}`;
    }
    return d;
  };
  const livePath = useMemo(() => linePath(liveCurve), [prices, liveCurve, xOf, yOf]);
  const expiryPath = useMemo(() => linePath(expiryCurve), [prices, expiryCurve, xOf, yOf]);

  // Profit/loss fills under the expiry curve (the canonical strategy
  // shape — what the trader is buying). Live curve is rendered as a
  // separate line on top so the user sees today vs. expiry.
  const { profitArea, lossArea } = useMemo(() => {
    const build = (test: (v: number) => boolean) => {
      const segs: string[] = [];
      let inSeg = false;
      for (let i = 0; i < prices.length; i++) {
        const v = expiryCurve[i];
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
  }, [prices, expiryCurve, xOf, yOf, yZero]);

  const xTicks = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= 6; i++) out.push(xMin + ((xMax - xMin) * i) / 6);
    return out;
  }, [xMin, xMax]);

  // Strategy summary readouts.
  const summary = useMemo(() => {
    const maxP = Math.max(...expiryCurve);
    const maxL = Math.min(...expiryCurve);
    // Net premium at entry. Positive = credit received, negative = debit.
    let net = 0;
    for (const l of legs) {
      const sign = l.action === "BUY" ? -1 : 1;
      net += sign * l.entry * (l.qty ?? 1) * 100;
    }
    // Breakevens: where the expiry curve crosses zero.
    const bes: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      const a = expiryCurve[i - 1];
      const b = expiryCurve[i];
      if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) {
        const t = a / (a - b);
        bes.push(prices[i - 1] + t * (prices[i] - prices[i - 1]));
      }
    }
    return { maxP, maxL, net, bes };
  }, [expiryCurve, legs, prices]);

  const updateLeg = (idx: number, patch: Partial<StrategyLeg>) => {
    setLegs((curr) => curr.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const tRemainingDays = Math.max(0, dteDays - daysFromNow);
  const dateLabel = daysFromNow === 0 ? "today"
    : daysFromNow >= dteDays ? "expiry"
    : `+${daysFromNow}d`;

  const preset = PRESETS.find((p) => p.key === presetKey)!;

  return (
    <div className="flex flex-col gap-3">
      {/* preset chooser */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Strategy</span>
        <div className="flex items-center gap-1 flex-wrap">
          {PRESETS.map((p) => (
            <button
              key={p.key} type="button"
              onClick={() => setPresetKey(p.key)}
              className={cn(
                "px-2 py-1 rounded text-[10px] tabular border transition-colors",
                p.key === presetKey
                  ? "border-accent bg-accent/15 text-accent font-semibold"
                  : "border-border text-text-muted hover:text-text-secondary hover:border-text-muted/50",
              )}
              title={p.desc}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[10px] tabular text-text-muted">
          {symbol} · {fmtExp(expiry)} · {dteDays}d
        </span>
      </div>
      <p className="text-[10px] text-text-muted italic -mt-1">{preset.desc}</p>

      {/* readouts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] tabular">
        <SummaryCell
          label="Max profit"
          value={isFinite(summary.maxP) ? fmtPnl(summary.maxP) : "∞"}
          tone="up"
        />
        <SummaryCell
          label="Max loss"
          value={isFinite(summary.maxL) ? fmtPnl(summary.maxL) : "−∞"}
          tone="down"
        />
        <SummaryCell
          label={summary.net >= 0 ? "Net credit" : "Net debit"}
          value={fmtPnl(Math.abs(summary.net))}
          tone={summary.net >= 0 ? "up" : "down"}
        />
        <SummaryCell
          label={summary.bes.length === 1 ? "Breakeven" : "Breakevens"}
          value={summary.bes.length === 0
            ? "—"
            : summary.bes.map((b) => `$${b.toFixed(2)}`).join(" · ")}
        />
      </div>

      {/* chart */}
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block">
        <defs>
          <linearGradient id="strat-profit" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART.pnl.profit} stopOpacity="0.40" />
            <stop offset="100%" stopColor={CHART.pnl.profit} stopOpacity="0.03" />
          </linearGradient>
          <linearGradient id="strat-loss" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={CHART.pnl.loss} stopOpacity="0.36" />
            <stop offset="100%" stopColor={CHART.pnl.loss} stopOpacity="0.03" />
          </linearGradient>
        </defs>

        {/* y gridlines + labels */}
        {yTicks.map((t, i) => (
          <g key={`gy-${i}`}>
            <line x1={PAD_L} x2={W - PAD_R} y1={yOf(t)} y2={yOf(t)}
                  stroke={CHART.axisText} strokeOpacity={t === 0 ? 0.45 : 0.05} />
            <text x={PAD_L - 8} y={yOf(t) + 4} fontSize="11"
                  fill={t === 0 ? CHART.axisText : CHART.textMuted}
                  textAnchor="end" className="tabular-nums">
              {fmtPnl(t)}
            </text>
          </g>
        ))}

        {/* x tick labels */}
        {xTicks.map((p, i) => (
          <g key={`xt-${i}`}>
            <text x={xOf(p)} y={H - 8} fontSize="11" fill={CHART.axisText}
                  textAnchor="middle" className="tabular-nums">
              {p < 100 ? p.toFixed(2) : p.toFixed(0)}
            </text>
          </g>
        ))}

        {/* fills under expiry curve */}
        <path d={profitArea} fill="url(#strat-profit)" />
        <path d={lossArea} fill="url(#strat-loss)" />

        {/* expiry curve — the canonical shape */}
        <path d={expiryPath} stroke={CHART.pnl.expiry} strokeWidth="2.5" fill="none" />
        {/* live curve — today / sliders, lighter dashed */}
        <path d={livePath} stroke={CHART.forecast.cone} strokeWidth="1.5"
              strokeDasharray="4 3" fill="none" strokeOpacity={0.85} />

        {/* spot marker */}
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

        {/* leg strike markers */}
        {legs.map((l, i) => {
          if (l.strike < xMin || l.strike > xMax) return null;
          const colorActive = l.action === "BUY" ? CHART.up : CHART.down;
          return (
            <g key={i}>
              <line x1={xOf(l.strike)} x2={xOf(l.strike)} y1={PAD_T} y2={H - 16}
                    stroke={colorActive} strokeOpacity={0.4}
                    strokeDasharray="3 3" strokeWidth={1} />
              <text x={xOf(l.strike)} y={H - 22} fontSize="9"
                    fill={colorActive} textAnchor="middle" fontWeight="600">
                {l.action === "BUY" ? "+" : "−"}{l.isCall ? "C" : "P"} {l.strike}
              </text>
            </g>
          );
        })}

        {/* breakeven dots */}
        {summary.bes.map((b, i) => (
          b >= xMin && b <= xMax ? (
            <g key={`be-${i}`}>
              <circle cx={xOf(b)} cy={yZero} r={3.5} fill={CHART.text} />
              <text x={xOf(b)} y={yZero - 8} fontSize="9" fill={CHART.text}
                    textAnchor="middle" fontWeight="500">BE {b.toFixed(2)}</text>
            </g>
          ) : null
        ))}
      </svg>

      {/* sliders */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-3 pt-2 border-t border-border/40">
        <StratSlider
          label="Date" accent={CHART.pnl.expiry}
          valueText={dateLabel}
          subText={`${tRemainingDays}d to expiry`}
          min={0} max={dteDays} step={1}
          value={daysFromNow} onChange={setDaysFromNow}
          isDefault={daysFromNow === 0}
          onReset={() => setDaysFromNow(0)}
          presets={[
            { label: "today", value: 0 },
            { label: "+1d", value: Math.min(1, dteDays) },
            { label: "½", value: Math.round(dteDays / 2) },
            { label: "exp", value: dteDays },
          ]}
        />
        <StratSlider
          label="IV" accent={CHART.forecast.cone}
          valueText={`${(ivMult * iv * 100).toFixed(1)}%`}
          subText={`${(ivMult * 100).toFixed(0)}% of current`}
          min={0.3} max={3} step={0.05}
          value={ivMult} onChange={setIvMult}
          isDefault={ivMult === 1}
          onReset={() => setIvMult(1)}
          presets={[
            { label: "−20%", value: 0.8 },
            { label: "now", value: 1 },
            { label: "+20%", value: 1.2 },
          ]}
        />
        <StratSlider
          label="Range" accent={CHART.ref.strike}
          valueText={`±${(range * 100).toFixed(0)}%`}
          subText="window around spot"
          min={0.05} max={0.6} step={0.05}
          value={range} onChange={setRange}
          isDefault={range === 0.25}
          onReset={() => setRange(0.25)}
          presets={[
            { label: "±10%", value: 0.1 },
            { label: "±25%", value: 0.25 },
            { label: "±50%", value: 0.5 },
          ]}
        />
      </div>

      {/* legs editor */}
      <div className="rounded-md border border-border bg-surface overflow-hidden">
        <div className="flex items-center gap-2 px-3 h-7 border-b border-border/60">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Legs</span>
          <span className="text-[10px] tabular text-text-muted">
            edit strike / action / qty / entry — curves recompute live
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] tabular">
            <thead>
              <tr className="text-text-muted">
                <th className="text-left px-2 py-1 font-normal text-[9px] uppercase tracking-wider">#</th>
                <th className="text-left px-2 py-1 font-normal text-[9px] uppercase tracking-wider">Action</th>
                <th className="text-left px-2 py-1 font-normal text-[9px] uppercase tracking-wider">Right</th>
                <th className="text-right px-2 py-1 font-normal text-[9px] uppercase tracking-wider">Strike</th>
                <th className="text-right px-2 py-1 font-normal text-[9px] uppercase tracking-wider">Entry $</th>
                <th className="text-right px-2 py-1 font-normal text-[9px] uppercase tracking-wider">Qty</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((l, i) => (
                <tr key={i} className="border-t border-border/30">
                  <td className="px-2 py-1 text-text-muted">{i + 1}</td>
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      onClick={() => updateLeg(i, { action: l.action === "BUY" ? "SELL" : "BUY" })}
                      className={cn(
                        "px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors",
                        l.action === "BUY"
                          ? "border-up/40 text-up bg-up/10"
                          : "border-down/40 text-down bg-down/10",
                      )}
                    >
                      {l.action}
                    </button>
                  </td>
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      onClick={() => updateLeg(i, { isCall: !l.isCall })}
                      className="px-2 py-0.5 rounded text-[10px] font-semibold border border-border text-text-secondary hover:bg-surface-2"
                    >
                      {l.isCall ? "CALL" : "PUT"}
                    </button>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input
                      type="number" step={baseWidth}
                      value={l.strike}
                      onChange={(e) => updateLeg(i, { strike: Number(e.target.value) })}
                      onBlur={(e) => updateLeg(i, { strike: snapStrike(Number(e.target.value), strikes) })}
                      className="w-20 bg-surface-2 border border-border rounded px-1 py-0.5 text-right tabular text-[11px]"
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input
                      type="number" step={0.01} min={0}
                      value={l.entry}
                      onChange={(e) => updateLeg(i, { entry: Math.max(0, Number(e.target.value)) })}
                      className="w-20 bg-surface-2 border border-border rounded px-1 py-0.5 text-right tabular text-[11px]"
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input
                      type="number" step={1} min={1}
                      value={l.qty ?? 1}
                      onChange={(e) => updateLeg(i, { qty: Math.max(1, Number(e.target.value)) })}
                      className="w-16 bg-surface-2 border border-border rounded px-1 py-0.5 text-right tabular text-[11px]"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCell({
  label, value, tone,
}: {
  label: string; value: React.ReactNode;
  tone?: "up" | "down";
}) {
  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-1.5 flex flex-col gap-0.5 min-w-0">
      <span className="text-[9px] uppercase tracking-wider text-text-muted">{label}</span>
      <span className={cn(
        "text-[13px] font-semibold tabular truncate",
        tone === "up" && "text-up",
        tone === "down" && "text-down",
        !tone && "text-text-primary",
      )}>{value}</span>
    </div>
  );
}

function StratSlider({
  label, accent, valueText, subText, min, max, step, value, onChange,
  isDefault, onReset, presets,
}: {
  label: string;
  accent: string;
  valueText: string;
  subText: string;
  min: number; max: number; step: number;
  value: number;
  onChange: (v: number) => void;
  isDefault: boolean;
  onReset: () => void;
  presets: { label: string; value: number }[];
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const isActivePreset = (pv: number) => Math.abs(value - pv) < step / 2;
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
        <span className="text-[13px] tabular font-semibold leading-none" style={{ color: accent }}>
          {valueText}
        </span>
        {!isDefault && (
          <button
            type="button" onClick={onReset}
            className="ml-auto text-[10px] uppercase tracking-wider text-text-muted hover:text-text-secondary"
          >
            reset
          </button>
        )}
      </div>
      <span className="text-[10px] tabular text-text-muted leading-none">{subText}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider-range w-full mt-1"
        style={{
          background: `linear-gradient(to right, ${accent} 0%, ${accent} ${pct}%, ${CHART.surface} ${pct}%, ${CHART.surface} 100%)`,
        }}
      />
      <div className="flex items-center gap-1 mt-0.5">
        {presets.map((p) => {
          const active = isActivePreset(p.value);
          return (
            <button
              key={p.label} type="button" onClick={() => onChange(p.value)}
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
    </div>
  );
}

function fmtPnl(v: number): string {
  if (!isFinite(v)) return v > 0 ? "∞" : "−∞";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${v < 0 ? "-" : ""}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${v < 0 ? "-" : ""}$${(a / 1_000).toFixed(1)}k`;
  return `${v < 0 ? "-" : ""}$${a.toFixed(0)}`;
}

function fmtExp(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(2, 4)}`;
}
