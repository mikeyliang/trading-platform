"""Backfill intraday bar history from the IBKR gateway into the parquet
archive that ``backtest.data.get_bars`` serves.

yfinance caps 15m history at ~59 days; IBKR serves years (subject to the
account's data subscriptions and the gateway's HMDS farm being healthy).
Bars are fetched in chunks (IB limits duration per request by bar size),
paced under IB's historical-data limits (~60 requests / 10 min), and merged
into the same per-symbol parquet files — so every consumer (sims, bot,
charts) transparently sees the extended archive.

Run ad hoc:
    docker exec -i trading-api python3 -m app.backtest.ib_history TQQQ SOXL \
        --interval 15m --years 2.5
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

import pandas as pd

from .data import _cache_path, BARS_DIR

logger = logging.getLogger(__name__)

_BAR_SIZE = {"1m": "1 min", "5m": "5 mins", "15m": "15 mins",
             "30m": "30 mins", "1h": "1 hour", "1d": "1 day"}
# duration per request — conservative chunks IB accepts for each bar size;
# fall back down the list on error 321 (invalid duration).
_CHUNKS = {"1m": ["1 D"], "5m": ["1 W"], "15m": ["1 M", "2 W", "1 W"],
           "30m": ["1 M", "2 W"], "1h": ["1 M"], "1d": ["1 Y"]}
_PACE_SECONDS = 11  # ~5.5 req/min keeps well under 60 req / 10 min


def _bars_to_df(bars) -> pd.DataFrame:
    rows = [{"time": pd.Timestamp(b.date), "open": float(b.open),
             "high": float(b.high), "low": float(b.low),
             "close": float(b.close), "volume": float(b.volume)} for b in bars]
    df = pd.DataFrame(rows).set_index("time").sort_index()
    if df.index.tz is None:
        df.index = df.index.tz_localize(timezone.utc)
    else:
        df.index = df.index.tz_convert(timezone.utc)
    return df


def _merge_into_archive(symbol: str, interval: str, df: pd.DataFrame) -> int:
    path = _cache_path(symbol, interval)
    BARS_DIR.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            old = pd.read_parquet(path)
            df = pd.concat([old, df])
            df = df[~df.index.duplicated(keep="last")].sort_index()
        except Exception:
            logger.exception("%s %s: existing archive unreadable — replacing", symbol, interval)
    df.to_parquet(path)
    return len(df)


async def backfill_symbol(ib, symbol: str, interval: str, years: float) -> dict:
    from ib_async import Stock

    contract = Stock(symbol.upper(), "SMART", "USD")
    await ib.qualifyContractsAsync(contract)
    target = datetime.now(timezone.utc) - timedelta(days=int(years * 365.25))
    end: Optional[datetime] = None  # None = now
    chunks = list(_CHUNKS[interval])
    frames: list[pd.DataFrame] = []
    requests = 0
    while True:
        end_str = end.strftime("%Y%m%d-%H:%M:%S") if end else ""
        try:
            bars = await asyncio.wait_for(ib.reqHistoricalDataAsync(
                contract, endDateTime=end_str, durationStr=chunks[0],
                barSizeSetting=_BAR_SIZE[interval], whatToShow="TRADES",
                useRTH=True, formatDate=2), timeout=120)
        except Exception as e:
            if len(chunks) > 1:  # maybe the duration is too big for this bar size
                logger.warning("%s: chunk %s failed (%s) — trying %s",
                               symbol, chunks[0], e, chunks[1])
                chunks.pop(0)
                continue
            logger.warning("%s: chunk fetch failed at %s: %s", symbol, end, e)
            break
        requests += 1
        if not bars:
            break  # reached the start of available history
        df = _bars_to_df(bars)
        frames.append(df)
        first = df.index[0].to_pydatetime()
        logger.info("%s %s: %d bars %s -> %s (req %d)", symbol, interval,
                    len(df), df.index[0], df.index[-1], requests)
        if first <= target or (end is not None and first >= end):
            break
        end = first - timedelta(minutes=1)
        await asyncio.sleep(_PACE_SECONDS)
    if not frames:
        return {"symbol": symbol, "bars": 0, "requests": requests}
    merged = pd.concat(frames)
    merged = merged[~merged.index.duplicated(keep="last")].sort_index()
    total = _merge_into_archive(symbol, interval, merged)
    return {"symbol": symbol, "bars": len(merged), "archive_total": total,
            "from": str(merged.index[0]), "to": str(merged.index[-1]),
            "requests": requests}


async def backfill(symbols: Iterable[str], interval: str = "15m",
                   years: float = 2.5, host: str = "ib-gateway",
                   port: int = 4003, client_id: int = 91) -> list[dict]:
    from ib_async import IB

    ib = IB()
    await ib.connectAsync(host, port, clientId=client_id, timeout=30)
    results = []
    try:
        for sym in symbols:
            try:
                results.append(await backfill_symbol(ib, sym, interval, years))
            except Exception as e:
                logger.exception("backfill %s failed", sym)
                results.append({"symbol": sym, "error": str(e)})
            await asyncio.sleep(_PACE_SECONDS)
    finally:
        ib.disconnect()
    return results


if __name__ == "__main__":
    import argparse
    import json

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="+")
    ap.add_argument("--interval", default="15m", choices=list(_BAR_SIZE))
    ap.add_argument("--years", type=float, default=2.5)
    ap.add_argument("--client-id", type=int, default=91)
    args = ap.parse_args()
    out = asyncio.run(backfill(args.symbols, args.interval, args.years,
                               client_id=args.client_id))
    print(json.dumps(out, indent=1))
