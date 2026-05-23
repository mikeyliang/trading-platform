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
