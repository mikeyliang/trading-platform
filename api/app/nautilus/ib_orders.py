"""
Multi-leg options order placement via ib_async BAG (combo) orders.

Why ib_async and not the NT IB exec client: NT's options-spread support
requires constructing OptionsSpread instruments and registering each leg
with the InstrumentProvider, which is heavy ceremony for ad-hoc retail
spreads. ib_async exposes the IB combo API (ComboLeg + Bag contract) as
two-line calls. We share the gateway socket via a separate client_id.

A bull put spread is a credit spread:
  - SELL 1 PUT at higher strike (short put, ~25 delta)
  - BUY  1 PUT at lower strike  (long put,  ~10 delta)
  - Same expiration, same underlying
  - Net credit; max loss = (short_strike - long_strike) - net_credit

We submit it as a single Bag order with a net-credit limit price, so both
legs fill together or not at all (no leg risk).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from ..config import settings
from ..ws.trades import trades_channel

logger = logging.getLogger(__name__)

try:
    from ib_async import (  # type: ignore
        Bag, ComboLeg, IB, LimitOrder, MarketOrder, Option, Stock,
    )
    IB_ASYNC_AVAILABLE = True
except Exception as e:  # noqa: BLE001
    IB_ASYNC_AVAILABLE = False
    logger.warning(f"ib_async unavailable, options orders disabled: {e}")


# Distinct from the chain-query client (50) and NT clients (1, 2).
_ORDERS_CLIENT_ID = 51


@dataclass
class SpreadLeg:
    strike: float
    right: Literal["C", "P"]
    action: Literal["BUY", "SELL"]
    con_id: int = 0  # filled after qualifyContracts


@dataclass
class OpenSpread:
    """In-memory record of an open multi-leg spread."""
    id: str
    symbol: str
    expiry: str            # YYYYMMDD
    spread_type: str       # "bull_put", "bear_call", etc.
    legs: List[SpreadLeg]
    quantity: int
    credit_received: float  # positive number, per spread, in dollars
    opened_at: str
    underlying_at_open: float
    status: Literal["open", "closing", "closed"] = "open"
    close_credit: Optional[float] = None  # what we paid to close (negative for debit)

    @property
    def short_strike(self) -> float:
        return next(leg.strike for leg in self.legs if leg.action == "SELL")

    @property
    def long_strike(self) -> float:
        return next(leg.strike for leg in self.legs if leg.action == "BUY")

    @property
    def width(self) -> float:
        return abs(self.short_strike - self.long_strike)

    @property
    def max_loss(self) -> float:
        return (self.width - self.credit_received) * 100 * self.quantity

    @property
    def max_profit(self) -> float:
        return self.credit_received * 100 * self.quantity

    def to_dict(self) -> Dict[str, Any]:
        return {
            **asdict(self),
            "short_strike": self.short_strike,
            "long_strike": self.long_strike,
            "width": self.width,
            "max_loss": self.max_loss,
            "max_profit": self.max_profit,
        }


class OrdersClient:
    """Lazy ib_async connection for options order placement."""

    def __init__(self):
        self._ib: Optional[Any] = None
        self._open: Dict[str, OpenSpread] = {}
        self._error_handler_attached: bool = False

    def _attach_trade_handlers(self, ib: Any, trade: Any) -> None:
        """Wire fill/cancel events on a Trade and (once per IB connection)
        the connection-level errorEvent to the trades WS channel.

        ib_async dispatches coroutine handlers via asyncio.ensure_future,
        so the async broadcast_* methods can be attached directly.
        """
        async def on_fill(t: Any, fill: Any) -> None:
            try:
                exe = getattr(fill, "execution", None)
                await trades_channel.broadcast_fill({
                    "order_id": str(t.order.orderId),
                    "symbol": getattr(t.contract, "symbol", ""),
                    "shares": float(getattr(exe, "shares", 0) or 0),
                    "price": float(getattr(exe, "price", 0) or 0),
                    "side": getattr(exe, "side", ""),
                    "time": exe.time.isoformat() if exe and getattr(exe, "time", None) else None,
                })
            except Exception as e:  # noqa: BLE001
                logger.debug("broadcast_fill failed: %s", e)

        async def on_cancel(t: Any) -> None:
            try:
                await trades_channel.broadcast_cancel({
                    "order_id": str(t.order.orderId),
                    "symbol": getattr(t.contract, "symbol", ""),
                    "status": getattr(t.orderStatus, "status", "Cancelled"),
                })
            except Exception as e:  # noqa: BLE001
                logger.debug("broadcast_cancel failed: %s", e)

        trade.filledEvent += on_fill
        trade.cancelledEvent += on_cancel

        if not self._error_handler_attached:
            async def on_error(reqId: int, errorCode: int, errorString: str, contract: Any) -> None:
                try:
                    await trades_channel.broadcast_error({
                        "req_id": reqId,
                        "code": errorCode,
                        "message": errorString,
                        "symbol": getattr(contract, "symbol", "") if contract else "",
                    })
                except Exception as e:  # noqa: BLE001
                    logger.debug("broadcast_error failed: %s", e)

            ib.errorEvent += on_error
            self._error_handler_attached = True

    async def connect(self):
        if not IB_ASYNC_AVAILABLE or settings.mock_mode:
            return None
        if self._ib is not None and self._ib.isConnected():
            return self._ib
        ib = IB()
        try:
            await ib.connectAsync(
                settings.ib_gateway_host,
                settings.ib_gateway_port,
                clientId=_ORDERS_CLIENT_ID,
                timeout=10,
            )
            self._ib = ib
            logger.info("orders client connected to gateway")
            return ib
        except Exception as e:  # noqa: BLE001
            logger.warning("orders client connect failed: %s", e)
            return None

    async def disconnect(self):
        if self._ib and self._ib.isConnected():
            self._ib.disconnect()
        self._ib = None
        self._error_handler_attached = False

    # -- stocks -----------------------------------------------------------

    async def place_stock_order(
        self,
        symbol: str,
        quantity: float,
        side: Literal["BUY", "SELL"],
        order_type: Literal["MARKET", "LIMIT"],
        limit_price: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """Place a single-leg stock order. Returns ``{order_id, status}`` or
        ``None`` when the gateway isn't reachable (mock_mode or down)."""
        if order_type == "LIMIT" and limit_price is None:
            raise ValueError("limit_price required for LIMIT orders")

        ib = await self.connect()
        if ib is None:
            return None

        contract = Stock(symbol.upper(), "SMART", "USD")
        await ib.qualifyContractsAsync(contract)
        if not getattr(contract, "conId", 0):
            logger.error("could not qualify stock contract for %s", symbol)
            return None

        if order_type == "LIMIT":
            order = LimitOrder(
                action=side,
                totalQuantity=quantity,
                lmtPrice=round(float(limit_price), 4),
                tif="DAY",
                transmit=True,
            )
        else:
            order = MarketOrder(action=side, totalQuantity=quantity, tif="DAY")

        trade = ib.placeOrder(contract, order)
        self._attach_trade_handlers(ib, trade)
        logger.info(
            "submitted stock order %s %s %s type=%s limit=%s orderId=%s",
            side, quantity, symbol.upper(),
            order_type, limit_price, trade.order.orderId,
        )
        return {
            "order_id": str(trade.order.orderId),
            "status": getattr(trade.orderStatus, "status", None) or "Submitted",
        }

    # -- spreads ----------------------------------------------------------

    def list_open(self) -> List[OpenSpread]:
        return [s for s in self._open.values() if s.status == "open"]

    def get(self, spread_id: str) -> Optional[OpenSpread]:
        return self._open.get(spread_id)

    async def place_bull_put_spread(
        self,
        symbol: str,
        expiry: str,
        short_strike: float,
        long_strike: float,
        quantity: int,
        limit_credit: float,
        underlying_price: Optional[float] = None,
    ) -> Optional[OpenSpread]:
        """Place a bull put spread as a Bag (combo) order.

        limit_credit is positive (e.g. 1.20 = $1.20 net credit per spread).
        IB combo limit price for credit spreads is entered as a NEGATIVE number
        for SELL action (we receive premium), but ib_async normalizes this:
        we submit action='SELL' on the Bag with limitPrice = -limit_credit.
        """
        if short_strike <= long_strike:
            raise ValueError("bull put spread requires short_strike > long_strike")

        ib = await self.connect()
        if ib is None:
            return None

        # 1. qualify the underlying + both option legs to get conIds
        underlying = Stock(symbol.upper(), "SMART", "USD")
        await ib.qualifyContractsAsync(underlying)

        short_put = Option(symbol.upper(), expiry, short_strike, "P", "SMART", "100", "USD")
        long_put = Option(symbol.upper(), expiry, long_strike, "P", "SMART", "100", "USD")
        qualified = await ib.qualifyContractsAsync(short_put, long_put)
        if not all(getattr(c, "conId", 0) for c in qualified):
            logger.error("could not qualify spread legs for %s %s %s/%s",
                         symbol, expiry, short_strike, long_strike)
            return None

        # 2. build the Bag contract
        bag = Bag(
            symbol=symbol.upper(),
            currency="USD",
            exchange="SMART",
            comboLegs=[
                ComboLeg(conId=short_put.conId, ratio=1, action="SELL", exchange="SMART"),
                ComboLeg(conId=long_put.conId, ratio=1, action="BUY", exchange="SMART"),
            ],
        )

        # 3. submit. SELL the bag at +limit means we receive credit; in IB combo
        # convention for credit spreads we use action SELL with positive limit price.
        order = LimitOrder(
            action="SELL",
            totalQuantity=quantity,
            lmtPrice=round(limit_credit, 2),
            tif="DAY",
            transmit=True,
        )

        trade = ib.placeOrder(bag, order)
        self._attach_trade_handlers(ib, trade)
        # fire and don't await fill — strategy loop polls. Capture the trade
        # so we can read fill events later if needed.
        logger.info("submitted bull-put-spread %s %s %s/%s qty=%s credit=%.2f orderId=%s",
                    symbol, expiry, short_strike, long_strike, quantity, limit_credit,
                    trade.order.orderId)

        spread = OpenSpread(
            id=f"sp_{uuid.uuid4().hex[:8]}",
            symbol=symbol.upper(),
            expiry=expiry,
            spread_type="bull_put",
            legs=[
                SpreadLeg(strike=short_strike, right="P", action="SELL", con_id=short_put.conId),
                SpreadLeg(strike=long_strike,  right="P", action="BUY",  con_id=long_put.conId),
            ],
            quantity=quantity,
            credit_received=round(limit_credit, 2),
            opened_at=datetime.now(timezone.utc).isoformat(),
            underlying_at_open=underlying_price or 0.0,
        )
        self._open[spread.id] = spread
        return spread

    async def close_spread(self, spread_id: str, limit_debit: float) -> bool:
        """Close an open spread by submitting the reverse Bag at limit_debit (positive number)."""
        spread = self._open.get(spread_id)
        if not spread or spread.status != "open":
            return False

        ib = await self.connect()
        if ib is None:
            return False

        # reverse legs: BUY back the short, SELL the long
        bag = Bag(
            symbol=spread.symbol,
            currency="USD",
            exchange="SMART",
            comboLegs=[
                ComboLeg(conId=leg.con_id, ratio=1,
                         action="BUY" if leg.action == "SELL" else "SELL",
                         exchange="SMART")
                for leg in spread.legs
            ],
        )
        # closing a credit spread means buying it back — pay debit, action=BUY, positive limit
        order = LimitOrder(
            action="BUY",
            totalQuantity=spread.quantity,
            lmtPrice=round(limit_debit, 2),
            tif="DAY",
            transmit=True,
        )
        trade = ib.placeOrder(bag, order)
        self._attach_trade_handlers(ib, trade)
        spread.status = "closing"
        spread.close_credit = -round(limit_debit, 2)
        logger.info("closing spread %s at debit %.2f", spread_id, limit_debit)
        return True

    def mark_closed(self, spread_id: str):
        spread = self._open.get(spread_id)
        if spread:
            spread.status = "closed"


orders_client = OrdersClient()
