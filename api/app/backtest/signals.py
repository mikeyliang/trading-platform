"""
Confluence signal engine — scores each bar on independent evidence lines and
emits entries/exits. Shared by the NautilusTrader backtest and the live bot,
so backtest results describe exactly what the bot would do.

Score components (long side; short side mirrors):
  structure  — CHoCH/BOS trend is up (struct_trend == 1)        [gate + 1pt]
  trend      — EMA fast > slow and close > trend EMA            [1pt]
  macd       — histogram positive or rising 2 bars              [1pt]
  smi        — SMI above its signal line, not overbought        [1pt]
  rsi        — RSI in bullish regime (>50) but not stretched    [1pt]
  stoch      — %K over %D, curling up from below 80             [1pt]
  vwap       — close above session VWAP                         [1pt]

Entry when score >= min_score (default 5 incl. the structure gate).
Exits are managed by the strategy (ATR stop / R-target / CHoCH flip).
"""
from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from . import indicators as ind

DEFAULT_PARAMS = {
    "min_score": 5,
    "allow_short": False,
    "atr_stop_mult": 2.0,
    "rr_target": 2.0,          # take-profit at rr_target * stop distance
    "risk_pct": 0.01,          # risk 1% of equity per trade
    "max_position_pct": 0.95,  # never deploy more than this fraction of equity
    "rsi_max_long": 72.0,      # don't chase stretched moves
    "rsi_min_short": 28.0,
    "smi_ob": 55.0,
    "smi_os": -55.0,
    # indicator params consumed by indicators.compute_all
    "ema_fast": 9, "ema_slow": 21, "ema_trend": 50,
    "rsi_period": 14, "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
    "stoch_k": 14, "stoch_smooth": 3, "stoch_d": 3,
    "smi_period": 13, "smi_smooth1": 25, "smi_smooth2": 2, "smi_signal": 9,
    "atr_period": 14, "swing_left": 5, "swing_right": 5,
    # higher-timeframe gate: only take longs when yesterday's completed daily
    # EMA(htf_fast) > EMA(htf_slow). 0 disables.
    "htf_fast": 0, "htf_slow": 0,
    # regime gates (see regime.py): block entries when prior-day VIX close
    # exceeds vix_gate_max (0 disables) / when the symbol's sector is losing
    # relative strength vs SPY.
    "vix_gate_max": 0.0, "sector_gate": False,
    # exits: trail_atr_mult > 0 switches from fixed R-target to a chandelier
    # trailing stop; signal_exit False disables structure/score-flip exits.
    "trail_atr_mult": 0.0, "signal_exit": True,
    # trade management: breakeven_r ratchets the stop to entry once the move
    # reaches that many R; partial_tp_r banks half the position at that R.
    "breakeven_r": 0.0, "partial_tp_r": 0.0,
    # risk throttle: trade dd_throttle_mult x size while account drawdown
    # from its high-water mark exceeds dd_throttle_at (0 disables).
    "dd_throttle_at": 0.0, "dd_throttle_mult": 0.5,
}


def htf_uptrend_mask(df: pd.DataFrame, fast: int, slow: int,
                     htf_tf: str = "1D") -> pd.Series:
    """Higher-timeframe EMA(fast) > EMA(slow), shifted one HTF bar so lower
    bars only see *completed* HTF values (no lookahead). htf_tf is any pandas
    resample rule — "1D" daily, "4h", "1h"…"""
    htf_close = df["close"].resample(htf_tf).last().dropna()
    ema_f = htf_close.ewm(span=fast, adjust=False).mean()
    ema_s = htf_close.ewm(span=slow, adjust=False).mean()
    up = (ema_f > ema_s).shift(1).fillna(False)
    return up.reindex(df.index, method="ffill").fillna(False).astype(bool)

COMPONENTS = ["structure", "trend", "macd", "smi", "rsi", "stoch", "vwap"]


def compute_signal_frame(df: pd.DataFrame, params: Optional[dict] = None) -> pd.DataFrame:
    """Indicator frame + per-bar long/short scores + entry/exit triggers.

    All inputs are causal (see indicators module) — row i uses only data
    through bar i, so iterating the frame in order has no lookahead.
    """
    p = {**DEFAULT_PARAMS, **(params or {})}
    f = ind.compute_all(df, p)

    up = f["struct_trend"] == 1
    dn = f["struct_trend"] == -1

    hist = f["macd_hist"]
    macd_rising = (hist > hist.shift(1)) & (hist.shift(1) > hist.shift(2))
    macd_falling = (hist < hist.shift(1)) & (hist.shift(1) < hist.shift(2))

    long_pts = pd.DataFrame({
        "structure": up,
        "trend": (f["ema_fast"] > f["ema_slow"]) & (f["close"] > f["ema_trend"]),
        "macd": (hist > 0) | macd_rising,
        "smi": (f["smi"] > f["smi_signal"]) & (f["smi"] < p["smi_ob"]),
        "rsi": (f["rsi"] > 50) & (f["rsi"] < p["rsi_max_long"]),
        "stoch": (f["stoch_k"] > f["stoch_d"]) & (f["stoch_k"] < 80),
        "vwap": f["close"] > f["vwap"],
    }).astype(int)

    short_pts = pd.DataFrame({
        "structure": dn,
        "trend": (f["ema_fast"] < f["ema_slow"]) & (f["close"] < f["ema_trend"]),
        "macd": (hist < 0) | macd_falling,
        "smi": (f["smi"] < f["smi_signal"]) & (f["smi"] > p["smi_os"]),
        "rsi": (f["rsi"] < 50) & (f["rsi"] > p["rsi_min_short"]),
        "stoch": (f["stoch_k"] < f["stoch_d"]) & (f["stoch_k"] > 20),
        "vwap": f["close"] < f["vwap"],
    }).astype(int)

    f["long_score"] = long_pts.sum(axis=1)
    f["short_score"] = short_pts.sum(axis=1)
    for c in COMPONENTS:
        f[f"long_{c}"] = long_pts[c]
        f[f"short_{c}"] = short_pts[c]

    min_score = p["min_score"]
    # entry trigger: score crosses the bar (avoid re-firing every bar of a streak)
    long_ok = (f["long_score"] >= min_score) & up
    short_ok = (f["short_score"] >= min_score) & dn
    if p.get("htf_fast") and p.get("htf_slow"):
        htf_up = htf_uptrend_mask(df, int(p["htf_fast"]), int(p["htf_slow"]),
                                  str(p.get("htf_tf", "1D")))
        long_ok = long_ok & htf_up
        short_ok = short_ok & ~htf_up
    f["enter_long"] = long_ok & ~long_ok.shift(1, fill_value=False)
    f["enter_short"] = short_ok & ~short_ok.shift(1, fill_value=False) if p["allow_short"] else False

    # exit pressure: structure flips or score collapses
    f["exit_long"] = (f["choch"] == -1) | (f["long_score"] <= 2)
    f["exit_short"] = (f["choch"] == 1) | (f["short_score"] <= 2)
    return f


def signal_reasons(row: pd.Series, side: str = "long") -> list[str]:
    """Human-readable components that fired on this bar (for UI/AI analyst)."""
    return [c for c in COMPONENTS if row.get(f"{side}_{c}", 0) == 1]
