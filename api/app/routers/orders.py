"""Portfolio read endpoints — IBKR only.

When the IBKR Gateway is connected, positions / account / trades come from
the live IBKR API. When the gateway is down (auth refresh, manual stop),
endpoints return zeroed / empty payloads so the dashboard degrades cleanly.

Order placement is intentionally NOT exposed — read-only at the brokerage
layer. Add a separate router behind explicit user confirmation if you need
order entry later.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter

from ..config import settings
from ..models.schemas import AccountSummary, Order, OrderSide, Position, SpreadPosition, Trade
from ..nautilus import ib_options
from ..nautilus.ib_node import ib_node

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["portfolio"])


_EMPTY_ACCOUNT = {
    "balance": 0.0,
    "equity": 0.0,
    "buying_power": 0.0,
    "unrealized_pnl": 0.0,
    "realized_pnl": 0.0,
    "total_trades": 0,
    "win_rate": 0.0,
    "mode": "paper",
}


def _to_position(raw: Dict[str, Any]) -> Position:
    """Map IBKR's raw position dict to our Position schema."""
    qty = float(raw.get("quantity", 0) or 0)
    return Position(
        symbol=str(raw.get("symbol", "?")),
        quantity=qty,
        avg_price=float(raw.get("avg_price", 0) or 0),
        current_price=float(raw.get("current_price", 0) or 0),
        unrealized_pnl=float(raw.get("unrealized_pnl", 0) or 0),
        unrealized_pnl_pct=float(raw.get("unrealized_pnl_pct", 0) or 0),
        side=OrderSide.BUY if qty >= 0 else OrderSide.SELL,
        sector=raw.get("sector"),
        is_option=bool(raw.get("is_option", False)),
        strike=raw.get("strike"),
        expiry=raw.get("expiry"),
        right=raw.get("right"),
        multiplier=raw.get("multiplier"),
    )


def _to_trade(raw: Dict[str, Any]) -> Trade:
    ts = raw.get("timestamp")
    if isinstance(ts, str):
        try:
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            ts = datetime.now(timezone.utc)
    elif ts is None:
        ts = datetime.now(timezone.utc)
    side = OrderSide.BUY if str(raw.get("side", "BUY")).upper() == "BUY" else OrderSide.SELL
    return Trade(
        id=str(raw.get("id", uuid.uuid4().hex[:8])),
        symbol=str(raw.get("symbol", "?")),
        side=side,
        quantity=float(raw.get("quantity", 0) or 0),
        price=float(raw.get("price", 0) or 0),
        pnl=(float(raw["pnl"]) if raw.get("pnl") is not None else None),
        timestamp=ts,
        strategy=raw.get("strategy"),
    )


@router.get(
    "/positions",
    response_model=List[Position],
    summary="List open positions",
    description=(
        "Live positions from IBKR. Returns an empty list when the gateway "
        "is disconnected. Option positions include strike / expiry / right / multiplier."
    ),
)
async def get_positions():
    from ..main import _refresh_position_marks  # local to avoid cycle at import
    # Always read positions from ib_async (single source of truth — see
    # the WS broadcaster in main.py for the same logic). Nautilus's
    # latest_positions() is unreliable when InstrumentProvider rejects
    # option contracts.
    try:
        raw = await ib_options.get_positions()
    except Exception as e:  # noqa: BLE001
        logger.warning("get_positions failed at ib_async read: %s", e)
        return []
    try:
        raw = await _refresh_position_marks(raw)
    except Exception as e:  # noqa: BLE001
        # Mark refresh is best-effort — fall through with stale marks
        # rather than 500ing the dashboard's positions table.
        logger.warning("_refresh_position_marks failed: %s", e)
    out: List[Position] = []
    for p in raw:
        try:
            out.append(_to_position(p))
        except Exception as e:  # noqa: BLE001
            logger.warning("position row map failed for %s: %s", p, e)
    return out


@router.get(
    "/orders",
    response_model=List[Order],
    summary="List recent orders (read-only)",
    description="Order placement isn't exposed — this endpoint always returns an empty list.",
)
def get_orders():
    return []


@router.get(
    "/spreads",
    response_model=List[SpreadPosition],
    summary="List multi-leg option spreads",
    description=(
        "Tracked by the strategy engine. Returns an empty list until the engine is enabled."
    ),
)
def get_spreads():
    return []


@router.get(
    "/trades",
    response_model=List[Trade],
    summary="List recent trades",
    description="Fills from the IBKR Gateway. Empty when the gateway is disconnected.",
)
def get_trades():
    if ib_node.is_connected:
        live = ib_node.latest_trades()
        if live:
            return [_to_trade(t) for t in live]
    return []


@router.get(
    "/account",
    response_model=AccountSummary,
    summary="Account summary (equity, BP, P&L)",
    description=(
        "Reads directly from ib_async's ``accountSummaryAsync`` so EQ/BP reflect IBKR's own "
        "NetLiquidation / BuyingPower tags, not Nautilus's cash-only "
        "``balances_total / balances_free`` abstraction. Returns zeroed fields when "
        "the gateway is disconnected."
    ),
)
async def get_account() -> AccountSummary:
    if ib_node.is_connected:
        acct = await ib_options.get_account_summary()
        if acct is None:
            # Fall back to the NT-sourced view so the dashboard stays populated
            # if the ib_async client briefly drops while NT is still up.
            acct = ib_node.latest_account()
        positions = await ib_options.get_positions()
        if positions:
            from ..main import _refresh_position_marks  # local to avoid cycle at import
            positions = await _refresh_position_marks(positions)
        upnl = sum(float(p.get("unrealized_pnl", 0)) for p in positions)
        if acct:
            merged = {
                **_EMPTY_ACCOUNT,
                **acct,
                "unrealized_pnl": round(upnl, 2),
                "mode": acct.get("mode") or settings.trading_mode,
            }
            return AccountSummary(**merged)
    return AccountSummary(**{**_EMPTY_ACCOUNT, "mode": settings.trading_mode})
