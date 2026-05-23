"""Endpoints for the exit monitor + monthly pre-flight."""
from __future__ import annotations

from fastapi import APIRouter

from ..services import monitor, preflight, scheduler

router = APIRouter(prefix="/api/monitor", tags=["monitor"])


@router.get("/state")
def monitor_state():
    """Current exit-monitor snapshot for every open spread."""
    return monitor.state.snapshot()


@router.post("/refresh")
async def monitor_refresh():
    """Force an immediate refresh of the exit-monitor state."""
    return await monitor.refresh()


@router.get("/preflight")
def preflight_state():
    """Latest 3rd-Friday pre-flight scan (cached). Empty if it hasn't run."""
    snap = preflight.snapshot()
    return snap if snap else {"ran_at": None, "scan": None}


@router.post("/preflight/run")
async def preflight_run():
    """Force the pre-flight scan to run now (manual trigger)."""
    return await preflight.run(scope="manual")


@router.get("/jobs")
def scheduled_jobs():
    """List scheduled jobs and their next run times — useful for the UI footer."""
    return {"jobs": scheduler.jobs_snapshot()}
