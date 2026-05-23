"""Monthly pre-flight — runs once on the 3rd Friday morning.

Auto-executes the picker scan for RUT + SPX so the user walks into a
ready-made shortlist on the monthly trade day. Result is cached in
process and surfaced by ``GET /api/monitor/preflight``.

The scheduler triggers ``run()`` at 09:05 ET on the 3rd Friday; the
endpoint can also call it on demand.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from . import scan_store
from .spread_finder import scan

logger = logging.getLogger(__name__)


@dataclass
class PreflightResult:
    ran_at: str
    scope: str                       # "scheduled" | "manual"
    scan: Optional[Dict[str, Any]] = None  # full picker scan payload
    note: Optional[str] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ran_at": self.ran_at,
            "scope": self.scope,
            "scan": self.scan,
            "note": self.note,
            "error": self.error,
        }


last_result: Optional[PreflightResult] = None


async def run(scope: str = "manual") -> Dict[str, Any]:
    """Run a pre-flight pass. Currently: scan RUT+SPX picker. Returns dict."""
    global last_result
    try:
        scan_payload = await scan(symbol="ALL", side="put", max_per_type=5)
        last_result = PreflightResult(
            ran_at=datetime.now(timezone.utc).isoformat(),
            scope=scope,
            scan=scan_payload,
            note="3rd-Friday pre-flight scan complete.",
        )
        await scan_store.save_scan(
            scope=f"preflight-{scope}", symbol="ALL", payload=scan_payload,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("preflight failed: %s", e)
        last_result = PreflightResult(
            ran_at=datetime.now(timezone.utc).isoformat(),
            scope=scope,
            error=str(e),
        )
    return last_result.to_dict()


def snapshot() -> Optional[Dict[str, Any]]:
    return last_result.to_dict() if last_result else None
