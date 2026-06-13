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


async def bulk_insert_trades(payloads: List[Dict[str, Any]]) -> int:
    """Insert many trade rows in a single transaction. Returns the number
    of rows inserted, or 0 if the DB is unavailable / the batch failed
    (the transaction is rolled back, so partial inserts can't happen)."""
    if not payloads:
        return 0
    pool = db.pool()
    if pool is None:
        return 0
    cols = [
        "timestamp", "symbol", "side", "quantity", "price", "order_type",
        "status", "pnl", "pnl_percentage", "strategy", "agent_id", "metadata_",
    ]
    placeholders = [
        f"${i}::jsonb" if c == "metadata_" else f"${i}"
        for i, c in enumerate(cols, start=1)
    ]
    sql = (
        f"INSERT INTO trade_history ({','.join(cols)}) "
        f"VALUES ({','.join(placeholders)})"
    )
    batch: list[tuple] = []
    for p in payloads:
        side = p.get("side")
        if isinstance(side, str):
            side = side.strip().lower()
        meta = p.get("metadata_") if "metadata_" in p else p.get("metadata")
        batch.append((
            p.get("timestamp"),
            p.get("symbol"),
            side,
            p.get("quantity"),
            p.get("price"),
            p.get("order_type"),
            p.get("status"),
            p.get("pnl"),
            p.get("pnl_percentage"),
            p.get("strategy"),
            p.get("agent_id"),
            json.dumps(meta) if meta is not None else None,
        ))
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.executemany(sql, batch)
        return len(batch)
    except Exception as e:  # noqa: BLE001
        logger.warning("bulk_insert_trades failed: %s", e)
        return 0


async def bulk_insert_external_trades(payloads: List[Dict[str, Any]]) -> Dict[str, int]:
    """Insert trade rows sourced from an external system (Flex / CSV) with
    idempotent dedup keyed on (source, external_id). Rows already present
    are skipped via ON CONFLICT DO NOTHING against the partial unique index.

    Returns ``{"inserted": n, "skipped": m}``. Rows missing source or
    external_id are skipped at the application level (they'd defeat dedup).
    """
    out = {"inserted": 0, "skipped": 0}
    if not payloads:
        return out
    pool = db.pool()
    if pool is None:
        return out
    cols = [
        "timestamp", "symbol", "side", "quantity", "price", "order_type",
        "status", "pnl", "pnl_percentage", "strategy", "agent_id",
        "metadata_", "source", "external_id",
    ]
    placeholders = [
        f"${i}::jsonb" if c == "metadata_" else f"${i}"
        for i, c in enumerate(cols, start=1)
    ]
    sql = (
        f"INSERT INTO trade_history ({','.join(cols)}) "
        f"VALUES ({','.join(placeholders)}) "
        f"ON CONFLICT (source, external_id) "
        f"WHERE source IS NOT NULL AND external_id IS NOT NULL "
        f"DO NOTHING"
    )
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                for p in payloads:
                    src = p.get("source")
                    ext = p.get("external_id")
                    if not src or not ext:
                        out["skipped"] += 1
                        continue
                    side = p.get("side")
                    if isinstance(side, str):
                        side = side.strip().lower()
                    meta = p.get("metadata_") if "metadata_" in p else p.get("metadata")
                    row = await conn.fetchrow(
                        sql + " RETURNING id",
                        p.get("timestamp"),
                        p.get("symbol"),
                        side,
                        p.get("quantity"),
                        p.get("price"),
                        p.get("order_type"),
                        p.get("status"),
                        p.get("pnl"),
                        p.get("pnl_percentage"),
                        p.get("strategy"),
                        p.get("agent_id"),
                        json.dumps(meta) if meta is not None else None,
                        src,
                        ext,
                    )
                    if row is None:
                        out["skipped"] += 1
                    else:
                        out["inserted"] += 1
    except Exception as e:  # noqa: BLE001
        logger.warning("bulk_insert_external_trades failed: %s", e)
    return out


async def bulk_upsert_external_trades(payloads: List[Dict[str, Any]]) -> Dict[str, int]:
    """Like ``bulk_insert_external_trades`` but **updates** existing rows
    on conflict instead of skipping them. Used by the Flex refresh mode
    to repair rows imported before the timestamp parser improved — only
    fields likely to have changed are overwritten (timestamp, price, pnl,
    metadata), preserving any local edits to side/qty/status/strategy.

    Returns ``{"inserted": n, "updated": m, "skipped": k}`` so the caller
    can distinguish fresh rows from refreshed ones.
    """
    out = {"inserted": 0, "updated": 0, "skipped": 0}
    if not payloads:
        return out
    pool = db.pool()
    if pool is None:
        return out
    cols = [
        "timestamp", "symbol", "side", "quantity", "price", "order_type",
        "status", "pnl", "pnl_percentage", "strategy", "agent_id",
        "metadata_", "source", "external_id",
    ]
    placeholders = [
        f"${i}::jsonb" if c == "metadata_" else f"${i}"
        for i, c in enumerate(cols, start=1)
    ]
    # ON CONFLICT DO UPDATE: refresh the volatile fields (timestamp, price,
    # pnl, metadata), leave behavioural fields alone. ``xmax = 0`` is the
    # canonical Postgres trick for distinguishing INSERT from UPDATE in
    # the same query: 0 means a fresh row was inserted, non-zero means
    # an existing row was updated.
    sql = (
        f"INSERT INTO trade_history ({','.join(cols)}) "
        f"VALUES ({','.join(placeholders)}) "
        f"ON CONFLICT (source, external_id) "
        f"WHERE source IS NOT NULL AND external_id IS NOT NULL "
        f"DO UPDATE SET "
        f"  timestamp = EXCLUDED.timestamp, "
        f"  price = EXCLUDED.price, "
        f"  pnl = COALESCE(EXCLUDED.pnl, trade_history.pnl), "
        f"  metadata_ = EXCLUDED.metadata_ "
        f"RETURNING (xmax = 0) AS inserted"
    )
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                for p in payloads:
                    src = p.get("source")
                    ext = p.get("external_id")
                    if not src or not ext:
                        out["skipped"] += 1
                        continue
                    side = p.get("side")
                    if isinstance(side, str):
                        side = side.strip().lower()
                    meta = p.get("metadata_") if "metadata_" in p else p.get("metadata")
                    row = await conn.fetchrow(
                        sql,
                        p.get("timestamp"),
                        p.get("symbol"),
                        side,
                        p.get("quantity"),
                        p.get("price"),
                        p.get("order_type"),
                        p.get("status"),
                        p.get("pnl"),
                        p.get("pnl_percentage"),
                        p.get("strategy"),
                        p.get("agent_id"),
                        json.dumps(meta) if meta is not None else None,
                        src,
                        ext,
                    )
                    if row is None:
                        out["skipped"] += 1
                    elif row["inserted"]:
                        out["inserted"] += 1
                    else:
                        out["updated"] += 1
    except Exception as e:  # noqa: BLE001
        logger.warning("bulk_upsert_external_trades failed: %s", e)
    return out


async def flex_summary() -> Dict[str, Any]:
    """Compact stats for the Flex-sourced subset of trade_history. Used by
    the UI's backfill panel: total rows, date span, per-account counts."""
    out: Dict[str, Any] = {
        "total_rows": 0,
        "earliest": None,
        "latest": None,
        "accounts": [],
    }
    pool = db.pool()
    if pool is None:
        return out
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT count(*) AS n, min(timestamp) AS lo, max(timestamp) AS hi "
                "FROM trade_history WHERE source = 'ibkr_flex' AND is_deleted = FALSE"
            )
            if row is not None:
                out["total_rows"] = int(row["n"] or 0)
                out["earliest"] = row["lo"].isoformat() if row["lo"] else None
                out["latest"] = row["hi"].isoformat() if row["hi"] else None
            accounts = await conn.fetch(
                "SELECT metadata_->>'account_id' AS account, count(*) AS n "
                "FROM trade_history "
                "WHERE source = 'ibkr_flex' AND is_deleted = FALSE "
                "  AND metadata_->>'account_id' IS NOT NULL "
                "GROUP BY metadata_->>'account_id' "
                "ORDER BY n DESC"
            )
            out["accounts"] = [
                {"account_id": r["account"], "rows": int(r["n"])}
                for r in accounts
            ]
    except Exception as e:  # noqa: BLE001
        logger.warning("flex_summary failed: %s", e)
    return out


def _build_filter_sql(
    *,
    symbol: Optional[str],
    status: Optional[str],
    side: Optional[str],
    strategy: Optional[str],
    agent_id: Optional[str],
    start: Optional[datetime],
    end: Optional[datetime],
    asset_class: Optional[str] = None,
    account_id: Optional[str] = None,
    transaction_type: Optional[str] = None,
    has_note: Optional[bool] = None,
) -> tuple[str, list[Any]]:
    """Shared WHERE-builder for list_trades / export_trades. Asset / account
    / tx_type live in ``metadata_`` JSONB — extracted with ``->>'key'``.

    ``asset_class`` is a high-level bucket the UI passes ('stock' | 'option');
    options expand to ``IN ('OPT', 'FOP')`` and stock to the complement
    (with NULL treated as stock-ish so legacy non-Flex rows aren't hidden)."""
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
    if asset_class:
        bucket = asset_class.strip().lower()
        if bucket == "option":
            clauses.append("(metadata_->>'asset_category') IN ('OPT', 'FOP')")
        elif bucket == "stock":
            # Treat NULL asset_category as stock — legacy non-Flex rows
            # don't carry the field but are almost always equities.
            clauses.append(
                "((metadata_->>'asset_category') IS NULL OR "
                "(metadata_->>'asset_category') NOT IN ('OPT', 'FOP', 'FUT'))"
            )
        elif bucket == "future":
            clauses.append("(metadata_->>'asset_category') = 'FUT'")
        # any other value: no-op (treat as 'all')
    if account_id:
        args.append(account_id.strip())
        clauses.append(f"(metadata_->>'account_id') = ${len(args)}")
    if transaction_type:
        args.append(transaction_type.strip())
        clauses.append(f"(metadata_->>'transaction_type') = ${len(args)}")
    if has_note is True:
        # Only rows where a non-empty journal note was saved into metadata.
        clauses.append(
            "(metadata_->>'note') IS NOT NULL AND length(trim(metadata_->>'note')) > 0"
        )
    elif has_note is False:
        clauses.append(
            "((metadata_->>'note') IS NULL OR length(trim(metadata_->>'note')) = 0)"
        )
    return f"WHERE {' AND '.join(clauses)}", args


async def export_trades(
    symbol: Optional[str] = None,
    status: Optional[str] = None,
    side: Optional[str] = None,
    strategy: Optional[str] = None,
    agent_id: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    asset_class: Optional[str] = None,
    account_id: Optional[str] = None,
    transaction_type: Optional[str] = None,
    has_note: Optional[bool] = None,
) -> List[Dict[str, Any]]:
    """All matching trades, unpaginated, newest-first. Same filter semantics
    as ``list_trades`` but skips the COUNT/LIMIT/OFFSET — callers stream
    the result straight into CSV."""
    pool = db.pool()
    if pool is None:
        return []
    where, args = _build_filter_sql(
        symbol=symbol, status=status, side=side, strategy=strategy,
        agent_id=agent_id, start=start, end=end,
        asset_class=asset_class, account_id=account_id,
        transaction_type=transaction_type, has_note=has_note,
    )
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                f"SELECT * FROM trade_history {where} "
                f"ORDER BY timestamp DESC, id DESC",
                *args,
            )
            return [_row_to_dict(r) for r in rows]
    except Exception as e:  # noqa: BLE001
        logger.warning("export_trades failed: %s", e)
        return []


async def list_trades(
    symbol: Optional[str] = None,
    status: Optional[str] = None,
    side: Optional[str] = None,
    strategy: Optional[str] = None,
    agent_id: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    asset_class: Optional[str] = None,
    account_id: Optional[str] = None,
    transaction_type: Optional[str] = None,
    has_note: Optional[bool] = None,
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
    where, args = _build_filter_sql(
        symbol=symbol, status=status, side=side, strategy=strategy,
        agent_id=agent_id, start=start, end=end,
        asset_class=asset_class, account_id=account_id,
        transaction_type=transaction_type, has_note=has_note,
    )
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


async def get_trade_analysis(
    symbol: Optional[str] = None,
    strategy: Optional[str] = None,
    agent_id: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Insight bundle over the (optionally filtered) trade set.

    Surfaces highlight trades (best/worst by pct, biggest win/loss by USD),
    the average BUY→SELL holding period per symbol, the most common
    strategies, and a per-hour-of-day breakdown. Rows without a non-null
    ``pnl`` / ``pnl_percentage`` are skipped from the relevant ranking so
    open trades don't masquerade as the worst loss.
    """
    empty: Dict[str, Any] = {
        "best_trade": None,
        "worst_trade": None,
        "biggest_win": None,
        "biggest_loss": None,
        "avg_hold_time_seconds": None,
        "common_strategies": [],
        "time_of_day_patterns": [],
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
            best = await conn.fetchrow(
                f"SELECT * FROM trade_history {where} AND pnl_percentage IS NOT NULL "
                f"ORDER BY pnl_percentage DESC, id DESC LIMIT 1",
                *args,
            )
            worst = await conn.fetchrow(
                f"SELECT * FROM trade_history {where} AND pnl_percentage IS NOT NULL "
                f"ORDER BY pnl_percentage ASC, id DESC LIMIT 1",
                *args,
            )
            biggest_win = await conn.fetchrow(
                f"SELECT * FROM trade_history {where} AND pnl IS NOT NULL "
                f"ORDER BY pnl DESC, id DESC LIMIT 1",
                *args,
            )
            biggest_loss = await conn.fetchrow(
                f"SELECT * FROM trade_history {where} AND pnl IS NOT NULL "
                f"ORDER BY pnl ASC, id DESC LIMIT 1",
                *args,
            )
            # Avg hold time: pair each SELL with the immediately preceding
            # BUY on the same symbol via LAG and average the gap. Rough
            # approximation when buys/sells don't pair 1:1, but good enough
            # for a dashboard insight.
            hold = await conn.fetchval(
                f"""
                WITH paired AS (
                  SELECT
                    timestamp,
                    side,
                    LAG(timestamp) OVER (PARTITION BY symbol ORDER BY timestamp, id) AS prev_ts,
                    LAG(side)      OVER (PARTITION BY symbol ORDER BY timestamp, id) AS prev_side
                  FROM trade_history {where}
                )
                SELECT AVG(EXTRACT(EPOCH FROM (timestamp - prev_ts)))
                FROM paired
                WHERE prev_side = 'buy' AND side = 'sell' AND prev_ts IS NOT NULL
                """,
                *args,
            )
            strategies = await conn.fetch(
                f"""
                SELECT
                  strategy,
                  COUNT(*)                                            AS trade_count,
                  COALESCE(SUM(pnl), 0)                               AS total_pnl,
                  CASE
                    WHEN COUNT(*) FILTER (WHERE pnl IS NOT NULL) > 0
                    THEN COUNT(*) FILTER (WHERE pnl > 0)::float
                         / COUNT(*) FILTER (WHERE pnl IS NOT NULL)
                    ELSE 0.0
                  END                                                 AS win_rate
                FROM trade_history {where} AND strategy IS NOT NULL
                GROUP BY strategy
                ORDER BY trade_count DESC, strategy ASC
                LIMIT 10
                """,
                *args,
            )
            hours = await conn.fetch(
                f"""
                SELECT
                  EXTRACT(HOUR FROM timestamp)::int                   AS hour,
                  COUNT(*)                                            AS trade_count,
                  COALESCE(SUM(pnl), 0)                               AS total_pnl,
                  COALESCE(AVG(pnl) FILTER (WHERE pnl IS NOT NULL), 0) AS avg_pnl,
                  CASE
                    WHEN COUNT(*) FILTER (WHERE pnl IS NOT NULL) > 0
                    THEN COUNT(*) FILTER (WHERE pnl > 0)::float
                         / COUNT(*) FILTER (WHERE pnl IS NOT NULL)
                    ELSE 0.0
                  END                                                 AS win_rate
                FROM trade_history {where}
                GROUP BY hour
                ORDER BY hour ASC
                """,
                *args,
            )
            return {
                "best_trade": _trade_summary(best),
                "worst_trade": _trade_summary(worst),
                "biggest_win": _trade_summary(biggest_win),
                "biggest_loss": _trade_summary(biggest_loss),
                "avg_hold_time_seconds": float(hold) if hold is not None else None,
                "common_strategies": [
                    {
                        "strategy": r["strategy"],
                        "count": int(r["trade_count"]),
                        "total_pnl": float(r["total_pnl"]),
                        "win_rate": float(r["win_rate"]),
                    }
                    for r in strategies
                ],
                "time_of_day_patterns": [
                    {
                        "hour": int(r["hour"]),
                        "count": int(r["trade_count"]),
                        "total_pnl": float(r["total_pnl"]),
                        "avg_pnl": float(r["avg_pnl"]),
                        "win_rate": float(r["win_rate"]),
                    }
                    for r in hours
                ],
            }
    except Exception as e:  # noqa: BLE001
        logger.warning("get_trade_analysis failed: %s", e)
        return empty


def _trade_summary(row: Any) -> Optional[Dict[str, Any]]:
    if row is None:
        return None
    d = _row_to_dict(row)
    side = d.get("side")
    if isinstance(side, str):
        side = side.upper()
    return {
        "id": int(d["id"]),
        "symbol": d.get("symbol"),
        "side": side,
        "quantity": d.get("quantity"),
        "price": d.get("price"),
        "pnl": d.get("pnl"),
        "pnl_percentage": d.get("pnl_percentage"),
        "timestamp": d.get("timestamp"),
        "strategy": d.get("strategy"),
    }


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
