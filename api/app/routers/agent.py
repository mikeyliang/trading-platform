"""Agent-facing portfolio endpoints.

Reads the trade_history table directly via asyncpg — rows with
``status = 'open'`` are treated as the agent's currently held positions.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, Field

from ..config import settings
from ..nautilus import ib_options
from ..nautilus.ib_node import ib_node
from ..nautilus.ib_orders import orders_client
from ..services import db

logger = logging.getLogger(__name__)

_agent_key_header = APIKeyHeader(name="X-Agent-Key", auto_error=False)


def require_agent_key(provided: Optional[str] = Depends(_agent_key_header)) -> None:
    expected = settings.agent_api_key
    if not expected:
        # Misconfigured deployment — fail closed rather than waving traffic through.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="agent api key not configured",
        )
    if not provided or provided != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing X-Agent-Key",
        )


router = APIRouter(
    prefix="/api/agent",
    tags=["agent"],
    dependencies=[Depends(require_agent_key)],
)


class AgentHealth(BaseModel):
    status: Literal["ok", "degraded"]
    ibkr_connected: bool
    db_connected: bool
    timestamp: datetime


@router.get(
    "/health",
    response_model=AgentHealth,
    summary="Agent subsystem health",
    description=(
        "Reports liveness of the IBKR gateway and Postgres pool. ``status`` is "
        "``ok`` only when both are reachable, otherwise ``degraded``."
    ),
)
async def get_agent_health() -> AgentHealth:
    ibkr_connected = ib_node.is_connected

    db_connected = False
    pool = db.pool()
    if pool is not None:
        try:
            async with pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
            db_connected = True
        except Exception as e:  # noqa: BLE001
            logger.warning("agent health db probe failed: %s", e)

    return AgentHealth(
        status="ok" if (ibkr_connected and db_connected) else "degraded",
        ibkr_connected=ibkr_connected,
        db_connected=db_connected,
        timestamp=datetime.now(timezone.utc),
    )


class AgentPosition(BaseModel):
    id: int = Field(..., description="trade_history row id.")
    symbol: str
    size: float = Field(..., description="Position size (signed: positive long, negative short).")
    entry_price: float = Field(..., description="Per-unit fill price the position was opened at.")
    current_pnl: Optional[float] = Field(
        None,
        description="Current P&L from the trade_history row. Null until populated.",
    )


@router.get(
    "/positions",
    response_model=List[AgentPosition],
    summary="List the agent's current open positions",
    description=(
        "Open rows from trade_history (status='open', not soft-deleted). Returns "
        "position id, symbol, size, entry price, and current P&L. Filter to a "
        "single agent with ``agent_id``."
    ),
)
async def get_agent_positions(
    agent_id: Optional[str] = Query(None, description="Filter to a single agent's open positions."),
) -> List[AgentPosition]:
    pool = db.pool()
    if pool is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="database unavailable",
        )

    clauses = ["is_deleted = FALSE", "status = 'open'"]
    args: list = []
    if agent_id:
        args.append(agent_id)
        clauses.append(f"agent_id = ${len(args)}")
    where = " AND ".join(clauses)

    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                f"SELECT id, symbol, quantity, price, pnl FROM trade_history "
                f"WHERE {where} ORDER BY timestamp DESC, id DESC",
                *args,
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("get_agent_positions query failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="positions query failed",
        )

    return [
        AgentPosition(
            id=int(r["id"]),
            symbol=r["symbol"] or "?",
            size=float(r["quantity"] or 0),
            entry_price=float(r["price"] or 0),
            current_pnl=(float(r["pnl"]) if r["pnl"] is not None else None),
        )
        for r in rows
    ]


class AgentTrade(BaseModel):
    symbol: str
    side: str
    quantity: float
    price: float
    status: str
    timestamp: datetime


@router.get(
    "/trades",
    response_model=List[AgentTrade],
    summary="List the agent's most recent trades",
    description=(
        "Returns the last 50 trade_history rows with status FILLED or PENDING "
        "(not soft-deleted), most recent first."
    ),
)
async def list_agent_trades() -> List[AgentTrade]:
    pool = db.pool()
    if pool is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="database unavailable",
        )

    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT symbol, side, quantity, price, status, timestamp "
                "FROM trade_history "
                "WHERE is_deleted = FALSE AND status IN ('FILLED', 'PENDING') "
                "ORDER BY timestamp DESC, id DESC "
                "LIMIT 50",
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("list_agent_trades query failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="trades query failed",
        )

    return [
        AgentTrade(
            symbol=r["symbol"] or "?",
            side=r["side"] or "?",
            quantity=float(r["quantity"] or 0),
            price=float(r["price"] or 0),
            status=r["status"] or "?",
            timestamp=r["timestamp"],
        )
        for r in rows
    ]


class AgentTradeRequest(BaseModel):
    symbol: str = Field(..., min_length=1, description="Underlying ticker (e.g. AAPL).")
    quantity: float = Field(..., gt=0, description="Share count (positive; side controls direction).")
    side: Literal["buy", "sell"]
    order_type: Literal["market", "limit"]
    limit_price: Optional[float] = Field(
        None, gt=0, description="Required when order_type='limit'."
    )


class AgentTradeResponse(BaseModel):
    order_id: str
    status: str


@router.post(
    "/trades",
    response_model=AgentTradeResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Place a single-leg stock order via IBKR",
    description=(
        "Submits a stock order through the shared ib_async orders client. "
        "Market orders ignore ``limit_price``; limit orders require it."
    ),
)
async def place_agent_trade(req: AgentTradeRequest) -> AgentTradeResponse:
    if req.order_type == "limit" and req.limit_price is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="limit_price required when order_type='limit'",
        )

    try:
        result = await orders_client.place_stock_order(
            symbol=req.symbol,
            quantity=req.quantity,
            side=req.side.upper(),  # type: ignore[arg-type]
            order_type=req.order_type.upper(),  # type: ignore[arg-type]
            limit_price=req.limit_price,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(e),
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("place_agent_trade failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="order submission failed",
        )

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="IBKR gateway unavailable",
        )

    return AgentTradeResponse(**result)


class AgentAccount(BaseModel):
    balance: float = Field(..., description="Total cash value (USD).")
    buying_power: float = Field(..., description="Available buying power for new positions.")
    equity: float = Field(..., description="Net liquidation (cash + position market value).")
    daily_pnl: float = Field(..., description="Today's P&L: sum of unrealized P&L across open positions.")


@router.get(
    "/account",
    response_model=AgentAccount,
    summary="Agent account snapshot",
    description=(
        "Returns balance, buying power, equity, and daily P&L from IBKR via "
        "the shared ib_async account-summary path. Daily P&L is computed as "
        "the sum of unrealized P&L on currently held positions (mark-refreshed)."
    ),
)
async def get_agent_account() -> AgentAccount:
    if not ib_node.is_connected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="IBKR gateway unavailable",
        )

    acct = await ib_options.get_account_summary()
    if acct is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="account summary unavailable",
        )

    from ..main import _refresh_position_marks  # local import avoids cycle

    positions = await ib_options.get_positions()
    if positions:
        positions = await _refresh_position_marks(positions)
    daily_pnl = sum(float(p.get("unrealized_pnl", 0) or 0) for p in positions)

    return AgentAccount(
        balance=float(acct.get("balance") or 0),
        buying_power=float(acct.get("buying_power") or 0),
        equity=float(acct.get("equity") or 0),
        daily_pnl=round(daily_pnl, 2),
    )
