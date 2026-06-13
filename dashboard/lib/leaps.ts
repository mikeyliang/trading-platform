// Client-side contract ranker for the option-chain "best picks" panel.
//
// Goal: surface, for a chosen expiration, the single best contract to BUY
// (a long deep-ITM call — the classic LEAPS stock-replacement play for
// long-term capital gains) and to SELL (a cash-secured put — the bullish
// income/acquisition play). We score off the chain rows the UI already has
// (Greeks + bid/ask/OI), so there's no extra backend round-trip.
//
// Scores are 0-100 with a fully transparent breakdown:
//   total = 50 (base) + Σ component contributions (Δ, extrinsic, liquidity,
//   horizon, iv), each clamped at the end. Components are surfaced as a
//   `breakdown` object so the UI can render a score-driver bar, and each
//   reason carries a `sign` (+1 / 0 / -1) so positives and negatives can be
//   chipped separately without the UI re-deriving sentiment.

import type { OptionRow, OptionsChain } from "@/lib/api";

export type ReasonSign = 1 | 0 | -1;
export interface Reason {
  text: string;
  sign: ReasonSign;
}

export interface ScoreBreakdown {
  delta: number;
  extrinsic: number;
  liquidity: number;
  horizon: number;
  iv: number;
}

export interface RankedContract {
  row: OptionRow;
  side: "call" | "put";
  lens: "buy" | "sell"; // buy = long call, sell = short put
  mid: number;
  spreadPct: number | null;
  intrinsic: number;
  extrinsic: number;
  extrinsicPct: number | null;
  distancePct: number; // (spot - strike) / spot * 100
  breakeven: number;
  absDelta: number;
  score: number; // 0-100
  breakdown: ScoreBreakdown;
  reasons: Reason[];
}

export interface LeapsRanking {
  dte: number;
  ltcgEligible: boolean; // held to expiry would clear the >1y LTCG bar
  spot: number | null;
  bestBuy: RankedContract | null; // best long call
  bestSell: RankedContract | null; // best short put
  rankedCalls: RankedContract[];
  rankedPuts: RankedContract[];
}

export const SCORE_BASE = 50;
export const BREAKDOWN_KEYS = ["delta", "extrinsic", "liquidity", "horizon", "iv"] as const;
export type BreakdownKey = (typeof BREAKDOWN_KEYS)[number];

export function daysToExpiry(yyyymmdd: string, from: Date = new Date()): number {
  if (yyyymmdd.length !== 8) return 0;
  const exp = new Date(
    +yyyymmdd.slice(0, 4),
    +yyyymmdd.slice(4, 6) - 1,
    +yyyymmdd.slice(6, 8),
  );
  return Math.max(0, Math.ceil((exp.getTime() - from.getTime()) / 86_400_000));
}

function mid(row: OptionRow): number | null {
  if (row.bid != null && row.ask != null && row.ask > 0) return (row.bid + row.ask) / 2;
  if (row.last != null && row.last > 0) return row.last;
  if (row.ask != null && row.ask > 0) return row.ask / 2;
  return null;
}

function spreadPct(row: OptionRow, m: number): number | null {
  if (row.bid == null || row.ask == null || row.bid <= 0 || row.ask <= 0 || m <= 0) return null;
  return ((row.ask - row.bid) / m) * 100;
}

function liquidityScore(
  sp: number | null,
  oi: number | null,
): { pts: number; reasons: Reason[] } {
  let pts = 0;
  const reasons: Reason[] = [];
  if (sp == null) {
    pts -= 15;
    reasons.push({ text: "no two-sided quote", sign: -1 });
  } else if (sp <= 2) {
    pts += 10;
    reasons.push({ text: `tight ${sp.toFixed(1)}% spread`, sign: 1 });
  } else if (sp <= 5) {
    pts += 5;
  } else if (sp <= 10) {
    pts += 0;
  } else {
    pts -= 12;
    reasons.push({ text: `wide ${sp.toFixed(0)}% spread`, sign: -1 });
  }
  if (oi != null) {
    if (oi >= 500) pts += 5;
    else if (oi >= 100) pts += 2;
    else if (oi < 50) {
      pts -= 5;
      reasons.push({ text: `thin OI ${oi}`, sign: -1 });
    }
  }
  return { pts, reasons };
}

// ── Long call (LEAPS stock replacement) ─────────────────────────────────
function scoreLongCall(row: OptionRow, spot: number, dte: number): RankedContract | null {
  const m = mid(row);
  if (m == null) return null;
  const intrinsic = Math.max(spot - row.strike, 0);
  const extrinsic = Math.max(m - intrinsic, 0);
  const extrinsicPct = m > 0 ? (extrinsic / m) * 100 : null;
  const sp = spreadPct(row, m);
  const absDelta = row.delta != null ? Math.abs(row.delta) : 0;
  const reasons: Reason[] = [];
  const bd: ScoreBreakdown = { delta: 0, extrinsic: 0, liquidity: 0, horizon: 0, iv: 0 };

  // Delta — the heart of stock replacement. 0.70-0.85 = stock-like, minimal
  // time-decay drag, but still cheaper than 100 shares.
  if (absDelta >= 0.7 && absDelta <= 0.85) {
    bd.delta = 20;
    reasons.push({ text: `Δ ${absDelta.toFixed(2)} — deep-ITM, stock-like`, sign: 1 });
  } else if ((absDelta >= 0.6 && absDelta < 0.7) || (absDelta > 0.85 && absDelta <= 0.92)) {
    bd.delta = 10;
    reasons.push({ text: `Δ ${absDelta.toFixed(2)}`, sign: 1 });
  } else if (absDelta >= 0.45 && absDelta < 0.6) {
    bd.delta = 0;
    reasons.push({ text: `Δ ${absDelta.toFixed(2)} — ATM, more leverage`, sign: 0 });
  } else if (absDelta > 0.92) {
    bd.delta = 2;
    reasons.push({ text: `Δ ${absDelta.toFixed(2)} — very deep, capital-heavy`, sign: 0 });
  } else if (absDelta > 0) {
    bd.delta = -15;
    reasons.push({ text: `Δ ${absDelta.toFixed(2)} — OTM, decay risk for a hold`, sign: -1 });
  }

  // Extrinsic % — every dollar of time premium is what you bleed to theta.
  if (extrinsicPct != null) {
    if (extrinsicPct <= 10) {
      bd.extrinsic = 15;
      reasons.push({ text: `only ${extrinsicPct.toFixed(0)}% time value`, sign: 1 });
    } else if (extrinsicPct <= 20) {
      bd.extrinsic = 8;
    } else if (extrinsicPct <= 35) {
      bd.extrinsic = 0;
    } else {
      bd.extrinsic = -15;
      reasons.push({ text: `${extrinsicPct.toFixed(0)}% time value — pricey to hold`, sign: -1 });
    }
  }

  const liq = liquidityScore(sp, row.oi);
  bd.liquidity = liq.pts;
  reasons.push(...liq.reasons);

  // LTCG / LEAPS horizon — held >1y clears the long-term bar.
  if (dte > 365) {
    bd.horizon = 12;
    reasons.push({ text: "expiry >1y — LTCG-eligible if held", sign: 1 });
  } else if (dte >= 270) {
    bd.horizon = 4;
  } else {
    bd.horizon = -8;
    reasons.push({ text: `${dte}d — short for a LEAPS hold`, sign: -1 });
  }

  if (row.iv != null && row.iv > 0.8) {
    bd.iv = -5;
    reasons.push({ text: `IV ${(row.iv * 100).toFixed(0)}% — rich premium`, sign: -1 });
  }

  const total = SCORE_BASE + bd.delta + bd.extrinsic + bd.liquidity + bd.horizon + bd.iv;

  return {
    row,
    side: "call",
    lens: "buy",
    mid: m,
    spreadPct: sp,
    intrinsic,
    extrinsic,
    extrinsicPct,
    distancePct: ((spot - row.strike) / spot) * 100,
    breakeven: row.strike + m,
    absDelta,
    score: Math.max(0, Math.min(100, Math.round(total))),
    breakdown: bd,
    reasons: reasons.slice(0, 5),
  };
}

// ── Short put (cash-secured put) ────────────────────────────────────────
function scoreShortPut(row: OptionRow, spot: number, dte: number): RankedContract | null {
  const m = mid(row);
  if (m == null) return null;
  const intrinsic = Math.max(row.strike - spot, 0);
  const extrinsic = Math.max(m - intrinsic, 0);
  const extrinsicPct = m > 0 ? (extrinsic / m) * 100 : null;
  const sp = spreadPct(row, m);
  const absDelta = row.delta != null ? Math.abs(row.delta) : 0;
  const reasons: Reason[] = [];
  const bd: ScoreBreakdown = { delta: 0, extrinsic: 0, liquidity: 0, horizon: 0, iv: 0 };

  // Delta — for a short put, ~0.15-0.35 is the sweet spot: real premium,
  // comfortably OTM, low assignment odds.
  if (absDelta >= 0.15 && absDelta <= 0.35) {
    bd.delta = 18;
    reasons.push({ text: `Δ ${absDelta.toFixed(2)} — OTM, low assignment risk`, sign: 1 });
  } else if ((absDelta >= 0.1 && absDelta < 0.15) || (absDelta > 0.35 && absDelta <= 0.45)) {
    bd.delta = 6;
    reasons.push({ text: `Δ ${absDelta.toFixed(2)}`, sign: 1 });
  } else if (absDelta > 0.45) {
    bd.delta = -15;
    reasons.push({ text: `Δ ${absDelta.toFixed(2)} — near ITM, assignment risk`, sign: -1 });
  } else if (absDelta > 0 && absDelta < 0.1) {
    bd.delta = -5;
    reasons.push({ text: `Δ ${absDelta.toFixed(2)} — little premium`, sign: -1 });
  }

  // Premium yield against strike (capital you'd secure).
  const premiumPct = row.strike > 0 ? (m / row.strike) * 100 : 0;
  if (premiumPct >= 3) {
    bd.extrinsic = 12;
    reasons.push({ text: `${premiumPct.toFixed(1)}% premium on strike`, sign: 1 });
  } else if (premiumPct >= 1.5) {
    bd.extrinsic = 6;
  } else if (premiumPct < 0.5) {
    bd.extrinsic = -6;
    reasons.push({ text: `thin ${premiumPct.toFixed(1)}% premium`, sign: -1 });
  }

  const liq = liquidityScore(sp, row.oi);
  bd.liquidity = liq.pts;
  reasons.push(...liq.reasons);

  // Richer IV pays the seller more.
  if (row.iv != null && row.iv > 0.4) {
    bd.iv = 5;
    reasons.push({ text: `IV ${(row.iv * 100).toFixed(0)}% — rich to sell`, sign: 1 });
  }

  if (dte > 365) reasons.push({ text: "LEAPS-dated — locks capital long", sign: 0 });

  const total = SCORE_BASE + bd.delta + bd.extrinsic + bd.liquidity + bd.horizon + bd.iv;

  return {
    row,
    side: "put",
    lens: "sell",
    mid: m,
    spreadPct: sp,
    intrinsic,
    extrinsic,
    extrinsicPct,
    distancePct: ((spot - row.strike) / spot) * 100,
    breakeven: row.strike - m,
    absDelta,
    score: Math.max(0, Math.min(100, Math.round(total))),
    breakdown: bd,
    reasons: reasons.slice(0, 5),
  };
}

export function rankContracts(chain: OptionsChain | null, expiry: string | null): LeapsRanking {
  const empty: LeapsRanking = {
    dte: 0,
    ltcgEligible: false,
    spot: chain?.underlying_price ?? null,
    bestBuy: null,
    bestSell: null,
    rankedCalls: [],
    rankedPuts: [],
  };
  const spot = chain?.underlying_price ?? null;
  if (!chain || !expiry || spot == null || spot <= 0) return empty;

  const dte = daysToExpiry(expiry);
  const rankedCalls = chain.calls
    .map((r) => scoreLongCall(r, spot, dte))
    .filter((x): x is RankedContract => x != null)
    .sort((a, b) => b.score - a.score);
  const rankedPuts = chain.puts
    .map((r) => scoreShortPut(r, spot, dte))
    .filter((x): x is RankedContract => x != null)
    .sort((a, b) => b.score - a.score);

  return {
    dte,
    ltcgEligible: dte > 365,
    spot,
    bestBuy: rankedCalls[0] ?? null,
    bestSell: rankedPuts[0] ?? null,
    rankedCalls,
    rankedPuts,
  };
}
