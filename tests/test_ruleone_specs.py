"""Tests for the Rule One spread scanner math and the exit monitor rules.

These cover the spec-driven logic that doesn't need IBKR: candidate
metrics (AROC / Kelly / adjusted %OTM / sizing), the webinar1 trade
recommendation decision tree (including the RUT-vs-SPX grouping
regression), and the side-aware exit-rule-#2 levels.
"""
from __future__ import annotations

import math
import sys
from datetime import date
from pathlib import Path

_API_DIR = Path(__file__).resolve().parents[1] / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.services.monitor import (  # noqa: E402
    _is_last_trade_day,
    _rule2_breached,
    _rule2_levels,
)
from app.services.spread_finder import (  # noqa: E402
    TRADE_SPECS,
    _build_candidate,
    _kelly,
    _recommend_trade,
)


# ---------------------------------------------------------------------------
# Candidate math
# ---------------------------------------------------------------------------

def _opt(strike: float, delta: float, bid: float, ask: float, iv: float = 0.18):
    return {"strike": strike, "delta": delta, "bid": bid, "ask": ask, "iv": iv}


def test_build_candidate_mars_metrics():
    """A realistic Mars setup: RUT 2200, short 2000P Δ-0.11, $10 wing."""
    spec = TRADE_SPECS["mars"]
    cand = _build_candidate(
        short_opt=_opt(2000, -0.11, 3.30, 3.70),   # mid 3.50
        long_opt=_opt(1990, -0.10, 2.40, 2.60),    # mid 2.50 → credit 1.00
        spec=spec, side="put", symbol="RUT", expiry="20260717",
        dte=30, spot=2200.0,
    )
    assert cand is not None
    assert cand.credit == 1.00
    assert cand.max_risk == 9.00
    assert cand.wing_width == 10.0
    # distance: (2200-2000)/2200 = 9.0909% ; DTE=30 → adj = raw
    assert abs(cand.distance_pct - 9.09) < 0.01
    assert abs(cand.adj_distance_pct - cand.distance_pct) < 0.01
    # AROC = (1/9) × (365/30) × 100 ≈ 135.2%
    assert abs(cand.aroc_pct - 135.2) < 0.5
    # Kelly: p=0.89, b=1/9 → f = 0.89 − 0.11×9 = −0.1 → clamped 0
    assert cand.kelly_pct == 0.0
    assert cand.passes["delta_cap"] is True       # 11 ≤ 12
    assert cand.passes["aroc"] is True            # 135 ≥ 64
    assert cand.passes["kelly"] is False          # 0 < 32
    assert cand.passes["adj_distance"] is True    # 9.09 ≥ 9
    # Sizing payload
    assert cand.max_loss_per_contract == 900.0
    assert cand.credit_per_contract == 100.0
    assert cand.expected_avg_loss_per_contract == 225.0   # 25% of 900
    assert cand.worst_historical_loss_per_contract == 405.0  # 45% of 900
    # Put-side alert levels sit ABOVE the short strike
    assert cand.alert_price == 2020.0              # +1% (half of 2% buffer)
    assert cand.last_day_buffer_price == 2040.0    # +2%
    # Informational analytics
    assert cand.breakeven == 1999.0                # 2000 − 1.00
    expected_em = 0.18 * math.sqrt(30 / 365) * 100
    assert abs(cand.expected_move_pct - expected_em) < 0.01
    assert abs(cand.cushion_sigma - cand.distance_pct / expected_em) < 0.01


def test_build_candidate_call_side_mirrors_levels():
    spec = TRADE_SPECS["mars"]
    cand = _build_candidate(
        short_opt=_opt(2400, 0.11, 3.30, 3.70),
        long_opt=_opt(2410, 0.10, 2.40, 2.60),
        spec=spec, side="call", symbol="RUT", expiry="20260717",
        dte=30, spot=2200.0,
    )
    assert cand is not None
    # Call-side alert levels sit BELOW the short strike
    assert cand.alert_price == 2376.0              # −1%
    assert cand.last_day_buffer_price == 2352.0    # −2%
    assert cand.breakeven == 2401.0                # 2400 + credit


def test_kelly_formula():
    # p=0.9, b=0.25 → f = 0.9 − 0.1/0.25 = 0.5
    assert abs(_kelly(0.9, 1.0, 4.0) - 0.5) < 1e-9
    assert _kelly(0.5, 1.0, 9.0) == 0.0   # negative edge clamps to 0
    assert _kelly(0.9, 0.0, 4.0) == 0.0   # degenerate inputs


# ---------------------------------------------------------------------------
# Recommendation decision tree
# ---------------------------------------------------------------------------

def _pick(strike: float) -> dict:
    return {"short_strike": strike}


def test_recommend_clustered_rut_family_takes_most_aggressive():
    rec = _recommend_trade({
        "rut": _pick(2000), "mars": _pick(2020), "marsmax": _pick(2040),
        "space": None,
    })
    assert rec is not None
    assert rec["trade_type"] == "marsmax"        # span 2% < 3% → rule (b)
    assert rec["runner_up_type"] == "mars"


def test_recommend_fib_gap_takes_safer_trade():
    # RUT pick sits 2.5% below Mars → meaningful separation, take safer.
    rec = _recommend_trade({
        "rut": _pick(2000), "mars": _pick(2050), "marsmax": _pick(2110),
        "space": None,
    })
    assert rec is not None
    assert rec["trade_type"] == "rut"
    assert rec["runner_up_type"] == "mars"


def test_recommend_does_not_mix_underlyings():
    """Regression: SPX strikes (~6000) must not enter the RUT span math.

    Before the fix, Mars (2020) + Space (6000) produced a 197% span, so the
    cluster rule never fired and the gap rule compared RUT to SPX strikes.
    """
    rec = _recommend_trade({
        "rut": None, "mars": _pick(2020), "marsmax": _pick(2040),
        "space": _pick(6000),
    })
    assert rec is not None
    # Mars family clusters within 1% → most aggressive of the FAMILY.
    assert rec["trade_type"] == "marsmax"
    assert rec["span_pct"] < 3.0
    assert rec["also_qualifying"] == ["space"]


def test_recommend_space_only():
    rec = _recommend_trade({
        "rut": None, "mars": None, "marsmax": None, "space": _pick(6000),
    })
    assert rec is not None
    assert rec["trade_type"] == "space"
    assert rec["also_qualifying"] == []


def test_recommend_nothing_qualifies():
    assert _recommend_trade({"rut": None, "mars": None}) is None


# ---------------------------------------------------------------------------
# Exit monitor — rule #2
# ---------------------------------------------------------------------------

def test_last_trade_day_thursday_before_friday_expiry():
    # 2026-07-17 is a Friday; Thursday 16th is the last trade day.
    assert _is_last_trade_day("20260717", today=date(2026, 7, 16)) is True
    assert _is_last_trade_day("20260717", today=date(2026, 7, 15)) is False
    # Expiry day itself still counts (AM settlement risk).
    assert _is_last_trade_day("20260717", today=date(2026, 7, 17)) is True
    # After expiry → no.
    assert _is_last_trade_day("20260717", today=date(2026, 7, 18)) is False
    assert _is_last_trade_day("garbage") is False


def test_rule2_levels_put_side():
    trigger, soft = _rule2_levels(2000.0, "P", 2.0)
    assert trigger == 2040.0
    assert soft == 2060.0
    assert _rule2_breached(2039.0, trigger, "P") is True   # fell to the level
    assert _rule2_breached(2041.0, trigger, "P") is False


def test_rule2_levels_call_side_mirrored():
    """Regression: bear-call shorts breach UPWARD — the old code put the
    buffer above the strike and checked `underlying <= level`, which could
    never fire for a call."""
    trigger, soft = _rule2_levels(2400.0, "C", 2.0)
    assert trigger == 2352.0
    assert soft == 2328.0
    assert _rule2_breached(2353.0, trigger, "C") is True   # rallied to level
    assert _rule2_breached(2351.0, trigger, "C") is False
