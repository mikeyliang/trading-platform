"""
Trade history store - raw SQL via asyncpg.

Provides CRUD + stats for the trade_history table. Used by the
/trade-history API router and eventually by agents to log fills.
"""
from __future__ import annotations

import math
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta

from ..services import db


async def create_trade(
    symbol: str,
    side: str,
    quantity: float,
    price: float,
    order_type: str = 'market',
    status: str = 'filled',
    strategy: Optional[str] = None,
    agent_id: Optional[str] = None,
    metadata_: Optional[Dict] = None,
    timestamp: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Insert a new trade record. Returns the created row as dict."""
    pool = db.pool()
    if pool is None:
        raise RuntimeError("database not available")
    
    ts = timestamp or datetime.utcnow()
    
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            INSERT INTO trade_history
                (timestamp, symbol, side, quantity, price, order_type, status,
                 strategy, agent_id, metadata_, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
            RETURNING id, timestamp, symbol, side, quantity, price,
                      order_type, status, pnl, pnl_percentage,
                      strategy, agent_id, metadata_, created_at, updated_at
        """, ts, symbol.upper(), side, quantity, price, order_type,
             status, strategy, agent_id, metadata_)
        
        return dict(row)


async def list_trades(
    page: int = 1,
    page_size: int = 50,
    symbol: Optional[str] = None,
    side: Optional[str] = None,
    strategy: Optional[str] = None,
    agent_id: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
) -> Dict[str, Any]:
    """List trades with pagination and filtering."""
    pool = db.pool()
    if pool is None:
        return {"trades": [], "total": 0, "page": page, "page_size": page_size, "total_pages": 0}
    
    # Build WHERE clause
    conditions = ["is_deleted = FALSE"]
    params = []
    idx = 1
    
    if symbol:
        conditions.append(f"symbol = ${idx}")
        params.append(symbol.upper())
        idx += 1
    
    if side:
        conditions.append(f"side = ${idx}")
        params.append(side)
        idx += 1
    
    if strategy:
        conditions.append(f"strategy = ${idx}")
        params.append(strategy)
        idx += 1
    
    if agent_id:
        conditions.append(f"agent_id = ${idx}")
        params.append(agent_id)
        idx += 1
    
    if start_date:
        conditions.append(f"timestamp >= ${idx}")
        params.append(start_date)
        idx += 1
    
    if end_date:
        conditions.append(f"timestamp <= ${idx}")
        params.append(end_date)
        idx += 1
    
    where_clause = " AND ".join(conditions)
    
    async with pool.acquire() as conn:
        # Get total count
        count_sql = f"SELECT COUNT(*) FROM trade_history WHERE {where_clause}"
        total = await conn.fetchval(count_sql, *params)
        
        # Pagination
        offset = (page - 1) * page_size
        total_pages = math.ceil(total / page_size) if total > 0 else 1
        
        # Get trades
        trades_sql = f"""
            SELECT id, timestamp, symbol, side, quantity, price,
                   order_type, status, pnl, pnl_percentage,
                   strategy, agent_id, metadata_, created_at, updated_at
            FROM trade_history
            WHERE {where_clause}
            ORDER BY timestamp DESC
            OFFSET ${idx} LIMIT ${idx + 1}
        """
        trades = await conn.fetch(trades_sql, *params, offset, page_size)
        
        return {
            "trades": [dict(t) for t in trades],
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages
        }


async def get_trade_stats(
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Calculate trade statistics for a date range."""
    pool = db.pool()
    if pool is None:
        return {
            "total_trades": 0, "winning_trades": 0, "losing_trades": 0,
            "win_rate": 0.0, "total_pnl": 0.0, "avg_pnl": 0.0, "profit_factor": 0.0
        }
    
    # Default to last 30 days
    if not end_date:
        end_date = datetime.utcnow()
    if not start_date:
        start_date = end_date - timedelta(days=30)
    
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT pnl, status
            FROM trade_history
            WHERE is_deleted = FALSE
              AND timestamp >= $1
              AND timestamp <= $2
              AND status = 'filled'
        """, start_date, end_date)
        
        total_trades = len(rows)
        if total_trades == 0:
            return {
                "total_trades": 0, "winning_trades": 0, "losing_trades": 0,
                "win_rate": 0.0, "total_pnl": 0.0, "avg_pnl": 0.0, "profit_factor": 0.0
            }
        
        winning = [r for r in rows if r['pnl'] and r['pnl'] > 0]
        losing = [r for r in rows if r['pnl'] and r['pnl'] < 0]
        
        total_pnl = sum(r['pnl'] for r in rows if r['pnl'])
        avg_pnl = total_pnl / total_trades
        win_rate = (len(winning) / total_trades * 100) if total_trades > 0 else 0
        
        gross_profit = sum(r['pnl'] for r in winning)
        gross_loss = abs(sum(r['pnl'] for r in losing))
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else float('inf')
        
        return {
            "total_trades": total_trades,
            "winning_trades": len(winning),
            "losing_trades": len(losing),
            "win_rate": round(win_rate, 2),
            "total_pnl": round(total_pnl, 2),
            "avg_pnl": round(avg_pnl, 2),
            "profit_factor": round(profit_factor, 2) if profit_factor != float('inf') else 999.99
        }


async def update_trade(
    trade_id: int,
    pnl: Optional[float] = None,
    pnl_percentage: Optional[float] = None,
    status: Optional[str] = None,
    metadata_: Optional[Dict] = None,
) -> Optional[Dict[str, Any]]:
    """Update a trade (e.g., add P&L after closing). Returns updated row or None."""
    pool = db.pool()
    if pool is None:
        return None
    
    # Build dynamic UPDATE
    updates = ["updated_at = NOW()"]
    params = []
    idx = 1
    
    if pnl is not None:
        updates.append(f"pnl = ${idx}")
        params.append(pnl)
        idx += 1
    
    if pnl_percentage is not None:
        updates.append(f"pnl_percentage = ${idx}")
        params.append(pnl_percentage)
        idx += 1
    
    if status is not None:
        updates.append(f"status = ${idx}")
        params.append(status)
        idx += 1
    
    if metadata_ is not None:
        updates.append(f"metadata_ = ${idx}")
        params.append(metadata_)
        idx += 1
    
    params.append(trade_id)
    
    async with pool.acquire() as conn:
        row = await conn.fetchrow(f"""
            UPDATE trade_history
            SET {', '.join(updates)}
            WHERE id = ${idx} AND is_deleted = FALSE
            RETURNING id, timestamp, symbol, side, quantity, price,
                      order_type, status, pnl, pnl_percentage,
                      strategy, agent_id, metadata_, created_at, updated_at
        """, *params)
        
        return dict(row) if row else None


async def delete_trade(trade_id: int) -> bool:
    """Soft-delete a trade. Returns True if deleted, False if not found."""
    pool = db.pool()
    if pool is None:
        return False
    
    async with pool.acquire() as conn:
        result = await conn.execute("""
            UPDATE trade_history
            SET is_deleted = TRUE, updated_at = NOW()
            WHERE id = $1 AND is_deleted = FALSE
        """, trade_id)
        
        return result.split()[-1] == '1'
