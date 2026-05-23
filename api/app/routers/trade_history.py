"""
Trade history API router.

Uses trade_history_store service (raw asyncpg SQL) matching the project pattern.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional, List
from datetime import datetime

from ..schemas.trade_history import (
    TradeHistoryCreate, 
    TradeHistoryUpdate, 
    TradeHistoryResponse,
    TradeHistoryListResponse,
    TradeStats
)
from ..services import trade_history_store

router = APIRouter(prefix="/api/trade-history", tags=["trade-history"])


@router.get("", response_model=TradeHistoryListResponse)
async def list_trades(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    symbol: Optional[str] = Query(None),
    side: Optional[str] = Query(None),
    strategy: Optional[str] = Query(None),
    agent_id: Optional[str] = Query(None),
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
):
    """List trades with pagination and filtering."""
    result = await trade_history_store.list_trades(
        page=page,
        page_size=page_size,
        symbol=symbol,
        side=side,
        strategy=strategy,
        agent_id=agent_id,
        start_date=start_date,
        end_date=end_date,
    )
    
    # Convert to response models
    trades = [
        TradeHistoryResponse(
            id=t['id'],
            timestamp=t['timestamp'],
            symbol=t['symbol'],
            side=t['side'],
            quantity=float(t['quantity']),
            price=float(t['price']),
            order_type=t['order_type'],
            status=t['status'],
            pnl=float(t['pnl']) if t['pnl'] else None,
            pnl_percentage=float(t['pnl_percentage']) if t['pnl_percentage'] else None,
            strategy=t['strategy'],
            agent_id=t['agent_id'],
            created_at=t['created_at'],
            updated_at=t['updated_at']
        ) for t in result['trades']
    ]
    
    return TradeHistoryListResponse(
        trades=trades,
        total=result['total'],
        page=result['page'],
        page_size=result['page_size'],
        total_pages=result['total_pages']
    )


@router.get("/stats", response_model=TradeStats)
async def get_trade_stats(
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
):
    """Get trade statistics."""
    stats = await trade_history_store.get_trade_stats(
        start_date=start_date,
        end_date=end_date
    )
    
    return TradeStats(**stats)


@router.post("", response_model=TradeHistoryResponse, status_code=201)
async def create_trade(trade: TradeHistoryCreate):
    """Record a new trade."""
    try:
        result = await trade_history_store.create_trade(
            symbol=trade.symbol,
            side=trade.side,
            quantity=float(trade.quantity),
            price=float(trade.price),
            order_type=trade.order_type,
            status=trade.status,
            strategy=trade.strategy,
            agent_id=trade.agent_id,
            metadata_=trade.metadata_,
            timestamp=trade.timestamp,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    
    return TradeHistoryResponse(
        id=result['id'],
        timestamp=result['timestamp'],
        symbol=result['symbol'],
        side=result['side'],
        quantity=float(result['quantity']),
        price=float(result['price']),
        order_type=result['order_type'],
        status=result['status'],
        pnl=float(result['pnl']) if result['pnl'] else None,
        pnl_percentage=float(result['pnl_percentage']) if result['pnl_percentage'] else None,
        strategy=result['strategy'],
        agent_id=result['agent_id'],
        created_at=result['created_at'],
        updated_at=result['updated_at']
    )


@router.put("/{trade_id}", response_model=TradeHistoryResponse)
async def update_trade(trade_id: int, trade_update: TradeHistoryUpdate):
    """Update a trade (e.g., add P&L after closing)."""
    result = await trade_history_store.update_trade(
        trade_id=trade_id,
        pnl=trade_update.pnl,
        pnl_percentage=trade_update.pnl_percentage,
        status=trade_update.status,
        metadata_=trade_update.metadata_,
    )
    
    if not result:
        raise HTTPException(status_code=404, detail="Trade not found")
    
    return TradeHistoryResponse(
        id=result['id'],
        timestamp=result['timestamp'],
        symbol=result['symbol'],
        side=result['side'],
        quantity=float(result['quantity']),
        price=float(result['price']),
        order_type=result['order_type'],
        status=result['status'],
        pnl=float(result['pnl']) if result['pnl'] else None,
        pnl_percentage=float(result['pnl_percentage']) if result['pnl_percentage'] else None,
        strategy=result['strategy'],
        agent_id=result['agent_id'],
        created_at=result['created_at'],
        updated_at=result['updated_at']
    )


@router.delete("/{trade_id}", status_code=204)
async def delete_trade(trade_id: int):
    """Soft delete a trade."""
    deleted = await trade_history_store.delete_trade(trade_id)
    
    if not deleted:
        raise HTTPException(status_code=404, detail="Trade not found")
