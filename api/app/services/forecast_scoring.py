"""Score elapsed forecasts against realised closes.

The forecast ensemble logs every prediction to ``forecast_log`` (see
``forecast/calibration.py``). Those rows sit unscored until their horizon
elapses and something fills in the actual return. This module is that
something: it fetches the realised daily close near each forecast's target
date and hands it to ``calibration.score_outstanding``.

Wired into the scheduler (daily) and exposed via a manual trigger endpoint so
the track-record surface can be backfilled on demand.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Optional

from ..forecast import calibration
from ..nautilus import ib_options

logger = logging.getLogger(__name__)

# Small in-process cache so scoring a batch of forecasts on the same symbol
# only hits IBKR once per symbol per run.
_bar_cache: dict[str, list[dict]] = {}


async def _fetch_close(symbol: str, target_date: date) -> Optional[float]:
    """Daily close on/around ``target_date``.

    Pulls enough daily bars to span from the target date to now and returns
    the close of the trading day nearest the target (forecasts target a
    calendar date that may land on a weekend/holiday). Returns None if IBKR
    has no bars for the name.
    """
    bars = _bar_cache.get(symbol)
    if bars is None:
        try:
            from datetime import datetime, timezone

            days_back = (datetime.now(timezone.utc).date() - target_date).days + 7
            days_back = max(days_back, 10)
            bars = await ib_options.get_bars(symbol, "1d", days_back)
        except Exception as e:  # noqa: BLE001
            logger.warning("forecast scoring: get_bars %s failed: %s", symbol, e)
            bars = []
        _bar_cache[symbol] = bars
    if not bars:
        return None

    target_ts = _to_epoch(target_date)
    best = min(bars, key=lambda b: abs(int(b.get("time", 0)) - target_ts))
    # Reject matches more than ~5 days off the target — that means we don't
    # actually have data covering the horizon, so the score would be garbage.
    if abs(int(best.get("time", 0)) - target_ts) > 5 * 86400:
        return None
    close = best.get("close")
    return float(close) if close else None


def _to_epoch(d: date) -> int:
    from datetime import datetime

    return int(datetime(d.year, d.month, d.day).timestamp())


async def run_scoring(max_rows: int = 500) -> int:
    """Score every forecast whose horizon has elapsed. Returns rows scored."""
    _bar_cache.clear()
    try:
        scored = await calibration.score_outstanding(_fetch_close, max_rows=max_rows)
    finally:
        _bar_cache.clear()
    if scored:
        logger.info("forecast scoring: scored %d forecast(s)", scored)
    return scored
