"""APScheduler wiring for the API.

Two jobs:
  * ``exit-monitor``  — every 5 min during US RTH on weekdays, refresh
                        the exit-delta state for every open spread.
  * ``preflight``     — 09:05 ET on the 3rd Friday of each month, run the
                        picker scan + cache the result.

Lightweight: AsyncIOScheduler runs in the same event loop as FastAPI, no
external process, no database. Jobs are idempotent and safe to retry.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from . import forecast_scoring, monitor, position_analysis, preflight, scan_store
from .spread_finder import scan as run_spread_scan

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler(timezone="US/Eastern")


async def _exit_monitor_job():
    snap = await monitor.refresh()
    if snap.get("triggered"):
        logger.warning("exit monitor: %d spread(s) at trigger", snap["triggered"])


async def _preflight_job():
    today = datetime.now(timezone.utc).date()
    # APScheduler's "day_of_week='fri'" + "day='15-21'" already gates this to
    # the 3rd Friday, so this guard is belt-and-suspenders.
    if not (15 <= today.day <= 21 and today.weekday() == 4):
        return
    logger.info("monthly pre-flight firing for %s", today)
    await preflight.run(scope="scheduled")


async def _forecast_scoring_job():
    """Daily — score forecasts whose horizon has elapsed against the realised
    close. Turns the ``forecast_log`` audit trail into a real track record so
    the Insights surface can show "is the model actually any good?"."""
    try:
        scored = await forecast_scoring.run_scoring()
        if scored:
            logger.info("forecast scoring: %d forecast(s) scored", scored)
    except Exception as e:  # noqa: BLE001
        logger.exception("forecast scoring failed: %s", e)


async def _position_analysis_job():
    """Daily — run the AI agent pipeline on every open option position and
    store the verdict, so the Insights timeline accumulates a running record
    of how the agents read each holding over time."""
    try:
        summary = await position_analysis.analyze_open_positions()
        logger.info("position analysis job: %s", summary)
    except Exception as e:  # noqa: BLE001
        logger.exception("position analysis job failed: %s", e)


async def _bar_archive_job():
    """Daily after the close — roll every cached bar parquet forward.

    yfinance only serves ~59d of 15m/30m/5m history, but the cache merges
    fetches instead of replacing (backtest.data), so refreshing daily grows an
    intraday archive past the provider cap — the only way to ever backtest
    intraday strategies on >2 months of data without paid feeds."""
    import asyncio
    from datetime import timedelta

    from ..backtest.data import BARS_DIR, _INTERVAL_LIMIT_DAYS, get_bars

    refreshed = 0
    for path in sorted(BARS_DIR.glob("*.parquet")):
        try:
            symbol, interval = path.stem.rsplit("_", 1)
        except ValueError:
            continue
        limit = _INTERVAL_LIMIT_DAYS.get(interval)
        if limit is None:
            continue
        start = datetime.now(timezone.utc) - timedelta(days=min(limit, 30))
        try:
            await asyncio.to_thread(get_bars, symbol, interval, start, None, True)
            refreshed += 1
        except Exception as e:  # noqa: BLE001
            logger.warning("bar archive refresh %s %s failed: %s", symbol, interval, e)
        await asyncio.sleep(2)  # stay under yfinance burst limits
    logger.info("bar archive job: refreshed %d parquet(s)", refreshed)


async def _opportunity_scan_job():
    """Daily morning scan — fills the picker's "latest cached scan" so the
    user can open the page and immediately see today's setups without
    waiting on a cold IBKR chain hydration."""
    logger.info("daily opportunity scan firing")
    try:
        payload = await run_spread_scan(symbol="ALL", side="put", max_per_type=5)
        await scan_store.save_scan(scope="scheduled-daily", symbol="ALL", payload=payload)
    except Exception as e:  # noqa: BLE001
        logger.exception("opportunity scan failed: %s", e)


def start():
    if scheduler.running:
        return
    scheduler.add_job(
        _exit_monitor_job,
        CronTrigger(day_of_week="mon-fri", hour="9-16", minute="*/5",
                    timezone="US/Eastern"),
        id="exit-monitor",
        replace_existing=True,
        max_instances=1,
    )
    scheduler.add_job(
        _preflight_job,
        CronTrigger(day_of_week="fri", day="15-21", hour=9, minute=5,
                    timezone="US/Eastern"),
        id="preflight",
        replace_existing=True,
        max_instances=1,
    )
    scheduler.add_job(
        _opportunity_scan_job,
        CronTrigger(day_of_week="mon-fri", hour=9, minute=30,
                    timezone="US/Eastern"),
        id="opportunity-scan",
        replace_existing=True,
        max_instances=1,
    )
    scheduler.add_job(
        _position_analysis_job,
        # 16:15 ET weekdays — just after the cash close, when marks are fresh.
        CronTrigger(day_of_week="mon-fri", hour=16, minute=15,
                    timezone="US/Eastern"),
        id="position-analysis",
        replace_existing=True,
        max_instances=1,
    )
    scheduler.add_job(
        _bar_archive_job,
        # 18:00 ET daily (incl. weekends — catches missed weekday runs).
        CronTrigger(hour=18, minute=0, timezone="US/Eastern"),
        id="bar-archive",
        replace_existing=True,
        max_instances=1,
    )
    scheduler.add_job(
        _forecast_scoring_job,
        # 17:30 ET on weekdays — after the cash close so the day's bar is final.
        CronTrigger(day_of_week="mon-fri", hour=17, minute=30,
                    timezone="US/Eastern"),
        id="forecast-scoring",
        replace_existing=True,
        max_instances=1,
    )
    scheduler.start()
    logger.info(
        "scheduler started: exit-monitor (5min RTH), opportunity-scan (09:30 ET), "
        "position-analysis (16:15 ET), forecast-scoring (17:30 ET), "
        "preflight (3rd Fri 09:05 ET)"
    )


async def shutdown():
    if scheduler.running:
        scheduler.shutdown(wait=False)


def jobs_snapshot() -> list[dict]:
    out = []
    for job in scheduler.get_jobs():
        out.append({
            "id": job.id,
            "next_run_time": job.next_run_time.isoformat() if job.next_run_time else None,
            "trigger": str(job.trigger),
        })
    return out
