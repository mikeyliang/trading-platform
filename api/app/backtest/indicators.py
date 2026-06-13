"""
Vectorized indicator library shared by the backtester and the live bot.

All functions take/return pandas Series/DataFrames aligned to the input index.
Conventions: df has columns open/high/low/close/volume with a UTC DatetimeIndex.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import numpy as np
import pandas as pd


# ── basic smoothers ──────────────────────────────────────────────────

def ema(s: pd.Series, period: int) -> pd.Series:
    return s.ewm(span=period, adjust=False).mean()


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False).mean()


# ── momentum ─────────────────────────────────────────────────────────

def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.fillna(50.0)


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal)
    return pd.DataFrame({"macd": line, "signal": sig, "hist": line - sig})


def stochastic(df: pd.DataFrame, k_period: int = 14, k_smooth: int = 3, d_period: int = 3) -> pd.DataFrame:
    ll = df["low"].rolling(k_period, min_periods=1).min()
    hh = df["high"].rolling(k_period, min_periods=1).max()
    raw_k = 100 * (df["close"] - ll) / (hh - ll).replace(0, np.nan)
    k = raw_k.rolling(k_smooth, min_periods=1).mean()
    d = k.rolling(d_period, min_periods=1).mean()
    return pd.DataFrame({"k": k.fillna(50.0), "d": d.fillna(50.0)})


def smi(df: pd.DataFrame, period: int = 13, smooth1: int = 25, smooth2: int = 2,
        signal: int = 9) -> pd.DataFrame:
    """Stochastic Momentum Index: double-EMA-smoothed close-vs-range-midpoint.
    Range roughly -100..+100; overbought > 40, oversold < -40."""
    hh = df["high"].rolling(period, min_periods=1).max()
    ll = df["low"].rolling(period, min_periods=1).min()
    m = df["close"] - (hh + ll) / 2.0
    d = (hh - ll) / 2.0
    m_s = ema(ema(m, smooth1), smooth2)
    d_s = ema(ema(d, smooth1), smooth2)
    val = 100 * m_s / d_s.replace(0, np.nan)
    val = val.fillna(0.0)
    return pd.DataFrame({"smi": val, "signal": ema(val, signal)})


# ── volume ───────────────────────────────────────────────────────────

def vwap(df: pd.DataFrame) -> pd.Series:
    """Session-anchored VWAP for intraday data; anchored to the full range
    when bars are daily (one bar per session)."""
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    pv = tp * df["volume"]
    if _is_intraday(df.index):
        # anchor per US-Eastern trading day so the session reset lands at the open
        days = df.index.tz_convert("America/New_York").date
        grouped_pv = pd.Series(pv.values, index=df.index).groupby(days).cumsum()
        grouped_v = df["volume"].groupby(days).cumsum()
        out = grouped_pv / grouped_v.replace(0, np.nan)
    else:
        out = pv.cumsum() / df["volume"].cumsum().replace(0, np.nan)
    return out.ffill().fillna(df["close"])


def _is_intraday(index: pd.DatetimeIndex) -> bool:
    if len(index) < 3:
        return False
    median_step = pd.Series(index[1:] - index[:-1]).median()
    return median_step < pd.Timedelta(hours=23)


@dataclass
class VolumeProfile:
    bins: List[float]          # price level of each bin (lower edge)
    volumes: List[float]       # volume in each bin
    poc: float                 # point of control (highest-volume price)
    vah: float                 # value area high (70% volume)
    val: float                 # value area low


def volume_profile(df: pd.DataFrame, num_bins: int = 40) -> VolumeProfile:
    """Histogram of traded volume by price; volume of each bar is spread
    uniformly across its high-low range."""
    lo, hi = float(df["low"].min()), float(df["high"].max())
    if hi <= lo:
        hi = lo + 1e-6
    edges = np.linspace(lo, hi, num_bins + 1)
    vols = np.zeros(num_bins)
    bar_lo = df["low"].values
    bar_hi = np.maximum(df["high"].values, bar_lo + 1e-12)
    bar_v = df["volume"].values.astype(float)
    for i in range(num_bins):
        b_lo, b_hi = edges[i], edges[i + 1]
        overlap = np.clip(np.minimum(bar_hi, b_hi) - np.maximum(bar_lo, b_lo), 0, None)
        vols[i] = float(np.sum(bar_v * overlap / (bar_hi - bar_lo)))

    poc_i = int(np.argmax(vols))
    total = vols.sum()
    # expand around POC until 70% of volume is inside
    lo_i = hi_i = poc_i
    acc = vols[poc_i]
    while acc < 0.70 * total and (lo_i > 0 or hi_i < num_bins - 1):
        next_lo = vols[lo_i - 1] if lo_i > 0 else -1
        next_hi = vols[hi_i + 1] if hi_i < num_bins - 1 else -1
        if next_hi >= next_lo:
            hi_i += 1; acc += max(next_hi, 0)
        else:
            lo_i -= 1; acc += max(next_lo, 0)
    mid = (edges[:-1] + edges[1:]) / 2
    return VolumeProfile(
        bins=[round(float(x), 4) for x in edges[:-1]],
        volumes=[round(float(v), 2) for v in vols],
        poc=round(float(mid[poc_i]), 4),
        vah=round(float(edges[hi_i + 1]), 4),
        val=round(float(edges[lo_i]), 4),
    )


# ── market structure (CHoCH / BOS) ───────────────────────────────────

def swing_pivots(df: pd.DataFrame, left: int = 5, right: int = 5) -> pd.DataFrame:
    """Mark confirmed swing highs/lows (fractal pivots). A pivot at bar i is
    only *confirmed* `right` bars later — consumers must use `confirm_idx`
    to avoid lookahead."""
    high, low = df["high"].values, df["low"].values
    n = len(df)
    rows = []
    for i in range(left, n - right):
        win_h = high[i - left: i + right + 1]
        win_l = low[i - left: i + right + 1]
        if high[i] >= win_h.max():
            rows.append({"idx": i, "confirm_idx": i + right, "kind": "H", "price": float(high[i])})
        elif low[i] <= win_l.min():
            rows.append({"idx": i, "confirm_idx": i + right, "kind": "L", "price": float(low[i])})
    return pd.DataFrame(rows, columns=["idx", "confirm_idx", "kind", "price"])


def market_structure(df: pd.DataFrame, left: int = 5, right: int = 5) -> pd.DataFrame:
    """Walk confirmed pivots into a structure-event series.

    Events (stamped at the bar where the close breaks the level — no lookahead):
      BOS_UP / BOS_DOWN     — break of structure continuing the trend
      CHOCH_UP / CHOCH_DOWN — change of character (first break against trend)

    Returns DataFrame[idx, time, event, level, trend_after].
    """
    pivots = swing_pivots(df, left, right)
    close = df["close"].values
    n = len(df)
    events = []
    last_high: Optional[float] = None
    last_low: Optional[float] = None
    pending: list = pivots.to_dict("records")
    pi = 0
    trend = 0  # 1 up, -1 down, 0 unknown

    for i in range(n):
        # activate pivots confirmed by this bar
        while pi < len(pending) and pending[pi]["confirm_idx"] <= i:
            p = pending[pi]
            if p["kind"] == "H":
                last_high = p["price"]
            else:
                last_low = p["price"]
            pi += 1

        if last_high is not None and close[i] > last_high:
            event = "BOS_UP" if trend >= 0 else "CHOCH_UP"
            events.append({"idx": i, "event": event, "level": last_high, "trend_after": 1})
            trend = 1
            last_high = None  # consumed
        elif last_low is not None and close[i] < last_low:
            event = "BOS_DOWN" if trend <= 0 else "CHOCH_DOWN"
            events.append({"idx": i, "event": event, "level": last_low, "trend_after": -1})
            trend = -1
            last_low = None

    out = pd.DataFrame(events, columns=["idx", "event", "level", "trend_after"])
    if len(out):
        out["time"] = df.index[out["idx"].values]
    return out


# ── composite frame ──────────────────────────────────────────────────

def compute_all(df: pd.DataFrame, p: Optional[dict] = None) -> pd.DataFrame:
    """One frame with every indicator the strategy/UI needs, NaN-safe."""
    p = p or {}
    out = df.copy()
    out["ema_fast"] = ema(df["close"], p.get("ema_fast", 9))
    out["ema_slow"] = ema(df["close"], p.get("ema_slow", 21))
    out["ema_trend"] = ema(df["close"], p.get("ema_trend", 50))
    out["rsi"] = rsi(df["close"], p.get("rsi_period", 14))
    m = macd(df["close"], p.get("macd_fast", 12), p.get("macd_slow", 26), p.get("macd_signal", 9))
    out["macd"], out["macd_signal"], out["macd_hist"] = m["macd"], m["signal"], m["hist"]
    st = stochastic(df, p.get("stoch_k", 14), p.get("stoch_smooth", 3), p.get("stoch_d", 3))
    out["stoch_k"], out["stoch_d"] = st["k"], st["d"]
    sm = smi(df, p.get("smi_period", 13), p.get("smi_smooth1", 25),
             p.get("smi_smooth2", 2), p.get("smi_signal", 9))
    out["smi"], out["smi_signal"] = sm["smi"], sm["signal"]
    out["vwap"] = vwap(df)
    out["atr"] = atr(df, p.get("atr_period", 14))

    # structure trend as a per-bar series (ffill of last event's trend)
    ms = market_structure(df, p.get("swing_left", 5), p.get("swing_right", 5))
    trend = pd.Series(np.nan, index=df.index)
    choch = pd.Series(0, index=df.index)  # +1 CHOCH_UP, -1 CHOCH_DOWN at event bar
    bos = pd.Series(0, index=df.index)
    for _, ev in ms.iterrows():
        t = df.index[int(ev["idx"])]
        trend.loc[t] = ev["trend_after"]
        if ev["event"].startswith("CHOCH"):
            choch.loc[t] = 1 if ev["event"] == "CHOCH_UP" else -1
        else:
            bos.loc[t] = 1 if ev["event"] == "BOS_UP" else -1
    out["struct_trend"] = trend.ffill().fillna(0)
    out["choch"] = choch
    out["bos"] = bos
    return out
