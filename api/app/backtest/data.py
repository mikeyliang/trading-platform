"""
Historical bar data for backtests — real OHLCV via yfinance, parquet-cached.

yfinance interval limits (approx):
  1m: 7d back   | 5m/15m/30m: 60d back | 1h: 730d back | 1d: full history
4h isn't a native yfinance interval — we fetch 1h and resample.

Cache layout: /app/data/bars/{SYMBOL}_{interval}.parquet (one file per
symbol+interval, refreshed when stale or when the requested range extends
past what's cached).
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

BARS_DIR = Path(os.environ.get("BARS_DIR", "/app/data/bars"))

# Max lookback yfinance allows per interval (conservative).
_INTERVAL_LIMIT_DAYS = {
    "1m": 7, "5m": 59, "15m": 59, "30m": 59,
    "1h": 729, "4h": 729, "1d": 365 * 30,
}
# Cache freshness: refetch if the cache file is older than this.
_CACHE_TTL = timedelta(hours=12)

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def _cache_path(symbol: str, interval: str) -> Path:
    return BARS_DIR / f"{symbol.upper()}_{interval}.parquet"


def _fetch_yf(symbol: str, interval: str, start: datetime, end: datetime) -> pd.DataFrame:
    import yfinance as yf

    yf_interval = "1h" if interval == "4h" else interval
    df = yf.Ticker(symbol).history(
        start=start.strftime("%Y-%m-%d"),
        end=(end + timedelta(days=1)).strftime("%Y-%m-%d"),
        interval=yf_interval,
        auto_adjust=True,
    )
    if df.empty:
        return df
    df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
    df.index = pd.to_datetime(df.index, utc=True)
    df.index.name = "time"
    # drop zero-volume half-bars yfinance sometimes emits at session open
    df = df[~((df["volume"] == 0) & (df["high"] == df["low"]))]
    if interval == "4h":
        df = (
            df.resample("4h", origin="start_day")
            .agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
            .dropna(subset=["open"])
        )
    return df


def get_bars(
    symbol: str,
    interval: str,
    start: datetime,
    end: Optional[datetime] = None,
    fresh: bool = False,
) -> pd.DataFrame:
    """Return OHLCV DataFrame (UTC index: time; cols open/high/low/close/volume).

    Clamps `start` to the interval's yfinance lookback limit. Raises
    ValueError when no data is available for the request.
    """
    symbol = symbol.upper()
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    end = end or datetime.now(timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    limit_days = _INTERVAL_LIMIT_DAYS.get(interval)
    if limit_days is None:
        raise ValueError(f"unsupported interval: {interval}")
    earliest = datetime.now(timezone.utc) - timedelta(days=limit_days)
    clamped_start = max(start, earliest)
    if clamped_start > start:
        logger.info("%s %s: start clamped %s -> %s (yfinance lookback limit)",
                    symbol, interval, start.date(), clamped_start.date())

    path = _cache_path(symbol, interval)
    with _lock_for(f"{symbol}_{interval}"):
        df = None
        if path.exists() and not fresh:
            try:
                df = pd.read_parquet(path)
                age = datetime.now(timezone.utc) - datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
                covers = (
                    len(df) > 0
                    and df.index[0] <= clamped_start + timedelta(days=5)
                    and (df.index[-1] >= end - timedelta(days=1) or age < _CACHE_TTL)
                )
                if not covers:
                    df = None
            except Exception:  # corrupt cache — refetch
                df = None

        if df is None:
            try:
                fetched = _fetch_yf(symbol, interval, clamped_start, end)
            except Exception:
                fetched = pd.DataFrame()
            if fetched.empty:
                # fetch failed (rate limit / outage) — serve stale cache if any
                if path.exists():
                    try:
                        df = pd.read_parquet(path)
                        logger.warning("%s %s: fetch failed, serving stale cache (%d bars)",
                                       symbol, interval, len(df))
                    except Exception:
                        df = None
                if df is None:
                    raise ValueError(f"no {interval} data for {symbol} in requested range")
            else:
                # merge with any existing cache so a short fresh fetch never
                # truncates a longer cached history
                if path.exists():
                    try:
                        old = pd.read_parquet(path)
                        fetched = pd.concat([old, fetched])
                        fetched = fetched[~fetched.index.duplicated(keep="last")].sort_index()
                    except Exception:
                        pass
                BARS_DIR.mkdir(parents=True, exist_ok=True)
                fetched.to_parquet(path)
                df = fetched
                logger.info("%s %s: fetched %d bars (%s → %s)", symbol, interval,
                            len(df), df.index[0], df.index[-1])

    # serve from the FULL accumulated cache, not the provider-clamped window —
    # the parquet archive grows past the yfinance lookback limit over time
    # (merge-on-fetch above), so old bars beyond the cap stay usable.
    out = df[(df.index >= start) & (df.index <= end)]
    if out.empty:
        raise ValueError(f"no {interval} bars for {symbol} between {start.date()} and {end.date()}")
    if start < clamped_start and out.index[0] > clamped_start - timedelta(days=2):
        logger.warning("%s %s: requested from %s but archive only reaches %s "
                       "(provider cap %dd; archive accumulates going forward)",
                       symbol, interval, start.date(), out.index[0].date(), limit_days)
    return out
