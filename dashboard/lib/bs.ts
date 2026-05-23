/**
 * Client-side Black-Scholes pricer + P/L helpers for the interactive
 * P/L profile chart. Used by the date / IV sliders so the curve updates
 * on every drag without a round-trip to the backend.
 *
 * Vanilla European options. Continuous dividend yield `q` (default 0).
 * Risk-free rate `r` defaults to 5% — high enough that ATM options still
 * have visible carry, low enough that it doesn't dominate near-dated P/L.
 *
 * All inputs are in trader units: prices in dollars, time in years,
 * sigma as an annualized decimal (e.g. 0.25 for 25%).
 */

// Abramowitz–Stegun erf approximation. Max error ~1.5e-7.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const y =
    1 -
    (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Black-Scholes European option price.
 *
 * @param s        underlying spot
 * @param k        strike
 * @param t        time to expiry, in YEARS
 * @param sigma    annualized volatility (e.g. 0.25)
 * @param r        risk-free rate (annualized)
 * @param q        continuous dividend yield (annualized)
 * @param isCall   true=call, false=put
 *
 * Returns intrinsic value when t ≤ 0 or sigma ≤ 0 so the curve at
 * expiry / with no vol is correct without a separate code path.
 */
export function bsPrice(
  s: number,
  k: number,
  t: number,
  sigma: number,
  r: number,
  q: number,
  isCall: boolean,
): number {
  if (t <= 0 || sigma <= 0 || s <= 0) {
    return Math.max(0, isCall ? s - k : k - s);
  }
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r - q + (sigma * sigma) / 2) * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (isCall) {
    return s * Math.exp(-q * t) * normCdf(d1) - k * Math.exp(-r * t) * normCdf(d2);
  }
  return k * Math.exp(-r * t) * normCdf(-d2) - s * Math.exp(-q * t) * normCdf(-d1);
}

export interface PnlInputs {
  spot: number;
  strike: number;
  /** Years until expiry at "now" (the live trade). */
  dteYears: number;
  /** Current implied vol (annualized decimal). */
  iv: number;
  /** "C" or "P". */
  isCall: boolean;
  /** Long vs short. */
  isLong: boolean;
  /** Entry premium, $/share. */
  entryPrice: number;
  /** Number of contracts. */
  quantity: number;
  /** Risk-free rate, annualized. Defaults to 5%. */
  r?: number;
  /** Continuous dividend yield, annualized. Defaults to 0. */
  q?: number;
}

/**
 * P/L of the position at (underlying=`s`, time-remaining=`tRemaining`,
 * vol=`sigma`). Output is dollars, signed by long/short.
 *
 * The convention: long pays entryPrice up front, gains as option
 * appreciates; short collects entryPrice, gains as option decays. Both
 * are multiplied by `100 × |quantity|`.
 */
export function bsPnl(
  s: number,
  tRemaining: number,
  sigma: number,
  inputs: PnlInputs,
): number {
  const r = inputs.r ?? 0.05;
  const q = inputs.q ?? 0.0;
  const price = bsPrice(s, inputs.strike, tRemaining, sigma, r, q, inputs.isCall);
  const sign = inputs.isLong ? 1 : -1;
  return sign * (price - inputs.entryPrice) * Math.abs(inputs.quantity) * 100;
}

/**
 * Compute a P/L curve across an array of underlying prices, at a chosen
 * future date (days from now) and IV multiplier.
 *
 * `daysFromNow=0` → curve TODAY. `daysFromNow >= dteYears*365` → expiry
 * intrinsic. `ivMult=1` → today's IV. `ivMult=2` → IV doubles.
 */
export function pnlCurve(
  prices: number[],
  daysFromNow: number,
  ivMult: number,
  inputs: PnlInputs,
): number[] {
  const tRemaining = Math.max(0, inputs.dteYears - daysFromNow / 365.25);
  const sigma = Math.max(0, inputs.iv * ivMult);
  return prices.map((p) => bsPnl(p, tRemaining, sigma, inputs));
}

/**
 * Convenience: P/L at expiry (intrinsic) — the reference curve. No vol
 * sensitivity, no time value. Always the same shape regardless of
 * sliders, so it's drawn as a faint reference behind the live curve.
 */
export function expiryIntrinsicCurve(
  prices: number[],
  inputs: PnlInputs,
): number[] {
  return prices.map((p) => bsPnl(p, 0, 0, inputs));
}

/**
 * Sample a price axis centered on spot with `range` half-width as a
 * fraction of spot. e.g. range=0.25 → ±25% around spot, 161 samples.
 */
export function samplePriceAxis(spot: number, range: number, n = 161): number[] {
  const half = Math.max(0.01, range) * spot;
  const lo = Math.max(0.01, spot - half);
  const hi = spot + half;
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = lo + ((hi - lo) * i) / (n - 1);
  }
  return out;
}

// ── Multi-leg strategies ────────────────────────────────────────────────

/** One leg of a multi-leg strategy. `entry` is the premium paid/collected
 *  per share (positive number). Action sign is folded in via `action`. */
export interface StrategyLeg {
  strike: number;
  isCall: boolean;
  action: "BUY" | "SELL";
  entry: number;
  /** Per-leg quantity (contracts). Defaults to 1 when undefined. */
  qty?: number;
}

/**
 * P/L of a multi-leg position at (s, tRemaining, sigma). Each leg is a
 * vanilla European option priced with the shared BS formula. The legs
 * share `t`, `sigma`, `r`, `q` — i.e. one expiry and a single IV (the
 * trading convention; per-leg IV would require a vol surface).
 */
export function strategyPnl(
  s: number,
  tRemaining: number,
  sigma: number,
  legs: StrategyLeg[],
  r = 0.05,
  q = 0.0,
): number {
  let total = 0;
  for (const leg of legs) {
    const qty = leg.qty ?? 1;
    const sign = leg.action === "BUY" ? 1 : -1;
    const price = bsPrice(s, leg.strike, tRemaining, sigma, r, q, leg.isCall);
    total += sign * (price - leg.entry) * qty * 100;
  }
  return total;
}

/** P/L curve for a multi-leg strategy across a price axis. */
export function strategyPnlCurve(
  prices: number[],
  daysFromNow: number,
  ivMult: number,
  legs: StrategyLeg[],
  dteYears: number,
  baseIv: number,
  r = 0.05,
  q = 0.0,
): number[] {
  const t = Math.max(0, dteYears - daysFromNow / 365.25);
  const sigma = Math.max(0, baseIv * ivMult);
  return prices.map((p) => strategyPnl(p, t, sigma, legs, r, q));
}

/** Expiry intrinsic curve for a multi-leg strategy. */
export function strategyExpiryCurve(
  prices: number[],
  legs: StrategyLeg[],
): number[] {
  return prices.map((p) => strategyPnl(p, 0, 0, legs));
}

// ── Greeks (per-contract, equity-option 100× multiplier applied) ────────

/**
 * Analytic Black-Scholes Greeks. All returned values are PER-SHARE — the
 * UI multiplies by 100 for per-contract presentation, mirroring how the
 * existing GreeksPanel works.
 *
 *   delta   ∂price/∂spot
 *   gamma   ∂²price/∂spot²
 *   theta   ∂price/∂t  (per CALENDAR DAY, sign as in trading convention:
 *                       long calls have negative theta)
 *   vega    ∂price/∂sigma · 0.01  (per 1 vol point, e.g. 25%→26%)
 */
export function bsGreeks(
  s: number,
  k: number,
  t: number,
  sigma: number,
  r: number,
  q: number,
  isCall: boolean,
): { delta: number; gamma: number; theta: number; vega: number } {
  if (t <= 0 || sigma <= 0 || s <= 0) {
    // Degenerate: only delta and a step at the strike survive.
    const intrinsic = isCall ? (s > k ? 1 : 0) : (s < k ? -1 : 0);
    return { delta: intrinsic, gamma: 0, theta: 0, vega: 0 };
  }
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r - q + (sigma * sigma) / 2) * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const Nd1 = normCdf(d1);
  const Nd2 = normCdf(d2);
  const nd1 = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * d1 * d1);
  const eqT = Math.exp(-q * t);
  const erT = Math.exp(-r * t);

  const delta = isCall ? eqT * Nd1 : eqT * (Nd1 - 1);
  const gamma = (eqT * nd1) / (s * sigma * sqrtT);
  // theta annualized, then converted to per-calendar-day. Sign matches the
  // industry "theta = ∂V/∂t with t increasing toward expiry" convention.
  const thetaAnnual = isCall
    ? -(s * eqT * nd1 * sigma) / (2 * sqrtT) - r * k * erT * Nd2 + q * s * eqT * Nd1
    : -(s * eqT * nd1 * sigma) / (2 * sqrtT) + r * k * erT * normCdf(-d2) - q * s * eqT * normCdf(-d1);
  const theta = thetaAnnual / 365.25;
  const vega = s * eqT * nd1 * sqrtT * 0.01;

  return { delta, gamma, theta, vega };
}
