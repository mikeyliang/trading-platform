"""Scan history endpoints — the dashboard's window onto persisted picker
results. Used to hydrate the picker on first load and to power the
/trade/history view.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query

from ..services import scan_store

router = APIRouter(prefix="/api/scans", tags=["scans"])


@router.get("/latest")
async def latest(symbol: Optional[str] = Query(None)):
    """Most recent stored scan, optionally filtered by underlying."""
    snap = await scan_store.latest_scan(symbol)
    return snap if snap else {"id": None, "ran_at": None, "payload": None}


@router.get("/history")
async def history(
    limit: int = Query(30, ge=1, le=200),
    symbol: Optional[str] = Query(None),
    trade_type: Optional[str] = Query(None, description="rut | mars | marsmax | space"),
):
    """Recent scans, newest first."""
    rows = await scan_store.recent_scans(limit=limit, symbol=symbol, trade_type=trade_type)
    return {"scans": rows, "count": len(rows)}
