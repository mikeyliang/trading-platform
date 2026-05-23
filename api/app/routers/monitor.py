"""Endpoints for the exit monitor + monthly pre-flight."""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from ..services import monitor, preflight, scheduler

router = APIRouter(prefix="/api/monitor", tags=["monitor"])


@router.get(
    "/state",
    summary="Exit-monitor snapshot",
    description="Current exit-monitor state for every open spread.",
    responses={
        200: {
            "content": {
                "application/json": {
                    "example": {
                        "as_of": "2026-05-23T14:32:11Z",
                        "spreads": [
                            {"id": "spx-2026-05-29-3950p", "delta": 0.14, "rule": "delta", "exit_now": False},
                        ],
                    }
                }
            }
        }
    },
)
def monitor_state() -> Dict[str, Any]:
    return monitor.state.snapshot()


@router.post(
    "/refresh",
    summary="Force the exit-monitor to re-evaluate now",
    description=(
        "Trigger a full refresh of the exit-monitor state. Returns the same shape as "
        "``GET /api/monitor/state`` once the refresh completes."
    ),
    responses={
        200: {
            "content": {
                "application/json": {
                    "example": {"as_of": "2026-05-23T14:32:11Z", "spreads": []}
                }
            }
        }
    },
)
async def monitor_refresh() -> Dict[str, Any]:
    return await monitor.refresh()


@router.get(
    "/preflight",
    summary="Last pre-flight snapshot",
    description="Latest 3rd-Friday pre-flight scan (cached). Empty if it hasn't run.",
)
def preflight_state() -> Dict[str, Any]:
    snap = preflight.snapshot()
    return snap if snap else {"ran_at": None, "scan": None}


@router.post(
    "/preflight/run",
    summary="Force a pre-flight scan now",
    description="Manual trigger; useful when you want to re-evaluate outside the monthly cron.",
)
async def preflight_run() -> Dict[str, Any]:
    return await preflight.run(scope="manual")


@router.get(
    "/jobs",
    summary="List scheduled jobs",
    description="Rendered in the dashboard footer so the user can see what's about to run.",
    responses={
        200: {
            "content": {
                "application/json": {
                    "example": {"jobs": [{"id": "preflight", "next_run": "2026-06-19T13:00:00Z"}]}
                }
            }
        }
    },
)
def scheduled_jobs() -> Dict[str, Any]:
    return {"jobs": scheduler.jobs_snapshot()}
