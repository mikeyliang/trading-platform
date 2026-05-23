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
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from ..config import settings

logger = logging.getLogger(__name__)

try:
    from ib_async import (  # type: ignore
        Bag, ComboLeg, IB, LimitOrder, Option, Stock,
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
        return next(l.strike for l in self.legs if l.action == "SELL")

    @property
    def long_strike(self) -> float:
        return next(l.strike for l in self.legs if l.action == "BUY")

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
                ComboLeg(conId=l.con_id, ratio=1,
                         action="BUY" if l.action == "SELL" else "SELL",
                         exchange="SMART")
                for l in spread.legs
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
        ib.placeOrder(bag, order)
        spread.status = "closing"
        spread.close_credit = -round(limit_debit, 2)
        logger.info("closing spread %s at debit %.2f", spread_id, limit_debit)
        return True

    def mark_closed(self, spread_id: str):
        spread = self._open.get(spread_id)
        if spread:
            spread.status = "closed"


orders_client = OrdersClient()
