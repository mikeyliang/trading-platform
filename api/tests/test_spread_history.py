"""Pins the spread pricing model and the historical-odds service.

No database or IBKR needed: the model is closed-form and the history is the
committed CSV pair in app/data.
"""
import asyncio
import math
from datetime import date

from app.services import spread_history as hist
from app.services import spread_model as model


# ---------------------------------------------------------------------------
# pricing model
# ---------------------------------------------------------------------------

def test_skew_matches_live_spx_chain_calibration():
    # 2026-11-06 close: SPX 7376.86, VIX 25.64, Dec-18 chain.
    spot, vix = 7376.86, 0.2564
    observed = {0.0: 0.200, 0.051: 0.252, 0.078: 0.279}  # OTM fraction -> chain IV
    for otm, iv in observed.items():
        strike = spot * (1 - otm)
        assert abs(model.skew_iv(vix, spot, strike) - iv) < 0.006, otm


def test_put_delta_is_monotone_and_bounded():
    spot, vol, years = 7376.86, 0.2564, 42 / 365
    deltas = [model.put_delta(spot, k, vol, years) for k in (7300, 7120, 7000, 6800)]
    assert all(0 < d < 1 for d in deltas)
    assert deltas == sorted(deltas, reverse=True)
    # Michael's reconstructed Space strike on Nov 6: about 21 delta with 14 days left.
    assert abs(model.put_delta(spot, 7120, vol, 14 / 365) * 100 - 20.8) < 1.0


def test_pick_short_strike_respects_distance_and_delta_cap():
    spec = model.STRATEGIES["space"]
    spot, vol, years = 7659.44, 0.1999, 35 / 365
    strike = model.pick_short_strike(spec, spot, vol, years)
    assert strike % model.STRIKE_STEP == 0
    assert strike <= spot * (1 - spec.min_distance)
    assert model.put_delta(spot, strike, vol, years) <= spec.max_entry_delta
    # The next strike up would have broken one of the two rules.
    up = strike + model.STRIKE_STEP
    assert up > spot * (1 - spec.min_distance) or model.put_delta(spot, up, vol, years) > spec.max_entry_delta


def test_spread_value_is_positive_and_below_width():
    v = model.spread_value(7376.86, 7120, model.SPREAD_WIDTH, 0.2564, 14 / 365)
    assert 0 < v < model.SPREAD_WIDTH


def test_third_friday_and_last_trade_day():
    assert model.third_friday(2026, 11) == date(2026, 11, 20)
    assert model.next_third_friday(date(2026, 11, 8)) == date(2026, 11, 20)
    assert model.next_third_friday(date(2026, 11, 20)) == date(2026, 12, 18)
    assert model.last_trade_day(date(2026, 11, 20)) == date(2026, 11, 19)


def test_normalize_strategy_accepts_app_spellings():
    assert model.normalize_strategy("Mars Max") == "marsmax"
    assert model.normalize_strategy("mars_max") == "marsmax"
    assert model.normalize_strategy("bull_put") == "rut"
    assert model.normalize_strategy("SPACE") == "space"
    assert model.normalize_strategy("iron condor") is None


# ---------------------------------------------------------------------------
# history dataset
# ---------------------------------------------------------------------------

def test_dataset_covers_every_strategy_since_2005():
    cov = hist.coverage()
    assert cov["first_entry"] == "2005-10-21"
    assert cov["trades"] >= 990
    for sid in model.STRATEGIES:
        rows = hist.closed_trades(sid)
        assert 240 <= len(rows) <= 260, sid
        assert all(r["outcome"] in {"win", "delta_exit", "last_day_exit", "partial_loss", "max_loss"} for r in rows)


def test_replay_reproduces_course_twelve_year_exit_counts():
    # The course's own table: 8 / 9 / 9 exits for RUT / Mars / Mars Max, 2012-2023.
    expected = {"rut": 8, "mars": 9, "marsmax": 9}
    for sid, course in expected.items():
        rows = [t for t in hist.closed_trades(sid) if "2012-01" <= t["entry"] < "2024-01"]
        non_wins = sum(t["outcome"] != "win" for t in rows)
        assert abs(non_wins - course) <= 3, (sid, non_wins)


def test_odds_for_current_space_spot():
    o = hist.odds("space", 20.8, 14)
    assert o["strategy"] == "space"
    assert o["n"] >= hist.MIN_SAMPLE
    assert o["exited"] + o["held_to_loss"] + o["wins"] == o["n"]
    assert 0 <= o["exit_pct"] <= 100
    assert len(o["examples"]) <= 12
    # one row per trade
    assert len({e["entry"] for e in o["examples"]}) == len(o["examples"])


def test_odds_widens_band_when_thin():
    o = hist.odds("rut", 38.0, 20)  # almost nobody sits at 38 delta three weeks out
    assert o["band"]["widened"] or o["n"] >= hist.MIN_SAMPLE


def test_regime_stats_and_finding():
    r = hist.regime_stats("marsmax", 25.6, "down")
    assert r["vix_bucket"] == "25-30"
    assert r["overall"]["n"] >= 240
    assert r["same_vix"]["n"] > 0 and r["same_trend"]["n"] > 0
    assert 0 <= r["downtrend_p"] <= 1
    assert "10-week average" in r["finding"]


def test_fisher_one_sided_sanity():
    assert hist.fisher_one_sided(0, 10, 0, 10) == 1.0
    assert hist.fisher_one_sided(10, 0, 0, 10) < 1e-4
    assert math.isclose(hist.fisher_one_sided(1, 1, 1, 1), 0.8333, abs_tol=1e-3)


def test_summary_shape():
    s = hist.summary()
    assert len(s["strategies"]) == 4
    space = next(x for x in s["strategies"] if x["id"] == "space")
    assert len(space["by_vix"]) == 5
    assert len(space["odds_grid"]) == len(hist.DAYS_BANDS) * len(hist.DELTA_BINS)
    assert space["exit_delta"] == 32


# ---------------------------------------------------------------------------
# router degrades to history-only without market data
# ---------------------------------------------------------------------------

def test_regime_now_without_live_data(monkeypatch):
    from app.routers import regime

    async def no_bars(symbol, days, allow_proxy=False):  # noqa: ARG001
        return []

    async def no_spot(symbol):  # noqa: ARG001
        return None

    monkeypatch.setattr(regime, "_daily_closes", no_bars)
    monkeypatch.setattr(regime, "_spot", no_spot)
    r = asyncio.run(regime.regime_now("SPX"))
    assert r["live"]["live"] is False
    assert r["strategies"][0]["strategy"] == "space"
    assert r["strategies"][0]["same_vix"] is None
    assert r["strategies"][0]["overall"]["n"] >= 240
