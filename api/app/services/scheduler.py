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

from . import monitor, preflight, scan_store
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
    scheduler.start()
    logger.info(
        "scheduler started: exit-monitor (5min RTH), opportunity-scan (09:30 ET), preflight (3rd Fri 09:05 ET)"
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
