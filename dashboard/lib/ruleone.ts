// Rule One advanced-strategies trade screener.
//
// Encodes the four credit-spread strategies taught in Jamal Hobson's
// Rule One advanced course (Feb–May 2026 cohort) and the math used to
// decide whether a candidate bull-put spread qualifies.
//
// The OKW spreadsheet is the canonical source for AROC / Kelly /
// adjusted-%OTM math. The formulas here are the standard finance
// approximations and will match the OKW within rounding for normal
// inputs — but if a value disagrees with the OKW, trust the OKW.

export type StrategyId = "rut" | "mars" | "marsmax" | "space";
export type Underlying = "RUT" | "SPX";

export interface StrategySpec {
  id: StrategyId;
  name: string;
  underlying: Underlying;
  // Entry rules
  maxDelta: number; // short-leg delta cap (×100, so "10" = 0.10)
  minAdjOTM: number; // minimum adjusted %OTM
  arocTarget: number; // minimum annualized return on capital, %
  minKelly: number; // minimum Kelly % to size the trade
  // Exit rules — both always in effect
  exitDelta: number; // rule 1: exit when short delta closes above this
  lastDayBufferPct: number; // rule 2: on Thursday before expiry, close if
  // underlying is within this % of short strike
  floorRequired: boolean; // must be two fib-floors below price
  // Historical 2008–2019 backtest (per webinar1)
  histCagrPct: number;
  histAvgLossPct: number;
  histMaxLossPct: number;
  histWins: number;
  histTotal: number;
  hist10kGrewTo: number; // $10,000 → this much over 12 years
  scaleNote: string; // capacity / volume guidance
  notes: string;
}

export const STRATEGIES: StrategySpec[] = [
  {
    id: "rut",
    name: "Traditional RUT",
    underlying: "RUT",
    maxDelta: 10,
    minAdjOTM: 11,
    arocTarget: 48,
    minKelly: 20,
    exitDelta: 30,
    lastDayBufferPct: 3,
    floorRequired: true,
    histCagrPct: 40.8,
    histAvgLossPct: 25,
    histMaxLossPct: 45,
    histWins: 124,
    histTotal: 132,
    hist10kGrewTo: 600_000,
    scaleNote: "RUT volume ~62k contracts/day — fine for 1–50 ct sizing",
    notes: "Bull-put on RUT, ~25 DTE. 2 fib floors below price required.",
  },
  {
    id: "mars",
    name: "Mars",
    underlying: "RUT",
    maxDelta: 12,
    minAdjOTM: 9,
    arocTarget: 64,
    minKelly: 32,
    exitDelta: 36,
    lastDayBufferPct: 2,
    floorRequired: false,
    histCagrPct: 58,
    histAvgLossPct: 25,
    histMaxLossPct: 45,
    histWins: 124,
    histTotal: 133,
    hist10kGrewTo: 2_500_000,
    scaleNote: "RUT volume — same capacity as traditional RUT",
    notes: "More aggressive RUT. Floor not required (still recorded).",
  },
  {
    id: "marsmax",
    name: "Mars Max",
    underlying: "RUT",
    maxDelta: 14,
    minAdjOTM: 9,
    arocTarget: 93,
    minKelly: 32,
    exitDelta: 42,
    lastDayBufferPct: 2,
    floorRequired: false,
    histCagrPct: 70,
    histAvgLossPct: 33,
    histMaxLossPct: 69,
    histWins: 110,
    histTotal: 119,
    hist10kGrewTo: 5_900_000,
    scaleNote: "Size DOWN — single losses have hit ~70% of capital",
    notes:
      "Most aggressive. Close to the money — must exit on trigger, no waiting.",
  },
  {
    id: "space",
    name: "Space",
    underlying: "SPX",
    maxDelta: 12,
    minAdjOTM: 5,
    arocTarget: 74,
    minKelly: 44,
    exitDelta: 32,
    lastDayBufferPct: 2,
    floorRequired: false,
    histCagrPct: 48,
    histAvgLossPct: 25,
    histMaxLossPct: 45,
    // webinar1 doesn't quote exact Space win counts — use Mars-equivalent
    // (8 losses across ~125 trades) as a stand-in.
    histWins: 125,
    histTotal: 133,
    hist10kGrewTo: 1_100_000,
    scaleNote: "SPX volume ~3M contracts/day — use for 50+ ct positions",
    notes:
      "SPX-based. 44-Kelly floor is the gatekeeper — rare to find qualifying setups.",
  },
];

export function winRatePct(spec: StrategySpec): number {
  return spec.histTotal ? (spec.histWins / spec.histTotal) * 100 : 0;
}

export function specsFor(underlying: Underlying): StrategySpec[] {
  return STRATEGIES.filter((s) => s.underlying === underlying);
}

export interface TradeInput {
  underlying: Underlying;
  spot: number;
  dte: number;
  shortStrike: number;
  longStrike: number;
  credit: number; // mid credit per share
  shortDelta: number; // absolute, e.g. 0.10
  bankroll: number;
}

export interface TradeMetrics {
  width: number;
  maxProfitPerContract: number;
  maxLossPerContract: number;
  distancePct: number; // raw % below spot
  adjOTMPct: number; // time-normalized %OTM (sqrt-time approx)
  arocPct: number;
  probOTM: number; // 0..1, derived from |delta|
  kellyPct: number; // 0..100
  oneThirdCap: number; // 33% bankroll cap
  maxContractsKelly: number;
  maxContractsThird: number;
  recommendedContracts: number;
  breakeven: number; // spot at expiration where P&L = 0
}

export interface RiskOutlook {
  expectedAvgLossPerContract: number; // maxLoss × histAvgLoss%
  worstHistoricalLossPerContract: number; // maxLoss × histMaxLoss%
  expectedAvgLossDollars: number; // × recommendedContracts
  worstHistoricalLossDollars: number; // × recommendedContracts
  winRatePct: number;
}

export function riskOutlook(m: TradeMetrics, spec: StrategySpec): RiskOutlook {
  const expectedAvgLossPerContract =
    m.maxLossPerContract * (spec.histAvgLossPct / 100);
  const worstHistoricalLossPerContract =
    m.maxLossPerContract * (spec.histMaxLossPct / 100);
  return {
    expectedAvgLossPerContract,
    worstHistoricalLossPerContract,
    expectedAvgLossDollars: expectedAvgLossPerContract * m.recommendedContracts,
    worstHistoricalLossDollars:
      worstHistoricalLossPerContract * m.recommendedContracts,
    winRatePct: winRatePct(spec),
  };
}

export interface ExitPlan {
  rule1ExitDelta: number; // close when short |Δ| reaches this
  rule2BufferPct: number; // 2 or 3 — within this % on Thursday → close
  alertPrice: number; // suggested underlying-price alert level
  lastDayBufferPrice: number; // underlying level at which rule 2 fires
}

export function exitPlan(t: TradeInput, spec: StrategySpec): ExitPlan {
  // Symmetric for puts/calls — adjust sign of buffer based on side.
  // We default to put-side (the strategies are bull-put first).
  const preBuffer = spec.lastDayBufferPct / 2;
  const alertPrice = t.shortStrike * (1 + preBuffer / 100);
  const lastDayBufferPrice = t.shortStrike * (1 + spec.lastDayBufferPct / 100);
  return {
    rule1ExitDelta: spec.exitDelta,
    rule2BufferPct: spec.lastDayBufferPct,
    alertPrice,
    lastDayBufferPrice,
  };
}

export function calcMetrics(t: TradeInput): TradeMetrics {
  const width = Math.abs(t.shortStrike - t.longStrike);
  const maxProfitPerShare = t.credit;
  const maxLossPerShare = Math.max(width - t.credit, 0.01);
  const maxProfitPerContract = maxProfitPerShare * 100;
  const maxLossPerContract = maxLossPerShare * 100;

  const distancePct = ((t.spot - t.shortStrike) / t.spot) * 100;

  // Time-adjustment: scale raw distance by sqrt(DTE/30) so a longer-DTE
  // trade with the same nominal cushion reads as further OTM. This is
  // the standard sqrt-time vol-equivalence; OKW may use a slightly
  // different normalization.
  const adjOTMPct = distancePct * Math.sqrt(t.dte / 30);

  const arocPct =
    (t.credit / maxLossPerShare) * (365 / Math.max(t.dte, 1)) * 100;

  const probOTM = Math.max(0, Math.min(1, 1 - Math.abs(t.shortDelta)));
  const b = t.credit / maxLossPerShare;
  const kellyRaw = b > 0 ? (probOTM * b - (1 - probOTM)) / b : 0;
  const kellyPct = Math.max(0, kellyRaw * 100);

  const oneThirdCap = t.bankroll / 3;
  const maxContractsKelly =
    maxLossPerContract > 0
      ? Math.floor((t.bankroll * (kellyPct / 100)) / maxLossPerContract)
      : 0;
  const maxContractsThird =
    maxLossPerContract > 0 ? Math.floor(oneThirdCap / maxLossPerContract) : 0;
  const recommendedContracts = Math.max(
    0,
    Math.min(maxContractsKelly, maxContractsThird),
  );

  const breakeven = t.shortStrike - t.credit;

  return {
    width,
    maxProfitPerContract,
    maxLossPerContract,
    distancePct,
    adjOTMPct,
    arocPct,
    probOTM,
    kellyPct,
    oneThirdCap,
    maxContractsKelly,
    maxContractsThird,
    recommendedContracts,
    breakeven,
  };
}

export interface CheckResult {
  spec: StrategySpec;
  applicable: boolean;
  passes: boolean;
  failureReasons: string[];
  checks: {
    delta: Check;
    adjOTM: Check;
    aroc: Check;
    kelly: Check;
  };
}

interface Check {
  pass: boolean;
  value: number;
  limit: number;
  label: string;
}

export function checkStrategy(
  t: TradeInput,
  m: TradeMetrics,
  spec: StrategySpec,
): CheckResult {
  const applicable = t.underlying === spec.underlying;
  const deltaVal = Math.abs(t.shortDelta) * 100;

  const checks = {
    delta: {
      pass: deltaVal <= spec.maxDelta,
      value: deltaVal,
      limit: spec.maxDelta,
      label: `Δ ≤ ${spec.maxDelta}`,
    },
    adjOTM: {
      pass: m.adjOTMPct >= spec.minAdjOTM,
      value: m.adjOTMPct,
      limit: spec.minAdjOTM,
      label: `adj %OTM ≥ ${spec.minAdjOTM}`,
    },
    aroc: {
      pass: m.arocPct >= spec.arocTarget,
      value: m.arocPct,
      limit: spec.arocTarget,
      label: `AROC ≥ ${spec.arocTarget}%`,
    },
    kelly: {
      pass: m.kellyPct >= spec.minKelly,
      value: m.kellyPct,
      limit: spec.minKelly,
      label: `Kelly ≥ ${spec.minKelly}`,
    },
  };

  const failureReasons: string[] = [];
  if (!applicable) failureReasons.push(`requires ${spec.underlying}`);
  for (const [, c] of Object.entries(checks)) {
    if (!c.pass) failureReasons.push(c.label);
  }

  return {
    spec,
    applicable,
    passes: applicable && Object.values(checks).every((c) => c.pass),
    failureReasons,
    checks,
  };
}

export function checkAll(t: TradeInput, m: TradeMetrics): CheckResult[] {
  return STRATEGIES.map((s) => checkStrategy(t, m, s));
}
