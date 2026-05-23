"""
Tick-by-tick (Time & Sales) helper.

IBKR streams individual prints via ``reqTickByTickData(contract, 'AllLast')``.
ib_async wraps them with the ``tickByTickAllLastEvent`` global event and also
appends each tick to ``ticker.tickByTicks`` on the ticker object.

We hold one subscription per symbol, keep a rolling deque of the last N
prints, and fan-out new prints to any WebSocket subscribers. Each print is
tagged with an aggressor side ("buy" if at/above ask, "sell" if at/below
bid, "mid" otherwise) computed against the latest quote — that's what makes
a tape readable.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional, Set

from fastapi import WebSocket

from ..config import settings

logger = logging.getLogger(__name__)

try:
    from ib_async import IB  # type: ignore
    from .ib_options import _resolve_contract
    IB_ASYNC_AVAILABLE = True
except Exception as e:  # noqa: BLE001
    IB_ASYNC_AVAILABLE = False
    logger.warning(f"ib_async not available, tick endpoints will return empty: {e}")


_TICKS_CLIENT_ID = 61
ROLLING_TAPE_LEN = 500
# Number of recent prints returned by REST snapshot — UI usually shows ~50.
DEFAULT_RECENT_N = 100


class _IBClient:
    def __init__(self):
        self._ib: Optional[Any] = None
        self._lock = asyncio.Lock()

    async def get(self):
        if not IB_ASYNC_AVAILABLE or settings.mock_mode:
            return None
        async with self._lock:
            if self._ib is not None and self._ib.isConnected():
                return self._ib
            ib = IB()
            try:
                await ib.connectAsync(
                    settings.ib_gateway_host,
                    settings.ib_gateway_port,
                    clientId=_TICKS_CLIENT_ID,
                    timeout=10,
                )
                self._ib = ib
                logger.info("ticks client connected to %s:%s",
                            settings.ib_gateway_host, settings.ib_gateway_port)
                return ib
            except Exception as e:  # noqa: BLE001
                logger.warning("ticks client connect failed: %s", e)
                return None

    async def disconnect(self):
        if self._ib and self._ib.isConnected():
            self._ib.disconnect()
        self._ib = None


_client = _IBClient()


@dataclass
class _TickSub:
    symbol: str
    ticker: Any = None
    quote_ticker: Any = None  # separate top-of-book subscription for aggressor tagging
    contract: Any = None
    tape: Deque[Dict[str, Any]] = field(default_factory=lambda: deque(maxlen=ROLLING_TAPE_LEN))
    subscribers: Set[WebSocket] = field(default_factory=set)


_subs: Dict[str, _TickSub] = {}
_lock = asyncio.Lock()


def _classify_side(price: float, bid: Optional[float], ask: Optional[float]) -> str:
    if ask is not None and price >= ask:
        return "buy"
    if bid is not None and price <= bid:
        return "sell"
    return "mid"


async def _ensure_sub(symbol: str) -> Optional[_TickSub]:
    symbol = symbol.upper()
    if symbol in _subs and _subs[symbol].ticker is not None:
        return _subs[symbol]

    ib = await _client.get()
    if ib is None:
        return None

    async with _lock:
        if symbol in _subs and _subs[symbol].ticker is not None:
            return _subs[symbol]

        sub = _subs.get(symbol) or _TickSub(symbol=symbol)
        try:
            contract = _resolve_contract(symbol)
            await ib.qualifyContractsAsync(contract)
            # AllLast includes pre/post prints (Last is regular-session only).
            ticker = ib.reqTickByTickData(contract, "AllLast", 0, False)
            # Lightweight top-of-book stream for bid/ask side classification.
            quote_ticker = ib.reqMktData(contract, "", snapshot=False, regulatorySnapshot=False)
            sub.contract = contract
            sub.ticker = ticker
            sub.quote_ticker = quote_ticker

            def _on_tick(tk, tbt):
                # tbt is the latest TickByTickAllLast object; ticker.tickByTicks
                # also accumulates, but we only need the freshest one.
                try:
                    price = float(getattr(tbt, "price", float("nan")))
                    size = float(getattr(tbt, "size", 0) or 0)
                except (TypeError, ValueError):
                    return
                if price != price or price <= 0:
                    return
                ts = getattr(tbt, "time", None)
                try:
                    ts_f = ts.timestamp() if hasattr(ts, "timestamp") else time.time()
                except Exception:  # noqa: BLE001
                    ts_f = time.time()

                bid = _safe(getattr(quote_ticker, "bid", None))
                ask = _safe(getattr(quote_ticker, "ask", None))
                side = _classify_side(price, bid, ask)

                # IBKR encodes special-condition flags via the attribute mask
                # (PastLimit, Unreported, etc). Surface the raw bit so the UI
                # can dim odd-lot or non-regular prints if needed.
                attrs = getattr(tbt, "tickAttribLast", None)
                cond = []
                if attrs is not None:
                    if getattr(attrs, "pastLimit", False):
                        cond.append("past_limit")
                    if getattr(attrs, "unreported", False):
                        cond.append("unreported")

                print_row = {
                    "ts": ts_f,
                    "price": round(price, 4),
                    "size": size,
                    "side": side,
                    "bid": bid,
                    "ask": ask,
                    "cond": cond,
                }
                sub.tape.append(print_row)
                if sub.subscribers:
                    asyncio.create_task(_broadcast(sub, print_row))

            ib.tickByTickAllLastEvent += _on_tick
            _subs[symbol] = sub
            return sub
        except Exception as e:  # noqa: BLE001
            logger.warning("reqTickByTickData(%s) failed: %s", symbol, e)
            return None


def _safe(v) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(v)
        if f != f or f < 0:
            return None
        return round(f, 4)
    except (TypeError, ValueError):
        return None


async def _broadcast(sub: _TickSub, row: Dict[str, Any]) -> None:
    dead: List[WebSocket] = []
    for ws in list(sub.subscribers):
        try:
            await ws.send_json({"type": "print", "data": row})
        except Exception:  # noqa: BLE001
            dead.append(ws)
    for ws in dead:
        sub.subscribers.discard(ws)


async def get_recent(symbol: str, n: int = DEFAULT_RECENT_N) -> Dict[str, Any]:
    sub = await _ensure_sub(symbol)
    if sub is None:
        return {"symbol": symbol.upper(), "prints": [], "available": False}
    prints = list(sub.tape)[-n:]
    return {"symbol": symbol.upper(), "prints": prints, "available": True}


async def add_subscriber(symbol: str, ws: WebSocket) -> bool:
    sub = await _ensure_sub(symbol)
    if sub is None:
        return False
    sub.subscribers.add(ws)
    # Hydrate with what we have so the tape isn't blank on first paint.
    try:
        await ws.send_json({
            "type": "tape",
            "data": {"symbol": symbol.upper(), "prints": list(sub.tape)},
        })
    except Exception:  # noqa: BLE001
        sub.subscribers.discard(ws)
        return False
    return True


def remove_subscriber(symbol: str, ws: WebSocket) -> None:
    sub = _subs.get(symbol.upper())
    if sub is not None:
        sub.subscribers.discard(ws)


async def shutdown():
    for sub in _subs.values():
        try:
            if sub.contract is not None:
                ib = await _client.get()
                if ib is not None:
                    ib.cancelTickByTickData(sub.contract, "AllLast")
                    ib.cancelMktData(sub.contract)
        except Exception:  # noqa: BLE001
            pass
    await _client.disconnect()
