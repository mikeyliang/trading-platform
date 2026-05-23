"""Persistence for spread-scan results.

Every time the discovery pipeline runs a scan (manual via picker, scheduled
preflight, or the daily opportunity-scan job) we drop the full payload here.
The dashboard queries ``recent_scans`` for the history view and
``latest_scan`` to hydrate the picker without re-running the scan.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from . import db

logger = logging.getLogger(__name__)


async def save_scan(
    scope: str,
    symbol: str,
    payload: Dict[str, Any],
) -> Optional[int]:
    """Persist a scan payload. Returns the row id, or None if the DB is
    unavailable (we don't fail the user-facing scan in that case)."""
    pool = db.pool()
    if pool is None:
        return None
    recommendation = None
    rec = payload.get("recommendation") if isinstance(payload, dict) else None
    if rec and isinstance(rec, dict):
        recommendation = rec.get("trade_type")
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO scans (scope, symbol, recommendation, payload)
                VALUES ($1, $2, $3, $4::jsonb)
                RETURNING id
                """,
                scope, symbol, recommendation, json.dumps(payload),
            )
            return int(row["id"]) if row else None
    except Exception as e:  # noqa: BLE001
        logger.warning("save_scan failed: %s", e)
        return None


async def latest_scan(symbol: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Most-recent persisted scan, optionally filtered by underlying."""
    pool = db.pool()
    if pool is None:
        return None
    try:
        async with pool.acquire() as conn:
            if symbol:
                row = await conn.fetchrow(
                    "SELECT id, ran_at, scope, symbol, recommendation, payload "
                    "FROM scans WHERE symbol = $1 ORDER BY ran_at DESC LIMIT 1",
                    symbol.upper(),
                )
            else:
                row = await conn.fetchrow(
                    "SELECT id, ran_at, scope, symbol, recommendation, payload "
                    "FROM scans ORDER BY ran_at DESC LIMIT 1"
                )
            return _row_to_dict(row) if row else None
    except Exception as e:  # noqa: BLE001
        logger.warning("latest_scan failed: %s", e)
        return None


async def recent_scans(
    limit: int = 30,
    symbol: Optional[str] = None,
    trade_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Recent scans (newest first). ``trade_type`` filters by recommendation."""
    pool = db.pool()
    if pool is None:
        return []
    try:
        async with pool.acquire() as conn:
            clauses = []
            args: list[Any] = []
            if symbol:
                args.append(symbol.upper())
                clauses.append(f"symbol = ${len(args)}")
            if trade_type:
                args.append(trade_type)
                clauses.append(f"recommendation = ${len(args)}")
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
            args.append(limit)
            rows = await conn.fetch(
                f"SELECT id, ran_at, scope, symbol, recommendation, payload "
                f"FROM scans {where} ORDER BY ran_at DESC LIMIT ${len(args)}",
                *args,
            )
            return [_row_to_dict(r) for r in rows]
    except Exception as e:  # noqa: BLE001
        logger.warning("recent_scans failed: %s", e)
        return []


def _row_to_dict(row: Any) -> Dict[str, Any]:
    return {
        "id": int(row["id"]),
        "ran_at": _iso(row["ran_at"]),
        "scope": row["scope"],
        "symbol": row["symbol"],
        "recommendation": row["recommendation"],
        "payload": json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"],
    }


def _iso(dt: datetime) -> str:
    return dt.isoformat() if dt else ""
