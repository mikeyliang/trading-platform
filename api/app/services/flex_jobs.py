"""In-memory job registry for long-running Flex backfills.

The Flex backfill endpoint can take 1–2 minutes for a 5-year sweep (each
365d slice triggers a fresh IBKR report build + poll). Holding the HTTP
connection open that long is fragile — any client-side proxy / browser
tab close / network hiccup loses the result. So callers can opt into a
background path: POST returns a job id immediately, the actual sweep
runs in a detached asyncio task, and the UI polls a status endpoint.

State lives in a process-local dict. Restarts wipe it — that's an
acceptable trade-off because the underlying writes are idempotent
(dedup on ``(source, external_id)``), so a lost result just means
re-running the backfill, not data loss.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Hard cap so a slow-leak doesn't grow the dict unboundedly across many
# manual triggers. We keep the most recent N and drop the rest LRU-style.
_MAX_JOBS = 20

JobStatus = str  # "running" | "done" | "failed" | "cancelled"


@dataclass
class FlexJob:
    id: str
    status: JobStatus = "running"
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: Optional[datetime] = None
    slice_count: int = 0
    current_slice: int = 0
    last_slice_info: Optional[Dict[str, Any]] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    refresh: bool = False
    years_back: int = 1
    # The task is mutable + not part of the public payload; underscored so
    # the dataclass dict serializer (if any) skips it. We track it so we
    # could implement cancellation later.
    _task: Optional[asyncio.Task] = None

    def report_progress(
        self,
        *,
        current_slice: int,
        slice_info: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.current_slice = current_slice
        if slice_info is not None:
            self.last_slice_info = slice_info

    def to_public(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "slice_count": self.slice_count,
            "current_slice": self.current_slice,
            "last_slice_info": self.last_slice_info,
            "result": self.result,
            "error": self.error,
            "refresh": self.refresh,
            "years_back": self.years_back,
        }


_jobs: Dict[str, FlexJob] = {}


def create_job(*, slice_count: int, refresh: bool, years_back: int) -> FlexJob:
    """Allocate a job slot. Caller is responsible for spawning the worker
    task and calling ``attach_task`` so cancellation can be wired later."""
    job = FlexJob(
        id=uuid.uuid4().hex[:12],
        slice_count=slice_count,
        refresh=refresh,
        years_back=years_back,
    )
    _jobs[job.id] = job
    _prune()
    return job


def get_job(job_id: str) -> Optional[FlexJob]:
    return _jobs.get(job_id)


def list_jobs(limit: int = 10) -> List[Dict[str, Any]]:
    """Newest first, capped at ``limit``."""
    ordered = sorted(_jobs.values(), key=lambda j: j.started_at, reverse=True)
    return [j.to_public() for j in ordered[:limit]]


def attach_task(job: FlexJob, task: asyncio.Task) -> None:
    job._task = task


def mark_done(job: FlexJob, result: Dict[str, Any]) -> None:
    job.status = "done"
    job.result = result
    job.finished_at = datetime.now(timezone.utc)


def mark_failed(job: FlexJob, error: str) -> None:
    job.status = "failed"
    job.error = error
    job.finished_at = datetime.now(timezone.utc)


def _prune() -> None:
    if len(_jobs) <= _MAX_JOBS:
        return
    ordered = sorted(_jobs.values(), key=lambda j: j.started_at)
    keep = set(j.id for j in ordered[-_MAX_JOBS:])
    for job_id in list(_jobs.keys()):
        if job_id not in keep:
            _jobs.pop(job_id, None)
