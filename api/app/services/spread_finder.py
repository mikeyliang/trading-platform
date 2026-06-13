"""Mars / Mars Max / Space / RUT credit-spread scanner.

Canonical source for the trade specs is ``services/dashboard/lib/ruleone.ts``
which encodes Jamal Hobson's Rule One advanced course (Feb–May 2026 cohort).
The OKW spreadsheet is the ground truth for AROC / Kelly / adjusted %OTM
math; values here use the same standard finance approximations.

Trade specs (entry rules + historical 2008–2019 backtest from webinar1):
  RUT (trad): Δ ≤ 10, adj %OTM ≥ 11%, AROC ≥ 48%, Kelly ≥ 20, exit Δ 30
              hist: 40.8% CAGR, 124/132 wins, avg loss 25%, $10k→$600k
  Mars:       Δ ≤ 12, adj %OTM ≥ 9%,  AROC ≥ 64%, Kelly ≥ 32, exit Δ 36
              hist: 58.0% CAGR, 124/133 wins, avg loss 25%, max loss 45%,
              $10k→$2.5M
  Mars Max:   Δ ≤ 14, adj %OTM ≥ 9%,  AROC ≥ 93%, Kelly ≥ 32, exit Δ 42
              hist: 70.0% CAGR, 110/119 wins, avg loss 33%, max loss 69%,
              $10k→$5.9M
  Space:      Δ ≤ 12, adj %OTM ≥ 5%,  AROC ≥ 74%, Kelly ≥ 44, exit Δ 32
              hist: 48.0% CAGR, avg loss 25%, max loss 45%, $10k→$1.1M

Two exit rules (both always in effect):
  1. Short-leg |Δ| ≥ trade-specific delta_exit → close immediately.
  2. On the Thursday before expiration, if underlying within
     ``last_day_buffer_pct`` of the short strike → close.

Adjusted %OTM = raw distance% × sqrt(DTE/30) (time-vol equivalence).
All metrics assume bull-put credit spreads by default; ``side="call"``
mirrors the math for the bear-call side of an iron condor.
"""
from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from ..nautilus import ib_options

logger = logging.getLogger(__name__)


def _chain_provider():
    """IBKR is the only chain source."""
    return ib_options


# ----------------------------------------------------------------------
# Spec
# ----------------------------------------------------------------------

@dataclass
class TradeSpec:
    # Entry rules
    name: str
    underlying: str           # "RUT" or "SPX"
    max_delta: float          # short-leg delta CAP (not just probe anchor)
    min_adj_distance_pct: float
    target_aroc_pct: float
    min_kelly_pct: float
    # Exit rules
    delta_exit: float         # exit-rule #1: close when |delta_short| hits this
    last_day_buffer_pct: float  # exit-rule #2: on Thursday before expiry, close
                                # when underlying is within this % of short strike
    floor_required: bool      # ≥ 2 fib floors below money required to qualify
    # Historical backtest (2008–2019, 12-yr, per webinar1)
    hist_cagr_pct: float          # compounded annual growth rate
    hist_avg_loss_pct: float      # average loss when an exit was triggered
    hist_max_loss_pct: float      # worst single loss observed
    hist_wins: int                # trades that expired OTM
    hist_total: int               # total trades placed
    hist_10k_grew_to: float       # $10,000 → $X after 12 years (per webinar1)
    # Sizing / scale guidance
    scale_note: str = ""      # capacity / volume guidance from the transcript
    description: str = ""

    @property
    def hist_win_rate_pct(self) -> float:
        return (self.hist_wins / self.hist_total * 100) if self.hist_total else 0.0


TRADE_SPECS: Dict[str, TradeSpec] = {
    "rut": TradeSpec(
        name="rut", underlying="RUT",
        max_delta=0.10, min_adj_distance_pct=11.0,
        target_aroc_pct=48.0, min_kelly_pct=20.0,
        delta_exit=0.30, last_day_buffer_pct=3.0,
        floor_required=True,
        hist_cagr_pct=40.8, hist_avg_loss_pct=25.0, hist_max_loss_pct=45.0,
        hist_wins=124, hist_total=132, hist_10k_grew_to=600_000.0,
        scale_note="RUT volume ~62k contracts/day — fine for 1–50 ct sizing",
        description="Traditional RUT — Δ ≤ 10, 2 fib floors below money required",
    ),
    "mars": TradeSpec(
        name="mars", underlying="RUT",
        max_delta=0.12, min_adj_distance_pct=9.0,
        target_aroc_pct=64.0, min_kelly_pct=32.0,
        delta_exit=0.36, last_day_buffer_pct=2.0,
        floor_required=False,
        hist_cagr_pct=58.0, hist_avg_loss_pct=25.0, hist_max_loss_pct=45.0,
        hist_wins=124, hist_total=133, hist_10k_grew_to=2_500_000.0,
        scale_note="RUT volume — same capacity as traditional RUT",
        description="Mars — more aggressive RUT spread, closer to money",
    ),
    "marsmax": TradeSpec(
        name="marsmax", underlying="RUT",
        max_delta=0.14, min_adj_distance_pct=9.0,
        target_aroc_pct=93.0, min_kelly_pct=32.0,
        delta_exit=0.42, last_day_buffer_pct=2.0,
        floor_required=False,
        hist_cagr_pct=70.0, hist_avg_loss_pct=33.0, hist_max_loss_pct=69.0,
        hist_wins=110, hist_total=119, hist_10k_grew_to=5_900_000.0,
        scale_note="RUT volume — capacity OK, but size DOWN: max loss can be 70%",
        description="Mars Max — most aggressive RUT; do NOT hesitate on exit",
    ),
    "space": TradeSpec(
        name="space", underlying="SPX",
        max_delta=0.12, min_adj_distance_pct=5.0,
        target_aroc_pct=74.0, min_kelly_pct=44.0,
        delta_exit=0.32, last_day_buffer_pct=2.0,
        floor_required=False,
        hist_cagr_pct=48.0, hist_avg_loss_pct=25.0, hist_max_loss_pct=45.0,
        # webinar1 doesn't quote exact Space win counts — use Mars-equivalent
        # (8 losses over 12 years, ~125 trades) as a stand-in. Update if/when
        # the OKW worksheet supplies a precise count.
        hist_wins=125, hist_total=133, hist_10k_grew_to=1_100_000.0,
        scale_note="SPX volume ~3M contracts/day — use for 50+ ct positions",
        description="Space — SPX-based; 44-Kelly floor is the gatekeeper",
    ),
}

# Acceptable DTE windows for "monthly" trades. The course uses 27 or 34
# days; we widen by ±3 to swallow holiday-truncated months. On the free
# Massive tier we scan just the nearest bucket to keep the first scan
# tractable (each expiry costs ~3-4 min of rate-limited /prev calls).
MONTHLY_DTE_BUCKETS = [
    (24, 37),  # one bucket covering both near (27d) and far (34d) monthlies
]
# Ideal monthly entry target (course: 27/34 DTE; mid ≈ 30) and a floor below
# which a monthly is too short-dated to bother scanning. Used by the
# nearest-monthly fallback when the strict bucket above is empty.
MONTHLY_DTE_TARGET = 30
MONTHLY_DTE_FLOOR = 12


# ----------------------------------------------------------------------
# Candidate model
# ----------------------------------------------------------------------

@dataclass
class SpreadCandidate:
    trade_type: str
    side: Literal["put", "call"]
    symbol: str
    expiry: str               # YYYYMMDD
    dte: int
    short_strike: float
    long_strike: float
    short_delta: float
    short_iv: Optional[float]
    credit: float             # per share (×100 = per contract dollars)
    max_risk: float           # per share
    wing_width: float
    distance_pct: float       # |spot - short_strike| / spot × 100
    adj_distance_pct: float   # distance minus 1σ expected move
    aroc_pct: float           # annualized return on capital
    win_prob_pct: float       # ≈ 1 - |short_delta|
    kelly_pct: float
    underlying_price: float
    passes: Dict[str, bool] = field(default_factory=dict)
    # ---- Automation / sizing payload (per-contract dollars unless noted) ----
    # Capital pct of bankroll → min(Kelly%, Rule-One 33% cap). Multiply by
    # bankroll/max_loss_per_contract → max safe contracts.
    recommended_capital_pct: float = 0.0
    max_loss_per_contract: float = 0.0  # ($) = max_risk × 100
    credit_per_contract: float = 0.0    # ($) = credit × 100
    expected_avg_loss_per_contract: float = 0.0  # max_loss × hist_avg_loss_pct
    worst_historical_loss_per_contract: float = 0.0  # max_loss × hist_max_loss_pct
    # Alert price thresholds — used by the monitor + chart overlay
    alert_price: Optional[float] = None  # set an underlying-price alert here:
                                         # one "buffer" tick above the short
                                         # strike on a put spread.
    last_day_buffer_price: Optional[float] = None  # exit-rule #2 trigger price:
                                                   # within last_day_buffer_pct
                                                   # of short_strike.
    # Spec snapshot — included so the dashboard doesn't need a second lookup
    delta_exit_pct: float = 0.0          # ×100, e.g. 36.0 for Mars
    last_day_buffer_pct: float = 0.0     # 2.0 or 3.0

    def to_dict(self) -> Dict[str, Any]:
        d = self.__dict__.copy()
        for k, v in list(d.items()):
            if isinstance(v, float) and math.isnan(v):
                d[k] = None
        return d

    @property
    def is_valid(self) -> bool:
        return all(self.passes.values())


# ----------------------------------------------------------------------
# Public API
# ----------------------------------------------------------------------

async def scan(
    symbol: str = "RUT",
    side: Literal["put", "call", "both"] = "put",
    trade_types: Optional[List[str]] = None,
    max_per_type: int = 5,
) -> Dict[str, Any]:
    """Scan for monthly credit-spread candidates across all requested trade types.

    Each trade type targets a specific underlying (RUT or SPX). When the caller
    passes ``symbol="RUT"`` we only scan RUT-anchored types (rut/mars/marsmax)
    against RUT, and skip SPX-only types (space). Pass ``symbol="SPX"`` (or any
    string starting with ``SPX``) to include Space; pass ``symbol="ALL"`` to
    fan out across both underlyings in one response.
    """
    requested = trade_types or list(TRADE_SPECS.keys())

    # Decide which underlyings to fetch based on which trade types are requested
    # and the caller's symbol hint.
    if symbol.upper() == "ALL":
        underlyings = sorted({TRADE_SPECS[t].underlying for t in requested if t in TRADE_SPECS})
    else:
        underlyings = [symbol.upper()]

    results: Dict[str, List[Dict[str, Any]]] = {t: [] for t in requested}
    underlying_prices: Dict[str, Optional[float]] = {}
    expirations_scanned: Dict[str, List[str]] = {}
    errors: Dict[str, str] = {}

    today = datetime.now(timezone.utc).date()

    for u in underlyings:
        applicable = [t for t in requested if TRADE_SPECS.get(t) and TRADE_SPECS[t].underlying == u]
        if not applicable:
            continue

        # Chain lookups touch external APIs (yfinance / Polygon). Wrap each
        # so a single upstream failure (Yahoo 429, Polygon NOT_AUTHORIZED,
        # network timeout) doesn't bring down the whole scan.
        try:
            chain = await _chain_provider().get_chain(u)
        except Exception as e:
            logger.warning("chain provider failed for %s: %s", u, e)
            errors[u] = f"chain provider error: {type(e).__name__}: {e}"
            underlying_prices[u] = None
            continue

        spot = chain.get("underlying_price")
        underlying_prices[u] = spot
        if not spot:
            errors[u] = chain.get("error", "no underlying price (data provider unreachable?)")
            continue

        expirations = _pick_monthly_expirations(chain.get("expirations") or [])
        expirations_scanned[u] = expirations
        if not expirations:
            errors[u] = "no monthly expirations in 24-37 DTE window"
            continue

        try:
            full_chains = await asyncio.gather(
                *[_chain_provider().get_chain(u, e) for e in expirations],
                return_exceptions=True,
            )
        except Exception as e:
            logger.warning("expiry hydration failed for %s: %s", u, e)
            errors[u] = f"expiry hydration error: {e}"
            continue
        # Drop any expiries that errored out; keep the successful ones.
        full_chains = [c for c in full_chains if isinstance(c, dict)]

        for full in full_chains:
            expiry = full["expirations"][0]
            dte = (datetime.strptime(expiry, "%Y%m%d").date() - today).days
            sides_to_scan: List[Literal["put", "call"]] = (
                ["put", "call"] if side == "both" else [side]  # type: ignore[list-item]
            )
            for s in sides_to_scan:
                options = full["puts"] if s == "put" else full["calls"]
                for t in applicable:
                    spec = TRADE_SPECS[t]
                    candidates = _find_candidates_for_spec(
                        options=options, spec=spec, side=s,
                        symbol=u, expiry=expiry, dte=dte, spot=spot,
                    )
                    results[t].extend(c.to_dict() for c in candidates)

    for t, rows in results.items():
        rows.sort(
            key=lambda r: (
                -int(all(r.get("passes", {}).values())),
                -r.get("distance_pct", 0),
                -r.get("aroc_pct", 0),
            )
        )
        results[t] = rows[:max_per_type]

    # Identify the top pick per trade type — highest AROC candidate that
    # passes all checks. Dashboard renders this as a hero card so the user
    # sees "the next Mars trade" without scanning the table.
    top_picks: Dict[str, Optional[Dict[str, Any]]] = {}
    for t, rows in results.items():
        passing = [r for r in rows if all(r.get("passes", {}).values())]
        top_picks[t] = passing[0] if passing else None

    # Apply the webinar1 decision rule: when multiple trade types qualify,
    # which one to actually place?
    #   - If all qualifying picks are within ~3% of each other → take the
    #     most aggressive (Mars Max), since you're getting more premium
    #     for the same effective distance.
    #   - Otherwise → take the most-conservative trade that still qualifies
    #     (RUT > Mars > Mars Max), preferring the one with the most fib
    #     headroom. This matches Jamal's "if Mars is below the fib but Max
    #     is above, take Mars" guidance.
    recommendation = _recommend_trade(top_picks)

    return {
        "symbol": symbol.upper(),
        "underlyings_scanned": underlyings,
        "underlying_prices": underlying_prices,
        "expirations_scanned": expirations_scanned,
        "errors": errors if errors else None,
        "as_of": datetime.now(timezone.utc).isoformat(),
        "trade_types": results,
        "top_picks": top_picks,
        "recommendation": recommendation,
    }


def _recommend_trade(top_picks: Dict[str, Optional[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
    """Pick which qualifying trade to actually place, per webinar1 rules.

    Jamal's decision tree, paraphrased from the transcript:
      (a) Build all three trades on the chart.
      (b) If they cluster within ~3% of each other → take Mars Max
          (more premium, same effective distance — no safety lost).
      (c) If Mars is below a fib floor but Mars Max is above → take Mars
          (the floor matters more than the extra AROC).
      (d) If only the conservative trade is below the fib → take that one.

    We don't have live fib-floor data in the scanner, so we approximate
    "fib floor crossed" as "the next-aggressive pick is ≥ 1% closer to spot"
    — the typical RUT fib step in the transcript examples.

    Returns ``{trade_type, candidate, reason, runner_up}`` or ``None`` when
    nothing qualifies.
    """
    qualifying = [(t, p) for t, p in top_picks.items() if p is not None]
    if not qualifying:
        return None

    # Ordering by aggressiveness: RUT (safest) → Mars → MarsMax (most aggressive)
    order = {"rut": 0, "mars": 1, "marsmax": 2, "space": 3}
    qualifying.sort(key=lambda x: order.get(x[0], 99))

    strikes = [p["short_strike"] for _, p in qualifying]
    span_pct = (
        (max(strikes) - min(strikes)) / min(strikes) * 100
        if min(strikes) > 0 else 0.0
    )

    # --- Rule (b): clustered picks → take the most aggressive ---
    if span_pct < 3.0 and len(qualifying) >= 2:
        chosen_type, chosen = qualifying[-1]
        runner_up_type, _ = qualifying[-2]
        reason = (
            f"All qualifying picks cluster within {span_pct:.1f}% — taking "
            f"the most aggressive ({chosen_type.upper()}) since the safer "
            f"trades give up premium without meaningful added safety."
        )
        return {
            "trade_type": chosen_type, "candidate": chosen,
            "reason": reason, "runner_up_type": runner_up_type,
            "span_pct": round(span_pct, 2),
        }

    # --- Rule (c)/(d): meaningful separation → take the safest pick that's
    # actually below the proxy fib step (≥ 1% safer than the next-most-
    # aggressive). Walking from safest to most-aggressive, take the first
    # one that's a fib-step *safer* than its more-aggressive neighbour. ---
    for i in range(len(qualifying) - 1):
        type_safe, pick_safe = qualifying[i]
        _, pick_agg = qualifying[i + 1]
        gap = (pick_agg["short_strike"] - pick_safe["short_strike"]) / pick_safe["short_strike"] * 100
        if gap >= 1.0:
            runner_up_type = qualifying[i + 1][0]
            reason = (
                f"{type_safe.upper()} sits {gap:.1f}% below {runner_up_type.upper()} "
                f"— take the safer trade for fib-floor cushion (Jamal: 'if Mars "
                f"is below the fib but Max is above, take Mars')."
            )
            return {
                "trade_type": type_safe, "candidate": pick_safe,
                "reason": reason, "runner_up_type": runner_up_type,
                "span_pct": round(span_pct, 2),
            }

    # --- Fallback: only one qualifying pick → return it. ---
    chosen_type, chosen = qualifying[0]
    reason = f"Only {chosen_type.upper()} qualifies — sole pick."
    return {
        "trade_type": chosen_type, "candidate": chosen,
        "reason": reason, "runner_up_type": None,
        "span_pct": round(span_pct, 2),
    }


# ----------------------------------------------------------------------
# Per-spec candidate search
# ----------------------------------------------------------------------

def _find_candidates_for_spec(
    options: List[Dict[str, Any]],
    spec: TradeSpec,
    side: Literal["put", "call"],
    symbol: str,
    expiry: str,
    dte: int,
    spot: float,
) -> List[SpreadCandidate]:
    """Return candidates whose short Δ is ≤ ``spec.max_delta``.

    Probes strikes with |delta| in [max_delta − 0.04, max_delta] so the
    ranking can pick the farthest-OTM strike that still hits the AROC/Kelly
    bars. The course teaches "as far away as you can while getting the
    targeted AROC" — start at the delta cap and back off until criteria pass.
    """
    with_delta = [o for o in options if o.get("delta") is not None]
    if not with_delta or dte <= 0:
        return []

    sorted_strikes = sorted(with_delta, key=lambda o: o["strike"])

    # Candidate window: |Δ| in [max_delta - 0.04, max_delta]. We score each
    # and let the ranker pick the best.
    probes = [
        o for o in sorted_strikes
        if (spec.max_delta - 0.04) <= abs(o["delta"]) <= spec.max_delta
    ]
    # If the window is empty (sparse chain), fall back to 3 strikes nearest
    # the cap so the user still gets candidates.
    if not probes:
        anchor = min(with_delta, key=lambda o: abs(abs(o["delta"]) - spec.max_delta))
        idx = sorted_strikes.index(anchor)
        probes = sorted_strikes[max(0, idx - 1):idx + 2]

    candidates: List[SpreadCandidate] = []
    for short_opt in probes:
        long_opt = _pick_long_leg(sorted_strikes, short_opt, side)
        if not long_opt:
            continue
        cand = _build_candidate(
            short_opt=short_opt, long_opt=long_opt, spec=spec, side=side,
            symbol=symbol, expiry=expiry, dte=dte, spot=spot,
        )
        if cand:
            candidates.append(cand)
    return candidates


def _pick_long_leg(
    strikes_sorted: List[Dict[str, Any]],
    short_opt: Dict[str, Any],
    side: Literal["put", "call"],
) -> Optional[Dict[str, Any]]:
    """Long leg = the adjacent strike further OTM (one strike below short for puts,
    one above for calls). The course teaches "next strike, don't widen the wings"."""
    idx = strikes_sorted.index(short_opt)
    if side == "put":
        return strikes_sorted[idx - 1] if idx > 0 else None
    return strikes_sorted[idx + 1] if idx + 1 < len(strikes_sorted) else None


def _build_candidate(
    short_opt: Dict[str, Any],
    long_opt: Dict[str, Any],
    spec: TradeSpec,
    side: Literal["put", "call"],
    symbol: str,
    expiry: str,
    dte: int,
    spot: float,
) -> Optional[SpreadCandidate]:
    credit = _mid_credit(short_opt, long_opt)
    if credit is None or credit <= 0.01:
        return None

    wing_width = abs(short_opt["strike"] - long_opt["strike"])
    if wing_width <= 0:
        return None

    max_risk = wing_width - credit
    if max_risk <= 0:
        return None

    distance_pct = abs(spot - short_opt["strike"]) / spot * 100
    # Canonical adjusted %OTM from lib/ruleone.ts: distance × sqrt(DTE/30).
    # Longer-DTE trades with the same nominal cushion read as further OTM
    # (sqrt-time vol equivalence — matches OKW spreadsheet within rounding).
    adj_distance_pct = distance_pct * math.sqrt(dte / 30.0)

    aroc_pct = (credit / max_risk) * (365 / max(dte, 1)) * 100

    short_delta = abs(short_opt["delta"])
    short_iv = short_opt.get("iv")
    win_prob = 1 - short_delta
    kelly_pct = _kelly(win_prob, credit, max_risk) * 100

    passes = {
        "delta_cap": short_delta * 100 <= spec.max_delta * 100,
        "aroc": aroc_pct >= spec.target_aroc_pct,
        "kelly": kelly_pct >= spec.min_kelly_pct,
        "adj_distance": adj_distance_pct >= spec.min_adj_distance_pct,
    }

    # ---------- Position sizing + automation payload ----------
    # Rule One max margin is 1/3 of bankroll on any single trade — encode it
    # alongside Kelly so the caller can size off the tighter of the two.
    recommended_capital_pct = min(kelly_pct, 33.333)
    max_loss_per_contract = round(max_risk * 100, 2)
    credit_per_contract = round(credit * 100, 2)
    expected_avg_loss_per_contract = round(
        max_loss_per_contract * spec.hist_avg_loss_pct / 100, 2
    )
    worst_historical_loss_per_contract = round(
        max_loss_per_contract * spec.hist_max_loss_pct / 100, 2
    )

    # Alert price = an underlying level one "buffer" tick from the short strike
    # so we can warn before exit-rule #2 actually fires. We use half the
    # last-day buffer (e.g. 1.5% for RUT, 1.0% for Mars/MarsMax/Space) — close
    # enough to be meaningful, far enough to give time to react.
    pre_buffer_pct = spec.last_day_buffer_pct / 2.0
    if side == "put":
        alert_price = round(short_opt["strike"] * (1 + pre_buffer_pct / 100), 2)
        last_day_buffer_price = round(
            short_opt["strike"] * (1 + spec.last_day_buffer_pct / 100), 2
        )
    else:  # call side mirrors the math (price below strike triggers concern)
        alert_price = round(short_opt["strike"] * (1 - pre_buffer_pct / 100), 2)
        last_day_buffer_price = round(
            short_opt["strike"] * (1 - spec.last_day_buffer_pct / 100), 2
        )

    return SpreadCandidate(
        trade_type=spec.name,
        side=side,
        symbol=symbol.upper(),
        expiry=expiry,
        dte=dte,
        short_strike=short_opt["strike"],
        long_strike=long_opt["strike"],
        short_delta=round(short_delta, 4),
        short_iv=short_iv,
        credit=round(credit, 2),
        max_risk=round(max_risk, 2),
        wing_width=round(wing_width, 2),
        distance_pct=round(distance_pct, 2),
        adj_distance_pct=round(adj_distance_pct, 2),
        aroc_pct=round(aroc_pct, 1),
        win_prob_pct=round(win_prob * 100, 1),
        kelly_pct=round(kelly_pct, 1),
        underlying_price=spot,
        passes=passes,
        recommended_capital_pct=round(recommended_capital_pct, 2),
        max_loss_per_contract=max_loss_per_contract,
        credit_per_contract=credit_per_contract,
        expected_avg_loss_per_contract=expected_avg_loss_per_contract,
        worst_historical_loss_per_contract=worst_historical_loss_per_contract,
        alert_price=alert_price,
        last_day_buffer_price=last_day_buffer_price,
        delta_exit_pct=round(spec.delta_exit * 100, 1),
        last_day_buffer_pct=spec.last_day_buffer_pct,
    )


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

def _mid_credit(short_opt: Dict[str, Any], long_opt: Dict[str, Any]) -> Optional[float]:
    short_mid = _mid(short_opt)
    long_mid = _mid(long_opt)
    if short_mid is None or long_mid is None:
        return None
    return short_mid - long_mid


def _mid(opt: Dict[str, Any]) -> Optional[float]:
    b, a = opt.get("bid"), opt.get("ask")
    if b is not None and a is not None and a > 0:
        return (b + a) / 2
    return opt.get("last")


def _kelly(win_prob: float, win_amount: float, loss_amount: float) -> float:
    """Kelly fraction. f* = p − (1−p)/b, where b = win/loss."""
    if loss_amount <= 0 or win_amount <= 0:
        return 0.0
    b = win_amount / loss_amount
    f = win_prob - (1 - win_prob) / b
    return max(0.0, f)


def _is_third_friday(d: date) -> bool:
    """Standard monthly OPEX = the third Friday (weekday 4, day 15-21)."""
    return d.weekday() == 4 and 15 <= d.day <= 21


def _pick_monthly_expirations(expirations: List[str]) -> List[str]:
    """Expirations to scan for monthly credit spreads.

    Primary: anything whose DTE lands in MONTHLY_DTE_BUCKETS (the course's
    27/34-day sweet spot, widened ±3). But monthlies sit ~30 days apart, so for
    ~13 days each month — once the front monthly decays to 10-23 DTE while the
    next is still 38-58 DTE — *nothing* lands in that window. Erroring out then
    ("no monthly expirations in 24-37 DTE window") read as a bug on the Rule
    One cycle card even though the card was happily showing the front monthly.

    Fallback: when the strict window is empty, scan the nearest standard
    monthly (third Friday) to the ~30-DTE target, floored so we never pick a
    nearly-expired front month. This re-aligns the scanner with the cycle
    card, which already targets that same monthly.
    """
    today = datetime.now(timezone.utc).date()
    dated: List[tuple[str, int, bool]] = []
    for e in expirations:
        try:
            d = datetime.strptime(e, "%Y%m%d").date()
        except ValueError:
            continue
        dte = (d - today).days
        if dte < 0:
            continue
        dated.append((e, dte, _is_third_friday(d)))

    in_window = sorted(
        e for e, dte, _ in dated
        if any(lo <= dte <= hi for lo, hi in MONTHLY_DTE_BUCKETS)
    )
    if in_window:
        return in_window

    # Nearest 3rd-Friday monthly to the target, floored. Fall back to any
    # non-trivial expiry if the provider doesn't surface clean monthlies.
    monthlies = [(e, dte) for e, dte, is3f in dated if is3f and dte >= MONTHLY_DTE_FLOOR]
    if not monthlies:
        monthlies = [(e, dte) for e, dte, _ in dated if dte >= MONTHLY_DTE_FLOOR]
    if not monthlies:
        return []
    best = min(monthlies, key=lambda t: abs(t[1] - MONTHLY_DTE_TARGET))
    return [best[0]]
