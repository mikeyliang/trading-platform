"""OKW-style trade tracker endpoints."""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException, Query

from ..models.schemas import OkwTradeClose, OkwTradeCreate
from ..services import okw_store

router = APIRouter(prefix="/api/okw", tags=["okw"])


@router.get(
    "/trades",
    summary="List OKW-tracked trades",
    description="Filter by ``status`` and ``trade_type``; capped at ``limit`` rows.",
    responses={
        200: {
            "content": {
                "application/json": {
                    "example": {
                        "trades": [
                            {
                                "id": 42, "symbol": "RUT", "trade_type": "rut",
                                "status": "open", "short_strike": 1900,
                                "long_strike": 1880, "credit": 2.30,
                            }
                        ]
                    }
                }
            }
        }
    },
)
async def list_trades(
    status: Optional[Literal["open", "closed", "expired"]] = Query(None),
    trade_type: Optional[str] = Query(None, description="rut | mars | marsmax | space"),
    limit: int = Query(100, ge=1, le=500),
) -> Dict[str, List[Dict[str, Any]]]:
    return {"trades": await okw_store.list_trades(status=status, trade_type=trade_type, limit=limit)}


@router.post(
    "/trades",
    status_code=201,
    summary="Open a new OKW spread",
    description="Persists a new open trade and computes ``width`` from short/long strike.",
    responses={
        201: {"description": "Trade row inserted."},
        503: {"description": "Persistence backend unavailable."},
    },
)
async def create_trade(payload: OkwTradeCreate) -> Dict[str, Any]:
    data = payload.model_dump()
    data["width"] = payload.width
    row = await okw_store.create_trade(data)
    if not row:
        raise HTTPException(status_code=503, detail="persistence unavailable")
    return row


@router.post(
    "/trades/{trade_id}/close",
    summary="Close an open OKW spread",
    responses={404: {"description": "Trade id not found."}},
)
async def close_trade(trade_id: int, payload: OkwTradeClose) -> Dict[str, Any]:
    row = await okw_store.close_trade(trade_id, payload.exit_reason, payload.realized_pnl)
    if not row:
        raise HTTPException(status_code=404, detail="trade not found")
    return row


@router.delete(
    "/trades/{trade_id}",
    summary="Delete an OKW trade",
    responses={
        200: {"content": {"application/json": {"example": {"ok": True}}}},
        404: {"description": "Trade id not found."},
    },
)
async def delete_trade(trade_id: int) -> Dict[str, bool]:
    ok = await okw_store.delete_trade(trade_id)
    if not ok:
        raise HTTPException(status_code=404, detail="trade not found")
    return {"ok": True}


@router.get(
    "/summary",
    summary="Aggregate OKW stats",
    description="Per-type win rate, average credit, realized P&L, etc.",
)
async def summary() -> Any:
    return await okw_store.summary()
