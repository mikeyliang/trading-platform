"""CRUD for the OKW-style trade tracker.

Manual entry today; can be wired to a real-trade flow later. Persists
Jamal's full Options Kelly Workbook column set so the user can later
backtest / audit / report against their actual placed trades.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from . import db

logger = logging.getLogger(__name__)


async def create_trade(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    pool = db.pool()
    if pool is None:
        return None
    cols = [
        "symbol", "trade_type", "side", "expiry", "dte",
        "short_strike", "long_strike", "width", "contracts", "credit",
        "spot_at_open", "short_delta", "aroc_pct", "kelly_pct",
        "adj_distance_pct", "fib_floor1", "fib_floor2", "notes",
    ]
    vals = [payload.get(c) for c in cols]
    placeholders = ",".join(f"${i+1}" for i in range(len(cols)))
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                f"INSERT INTO okw_trades ({','.join(cols)}) VALUES ({placeholders}) RETURNING *",
                *vals,
            )
            return _row_to_dict(row) if row else None
    except Exception as e:  # noqa: BLE001
        logger.warning("create_trade failed: %s", e)
        return None


async def list_trades(
    status: Optional[str] = None,
    trade_type: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    pool = db.pool()
    if pool is None:
        return []
    clauses = []
    args: list[Any] = []
    if status:
        args.append(status)
        clauses.append(f"status = ${len(args)}")
    if trade_type:
        args.append(trade_type)
        clauses.append(f"trade_type = ${len(args)}")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    args.append(limit)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                f"SELECT * FROM okw_trades {where} ORDER BY placed_at DESC LIMIT ${len(args)}",
                *args,
            )
            return [_row_to_dict(r) for r in rows]
    except Exception as e:  # noqa: BLE001
        logger.warning("list_trades failed: %s", e)
        return []


async def close_trade(
    trade_id: int,
    exit_reason: str,
    realized_pnl: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    pool = db.pool()
    if pool is None:
        return None
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE okw_trades
                SET status = 'closed',
                    closed_at = NOW(),
                    exit_reason = $2,
                    realized_pnl = $3
                WHERE id = $1
                RETURNING *
                """,
                trade_id, exit_reason, realized_pnl,
            )
            return _row_to_dict(row) if row else None
    except Exception as e:  # noqa: BLE001
        logger.warning("close_trade failed: %s", e)
        return None


async def delete_trade(trade_id: int) -> bool:
    pool = db.pool()
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            row = await conn.execute("DELETE FROM okw_trades WHERE id = $1", trade_id)
            return row.endswith("1")
    except Exception as e:  # noqa: BLE001
        logger.warning("delete_trade failed: %s", e)
        return False


async def summary() -> Dict[str, Any]:
    """Aggregate stats — total trades, wins/losses, AROC realized vs target."""
    pool = db.pool()
    if pool is None:
        return {"total": 0, "open": 0, "closed": 0, "expired": 0,
                "wins": 0, "losses": 0, "realized_pnl": 0.0}
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow("""
                SELECT
                  COUNT(*)                                          AS total,
                  COUNT(*) FILTER (WHERE status = 'open')           AS open,
                  COUNT(*) FILTER (WHERE status = 'closed')         AS closed,
                  COUNT(*) FILTER (WHERE status = 'expired')        AS expired,
                  COUNT(*) FILTER (WHERE realized_pnl > 0)          AS wins,
                  COUNT(*) FILTER (WHERE realized_pnl < 0)          AS losses,
                  COALESCE(SUM(realized_pnl), 0)                    AS realized_pnl
                FROM okw_trades
            """)
            return {k: (float(v) if k == "realized_pnl" else int(v)) for k, v in dict(row).items()}
    except Exception as e:  # noqa: BLE001
        logger.warning("summary failed: %s", e)
        return {"total": 0, "open": 0, "closed": 0, "expired": 0,
                "wins": 0, "losses": 0, "realized_pnl": 0.0}


def _row_to_dict(row: Any) -> Dict[str, Any]:
    d = dict(row)
    for k in ("placed_at", "closed_at"):
        v = d.get(k)
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    for k in ("short_strike", "long_strike", "width", "credit", "spot_at_open",
              "short_delta", "aroc_pct", "kelly_pct", "adj_distance_pct",
              "fib_floor1", "fib_floor2", "realized_pnl"):
        if d.get(k) is not None:
            d[k] = float(d[k])
    return d
