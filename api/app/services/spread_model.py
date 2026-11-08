"""Closed-form pricing for Rule One index put spreads.

Everything in here is pure Python with no I/O so the historical rebuild
(``scripts/build_spread_history.py``), the regime endpoints and the tests
all price a spread the same way.

Model
-----
Black-Scholes on a cash index with a put-skew overlay. The implied vol of a
put struck ``K`` under spot ``S`` is

    iv(S, K) = index_vol * (0.78 + 4.0 * max(0, ln(S / K)))

where ``index_vol`` is VIX for SPX and VIX * 1.33 for RUT (the long-run
RVX / VIX ratio; RVX itself is only on IBKR for the last five years).

Calibration (2026-11-06, SPX 7376.86, VIX 25.64, Dec-18 expiry, 42 DTE):
the live chain showed IV 20.0 at the money, 25.2 at 5.1% OTM and 27.9 at
7.8% OTM. The overlay reproduces those within about one vol point and the
resulting spread marks within about 5% of the quoted mids. Short-leg deltas
are what the exit rules key off, and those land within 1-2 delta points.

What it does not model: bid/ask, dividends, early assignment (not a concern
for European index options) and day-to-day skew changes. Treat prices and
returns as directional; treat deltas, strike picks and exit/no-exit as the
reliable part.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from statistics import NormalDist
from typing import Dict, Optional

_N = NormalDist().cdf

RISK_FREE = 0.03
RUT_VOL_RATIO = 1.33  # index_vol for RUT = VIX * ratio when RVX is unavailable
SPREAD_WIDTH = 10.0   # the course trades $10-wide spreads on RUT and SPX
STRIKE_STEP = 5.0


@dataclass(frozen=True)
class StrategySpec:
    id: str
    label: str
    underlying: str          # RUT | SPX
    max_entry_delta: float   # short-leg delta cap at entry (fraction)
    min_distance: float      # short strike at least this far below spot
    exit_delta: float        # close when short-leg delta reaches this
    last_day_buffer: float   # Thursday-before-expiry: close if spot within this of the strike


STRATEGIES: Dict[str, StrategySpec] = {
    "rut":     StrategySpec("rut",     "RUT",      "RUT", 0.10, 0.11, 0.30, 0.03),
    "mars":    StrategySpec("mars",    "Mars",     "RUT", 0.12, 0.09, 0.36, 0.02),
    "marsmax": StrategySpec("marsmax", "Mars Max", "RUT", 0.14, 0.09, 0.42, 0.02),
    "space":   StrategySpec("space",   "Space",    "SPX", 0.12, 0.05, 0.32, 0.02),
}

STRATEGIES_FOR_UNDERLYING: Dict[str, list[str]] = {
    "RUT": ["rut", "mars", "marsmax"],
    "SPX": ["space"],
}


def normalize_strategy(value: Optional[str]) -> Optional[str]:
    """Map the various spellings used around the app onto a strategy id."""
    if not value:
        return None
    key = value.lower().replace(" ", "").replace("_", "").replace("-", "")
    if key in ("marsmax", "max"):
        return "marsmax"
    if key in ("mars",):
        return "mars"
    if key in ("space", "spx"):
        return "space"
    if key in ("rut", "bullput", "trad", "traditional", "ruttraditional"):
        return "rut"
    for sid in STRATEGIES:
        if sid in key:
            return sid
    return None


def index_vol_for(underlying: str, vix: float, rvx: Optional[float] = None) -> float:
    """Vol input for the model: RVX for RUT when we have it, otherwise VIX scaled."""
    if underlying.upper() == "RUT":
        return rvx if rvx else vix * RUT_VOL_RATIO
    return vix


def skew_iv(index_vol: float, spot: float, strike: float) -> float:
    """Put-skew implied vol (fraction) for a strike under the current spot."""
    moneyness = max(0.0, math.log(spot / strike))
    return index_vol * (0.78 + 4.0 * moneyness)


def put_price(spot: float, strike: float, vol: float, years: float) -> float:
    if years <= 1e-6:
        return max(strike - spot, 0.0)
    sq = vol * math.sqrt(years)
    d1 = (math.log(spot / strike) + (RISK_FREE + vol * vol / 2) * years) / sq
    d2 = d1 - sq
    return strike * math.exp(-RISK_FREE * years) * _N(-d2) - spot * _N(-d1)


def put_delta(spot: float, strike: float, index_vol: float, years: float) -> float:
    """Absolute short-put delta (fraction, 0..1) using the skewed vol."""
    if years <= 1e-6:
        return 1.0 if spot < strike else 0.0
    vol = skew_iv(index_vol, spot, strike)
    sq = vol * math.sqrt(years)
    d1 = (math.log(spot / strike) + (RISK_FREE + vol * vol / 2) * years) / sq
    return 1.0 - _N(d1)


def spread_value(spot: float, short_strike: float, width: float, index_vol: float, years: float) -> float:
    """Mark of a bull put spread (short ``short_strike``, long ``short_strike - width``)."""
    short = put_price(spot, short_strike, skew_iv(index_vol, spot, short_strike), years)
    long_ = put_price(spot, short_strike - width, skew_iv(index_vol, spot, short_strike - width), years)
    return short - long_


def pick_short_strike(spec: StrategySpec, spot: float, index_vol: float, years: float) -> float:
    """First strike at or below the distance floor whose delta clears the cap.

    This is the rule-book pick (distance first, then delta). The course's
    AROC and Kelly checks are deliberately not applied: they turn on the
    credit to within a few cents, which a closed-form model cannot promise,
    and applying them would silently drop trades the trader actually took.
    """
    strike = math.floor(spot * (1 - spec.min_distance) / STRIKE_STEP) * STRIKE_STEP
    while put_delta(spot, strike, index_vol, years) > spec.max_entry_delta:
        strike -= STRIKE_STEP
    return strike


def third_friday(year: int, month: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(4 - first.weekday()) % 7 + 14)


def next_third_friday(after: date) -> date:
    y, m = after.year, after.month
    while True:
        tf = third_friday(y, m)
        if tf > after:
            return tf
        m += 1
        if m == 13:
            y, m = y + 1, 1


def last_trade_day(expiry: date) -> date:
    """Thursday before a Friday expiry: the day exit rule #2 is checked."""
    return expiry - timedelta(days=1)
