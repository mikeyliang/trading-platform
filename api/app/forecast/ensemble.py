"""
Ensemble forecaster — Chronos + classical baselines.

Why ensemble: any single model has a regime where it dominates and another
where it's wrong. Chronos is excellent at zero-shot pattern recognition but
agnostic to financial-specific signals like mean reversion, autocorrelation,
and trend persistence. Three simple baselines covering those regimes,
combined with Chronos, often beats Chronos alone on volatile equities.

Members:
  * **chronos** — foundation model, neutral
  * **momentum** — extrapolates the last N-day log return (trend persists)
  * **mean_reversion** — pulls back toward EMA50 (overextended → reverts)
  * **martingale** — flat forecast equal to last close (worst-case baseline,
    keeps the ensemble honest — if it can't beat "no change" you have a problem)

Combination: simple unweighted average of price-level forecasts. Could be
upgraded to inverse-MAE weighting once calibration data accumulates.
"""
from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional

from . import chronos as chronos_mod

logger = logging.getLogger(__name__)


def forecast(
    closes: List[float],
    horizons: tuple[int, ...] = chronos_mod.DEFAULT_HORIZONS,
) -> Optional[Dict[str, Any]]:
    """Return an ensemble forecast + each member separately.

    Output shape:
      {
        "ensemble": {  # combined forecast
          "horizons": {
            "1":  {median, p10, p90, expected_return_pct, band_pct, ...},
            "5":  {...},
            "21": {...},
          },
        },
        "members": {
          "chronos": {horizons: {...}},
          "momentum": {...},
          "mean_reversion": {...},
          "martingale": {...},
        },
        "agreement": {  # 0..1 score per horizon — high means members agree
          "1": float, "5": float, "21": float
        }
      }
    """
    if len(closes) < 65:
        return None

    last_close = float(closes[-1])

    # Run all member models.
    chronos_fc = chronos_mod.forecast_multi(closes, horizons=horizons)
    momentum_fc = _momentum_forecast(closes, horizons)
    mr_fc = _mean_reversion_forecast(closes, horizons)
    martingale_fc = _martingale_forecast(last_close, horizons)

    members: Dict[str, Dict[str, Any]] = {}
    if chronos_fc:
        members["chronos"] = {"horizons": chronos_fc["horizons"], "model": chronos_fc.get("model")}
    if momentum_fc:
        members["momentum"] = {"horizons": momentum_fc}
    if mr_fc:
        members["mean_reversion"] = {"horizons": mr_fc}
    if martingale_fc:
        members["martingale"] = {"horizons": martingale_fc}

    if not members:
        return None

    # Combine — equal-weight average of price paths at each horizon.
    ensemble_horizons: Dict[str, Dict[str, Any]] = {}
    agreement: Dict[str, float] = {}
    for h in horizons:
        key = str(h)
        member_paths = []
        for name, m in members.items():
            mh = m["horizons"].get(key)
            if mh is None:
                continue
            member_paths.append((name, mh))

        if not member_paths:
            continue

        # Average price paths point-by-point.
        path_len = min(len(mh["median"]) for _, mh in member_paths)
        avg_med = [
            sum(mh["median"][i] for _, mh in member_paths) / len(member_paths)
            for i in range(path_len)
        ]
        # Band width: take the widest p10/p90 across members for conservatism —
        # if any model thinks the range is wide, the ensemble respects that.
        avg_p10 = [
            min(mh["p10"][i] for _, mh in member_paths)
            for i in range(path_len)
        ]
        avg_p90 = [
            max(mh["p90"][i] for _, mh in member_paths)
            for i in range(path_len)
        ]

        terminal_med = avg_med[-1] if avg_med else last_close
        expected_return = (terminal_med - last_close) / last_close * 100 if last_close else 0.0
        band = ((avg_p90[-1] - avg_p10[-1]) / last_close * 100) if (avg_p10 and avg_p90 and last_close) else 0.0

        # Agreement: 1 - normalized std of terminal expected returns across members.
        # When all members agree on direction/magnitude, agreement is high.
        terminal_returns = [
            (mh["median"][-1] - last_close) / last_close
            for _, mh in member_paths
            if len(mh["median"]) >= 1
        ]
        if len(terminal_returns) >= 2:
            mean = sum(terminal_returns) / len(terminal_returns)
            var = sum((r - mean) ** 2 for r in terminal_returns) / len(terminal_returns)
            std = math.sqrt(var)
            # Normalize: a 1% std across members means low agreement at 1d, high at 21d.
            # Use horizon-scaled threshold.
            threshold = 0.005 * math.sqrt(h)  # ≈ 0.5% per sqrt(day)
            agreement[key] = round(max(0.0, 1.0 - std / max(threshold, 1e-6)), 3)
            agreement[key] = min(1.0, agreement[key])
        else:
            agreement[key] = 1.0

        ensemble_horizons[key] = {
            "horizon": h,
            "median": [round(v, 4) for v in avg_med],
            "p10": [round(v, 4) for v in avg_p10],
            "p90": [round(v, 4) for v in avg_p90],
            "expected_return_pct": round(expected_return, 2),
            "band_pct": round(band, 2),
            "members_used": [name for name, _ in member_paths],
        }

    return {
        "last_close": last_close,
        "ensemble": {"horizons": ensemble_horizons},
        "members": members,
        "agreement": agreement,
    }


# ─── Baseline models ───────────────────────────────────────────────────────────

def _momentum_forecast(closes: List[float], horizons: tuple[int, ...]) -> Dict[str, Dict[str, Any]]:
    """Linear-momentum baseline: extrapolate the recent N-day mean log return.

    Captures "trends persist". Strongest when the underlying has been in a
    clean trend; weak in chop. Bands come from realized volatility of recent
    returns — wider bands when the recent series is noisy.
    """
    if len(closes) < 21:
        return {}
    last_close = float(closes[-1])

    # Mean and std of recent 20 log returns.
    rets = []
    for i in range(max(1, len(closes) - 20), len(closes)):
        if closes[i - 1] > 0 and closes[i] > 0:
            rets.append(math.log(closes[i] / closes[i - 1]))
    if not rets:
        return {}
    mu = sum(rets) / len(rets)
    var = sum((r - mu) ** 2 for r in rets) / max(len(rets) - 1, 1)
    sigma = math.sqrt(var)

    out: Dict[str, Dict[str, Any]] = {}
    for h in horizons:
        # Walk forward: each step adds mu to log-price, with sqrt(h) widening band.
        med_path = []
        p10_path = []
        p90_path = []
        cum_log = math.log(last_close)
        for step in range(1, h + 1):
            cum_log_med = math.log(last_close) + mu * step
            band = sigma * math.sqrt(step) * 1.2816  # 80% interval (10/90)
            med_path.append(math.exp(cum_log_med))
            p10_path.append(math.exp(cum_log_med - band))
            p90_path.append(math.exp(cum_log_med + band))

        terminal_med = med_path[-1]
        expected_return = (terminal_med - last_close) / last_close * 100
        band_pct = ((p90_path[-1] - p10_path[-1]) / last_close * 100)
        out[str(h)] = {
            "horizon": h,
            "median": [round(v, 4) for v in med_path],
            "p10": [round(v, 4) for v in p10_path],
            "p90": [round(v, 4) for v in p90_path],
            "expected_return_pct": round(expected_return, 2),
            "band_pct": round(band_pct, 2),
        }
    return out


def _mean_reversion_forecast(closes: List[float], horizons: tuple[int, ...]) -> Dict[str, Dict[str, Any]]:
    """Mean-reversion baseline: pulls price back toward EMA50 with exponential
    decay. Captures "overextended price reverts to recent average".

    Half-life ~ 10 trading days — calibrated to typical equity mean-reversion
    timescales. Stronger pull when price is far from EMA50.
    """
    if len(closes) < 50:
        return {}
    last_close = float(closes[-1])
    ema50 = _ema(closes, 50)
    if ema50 <= 0:
        return {}

    # Distance from EMA in log space.
    log_gap = math.log(last_close / ema50)

    # Realized vol for band.
    rets = []
    for i in range(max(1, len(closes) - 30), len(closes)):
        if closes[i - 1] > 0 and closes[i] > 0:
            rets.append(math.log(closes[i] / closes[i - 1]))
    if not rets:
        return {}
    mu = sum(rets) / len(rets)
    var = sum((r - mu) ** 2 for r in rets) / max(len(rets) - 1, 1)
    sigma = math.sqrt(var)

    # Half-life 10 days → decay factor exp(-ln2/10) per step.
    decay = math.exp(-math.log(2) / 10)

    out: Dict[str, Dict[str, Any]] = {}
    for h in horizons:
        med_path = []
        p10_path = []
        p90_path = []
        for step in range(1, h + 1):
            # Log-gap shrinks by `decay**step`; target log price approaches log(ema50).
            remaining_gap = log_gap * (decay ** step)
            cum_log_med = math.log(ema50) + remaining_gap
            band = sigma * math.sqrt(step) * 1.2816
            med_path.append(math.exp(cum_log_med))
            p10_path.append(math.exp(cum_log_med - band))
            p90_path.append(math.exp(cum_log_med + band))

        terminal_med = med_path[-1]
        expected_return = (terminal_med - last_close) / last_close * 100
        band_pct = ((p90_path[-1] - p10_path[-1]) / last_close * 100)
        out[str(h)] = {
            "horizon": h,
            "median": [round(v, 4) for v in med_path],
            "p10": [round(v, 4) for v in p10_path],
            "p90": [round(v, 4) for v in p90_path],
            "expected_return_pct": round(expected_return, 2),
            "band_pct": round(band_pct, 2),
        }
    return out


def _martingale_forecast(last_close: float, horizons: tuple[int, ...]) -> Dict[str, Dict[str, Any]]:
    """Martingale ("no information") baseline: best-guess is current price.

    Bands widen with sqrt(time) at a generic 1% daily vol. Used as a honest
    floor: if Chronos can't beat this on calibration, that's a red flag.
    """
    if last_close <= 0:
        return {}
    daily_vol = 0.01  # generic placeholder; could be replaced with RV30
    out: Dict[str, Dict[str, Any]] = {}
    for h in horizons:
        med_path = [last_close] * h
        band_path = [daily_vol * math.sqrt(step) * 1.2816 for step in range(1, h + 1)]
        p10_path = [last_close * math.exp(-b) for b in band_path]
        p90_path = [last_close * math.exp(b) for b in band_path]
        out[str(h)] = {
            "horizon": h,
            "median": [round(v, 4) for v in med_path],
            "p10": [round(v, 4) for v in p10_path],
            "p90": [round(v, 4) for v in p90_path],
            "expected_return_pct": 0.0,
            "band_pct": round(((p90_path[-1] - p10_path[-1]) / last_close * 100), 2),
        }
    return out


def _ema(series: List[float], period: int) -> float:
    if len(series) < period:
        return series[-1] if series else 0.0
    k = 2 / (period + 1)
    ema = series[0]
    for v in series[1:]:
        ema = v * k + ema * (1 - k)
    return ema
