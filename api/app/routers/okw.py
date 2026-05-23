"""OKW-style trade tracker endpoints."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..services import okw_store

router = APIRouter(prefix="/api/okw", tags=["okw"])


class TradeCreate(BaseModel):
    symbol: str
    trade_type: str
    side: str = "put"
    expiry: str
    dte: int
    short_strike: float
    long_strike: float
    contracts: int = 1
    credit: float
    spot_at_open: Optional[float] = None
    short_delta: Optional[float] = None
    aroc_pct: Optional[float] = None
    kelly_pct: Optional[float] = None
    adj_distance_pct: Optional[float] = None
    fib_floor1: Optional[float] = None
    fib_floor2: Optional[float] = None
    notes: Optional[str] = None

    @property
    def width(self) -> float:
        return abs(self.short_strike - self.long_strike)


class TradeClose(BaseModel):
    exit_reason: str = Field(..., description="delta | 2pct | profit | manual")
    realized_pnl: Optional[float] = None


@router.get("/trades")
async def list_trades(
    status: Optional[str] = Query(None, description="open | closed | expired"),
    trade_type: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
):
    return {"trades": await okw_store.list_trades(status=status, trade_type=trade_type, limit=limit)}


@router.post("/trades")
async def create_trade(payload: TradeCreate):
    data = payload.model_dump()
    data["width"] = payload.width
    row = await okw_store.create_trade(data)
    if not row:
        raise HTTPException(status_code=503, detail="persistence unavailable")
    return row


@router.post("/trades/{trade_id}/close")
async def close_trade(trade_id: int, payload: TradeClose):
    row = await okw_store.close_trade(trade_id, payload.exit_reason, payload.realized_pnl)
    if not row:
        raise HTTPException(status_code=404, detail="trade not found")
    return row


@router.delete("/trades/{trade_id}")
async def delete_trade(trade_id: int):
    ok = await okw_store.delete_trade(trade_id)
    if not ok:
        raise HTTPException(status_code=404, detail="trade not found")
    return {"ok": True}


@router.get("/summary")
async def summary() -> Any:
    return await okw_store.summary()
