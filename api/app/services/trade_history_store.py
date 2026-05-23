"""CRUD for the generic trade-history log.

Records every executed order (manual, agent-placed, or backfilled) with
P&L for attribution and dashboards. Soft-delete via ``is_deleted`` so the
audit trail stays intact even after a row is hidden from the UI.
"""
from __future__ import annotations

import json
import logging
import math
from datetime import datetime
from typing import Any, Dict, List, Optional

from . import db

logger = logging.getLogger(__name__)


_NUMERIC_COLS = ("quantity", "price", "pnl", "pnl_percentage")


async def create_trade(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Insert a trade row. Returns the persisted row, or None if the DB
    is unavailable / insert failed."""
    pool = db.pool()
    if pool is None:
        return None
    side = payload.get("side")
    if isinstance(side, str):
        side = side.strip().lower()
    metadata = payload.get("metadata_") or payload.get("metadata")
    cols = [
        "timestamp", "symbol", "side", "quantity", "price", "order_type",
        "status", "pnl", "pnl_percentage", "strategy", "agent_id", "metadata_",
    ]
    vals = [
        payload.get("timestamp"),
        payload.get("symbol"),
        side,
        payload.get("quantity"),
        payload.get("price"),
        payload.get("order_type"),
        payload.get("status"),
        payload.get("pnl"),
        payload.get("pnl_percentage"),
        payload.get("strategy"),
        payload.get("agent_id"),
        json.dumps(metadata) if metadata is not None else None,
    ]
    placeholders = []
    for i, c in enumerate(cols, start=1):
        placeholders.append(f"${i}::jsonb" if c == "metadata_" else f"${i}")
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                f"INSERT INTO trade_history ({','.join(cols)}) "
                f"VALUES ({','.join(placeholders)}) RETURNING *",
                *vals,
            )
            return _row_to_dict(row) if row else None
    except Exception as e:  # noqa: BLE001
        logger.warning("create_trade failed: %s", e)
        return None


async def list_trades(
    symbol: Optional[str] = None,
    status: Optional[str] = None,
    side: Optional[str] = None,
    strategy: Optional[str] = None,
    agent_id: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    page: int = 1,
    page_size: int = 50,
) -> Dict[str, Any]:
    """Paginated, filtered trade list. Hides soft-deleted rows. Returns
    ``{trades, total, page, page_size, total_pages}`` so the caller can
    populate ``TradeHistoryListResponse`` directly."""
    page = max(1, page)
    page_size = max(1, min(500, page_size))
    empty = {"trades": [], "total": 0, "page": page,
             "page_size": page_size, "total_pages": 0}
    pool = db.pool()
    if pool is None:
        return empty
    clauses = ["is_deleted = FALSE"]
    args: list[Any] = []
    if symbol:
        args.append(symbol.strip().upper())
        clauses.append(f"symbol = ${len(args)}")
    if status:
        args.append(status)
        clauses.append(f"status = ${len(args)}")
    if side:
        args.append(side.strip().lower())
        clauses.append(f"side = ${len(args)}")
    if strategy:
        args.append(strategy)
        clauses.append(f"strategy = ${len(args)}")
    if agent_id:
        args.append(agent_id)
        clauses.append(f"agent_id = ${len(args)}")
    if start is not None:
        args.append(start)
        clauses.append(f"timestamp >= ${len(args)}")
    if end is not None:
        args.append(end)
        clauses.append(f"timestamp <= ${len(args)}")
    where = f"WHERE {' AND '.join(clauses)}"
    try:
        async with pool.acquire() as conn:
            total = int(await conn.fetchval(
                f"SELECT COUNT(*) FROM trade_history {where}", *args,
            ))
            if total == 0:
                return {**empty, "total": 0, "total_pages": 0}
            args_page = [*args, page_size, (page - 1) * page_size]
            rows = await conn.fetch(
                f"SELECT * FROM trade_history {where} "
                f"ORDER BY timestamp DESC, id DESC "
                f"LIMIT ${len(args_page) - 1} OFFSET ${len(args_page)}",
                *args_page,
            )
            return {
                "trades": [_row_to_dict(r) for r in rows],
                "total": total,
                "page": page,
                "page_size": page_size,
                "total_pages": math.ceil(total / page_size),
            }
    except Exception as e:  # noqa: BLE001
        logger.warning("list_trades failed: %s", e)
        return empty


async def get_trade(trade_id: int) -> Optional[Dict[str, Any]]:
    """Single row by id (ignores soft-deleted)."""
    pool = db.pool()
    if pool is None:
        return None
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM trade_history WHERE id = $1 AND is_deleted = FALSE",
                trade_id,
            )
            return _row_to_dict(row) if row else None
    except Exception as e:  # noqa: BLE001
        logger.warning("get_trade failed: %s", e)
        return None


async def get_trade_stats(
    symbol: Optional[str] = None,
    strategy: Optional[str] = None,
    agent_id: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Aggregate P&L stats over the (optionally filtered) trade set.

    Stats consider only rows with a non-null ``pnl`` so open / un-settled
    trades don't drag the average toward zero."""
    empty = {
        "total_trades": 0, "winning_trades": 0, "losing_trades": 0,
        "win_rate": 0.0, "total_pnl": 0.0, "avg_pnl": 0.0, "profit_factor": 0.0,
    }
    pool = db.pool()
    if pool is None:
        return empty
    clauses = ["is_deleted = FALSE"]
    args: list[Any] = []
    if symbol:
        args.append(symbol.strip().upper())
        clauses.append(f"symbol = ${len(args)}")
    if strategy:
        args.append(strategy)
        clauses.append(f"strategy = ${len(args)}")
    if agent_id:
        args.append(agent_id)
        clauses.append(f"agent_id = ${len(args)}")
    if start is not None:
        args.append(start)
        clauses.append(f"timestamp >= ${len(args)}")
    if end is not None:
        args.append(end)
        clauses.append(f"timestamp <= ${len(args)}")
    where = f"WHERE {' AND '.join(clauses)}"
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(f"""
                SELECT
                  COUNT(*) FILTER (WHERE pnl IS NOT NULL)            AS total_trades,
                  COUNT(*) FILTER (WHERE pnl > 0)                    AS winning_trades,
                  COUNT(*) FILTER (WHERE pnl < 0)                    AS losing_trades,
                  COALESCE(SUM(pnl), 0)                              AS total_pnl,
                  COALESCE(SUM(pnl) FILTER (WHERE pnl > 0), 0)       AS gross_profit,
                  COALESCE(SUM(pnl) FILTER (WHERE pnl < 0), 0)       AS gross_loss
                FROM trade_history {where}
            """, *args)
            total = int(row["total_trades"])
            wins = int(row["winning_trades"])
            losses = int(row["losing_trades"])
            total_pnl = float(row["total_pnl"])
            gross_profit = float(row["gross_profit"])
            gross_loss = float(row["gross_loss"])
            win_rate = (wins / total) if total else 0.0
            avg_pnl = (total_pnl / total) if total else 0.0
            profit_factor = (gross_profit / abs(gross_loss)) if gross_loss < 0 else 0.0
            return {
                "total_trades": total,
                "winning_trades": wins,
                "losing_trades": losses,
                "win_rate": win_rate,
                "total_pnl": total_pnl,
                "avg_pnl": avg_pnl,
                "profit_factor": profit_factor,
            }
    except Exception as e:  # noqa: BLE001
        logger.warning("get_trade_stats failed: %s", e)
        return empty


async def update_trade(
    trade_id: int,
    updates: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Patch a subset of mutable fields. Supports pnl, pnl_percentage,
    status, metadata_. Returns the updated row, or None on miss."""
    pool = db.pool()
    if pool is None:
        return None
    allowed = {"pnl", "pnl_percentage", "status", "metadata_"}
    norm: Dict[str, Any] = {}
    for k, v in updates.items():
        key = "metadata_" if k == "metadata" else k
        if key in allowed:
            norm[key] = v
    if not norm:
        return await get_trade(trade_id)
    sets: list[str] = []
    args: list[Any] = []
    for key, val in norm.items():
        if key == "metadata_":
            args.append(json.dumps(val) if val is not None else None)
            sets.append(f"metadata_ = ${len(args)}::jsonb")
        else:
            args.append(val)
            sets.append(f"{key} = ${len(args)}")
    args.append(trade_id)
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                f"UPDATE trade_history SET {', '.join(sets)} "
                f"WHERE id = ${len(args)} AND is_deleted = FALSE RETURNING *",
                *args,
            )
            return _row_to_dict(row) if row else None
    except Exception as e:  # noqa: BLE001
        logger.warning("update_trade failed: %s", e)
        return None


async def delete_trade(trade_id: int) -> bool:
    """Soft-delete: flips ``is_deleted`` so the row disappears from list
    views but stays in the audit trail. Idempotent — re-deleting returns
    False because the WHERE excludes already-deleted rows."""
    pool = db.pool()
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            result = await conn.execute(
                "UPDATE trade_history SET is_deleted = TRUE "
                "WHERE id = $1 AND is_deleted = FALSE",
                trade_id,
            )
            return result.endswith(" 1")
    except Exception as e:  # noqa: BLE001
        logger.warning("delete_trade failed: %s", e)
        return False


def _row_to_dict(row: Any) -> Dict[str, Any]:
    d = dict(row)
    ts = d.get("timestamp")
    if isinstance(ts, datetime):
        d["timestamp"] = ts.isoformat()
    for k in _NUMERIC_COLS:
        if d.get(k) is not None:
            d[k] = float(d[k])
    meta = d.get("metadata_")
    if isinstance(meta, str):
        try:
            d["metadata_"] = json.loads(meta)
        except (TypeError, ValueError):
            pass
    return d
