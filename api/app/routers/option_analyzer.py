"""Single-option position analyzer.

Combines a contract's live snapshot (price, IV, OI/vol) with Black-Scholes
Greeks, an EMA of recently-modelled option prices (using historical underlying
bars + current IV), a P/L profile, and a deterministic advice score.

The synthetic EMA of option prices works around the fact that historical
options data isn't available on our free vendors — instead we replay the
underlying's close series through Black-Scholes at the current IV. It's a
rough proxy (IV obviously changed historically) but useful for "is the
option's value trending up or down on this underlying" intuition.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException, Query

from ..forecast import chronos, ensemble as forecast_ensemble
from ..forecast import calibration as forecast_calibration
from ..nautilus import ib_options
from ..nautilus.strategies.smi import (
    compute_ema_series,
    compute_macd_series,
    compute_rsi_series,
    compute_smi_series,
    compute_vwap_series,
)
from ..services.black_scholes import bs_price, greeks as bs_greeks, implied_vol
from ..util.cache import TTLCache
from .market import get_bars


# Default bar count per chart timeframe. Tuned so the chart fits ~the
# same horizontal span regardless of TF (≈3 trading days on 5m, ≈3 years on 1w).
_TF_DAYS: Dict[str, int] = {
    "5m": 5,
    "15m": 10,
    "1h": 30,
    "4h": 90,
    "1d": 180,
    "1w": 1095,  # ≈ 3 years of weekly bars — right horizon for LEAPs.
}
_SUPPORTED_TFS = list(_TF_DAYS.keys())

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/options", tags=["options"])

_cache = TTLCache(ttl_seconds=45)


def _years_to_expiry(expiry_yyyymmdd: str) -> float:
    try:
        y, m, d = int(expiry_yyyymmdd[:4]), int(expiry_yyyymmdd[4:6]), int(expiry_yyyymmdd[6:8])
        exp = datetime(y, m, d, 16, 0, tzinfo=timezone.utc)
    except (ValueError, IndexError):
        return 0.0
    now = datetime.now(timezone.utc)
    seconds = (exp - now).total_seconds()
    return max(seconds / (365.25 * 24 * 3600), 0.0)


def _days_to_expiry(expiry_yyyymmdd: str) -> int:
    try:
        y, m, d = int(expiry_yyyymmdd[:4]), int(expiry_yyyymmdd[4:6]), int(expiry_yyyymmdd[6:8])
        exp = datetime(y, m, d, tzinfo=timezone.utc).date()
    except (ValueError, IndexError):
        return 0
    return max((exp - datetime.now(timezone.utc).date()).days, 0)


def _build_pnl_profile(
    spot: float,
    strike: float,
    right: str,
    iv: float,
    dte_years: float,
    entry_price: float,
    quantity: int,
    is_long: bool,
) -> Dict[str, Any]:
    """Sample option PnL across an underlying-price range and return three curves:
    today (full DTE remaining), halfway (half DTE remaining), and expiry (intrinsic).

    Price range adapts to the position: always wide enough to include spot,
    strike, and roughly ±3σ of the IV-implied terminal distribution — so deep
    ITM/OTM positions still show breakeven and the expiry kink in-frame.
    """
    n = 121
    side = right.lower()
    sign = 1 if is_long else -1
    qty_abs = abs(quantity) or 1

    # Pick a price window that captures spot, strike, breakeven, and ~±3σ at expiry.
    sigma_T = spot * iv * math.sqrt(dte_years) if dte_years > 0 and iv > 0 else spot * 0.30
    pivots = [spot, strike, spot - 3 * sigma_T, spot + 3 * sigma_T]
    if side == "call":
        pivots.append(strike + entry_price)
    else:
        pivots.append(strike - entry_price)
    lo = max(0.01, min(pivots) * 0.92)
    hi = max(pivots) * 1.08
    step = (hi - lo) / (n - 1)
    multiplier = 100  # equity-option contract size

    halfway_years = dte_years / 2.0
    prices: List[float] = []
    expiry_pnl: List[float] = []
    today_pnl: List[float] = []
    halfway_pnl: List[float] = []

    for i in range(n):
        s = lo + i * step
        prices.append(round(s, 2))

        # at expiry — intrinsic
        intrinsic = max(s - strike, 0) if side == "call" else max(strike - s, 0)
        e_pnl = sign * (intrinsic - entry_price) * multiplier * qty_abs
        expiry_pnl.append(round(e_pnl, 2))

        # today — BS at remaining DTE
        try:
            theo_now = bs_price(s, strike, dte_years, iv, side) if dte_years > 0 and iv > 0 else intrinsic
        except Exception:
            theo_now = intrinsic
        today_pnl.append(round(sign * (theo_now - entry_price) * multiplier * qty_abs, 2))

        # halfway — BS at DTE/2
        try:
            theo_half = bs_price(s, strike, halfway_years, iv, side) if halfway_years > 0 and iv > 0 else intrinsic
        except Exception:
            theo_half = intrinsic
        halfway_pnl.append(round(sign * (theo_half - entry_price) * multiplier * qty_abs, 2))

    return {
        "prices": prices,
        "expiry": expiry_pnl,
        "today": today_pnl,
        "halfway": halfway_pnl,
    }


def _sigma_ranges(spot: float, iv: float, dte_years: float) -> Dict[str, Optional[float]]:
    """1σ and 2σ terminal-price ranges using the lognormal model.

    These bound where the underlying is *expected* to land under the
    risk-neutral measure with the current IV. The chart uses them for the
    probability cone shading; the analyst uses them as a "expected move" reference.
    """
    if iv <= 0 or dte_years <= 0:
        return {"sigma1_low": None, "sigma1_high": None,
                "sigma2_low": None, "sigma2_high": None,
                "expected_move_abs": None, "expected_move_pct": None}
    sd = iv * math.sqrt(dte_years)
    # Lognormal 1σ band: spot * exp(±sd) — symmetric in log space.
    s1_lo = spot * math.exp(-sd)
    s1_hi = spot * math.exp(+sd)
    s2_lo = spot * math.exp(-2 * sd)
    s2_hi = spot * math.exp(+2 * sd)
    move_abs = spot * sd  # arithmetic 1σ — close to (s1_hi - spot) for small sd
    return {
        "sigma1_low": round(s1_lo, 2),
        "sigma1_high": round(s1_hi, 2),
        "sigma2_low": round(s2_lo, 2),
        "sigma2_high": round(s2_hi, 2),
        "expected_move_abs": round(move_abs, 2),
        "expected_move_pct": round(sd * 100, 2),
    }


def _decay_profile(
    spot: float,
    strike: float,
    iv: float,
    dte_years: float,
    side: str,
    entry_price: float,
    quantity: int,
    is_long: bool,
    n_points: int = 40,
) -> List[Dict[str, Any]]:
    """PnL as a function of remaining DTE, assuming spot stays where it is.

    The visceral "what theta does to me" view. Returns a series sampled
    from today out to expiry; each point includes PnL if spot stays put,
    and PnL if spot ends up at ±1σ of the move-by-then (so you can see how
    much a moderate underlying move offsets decay).
    """
    out: List[Dict[str, Any]] = []
    if dte_years <= 0:
        return out
    sign = 1 if is_long else -1
    qty_abs = abs(quantity) or 1
    multiplier = 100
    total_days = max(int(dte_years * 365), 1)

    for i in range(n_points + 1):
        # Walk from "now" (full DTE) down to "expiry" (DTE=0).
        frac = i / n_points
        dte_at = dte_years * (1 - frac)
        days_remaining = int(round(dte_at * 365))

        elapsed_years = dte_years - dte_at
        sd_elapsed = iv * math.sqrt(max(elapsed_years, 0)) if iv > 0 else 0
        s_up = spot * math.exp(sd_elapsed) if sd_elapsed > 0 else spot
        s_dn = spot * math.exp(-sd_elapsed) if sd_elapsed > 0 else spot

        def _pnl(s: float, t: float) -> float:
            if t <= 0:
                intrinsic = max(s - strike, 0) if side == "call" else max(strike - s, 0)
                theo = intrinsic
            else:
                try:
                    theo = bs_price(s, strike, t, iv, side)
                except Exception:
                    theo = 0.0
            return sign * (theo - entry_price) * multiplier * qty_abs

        out.append({
            "days_remaining": days_remaining,
            "pnl_flat": round(_pnl(spot, dte_at), 2),
            "pnl_up_1s": round(_pnl(s_up, dte_at), 2),
            "pnl_dn_1s": round(_pnl(s_dn, dte_at), 2),
        })
    return out


def _probability_metrics(
    spot: float,
    strike: float,
    dte_years: float,
    iv: float,
    side: str,
    is_long: bool,
    entry_price: float,
    rate: float = 0.045,
) -> Dict[str, Optional[float]]:
    """POP (probability of profit at expiry), P(ITM at expiry), and a
    rough P(touch) under the lognormal/Brownian-bridge approximation.

    Numbers are risk-neutral, not "true world" probabilities — useful as
    a benchmark/comparable, not a forecast.
    """
    if iv <= 0 or dte_years <= 0:
        return {"pop": None, "prob_itm": None, "prob_touch": None}

    sd = iv * math.sqrt(dte_years)
    mu = math.log(spot) + (rate - 0.5 * iv * iv) * dte_years

    def _p_gt(barrier: float) -> float:
        """P(S_T > barrier) under risk-neutral lognormal."""
        if barrier <= 0:
            return 1.0
        z = (math.log(barrier) - mu) / sd
        return 1 - _norm_cdf(z)

    if side == "call":
        breakeven = strike + entry_price
        prob_itm = _p_gt(strike)
        p_above_be = _p_gt(breakeven)
        pop = p_above_be if is_long else 1 - p_above_be
        # Probability of touching breakeven during life — Brownian reflection
        # gives ~2 × P(end past breakeven) when breakeven is OTM; clamp to 1.
        prob_touch = min(1.0, 2 * p_above_be) if breakeven > spot else 1.0
    else:
        breakeven = strike - entry_price
        prob_itm = 1 - _p_gt(strike)
        p_below_be = 1 - _p_gt(breakeven)
        pop = p_below_be if is_long else 1 - p_below_be
        prob_touch = min(1.0, 2 * p_below_be) if breakeven < spot else 1.0

    return {
        "pop": round(pop, 4),
        "prob_itm": round(prob_itm, 4),
        "prob_touch": round(prob_touch, 4),
    }


def _norm_cdf(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def _iv_rank_metrics(
    iv_series: List[Dict[str, Any]],
    hv_series: List[Dict[str, Any]],
    lookback: int = 252,
    chart_points: int = 252,
) -> Dict[str, Any]:
    """IV rank / percentile from the underlying's real IV-index history (IBKR
    OPTION_IMPLIED_VOLATILITY daily series).

    IV rank = where today's IV sits between the 52-week low and high (0-100).
    IV percentile = % of days in the window with IV below today's. Rank is
    the headline number ("is vol high or low for THIS name"); percentile is
    robust to one-day spikes stretching the range. Both use the IV *index*
    (~30d ATM), the standard convention — not the contract's own IV, which
    mixes in skew/term-structure.
    """
    empty = {
        "iv_rank": None, "iv_percentile": None,
        "iv_52w_high": None, "iv_52w_low": None,
        "underlying_iv_now": None,
        "iv_history": [], "hv_history": [],
    }
    values = [p["value"] for p in iv_series][-lookback:]
    if len(values) < 60:
        return empty
    iv_now = values[-1]
    hi, lo = max(values), min(values)
    rank = ((iv_now - lo) / (hi - lo) * 100) if hi > lo else 50.0
    below = sum(1 for v in values[:-1] if v < iv_now)
    pctile = below / max(len(values) - 1, 1) * 100
    return {
        "iv_rank": round(rank, 1),
        "iv_percentile": round(pctile, 1),
        "iv_52w_high": round(hi, 4),
        "iv_52w_low": round(lo, 4),
        "underlying_iv_now": round(iv_now, 4),
        "iv_history": iv_series[-chart_points:],
        "hv_history": hv_series[-chart_points:],
    }


def _realized_vol(closes: List[float], lookback_days: int = 30) -> Optional[float]:
    """Annualized realized vol from log returns over the trailing window.

    Used to give the current IV context — IV materially above realized vol
    suggests options are pricing in more move than the underlying has
    recently produced (vol risk premium).
    """
    if len(closes) < lookback_days + 1:
        return None
    rets = []
    for i in range(len(closes) - lookback_days, len(closes)):
        if i == 0 or closes[i - 1] <= 0:
            continue
        r = math.log(closes[i] / closes[i - 1])
        rets.append(r)
    if len(rets) < 5:
        return None
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / max(len(rets) - 1, 1)
    daily_vol = math.sqrt(var)
    return round(daily_vol * math.sqrt(252), 4)


def _liquidity(bid: Optional[float], ask: Optional[float],
               last: Optional[float], volume: Optional[float],
               oi: Optional[float]) -> Dict[str, Any]:
    """Spread + grade for the contract.

    Grade scale (% spread over mid):
      tight   ≤ 3%
      normal  3-7%
      wide    7-15%
      poor    > 15% (or no two-sided market)
    """
    spread = None
    spread_pct = None
    mid = None
    if bid is not None and ask is not None and bid > 0 and ask > 0:
        spread = round(ask - bid, 4)
        mid = (bid + ask) / 2
        if mid > 0:
            spread_pct = round((ask - bid) / mid * 100, 2)
    if spread_pct is None:
        grade = "poor"
    elif spread_pct <= 3:
        grade = "tight"
    elif spread_pct <= 7:
        grade = "normal"
    elif spread_pct <= 15:
        grade = "wide"
    else:
        grade = "poor"
    return {
        "bid": bid, "ask": ask, "last": last,
        "spread": spread,
        "spread_pct": spread_pct,
        "grade": grade,
        "volume": volume,
        "open_interest": oi,
    }


def _synthetic_option_history(
    closes: List[float],
    strike: float,
    right: str,
    iv: float,
    target_dte_years: float,
    bar_count: int = 60,
) -> List[float]:
    """Replay underlying closes through BS to get a synthetic option-price
    series. The DTE is held constant (we're modelling 'what would this option
    have been worth at the current expiry distance' — not a true historical
    price). Returns the most-recent bar_count values."""
    series: List[float] = []
    if iv <= 0 or target_dte_years <= 0:
        return series
    side = right.lower()
    use = closes[-bar_count:] if len(closes) > bar_count else closes
    for c in use:
        try:
            series.append(round(bs_price(c, strike, target_dte_years, iv, side), 4))
        except Exception:
            series.append(0.0)
    return series


def _advice(
    delta: float,
    theta: float,
    vega: float,
    dte: int,
    is_long: bool,
    distance_pct: float,
    iv: float,
    rsi: float,
    trend_score: int,
    forecast: Optional[Dict[str, Any]] = None,
    # Chart-TF momentum block — these are the *current* values from the
    # series the user is looking at, so the verdict reflects what they see.
    macd_hist: Optional[float] = None,
    macd_hist_prev: Optional[float] = None,
    smi: Optional[float] = None,
    smi_signal: Optional[float] = None,
    spot: Optional[float] = None,
    vwap: Optional[float] = None,
    chart_tf: Optional[str] = None,
    # P/L state — entry price vs current mid lets the scorer reward
    # winners ("let it run") and only flag close when premium has
    # actually decayed, not when the contract is just OTM.
    entry_price: Optional[float] = None,
    mid: Optional[float] = None,
    # IV rank (0-100) from the underlying's real 52-week IV-index history
    # (IBKR). Where the contract's IV sits in the name's own vol regime —
    # far more informative than the absolute IV level.
    iv_rank: Optional[float] = None,
) -> Dict[str, Any]:
    """Compose a -100..+100 score and a human label for this option position.

    Positive = lean toward holding/adding. Negative = lean toward closing.
    Logic favors closing options with bad theta/dte alignment and weak trend.
    """
    score = 0
    notes: List[str] = []

    # ── P/L state vs entry ─────────────────────────────────────────────
    # Most informative single signal: is the position making or losing money?
    # Winners deserve room to run; real decay (mid < 50% of entry) flags risk.
    if entry_price and entry_price > 0 and mid is not None and mid > 0:
        pnl_pct = (mid - entry_price) / entry_price * 100
        if is_long:
            if pnl_pct >= 50:
                score += 15
                notes.append(f"Up {pnl_pct:+.0f}% on entry — let winners run (consider trim)")
            elif pnl_pct >= 15:
                score += 8
                notes.append(f"Up {pnl_pct:+.0f}% on entry — thesis working")
            elif pnl_pct >= -15:
                score += 2
                notes.append(f"Near break-even ({pnl_pct:+.0f}%) — give thesis room")
            elif pnl_pct >= -40:
                score -= 4
                notes.append(f"Down {pnl_pct:.0f}% on entry — thesis softening")
            else:
                score -= 14
                notes.append(f"Down {pnl_pct:.0f}% on entry — premium decayed materially")
        else:
            # Short positions: profit shows as mid BELOW entry (smaller debit
            # to buy back). Flip the sign.
            short_pnl_pct = -pnl_pct
            if short_pnl_pct >= 50:
                score += 12
                notes.append(f"Short position +{short_pnl_pct:.0f}% — close near max profit")
            elif short_pnl_pct >= 15:
                score += 6
                notes.append(f"Short position +{short_pnl_pct:.0f}% — collecting premium")
            elif short_pnl_pct <= -30:
                score -= 14
                notes.append(f"Short position {short_pnl_pct:.0f}% — losing more than collected")

    abs_d = abs(delta) if delta is not None else 0
    if is_long:
        # Long options: the score should reflect WHERE THE THESIS IS,
        # not auto-punish OTM-ness. Cheap OTM is the whole point of
        # buying options for leverage; "far OTM" only becomes a real
        # problem combined with little time left.
        if abs_d >= 0.65:
            score += 12
            notes.append("Deep ITM — behaves like stock, low time-decay drag")
        elif abs_d >= 0.30:
            # ATM-ish: balanced. No bias either way; trend score will move it.
            pass
        elif abs_d >= 0.15 and dte <= 21:
            # OTM only matters when time's running out.
            score -= 8
            notes.append(f"Δ {abs_d:.2f} + {dte}d left — needs a move soon")
        elif abs_d < 0.15 and dte <= 21:
            # Very-OTM + short DTE → real "lottery ticket" red flag.
            score -= 18
            notes.append(f"Far OTM (Δ {abs_d:.2f}) with only {dte}d left")
        elif abs_d < 0.15 and dte <= 60:
            score -= 4
            notes.append(f"Far OTM (Δ {abs_d:.2f}) — needs a sustained move")
        # else: very-OTM LEAPs etc → neutral; let trend + thesis drive the score.

        if dte <= 7:
            score -= 18
            notes.append(f"Only {dte}d left — gamma risk, theta accelerating")
        elif dte <= 21:
            score -= 3
            notes.append(f"{dte}d to expiry — manage actively")
        elif dte >= 45:
            score += 5
            notes.append(f"{dte}d to expiry — time on your side")

        if iv and iv > 0.7:
            score -= 6
            notes.append(f"IV {iv*100:.0f}% — expensive premium, vega risk")
        # IV rank — regime-relative vol. Holding long premium bought near the
        # 52w vol highs is exposed to IV mean-reversion (vega crush) even if
        # the direction call is right; bottom-decile vol is a tailwind.
        if iv_rank is not None:
            if iv_rank >= 70:
                score -= 7
                notes.append(f"IV rank {iv_rank:.0f} — vol near 52w highs, crush risk on longs")
            elif iv_rank <= 20:
                score += 4
                notes.append(f"IV rank {iv_rank:.0f} — vol near 52w lows, cheap premium")
    else:
        # short options — theta is your friend, but assignment risk near strike
        if abs_d >= 0.40:
            score -= 25
            notes.append(f"Short delta {abs_d:.2f} — too close to ITM, assignment risk")
        elif abs_d >= 0.25:
            score -= 8
            notes.append(f"Short delta {abs_d:.2f} — manage if it expands further")
        else:
            score += 10
            notes.append(f"Short delta {abs_d:.2f} — comfortably OTM")
        if dte <= 7:
            score += 5
            notes.append("Theta acceleration in your favor — but watch gamma")
        if iv and iv > 0.5:
            score += 5
            notes.append(f"IV {iv*100:.0f}% — rich premium collected")
        # IV rank — short premium wants to be sold high in the name's own
        # vol regime; collecting bottom-quartile vol is poor pay for the risk.
        if iv_rank is not None:
            if iv_rank >= 60:
                score += 6
                notes.append(f"IV rank {iv_rank:.0f} — selling rich vol, mean-reversion tailwind")
            elif iv_rank <= 25:
                score -= 6
                notes.append(f"IV rank {iv_rank:.0f} — thin premium for the risk taken")

    # underlying alignment — favors holding if trend matches option side
    long_call = is_long and delta is not None and delta > 0
    long_put = is_long and delta is not None and delta < 0
    short_put_like = (not is_long) and delta is not None and delta < 0  # short put benefits from up
    short_call_like = (not is_long) and delta is not None and delta > 0  # short call benefits from down

    if long_call or short_put_like:
        score += trend_score  # +ve trend helps
    elif long_put or short_call_like:
        score -= trend_score

    if rsi >= 70 and (long_call or short_put_like):
        score -= 5
        notes.append(f"RSI {rsi:.0f} — underlying overbought, pullback risk")
    if rsi <= 30 and (long_put or short_call_like):
        score -= 5
        notes.append(f"RSI {rsi:.0f} — underlying oversold, bounce risk")

    # Distance penalty only when DTE is short enough that the implied
    # move-per-day to reach the strike is unrealistic. A 365d 8%-OTM
    # call on a 25% IV name is fine; a 14d 8%-OTM call needs a daily
    # vol of ~2% to be on track.
    if is_long and abs(distance_pct) > 8 and abs_d < 0.30 and dte <= 45:
        required_daily_pct = abs(distance_pct) / max(dte, 1)
        if required_daily_pct > 0.5:
            penalty = -8 if required_daily_pct > 1.0 else -4
            score += penalty
            notes.append(
                f"Strike {distance_pct:+.1f}% from spot needs ~{required_daily_pct:.1f}%/day "
                f"to reach in {dte}d"
            )

    # MACD histogram — direct, not just via trend_score. Sign + recent flip.
    # Skews bullish positions when hist > 0 and especially when it just flipped.
    if macd_hist is not None:
        bullish_pos = (long_call or short_put_like)
        bearish_pos = (long_put or short_call_like)
        flipped_up = macd_hist_prev is not None and macd_hist > 0 >= macd_hist_prev
        flipped_dn = macd_hist_prev is not None and macd_hist < 0 <= macd_hist_prev
        tf_tag = f" ({chart_tf})" if chart_tf else ""
        if bullish_pos:
            if flipped_up:
                score += 8
                notes.append(f"MACD bullish cross{tf_tag} — momentum turning up")
            elif macd_hist > 0:
                score += 3
                notes.append(f"MACD positive{tf_tag} (hist {macd_hist:+.3f})")
            elif flipped_dn:
                score -= 8
                notes.append(f"MACD bearish cross{tf_tag} — momentum rolling over")
            elif macd_hist < 0:
                score -= 3
                notes.append(f"MACD negative{tf_tag} (hist {macd_hist:+.3f})")
        elif bearish_pos:
            if flipped_dn:
                score += 8
                notes.append(f"MACD bearish cross{tf_tag} — aligned with position")
            elif macd_hist < 0:
                score += 3
                notes.append(f"MACD negative{tf_tag} (hist {macd_hist:+.3f})")
            elif flipped_up:
                score -= 8
                notes.append(f"MACD bullish cross{tf_tag} — against position")
            elif macd_hist > 0:
                score -= 3
                notes.append(f"MACD positive{tf_tag} (hist {macd_hist:+.3f})")

    # SMI — overbought/oversold + cross with signal line.
    # Strong signal (≥40 / ≤-40) is a pullback/bounce warning; cross is
    # directional confirmation aligned (or not) with the position.
    if smi is not None:
        bullish_pos = (long_call or short_put_like)
        bearish_pos = (long_put or short_call_like)
        tf_tag = f" ({chart_tf})" if chart_tf else ""
        if smi >= 40 and bullish_pos:
            score -= 6
            notes.append(f"SMI {smi:.0f}{tf_tag} — overbought, pullback risk for longs")
        elif smi <= -40 and bearish_pos:
            score -= 6
            notes.append(f"SMI {smi:.0f}{tf_tag} — oversold, bounce risk for shorts/puts")
        elif smi >= 40 and bearish_pos:
            score += 4
            notes.append(f"SMI {smi:.0f}{tf_tag} — overbought favors put/short-call")
        elif smi <= -40 and bullish_pos:
            score += 4
            notes.append(f"SMI {smi:.0f}{tf_tag} — oversold favors call/short-put")
        # cross with signal line
        if smi_signal is not None:
            if smi > smi_signal and abs(smi - smi_signal) < 5:
                # near a fresh bullish cross
                if bullish_pos:
                    score += 3
                    notes.append(f"SMI above signal{tf_tag} — short-term bullish")
                elif bearish_pos:
                    score -= 3
            elif smi < smi_signal and abs(smi - smi_signal) < 5:
                if bullish_pos:
                    score -= 3
                elif bearish_pos:
                    score += 3
                    notes.append(f"SMI below signal{tf_tag} — short-term bearish")

    # VWAP — only meaningful on intraday timeframes (daily-reset).
    # Above VWAP = institutional support; below = distribution.
    if vwap is not None and spot is not None and chart_tf and chart_tf not in ("1d", "1w", "1mo"):
        diff_pct = (spot - vwap) / vwap * 100 if vwap else 0
        bullish_pos = (long_call or short_put_like)
        bearish_pos = (long_put or short_call_like)
        if abs(diff_pct) >= 0.3:
            if bullish_pos and diff_pct > 0:
                score += 3
                notes.append(f"Spot {diff_pct:+.2f}% above VWAP{chart_tf and f' ({chart_tf})'} — intraday bias up")
            elif bullish_pos and diff_pct < 0:
                score -= 3
                notes.append(f"Spot {diff_pct:.2f}% below VWAP ({chart_tf}) — intraday bias down")
            elif bearish_pos and diff_pct < 0:
                score += 3
                notes.append(f"Spot {diff_pct:.2f}% below VWAP ({chart_tf}) — intraday bias down")
            elif bearish_pos and diff_pct > 0:
                score -= 3
                notes.append(f"Spot {diff_pct:+.2f}% above VWAP ({chart_tf}) — against put/short-call")

    # forecast alignment — Ensemble 5d expected return + ensemble agreement.
    # Bullish positions (long call / short put) want positive expected return;
    # bearish positions (long put / short call) want negative. Wide forecast
    # bands mean low conviction — penalize all positions slightly (uncertainty risk).
    # When ensemble members disagree (low agreement), apply less score weight.
    agreement = (forecast or {}).get("_agreement_5d", 1.0) if forecast else 1.0
    conviction_mult = 0.4 + 0.6 * agreement  # 0.4 (chaos) to 1.0 (consensus)
    if forecast is not None:
        er = forecast.get("expected_return_pct") or 0.0
        band = forecast.get("band_pct") or 0.0
        bullish_pos = (long_call or short_put_like)
        bearish_pos = (long_put or short_call_like)
        # Directional alignment — magnitudes scaled by ensemble agreement.
        # When members disagree, the forecast moves the score less.
        agree_tag = f" · agreement {agreement*100:.0f}%" if agreement < 0.95 else ""
        if bullish_pos:
            if er >= 3.0:
                score += int(10 * conviction_mult)
                notes.append(f"Model 5d +{er:.1f}% — aligned with position{agree_tag}")
            elif er >= 0.5:
                score += int(4 * conviction_mult)
                notes.append(f"Model 5d +{er:.1f}% — mildly supportive{agree_tag}")
            elif er <= -3.0:
                score -= int(12 * conviction_mult)
                notes.append(f"Model 5d {er:.1f}% — against position direction{agree_tag}")
            elif er <= -0.5:
                score -= int(5 * conviction_mult)
                notes.append(f"Model 5d {er:.1f}% — mild headwind{agree_tag}")
        elif bearish_pos:
            if er <= -3.0:
                score += int(10 * conviction_mult)
                notes.append(f"Model 5d {er:.1f}% — aligned with position{agree_tag}")
            elif er <= -0.5:
                score += int(4 * conviction_mult)
                notes.append(f"Model 5d {er:.1f}% — mildly supportive{agree_tag}")
            elif er >= 3.0:
                score -= int(12 * conviction_mult)
                notes.append(f"Model 5d +{er:.1f}% — against position direction{agree_tag}")
            elif er >= 0.5:
                score -= int(5 * conviction_mult)
                notes.append(f"Model 5d +{er:.1f}% — mild headwind{agree_tag}")
        # Conviction — a wide p10/p90 band means the model is uncertain.
        if band >= 8.0:
            score -= 3
            notes.append(f"Forecast band ±{band:.1f}% — low conviction")
        # Ensemble disagreement is itself a flag.
        if agreement < 0.5:
            score -= 2
            notes.append(f"Forecast members disagree ({agreement*100:.0f}% agreement) — soft signal")

    score = max(-100, min(100, score))
    if score >= 40:
        label = "Hold / lean bullish to this trade"
    elif score >= 15:
        label = "Hold with caution"
    elif score >= -15:
        label = "Mixed — review manually"
    elif score >= -40:
        label = "Reduce or close"
    else:
        label = "Close — risk/reward poor"

    return {"score": score, "label": label, "notes": notes}


def _narrative(
    symbol: str, side: str, is_long: bool, qty: int,
    strike: float, expiry: str, dte: int,
    spot: float, distance_pct: float,
    mid: Optional[float], entry: float,
    iv: float, rv_30: Optional[float], iv_rv_ratio: Optional[float],
    delta: Optional[float], theta: Optional[float],
    sigma: Dict[str, Any], prob: Dict[str, Any], liquidity: Dict[str, Any],
    advice: Dict[str, Any], forecast: Optional[Dict[str, Any]] = None,
    iv_rank: Optional[float] = None,
) -> str:
    """One-sentence reading of the position. The headline numbers (spot, IV,
    DTE, POP, etc.) are already in the market-state strip — the narrative is
    the *call* in plain English, NOT a metric dump.

    Picks the single most important fact about the trade (POP, distance to
    strike, IV/RV regime, or theta posture) and frames the verdict around it.
    Used as a hover-friendly verdict summary AND fed to LLM agents."""
    pos_side = "long" if is_long else "short"
    side_letter = side[0].upper()  # C or P
    pos = f"{pos_side} {qty}× {symbol} {strike:g}{side_letter} {dte}d"

    pop = prob.get("pop")
    iv_rv = iv_rv_ratio
    pop_str = f"POP {pop*100:.0f}%" if pop is not None else None

    # Pick the dominant frame for this trade.
    abs_d = abs(delta) if delta is not None else 0.0
    em = sigma.get("expected_move_pct")

    frames: List[str] = []
    if is_long and abs(distance_pct) > 8 and abs_d < 0.30:
        frames.append(f"strike is {distance_pct:+.1f}% from spot — needs a big move")
    elif is_long and abs_d >= 0.65:
        frames.append(f"deep ITM (|Δ| {abs_d:.2f}) — behaves like stock")
    if pop is not None and pop < 0.30:
        frames.append(f"low POP {pop*100:.0f}%")
    elif pop is not None and pop >= 0.65:
        frames.append(f"high POP {pop*100:.0f}%")
    if iv_rank is not None and iv_rank >= 75 and is_long:
        frames.append(f"IV rank {iv_rank:.0f} — vol near 52w highs")
    elif iv_rank is not None and iv_rank <= 20 and not is_long:
        frames.append(f"IV rank {iv_rank:.0f} — collecting bottom-of-range vol")
    elif iv_rv is not None and iv_rv >= 1.3 and is_long:
        frames.append(f"IV/RV {iv_rv:.2f}× — paying up for vol")
    elif iv_rv is not None and iv_rv <= 0.8 and not is_long:
        frames.append(f"IV/RV {iv_rv:.2f}× — collecting cheap vol")
    if dte <= 7:
        frames.append(f"{dte}d to expiry — gamma risk peak")
    if liquidity.get("grade") in ("wide", "poor"):
        frames.append(f"{liquidity['grade']} liquidity")

    if forecast is not None:
        er = forecast.get("expected_return_pct")
        if er is not None and abs(er) >= 2.0:
            frames.append(f"model 5d {er:+.1f}%")

    # Fallback frame so we always say something.
    if not frames and pop_str:
        frames.append(pop_str)

    summary = " · ".join(frames[:3]) if frames else "mixed signals"
    return f"{pos}. {summary}. Verdict: {advice['label']}."


@router.get("/forecast_accuracy/{symbol}")
async def forecast_accuracy(symbol: str, horizon: int = Query(5, ge=1, le=21)):
    """Per-model historical accuracy for this symbol/horizon.

    Returns MAE, RMSE, sign-hit-rate per model across recent scored
    forecasts. Powers the calibration panel in the UI — lets the user
    see "is the model actually any good for THIS name?".
    """
    symbol = symbol.upper()
    return await forecast_calibration.model_accuracy(symbol=symbol, horizon=horizon)


@router.get("/analyze/{symbol}")
async def analyze_option(
    symbol: str,
    strike: float = Query(..., description="Strike price"),
    expiry: str = Query(..., description="YYYYMMDD"),
    right: Literal["C", "P"] = Query(..., description="C=call, P=put"),
    quantity: int = Query(1, description="signed: + = long, - = short"),
    entry_price: Optional[float] = Query(None, description="cost basis per share; defaults to current mid"),
    timeframe: str = Query("1d", description="chart timeframe: 5m | 15m | 1h | 4h | 1d"),
):
    symbol = symbol.upper()
    if timeframe not in _TF_DAYS:
        timeframe = "1d"
    cache_key = (symbol, strike, expiry, right, quantity, entry_price, timeframe)
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    # Fetch in parallel:
    #   - daily bars: stable foundation for IV/RV/sigma/Greeks + Chronos forecast
    #   - chart bars: at user-selected timeframe, for the underlying-analysis card
    #     (skipped when timeframe == "1d" since both views collapse to the same series)
    #   - option snapshot for the specific contract
    #   - real historical option bars (IBKR) — replaces the BS-replay when available
    #   - underlying IV/HV history (IBKR vol indices) — powers IV rank/percentile
    import asyncio as _asyncio
    daily_task = _asyncio.create_task(get_bars(symbol, "1d", 200))
    chart_task = (
        _asyncio.create_task(get_bars(symbol, timeframe, _TF_DAYS[timeframe]))
        if timeframe != "1d" else None
    )
    snap_task = _asyncio.create_task(ib_options.get_option_snapshot(symbol, strike, expiry, right))
    opt_bars_task = _asyncio.create_task(
        ib_options.get_option_bars(symbol, strike, expiry, right, timeframe, _TF_DAYS[timeframe])
    )
    vol_hist_task = _asyncio.create_task(ib_options.get_vol_history(symbol, 365))
    if chart_task is not None:
        daily_resp, chart_resp, row, real_option_bars, vol_history = await _asyncio.gather(
            daily_task, chart_task, snap_task, opt_bars_task, vol_hist_task
        )
    else:
        daily_resp, row, real_option_bars, vol_history = await _asyncio.gather(
            daily_task, snap_task, opt_bars_task, vol_hist_task
        )
        chart_resp = daily_resp

    bars = daily_resp.get("bars", [])
    if not bars:
        raise HTTPException(404, f"no bars for {symbol}")
    closes = [b["close"] for b in bars]
    spot = float(closes[-1])

    rsi_series_daily = compute_rsi_series(closes, 14) if len(closes) > 15 else [50.0]
    rsi = rsi_series_daily[-1]
    macd = compute_macd_series(closes) if len(closes) > 35 else {"macd": [0.0], "signal": [0.0], "hist": [0.0]}
    ema9 = compute_ema_series(closes, 9)
    ema21 = compute_ema_series(closes, 21)
    ema50 = compute_ema_series(closes, 50) if len(closes) >= 50 else None
    ema200 = compute_ema_series(closes, 200) if len(closes) >= 200 else None

    trend_score = 0
    if ema9 and ema21 and ema9[-1] > ema21[-1]:
        trend_score += 5
    elif ema9 and ema21:
        trend_score -= 5
    if ema200 and spot > ema200[-1]:
        trend_score += 5
    elif ema200:
        trend_score -= 5
    if macd["hist"][-1] > 0:
        trend_score += 5
    else:
        trend_score -= 5

    bid = row["bid"] if row else None
    ask = row["ask"] if row else None
    last = row["last"] if row else None
    mid = None
    mid_source = None  # "quote" | "last" | "theoretical"
    # bid=0 is a real quote on deep-OTM contracts (no bidders), not missing
    # data — _safe_price already stripped IBKR's -1 sentinel to None. As long
    # as the ask side is quoted, the midpoint is meaningful.
    if bid is not None and ask is not None and ask > 0:
        mid = (bid + ask) / 2
        mid_source = "quote"
    elif last is not None and last > 0:
        mid = last
        mid_source = "last"
    elif ask is not None and ask > 0:
        mid = ask / 2
        mid_source = "ask-half"
    elif bid is not None and bid > 0:
        mid = bid
        mid_source = "bid-only"

    iv = row["iv"] if row and row.get("iv") else None

    dte_years = _years_to_expiry(expiry)
    dte = _days_to_expiry(expiry)

    side_full = "call" if right == "C" else "put"

    # Solve IV from market mid if not given
    if (iv is None or iv <= 0) and mid is not None and mid > 0:
        iv = implied_vol(mid, spot, strike, dte_years, side_full) or 0.0

    # Final fallback IV
    if iv is None or iv <= 0:
        iv = 0.35

    # Last-resort theoretical mid via Black-Scholes when IBKR has no live
    # quote at all (common on deep-OTM long-dated LEAPs where bid/ask/last
    # are all empty). Better to surface a model price than show "—" — the
    # whole analyzer is built around having a mid to chart P/L from.
    if mid is None and dte_years > 0:
        try:
            theoretical = bs_price(spot, strike, dte_years, iv, side_full)
            if theoretical and theoretical > 0:
                mid = round(theoretical, 4)
                mid_source = "theoretical"
        except Exception as e:  # noqa: BLE001
            logger.debug("BS fallback failed for %s %s%s: %s", symbol, strike, right, e)

    # 3. Greeks (prefer vendor data, recompute from BS if missing)
    g = bs_greeks(spot, strike, dte_years, iv, side_full)
    delta = row.get("delta") if row and row.get("delta") is not None else g["delta"]
    gamma = row.get("gamma") if row and row.get("gamma") is not None else g["gamma"]
    theta = row.get("theta") if row and row.get("theta") is not None else g["theta"]
    vega = row.get("vega") if row and row.get("vega") is not None else g["vega"]

    # 4. Synthetic option-price EMA series
    syn_hist = _synthetic_option_history(closes, strike, side_full, iv, dte_years, bar_count=60)
    opt_ema9 = compute_ema_series(syn_hist, 9) if len(syn_hist) >= 9 else syn_hist
    opt_ema21 = compute_ema_series(syn_hist, 21) if len(syn_hist) >= 21 else syn_hist

    # 5. P/L profile
    effective_entry = (
        entry_price if entry_price is not None and entry_price > 0
        else (mid if mid is not None else (last or 1.0))
    )
    is_long = quantity >= 0
    pnl_profile = _build_pnl_profile(
        spot=spot, strike=strike, right=side_full, iv=iv,
        dte_years=dte_years, entry_price=effective_entry, quantity=quantity,
        is_long=is_long,
    )
    sigma = _sigma_ranges(spot=spot, iv=iv, dte_years=dte_years)
    decay = _decay_profile(
        spot=spot, strike=strike, iv=iv, dte_years=dte_years,
        side=side_full, entry_price=effective_entry,
        quantity=quantity, is_long=is_long,
    )
    probability = _probability_metrics(
        spot=spot, strike=strike, dte_years=dte_years, iv=iv,
        side=side_full, is_long=is_long, entry_price=effective_entry,
    )
    rv_30 = _realized_vol(closes, lookback_days=30)
    rv_90 = _realized_vol(closes, lookback_days=90)
    iv_rv_ratio = round(iv / rv_30, 3) if rv_30 and rv_30 > 0 else None
    # IV rank/percentile from IBKR's real IV-index history (52-week window).
    ivr = _iv_rank_metrics(
        (vol_history or {}).get("iv", []),
        (vol_history or {}).get("hv", []),
    )
    liquidity = _liquidity(bid=bid, ask=ask, last=last,
                           volume=row.get("vol") if row else None,
                           oi=row.get("oi") if row else None)

    # break-even
    if side_full == "call":
        breakeven = strike + effective_entry
    else:
        breakeven = strike - effective_entry

    distance_pct = ((spot - strike) / strike * 100) if strike else 0.0

    # 5b. chart-timeframe indicators (drives the underlying-analysis card UI).
    # Indicators are computed on the chart bars (intraday or daily depending on
    # the requested timeframe) so what the user sees lines up bar-for-bar.
    chart_bars = chart_resp.get("bars", []) if chart_resp else []
    chart_indicators = _chart_indicators(chart_bars, timeframe)
    # 5b2. Companion option-chart. Preferred source: REAL historical option
    # bars from IBKR (true traded prices, embodying the actual IV path and
    # real volume). Fallback: the synthetic BS-replay when the contract has
    # no usable history (fresh listings, very illiquid strikes).
    if real_option_bars and len(real_option_bars) >= 10:
        option_chart_block = _option_chart_from_real_bars(
            real_option_bars, chart_bars, timeframe
        )
    else:
        option_chart_block = _option_chart_indicators(
            chart_bars, strike, side_full, iv, dte_years, timeframe
        )
    # 5b3. Multi-TF snapshot — current value of every indicator across all
    # supported TFs. Lets the UI render a "is the trend on every TF
    # confirming?" matrix and lets the advice scoring use cross-TF
    # consensus, not just one frame.
    multi_tf = await _multi_tf_snapshot(symbol, timeframe, chart_indicators, daily_resp)
    # DTE-aware default chart TF — 0DTE option wants intraday bars, 240DTE
    # wants 1d. UI seeds the timeframe state from this on first load.
    recommended_chart_tf = _recommended_chart_tf(dte)

    # 5c. Probabilistic forecast — ensemble of Chronos-2 (log-return space),
    # momentum, mean-reversion, and martingale baselines across 1/5/21-day
    # horizons. Conformal-calibrated against this symbol's recent residuals
    # so p10/p90 bands actually hit ~80% coverage.
    ensemble_result = forecast_ensemble.forecast(closes, horizons=chronos.DEFAULT_HORIZONS)
    if ensemble_result is not None:
        # Apply conformal calibration to the ensemble's bands.
        ensemble_result["ensemble"] = await forecast_calibration.apply_calibration(
            {**ensemble_result["ensemble"], "last_close": ensemble_result["last_close"]},
            symbol=symbol,
            model="ensemble",
        )
        # Persist each member's forecast so future calibration has fuel.
        for member_name, member_data in ensemble_result["members"].items():
            for hk, hf in member_data.get("horizons", {}).items():
                await forecast_calibration.log_forecast(
                    symbol=symbol,
                    model=member_name,
                    horizon=int(hk),
                    anchor_close=spot,
                    predicted_median=hf["median"][-1],
                    predicted_p10=hf["p10"][-1],
                    predicted_p90=hf["p90"][-1],
                )
        # And the ensemble itself.
        for hk, hf in ensemble_result["ensemble"].get("horizons", {}).items():
            await forecast_calibration.log_forecast(
                symbol=symbol,
                model="ensemble",
                horizon=int(hk),
                anchor_close=spot,
                predicted_median=hf["median"][-1],
                predicted_p10=hf["p10"][-1],
                predicted_p90=hf["p90"][-1],
            )

    # Shape the back-compat `forecast` field as the calibrated ensemble 5d view.
    forecast: Optional[Dict[str, Any]] = None
    if ensemble_result is not None:
        h5 = ensemble_result["ensemble"]["horizons"].get("5")
        if h5:
            forecast = {
                "horizon": h5["horizon"],
                "context_len": ensemble_result.get("members", {}).get("chronos", {}).get("horizons", {}).get("5", {}).get("context_len", 0),
                "last_close": ensemble_result["last_close"],
                "median": h5["median"],
                "p10": h5["p10"],
                "p90": h5["p90"],
                "expected_return_pct": h5["expected_return_pct"],
                "band_pct": h5["band_pct"],
            }

    # 6. advice — pulls in chart-TF momentum so the verdict reflects what the
    # user is currently looking at (not just the daily-bar fallbacks).
    def _last(seq: List[float]) -> Optional[float]:
        return seq[-1] if seq else None
    def _second_last(seq: List[float]) -> Optional[float]:
        return seq[-2] if len(seq) >= 2 else None

    chart_macd_hist = _last(chart_indicators.get("macd_hist", []))
    chart_macd_hist_prev = _second_last(chart_indicators.get("macd_hist", []))
    chart_smi = _last(chart_indicators.get("smi", []))
    chart_smi_signal = _last(chart_indicators.get("smi_signal", []))
    chart_vwap = _last(chart_indicators.get("vwap", []))

    # Inject the ensemble's 5d agreement score as a conviction multiplier
    # into the forecast advice block (private attribute pattern).
    advice_forecast = dict(forecast) if forecast else None
    if advice_forecast is not None and ensemble_result is not None:
        advice_forecast["_agreement_5d"] = ensemble_result.get("agreement", {}).get("5", 1.0)

    advice = _advice(
        delta=delta or 0.0,
        theta=theta or 0.0,
        vega=vega or 0.0,
        dte=dte,
        is_long=is_long,
        distance_pct=distance_pct,
        iv=iv,
        rsi=rsi,
        trend_score=trend_score,
        forecast=advice_forecast,
        macd_hist=chart_macd_hist,
        macd_hist_prev=chart_macd_hist_prev,
        smi=chart_smi,
        smi_signal=chart_smi_signal,
        spot=spot,
        vwap=chart_vwap if chart_vwap and chart_vwap > 0 else None,
        chart_tf=timeframe,
        entry_price=effective_entry,
        mid=mid,
        iv_rank=ivr["iv_rank"],
    )

    # max profit/loss for the position
    multiplier = 100
    qty_abs = abs(quantity) or 1

    # Unrealized P&L vs entry — THE number a trader reviewing their own
    # position wants first. Sign-aware: shorts profit when the mark drops.
    position_pnl: Dict[str, Optional[float]] = {
        "cost_basis": round(effective_entry * multiplier * qty_abs, 2),
        "market_value": None,
        "unrealized_pnl": None,
        "unrealized_pnl_pct": None,
        "mark": round(mid, 4) if mid is not None else None,
        "mark_source": mid_source,
    }
    if mid is not None and effective_entry > 0:
        pnl_sign = 1 if is_long else -1
        unreal = pnl_sign * (mid - effective_entry) * multiplier * qty_abs
        position_pnl["market_value"] = round(mid * multiplier * qty_abs, 2)
        position_pnl["unrealized_pnl"] = round(unreal, 2)
        position_pnl["unrealized_pnl_pct"] = round(
            pnl_sign * (mid - effective_entry) / effective_entry * 100, 2
        )

    if is_long:
        max_loss = -effective_entry * multiplier * qty_abs  # premium paid
        max_profit = float("inf") if side_full == "call" else (strike - effective_entry) * multiplier * qty_abs
    else:
        max_profit = effective_entry * multiplier * qty_abs
        max_loss = float("-inf") if side_full == "call" else -(strike - effective_entry) * multiplier * qty_abs

    def _json_num(v: float) -> Optional[float]:
        if v is None or math.isnan(v) or math.isinf(v):
            return None
        return v

    narrative = _narrative(
        symbol=symbol, side=side_full, is_long=is_long,
        qty=abs(quantity) or 1, strike=strike, expiry=expiry, dte=dte,
        spot=spot, distance_pct=distance_pct, mid=mid, entry=effective_entry,
        iv=iv, rv_30=rv_30, iv_rv_ratio=iv_rv_ratio,
        delta=delta, theta=theta,
        sigma=sigma, prob=probability, liquidity=liquidity,
        advice=advice, forecast=forecast,
        iv_rank=ivr["iv_rank"],
    )

    resp = {
        "symbol": symbol,
        "strike": strike,
        "expiry": expiry,
        "right": right,
        "side": side_full,
        "quantity": quantity,
        "is_long": is_long,
        "dte": dte,
        "spot": round(spot, 4),
        "distance_pct": round(distance_pct, 2),
        "underlying": {
            "ema9": round(ema9[-1], 2) if ema9 else None,
            "ema21": round(ema21[-1], 2) if ema21 else None,
            "ema50": round(ema50[-1], 2) if ema50 else None,
            "ema200": round(ema200[-1], 2) if ema200 else None,
            "rsi": round(rsi, 1),
            "macd_hist": round(macd["hist"][-1], 4),
            "trend_score": trend_score,
            "history": [{"time": b["time"], "close": b["close"]} for b in bars[-90:]],
            "ema9_history": [round(v, 2) for v in (ema9[-90:] if ema9 else [])],
            "ema21_history": [round(v, 2) for v in (ema21[-90:] if ema21 else [])],
        },
        "option": {
            "bid": bid, "ask": ask, "last": last, "mid": round(mid, 4) if mid else None,
            "mid_source": mid_source,
            "iv": round(iv, 4),
            "entry_price": round(effective_entry, 4),
            "synthetic_history": syn_hist,
            "synthetic_ema9": [round(v, 4) for v in opt_ema9[-60:]],
            "synthetic_ema21": [round(v, 4) for v in opt_ema21[-60:]],
        },
        "greeks": {
            "delta": _json_num(round(delta, 4)) if delta is not None else None,
            "gamma": _json_num(round(gamma, 6)) if gamma is not None else None,
            "theta": _json_num(round(theta, 4)) if theta is not None else None,
            "vega": _json_num(round(vega, 4)) if vega is not None else None,
        },
        "pnl_profile": pnl_profile,
        "breakeven": round(breakeven, 2),
        "max_profit": _json_num(max_profit),
        "max_loss": _json_num(max_loss),
        "advice": advice,
        "tradingagents_enabled": True,

        # ---- analytics block (used by new UI panels + AI agent tooling) ----
        "decay_profile": decay,
        "sigma_ranges": sigma,
        "probability": probability,
        "liquidity": liquidity,
        "vol_context": {
            "realized_vol_30d": rv_30,
            "realized_vol_90d": rv_90,
            "iv_to_rv_ratio": iv_rv_ratio,
            # Real IV-regime context from IBKR's vol indices (52-week window).
            "iv_rank": ivr["iv_rank"],
            "iv_percentile": ivr["iv_percentile"],
            "iv_52w_high": ivr["iv_52w_high"],
            "iv_52w_low": ivr["iv_52w_low"],
            "underlying_iv_now": ivr["underlying_iv_now"],
            "iv_history": ivr["iv_history"],
            "hv_history": ivr["hv_history"],
        },
        "position_pnl": position_pnl,
        "narrative": narrative,

        # ---- chart-timeframe block (drives the underlying analysis card) ----
        "chart": {
            "timeframe": timeframe,
            "supported_timeframes": _SUPPORTED_TFS,
            **chart_indicators,
        },
        # ---- option-side chart block: synthetic price + indicators on the
        # option itself, RV30 as IV-history proxy. ----
        "option_chart": option_chart_block,
        # ---- Multi-TF momentum snapshot: latest indicator readings on every
        # supported TF, plus a DTE-aware recommended chart TF. ----
        "multi_tf": multi_tf,
        "recommended_chart_tf": recommended_chart_tf,
        "forecast": forecast,
        # Full multi-horizon ensemble + per-member breakdown + calibration meta.
        "forecast_ensemble": ensemble_result,

        # ---- signal_inputs: explicit "what fed the verdict" snapshot so the
        # UI can show users the data driving the score (auditability). ----
        "signal_inputs": {
            "daily": {
                "rsi": round(rsi, 2),
                "macd_hist": round(macd["hist"][-1], 4) if macd.get("hist") else None,
                "ema9": round(ema9[-1], 2) if ema9 else None,
                "ema21": round(ema21[-1], 2) if ema21 else None,
                "ema200": round(ema200[-1], 2) if ema200 else None,
                "trend_score": trend_score,
            },
            "chart_tf": {
                "timeframe": timeframe,
                "rsi": _last(chart_indicators.get("rsi", [])),
                "macd_hist": chart_macd_hist,
                "macd_hist_prev": chart_macd_hist_prev,
                "smi": chart_smi,
                "smi_signal": chart_smi_signal,
                "vwap": chart_vwap,
            },
            "forecast_5d": (
                {
                    "expected_return_pct": forecast["expected_return_pct"],
                    "band_pct": forecast["band_pct"],
                    "model": "chronos-bolt-small",
                } if forecast else None
            ),
            "iv": round(iv, 4),
            "iv_rv_ratio": iv_rv_ratio,
            "iv_rank": ivr["iv_rank"],
            "dte": dte,
            "abs_delta": round(abs(delta), 4) if delta is not None else None,
        },
    }
    _cache.set(cache_key, resp)
    return resp


def _held_option_history(
    bars: List[Dict[str, Any]],
    strike: float,
    side: str,
    iv: float,
    dte_now_years: float,
    timeframe: str,
) -> List[float]:
    """Synthetic option-price series assuming the option was *held through*
    the period: DTE shrinks as we walk forward (matching reality), IV held
    constant at the current value (a proxy — historical IV isn't available).

    For N bars in the input series, bar i (0..N-1) is at DTE-now plus
    (N-1-i) × bar-period-in-years remaining to expiry. So the oldest bar
    represents the option with the most time, the last bar matches "today".
    """
    if not bars or iv <= 0:
        return []
    bar_years = _TF_BAR_YEARS.get(timeframe, 1 / 252)
    n = len(bars)
    out: List[float] = []
    for i, b in enumerate(bars):
        remaining_bars = n - 1 - i
        t = max(0.0, dte_now_years + remaining_bars * bar_years)
        try:
            price = bs_price(b["close"], strike, t, iv, side)
        except Exception:
            price = 0.0
        out.append(price)
    return out


# Bar duration in calendar years per timeframe. Used by held-over-time
# synthetic option history to advance DTE one bar at a time. Trading day =
# 6.5 hours; 252 trading days/year.
_TF_BAR_YEARS: Dict[str, float] = {
    "5m": 5 / 60 / 6.5 / 252,
    "15m": 15 / 60 / 6.5 / 252,
    "1h": 1 / 6.5 / 252,
    "4h": 4 / 6.5 / 252,
    "1d": 1 / 252,
}


def _rolling_realized_vol(
    closes: List[float],
    window: int = 30,
    annualize: bool = True,
) -> List[float]:
    """Rolling annualized realized volatility from log returns.

    Used as an IV-history proxy: actual implied vol time series isn't
    available without paid data, but realized vol over time tells the user
    "how much has the underlying been moving recently" which is the next-
    best signal for option pricing context. Returns same length as `closes`
    with warm-up bars filled with NaN→0.0.
    """
    n = len(closes)
    out = [0.0] * n
    if n < window + 2:
        return out
    for i in range(window, n):
        rets: List[float] = []
        for j in range(i - window + 1, i + 1):
            if j == 0 or closes[j - 1] <= 0 or closes[j] <= 0:
                continue
            rets.append(math.log(closes[j] / closes[j - 1]))
        if len(rets) < 5:
            continue
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / max(len(rets) - 1, 1)
        daily_vol = math.sqrt(var)
        out[i] = daily_vol * math.sqrt(252) if annualize else daily_vol
    return out


def _option_chart_indicators(
    bars: List[Dict[str, Any]],
    strike: float,
    side: str,
    iv: float,
    dte_now_years: float,
    timeframe: str,
) -> Dict[str, Any]:
    """Option-side companion to _chart_indicators.

    Computes a held-through-time synthetic option price series and indicators
    on THAT series (RSI, MACD, EMA) — so the user can see the option's own
    momentum/trend, not just the underlying's. Also returns rolling RV30 of
    the underlying as an IV-history proxy.
    """
    n = len(bars)
    if n == 0:
        return _empty_option_chart(timeframe, source="synthetic")
    underlying_closes = [b["close"] for b in bars]
    syn_prices = _held_option_history(bars, strike, side, iv, dte_now_years, timeframe)

    rsi = compute_rsi_series(syn_prices, 14) if n > 15 else [50.0] * n
    macd = (
        compute_macd_series(syn_prices)
        if n > 35 else {"macd": [0.0] * n, "signal": [0.0] * n, "hist": [0.0] * n}
    )
    ema9_s = compute_ema_series(syn_prices, 9) if n >= 9 else syn_prices[:]
    ema21_s = compute_ema_series(syn_prices, 21) if n >= 21 else syn_prices[:]
    rv30 = _rolling_realized_vol(underlying_closes, window=30, annualize=True)

    return {
        "timeframe": timeframe,
        "source": "synthetic",
        "times": [b["time"] for b in bars],
        "bars": [],
        "volume": [],
        "synthetic_prices": [round(v, 4) for v in syn_prices],
        "rsi": [round(v, 2) for v in rsi],
        "macd": [round(v, 5) for v in macd["macd"]],
        "macd_signal": [round(v, 5) for v in macd["signal"]],
        "macd_hist": [round(v, 5) for v in macd["hist"]],
        "ema9": [round(v, 4) for v in ema9_s],
        "ema21": [round(v, 4) for v in ema21_s],
        "rv30": [round(v, 4) for v in rv30],
    }


def _empty_option_chart(timeframe: str, source: str) -> Dict[str, Any]:
    return {
        "timeframe": timeframe,
        "source": source,
        "times": [], "bars": [], "volume": [],
        "synthetic_prices": [],
        "rsi": [], "macd": [], "macd_signal": [], "macd_hist": [],
        "ema9": [], "ema21": [],
        "rv30": [],
    }


def _option_chart_from_real_bars(
    opt_bars: List[Dict[str, Any]],
    underlying_chart_bars: List[Dict[str, Any]],
    timeframe: str,
) -> Dict[str, Any]:
    """Option chart block built from REAL IBKR option history.

    Same shape as the synthetic block (so the UI/AI consumers work
    unchanged) plus real OHLCV bars and volume. Indicators run on the real
    close series — option momentum as it actually traded, IV path included.
    `synthetic_prices` carries the real closes for back-compat. RV30 of the
    underlying is tail-aligned to the option bars (both are on the same
    timeframe/session grid, so aligning from the most recent bar back is
    accurate where it matters and only approximate in the warm-up region).
    """
    n = len(opt_bars)
    if n == 0:
        return _empty_option_chart(timeframe, source="ibkr")
    closes = [b["close"] for b in opt_bars]

    rsi = compute_rsi_series(closes, 14) if n > 15 else [50.0] * n
    macd = (
        compute_macd_series(closes)
        if n > 35 else {"macd": [0.0] * n, "signal": [0.0] * n, "hist": [0.0] * n}
    )
    ema9_s = compute_ema_series(closes, 9) if n >= 9 else closes[:]
    ema21_s = compute_ema_series(closes, 21) if n >= 21 else closes[:]

    underlying_closes = [b["close"] for b in underlying_chart_bars]
    rv30_full = _rolling_realized_vol(underlying_closes, window=30, annualize=True)
    rv30 = rv30_full[-n:] if len(rv30_full) >= n else [0.0] * (n - len(rv30_full)) + rv30_full

    return {
        "timeframe": timeframe,
        "source": "ibkr",
        "times": [b["time"] for b in opt_bars],
        "bars": [
            {
                "time": b["time"],
                "open": round(b["open"], 4),
                "high": round(b["high"], 4),
                "low": round(b["low"], 4),
                "close": round(b["close"], 4),
                "volume": b.get("volume", 0),
            }
            for b in opt_bars
        ],
        "volume": [b.get("volume", 0) for b in opt_bars],
        "synthetic_prices": [round(v, 4) for v in closes],
        "rsi": [round(v, 2) for v in rsi],
        "macd": [round(v, 5) for v in macd["macd"]],
        "macd_signal": [round(v, 5) for v in macd["signal"]],
        "macd_hist": [round(v, 5) for v in macd["hist"]],
        "ema9": [round(v, 4) for v in ema9_s],
        "ema21": [round(v, 4) for v in ema21_s],
        "rv30": [round(v, 4) for v in rv30],
    }


def _recommended_chart_tf(dte: int) -> str:
    """DTE → most-useful chart timeframe. Heuristic:
        0-1d (0DTE/1DTE)  → 5m   (intraday-only relevance)
        2-7d              → 15m  (weekly options)
        8-30d             → 1h   (monthly options)
        31-60d            → 4h
        61-270d           → 1d
        270d+ (LEAPs)     → 1w   (multi-year horizon needed)
    """
    if dte <= 1:
        return "5m"
    if dte <= 7:
        return "15m"
    if dte <= 30:
        return "1h"
    if dte <= 60:
        return "4h"
    if dte <= 270:
        return "1d"
    return "1w"


async def _multi_tf_snapshot(
    symbol: str,
    chart_tf: str,
    chart_indicators: Dict[str, Any],
    daily_resp: Dict[str, Any],
) -> Dict[str, Dict[str, Any]]:
    """Latest indicator readings on every supported timeframe.

    Already-fetched series (chart_tf and 1d) are reused; the rest are
    fetched in parallel. Each TF's snapshot is just the LAST value of
    every indicator (RSI/MACD/SMI/VWAP/EMA9/EMA21) plus a small
    'trend' classification ("bull"/"bear"/"neutral") combining them.
    """
    import asyncio as _asyncio

    # Build map of TF → bars. Skip TFs we already have to save an IBKR roundtrip.
    bars_by_tf: Dict[str, List[Dict[str, Any]]] = {}
    bars_by_tf["1d"] = daily_resp.get("bars", []) or []
    if chart_tf != "1d":
        bars_by_tf[chart_tf] = (
            (chart_indicators or {}).get("bars", []) or []
        ) or daily_resp.get("bars", [])

    # Fetch missing TFs in parallel — each call is cached by get_bars, so
    # subsequent users of the analyzer for the same symbol won't repay this.
    missing = [t for t in _SUPPORTED_TFS if t not in bars_by_tf]
    if missing:
        tasks = [get_bars(symbol, t, _TF_DAYS[t]) for t in missing]
        results = await _asyncio.gather(*tasks, return_exceptions=True)
        for tf_name, res in zip(missing, results):
            if isinstance(res, Exception):
                bars_by_tf[tf_name] = []
            else:
                bars_by_tf[tf_name] = res.get("bars", []) or []

    out: Dict[str, Dict[str, Any]] = {}
    for tf in _SUPPORTED_TFS:
        bars = bars_by_tf.get(tf, [])
        if len(bars) < 30:
            out[tf] = {"available": False}
            continue
        ind = _chart_indicators(bars, tf)
        spot = float(bars[-1]["close"])
        rsi = ind["rsi"][-1] if ind["rsi"] else None
        macd_h = ind["macd_hist"][-1] if ind["macd_hist"] else None
        macd_h_prev = ind["macd_hist"][-2] if ind["macd_hist"] and len(ind["macd_hist"]) >= 2 else None
        smi = ind["smi"][-1] if ind["smi"] else None
        smi_sig = ind["smi_signal"][-1] if ind["smi_signal"] else None
        vwap = ind["vwap"][-1] if ind["vwap"] else None
        vwap_useful = tf not in ("1d", "1w", "1mo") and vwap and vwap > 0
        vwap_diff_pct = ((spot - vwap) / vwap * 100) if vwap_useful else None
        ema9 = ind["ema9"][-1] if ind["ema9"] else None
        ema21 = ind["ema21"][-1] if ind["ema21"] else None
        trend = _classify_trend(rsi, macd_h, smi, ema9, ema21, spot)
        out[tf] = {
            "available": True,
            "spot": round(spot, 4),
            "rsi": rsi,
            "macd_hist": macd_h,
            "macd_hist_prev": macd_h_prev,
            "smi": smi,
            "smi_signal": smi_sig,
            "vwap": vwap if vwap_useful else None,
            "vwap_diff_pct": round(vwap_diff_pct, 3) if vwap_diff_pct is not None else None,
            "ema9": ema9,
            "ema21": ema21,
            "trend": trend,
        }
    return out


def _classify_trend(
    rsi: Optional[float],
    macd_h: Optional[float],
    smi: Optional[float],
    ema9: Optional[float],
    ema21: Optional[float],
    spot: float,
) -> str:
    """Combine the bar-level momentum indicators into a coarse 'bull/bear/
    neutral' label for the TF. Used by the matrix UI + cross-TF consensus."""
    score = 0
    if rsi is not None:
        if rsi >= 60:
            score += 1
        elif rsi <= 40:
            score -= 1
    if macd_h is not None:
        if macd_h > 0:
            score += 1
        elif macd_h < 0:
            score -= 1
    if smi is not None:
        if smi > 0:
            score += 1
        elif smi < 0:
            score -= 1
    if ema9 is not None and ema21 is not None:
        if ema9 > ema21:
            score += 1
        elif ema9 < ema21:
            score -= 1
    if score >= 2:
        return "bull"
    if score <= -2:
        return "bear"
    return "neutral"


def _chart_indicators(bars: List[Dict[str, Any]], timeframe: str) -> Dict[str, Any]:
    """Compute the chart-timeframe indicator bundle: OHLCV + RSI/MACD/SMI/VWAP/EMAs.

    Returns lists aligned to `bars` (same length). Empty arrays when the bar
    series is too short for stable indicators — UI handles that gracefully.
    VWAP daily-resets only on intraday timeframes (matches TWS/Bloomberg).
    """
    n = len(bars)
    if n == 0:
        return {
            "bars": [],
            "rsi": [], "macd": [], "macd_signal": [], "macd_hist": [],
            "smi": [], "smi_signal": [], "vwap": [],
            "ema9": [], "ema21": [],
        }
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    closes = [b["close"] for b in bars]
    volumes = [b.get("volume", 0) for b in bars]
    times = [b["time"] for b in bars]

    rsi = compute_rsi_series(closes, 14) if n > 15 else [50.0] * n
    macd = (
        compute_macd_series(closes)
        if n > 35 else {"macd": [0.0] * n, "signal": [0.0] * n, "hist": [0.0] * n}
    )
    smi = (
        compute_smi_series(highs, lows, closes)
        if n > 30 else {"smi": [0.0] * n, "signal": [0.0] * n}
    )
    daily_reset = timeframe not in ("1d", "1w", "1mo")
    vwap = compute_vwap_series(highs, lows, closes, volumes, times, daily_reset=daily_reset)
    ema9_s = compute_ema_series(closes, 9)
    ema21_s = compute_ema_series(closes, 21)

    return {
        "bars": [
            {
                "time": b["time"],
                "open": round(b["open"], 4),
                "high": round(b["high"], 4),
                "low": round(b["low"], 4),
                "close": round(b["close"], 4),
                "volume": b.get("volume", 0),
            }
            for b in bars
        ],
        "rsi": [round(v, 2) for v in rsi],
        "macd": [round(v, 4) for v in macd["macd"]],
        "macd_signal": [round(v, 4) for v in macd["signal"]],
        "macd_hist": [round(v, 4) for v in macd["hist"]],
        "smi": [round(v, 2) for v in smi["smi"]],
        "smi_signal": [round(v, 2) for v in smi["signal"]],
        "vwap": [round(v, 4) for v in vwap],
        "ema9": [round(v, 4) for v in ema9_s],
        "ema21": [round(v, 4) for v in ema21_s],
    }
