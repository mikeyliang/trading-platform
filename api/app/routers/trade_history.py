"""Trade-history CRUD endpoints.

Thin HTTP layer over ``trade_history_store``. The store is the single
source of truth for filtering, pagination, soft-delete, and stats math —
this module only validates payloads, maps store dicts onto Pydantic
response models, and translates miss / failure into the right HTTP code.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, status

from ..schemas.trade_history import (
    TradeHistoryCreate,
    TradeHistoryListResponse,
    TradeHistoryResponse,
    TradeHistoryUpdate,
    TradeStats,
)
from ..services import trade_history_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/trade-history", tags=["trade-history"])


@router.get(
    "/",
    response_model=TradeHistoryListResponse,
    summary="List trade-history rows with pagination and filters.",
)
async def list_trade_history(
    symbol: Optional[str] = Query(None, description="Filter by ticker (case-insensitive)."),
    status_: Optional[str] = Query(None, alias="status", description="Filter by trade status."),
    side: Optional[str] = Query(None, description="Filter by side (BUY / SELL)."),
    strategy: Optional[str] = Query(None, description="Filter by strategy tag."),
    agent_id: Optional[str] = Query(None, description="Filter by placing agent ID."),
    start: Optional[datetime] = Query(None, description="Inclusive lower bound on timestamp."),
    end: Optional[datetime] = Query(None, description="Inclusive upper bound on timestamp."),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
) -> TradeHistoryListResponse:
    result = await trade_history_store.list_trades(
        symbol=symbol,
        status=status_,
        side=side,
        strategy=strategy,
        agent_id=agent_id,
        start=start,
        end=end,
        page=page,
        page_size=page_size,
    )
    return TradeHistoryListResponse(**result)


@router.get(
    "/stats",
    response_model=TradeStats,
    summary="Aggregate P&L stats across the filtered trade set.",
)
async def trade_history_stats(
    symbol: Optional[str] = Query(None),
    strategy: Optional[str] = Query(None),
    agent_id: Optional[str] = Query(None),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
) -> TradeStats:
    result = await trade_history_store.get_trade_stats(
        symbol=symbol,
        strategy=strategy,
        agent_id=agent_id,
        start=start,
        end=end,
    )
    return TradeStats(**result)


@router.post(
    "/",
    response_model=TradeHistoryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Insert a trade row.",
)
async def create_trade_history(payload: TradeHistoryCreate) -> TradeHistoryResponse:
    row = await trade_history_store.create_trade(payload.model_dump(by_alias=False))
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="trade_history insert unavailable",
        )
    return TradeHistoryResponse(**row)


@router.put(
    "/{trade_id}",
    response_model=TradeHistoryResponse,
    summary="Patch mutable fields on an existing trade.",
)
async def update_trade_history(trade_id: int, payload: TradeHistoryUpdate) -> TradeHistoryResponse:
    updates = payload.model_dump(by_alias=False, exclude_unset=True)
    row = await trade_history_store.update_trade(trade_id, updates)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"trade {trade_id} not found",
        )
    return TradeHistoryResponse(**row)


@router.delete(
    "/{trade_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Soft-delete a trade row (flips is_deleted).",
)
async def delete_trade_history(trade_id: int) -> None:
    deleted = await trade_history_store.delete_trade(trade_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"trade {trade_id} not found or already deleted",
        )
    return None
