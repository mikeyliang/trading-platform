"""Market-regime gates layered on top of the confluence entry signals.

Three regime inputs (all daily, all shifted one day so intraday bars only
ever see *completed* values — no lookahead):

  VIX gate     — block new entries while the prior day's VIX close is above
                 `vix_gate_max` (0 disables). General market fear.
  Sector gate  — block longs while the symbol's sector proxy ETF is losing
                 relative strength vs SPY (prior-day 20d RS change <= 0).
                 For broad-market symbols (proxy SPY) absolute 20d momentum
                 is used instead. `sector_gate` toggles.
  HTF bias     — daily EMA(htf_fast) > EMA(htf_slow), already implemented in
                 signals.htf_uptrend_mask via the htf_fast/htf_slow params.

Shared by the NautilusTrader backtest and the live bot so simulated results
describe exactly what the bot would do.
"""
from __future__ import annotations

import logging
from typing import Optional

import pandas as pd

from .data import get_bars

logger = logging.getLogger(__name__)

RS_LOOKBACK_DAYS = 20  # sector relative-strength momentum window

# symbol -> sector/industry proxy ETF whose relative strength vs SPY gates
# entries. SPY itself = broad market -> absolute momentum. Unmapped symbols
# pass the sector gate (no opinion).
SECTOR_PROXY = {
    # leveraged index/sector ETFs
    "TQQQ": "QQQ", "QLD": "QQQ", "SQQQ": "QQQ",
    "SPXL": "SPY", "UPRO": "SPY", "SSO": "SPY",
    "SOXL": "SOXX", "SOXS": "SOXX",
    "TECL": "XLK", "TECS": "XLK",
    "NVDL": "SMH", "TSLL": "XLY",
    # single names
    "AAPL": "XLK", "MSFT": "XLK", "PLTR": "XLK", "ORCL": "XLK", "CRM": "XLK",
    "NVDA": "SMH", "AMD": "SMH", "AVGO": "SMH", "INTC": "SMH", "MU": "SMH", "TSM": "SMH",
    "GOOGL": "XLC", "META": "XLC", "NFLX": "XLC",
    "AMZN": "XLY", "TSLA": "XLY",
    "JPM": "XLF", "GS": "XLF", "BAC": "XLF",
    "XOM": "XLE", "CVX": "XLE",
    "UNH": "XLV", "LLY": "XLV",
}


def _align(daily: pd.Series, index: pd.DatetimeIndex) -> pd.Series:
    """Forward-fill a daily series onto an intraday index, handling tz."""
    if daily.index.tz is None and index.tz is not None:
        daily = daily.tz_localize(index.tz)
    elif daily.index.tz is not None and index.tz is not None:
        daily = daily.tz_convert(index.tz)
    elif daily.index.tz is not None and index.tz is None:
        daily = daily.tz_localize(None)
    return daily.reindex(index, method="ffill")


def _daily_closes(symbol: str, index: pd.DatetimeIndex, pad_days: int) -> pd.Series:
    start = (index[0] - pd.Timedelta(days=pad_days)).to_pydatetime()
    end = (index[-1] + pd.Timedelta(days=1)).to_pydatetime()
    return get_bars(symbol, "1d", start, end)["close"]


def vix_mask(index: pd.DatetimeIndex, max_level: float) -> pd.Series:
    """True while the prior day's VIX close is at or below `max_level`."""
    vix = _daily_closes("^VIX", index, pad_days=15)
    ok = (vix <= max_level).shift(1)  # completed days only
    return _align(ok, index).fillna(True).astype(bool)


def sector_rs_mask(symbol: str, index: pd.DatetimeIndex,
                   lookback: int = RS_LOOKBACK_DAYS) -> pd.Series:
    """True while the symbol's sector is holding/gaining strength vs SPY."""
    proxy = SECTOR_PROXY.get(symbol.upper())
    if proxy is None:
        return pd.Series(True, index=index)
    sec = _daily_closes(proxy, index, pad_days=lookback * 3 + 15)
    if proxy == "SPY":
        rs = sec  # broad market: absolute momentum
    else:
        spy = _daily_closes("SPY", index, pad_days=lookback * 3 + 15)
        rs = sec / spy.reindex(sec.index, method="ffill")
    ok = (rs.pct_change(lookback) > 0).shift(1)  # completed days only
    return _align(ok, index).fillna(True).astype(bool)


def apply_regime_gates(frame: pd.DataFrame, symbol: str, p: dict) -> pd.DataFrame:
    """AND the enabled regime gates into enter_long/enter_short.

    Adds a `regime_ok` column when any gate is active. A gate whose data
    fetch fails is skipped (logged) — trade the technicals rather than halt.
    """
    mask: Optional[pd.Series] = None
    vmax = float(p.get("vix_gate_max", 0) or 0)
    if vmax > 0:
        try:
            m = vix_mask(frame.index, vmax)
            mask = m if mask is None else (mask & m)
        except Exception:
            logger.exception("VIX gate unavailable — skipping")
    if bool(p.get("sector_gate", False)):
        try:
            m = sector_rs_mask(symbol, frame.index)
            mask = m if mask is None else (mask & m)
        except Exception:
            logger.exception("sector gate unavailable — skipping")
    if mask is None:
        return frame
    frame = frame.copy()
    frame["regime_ok"] = mask
    frame["enter_long"] = frame["enter_long"] & mask
    if "enter_short" in frame.columns:
        frame["enter_short"] = frame["enter_short"] & mask
    return frame
