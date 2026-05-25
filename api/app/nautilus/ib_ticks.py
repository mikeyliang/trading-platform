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
from .ib_client_base import ResilientIBClient

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


class _TicksClient(ResilientIBClient):
    """Dedicated IB connection for tick-by-tick streams.

    Restores every active tick subscription on reconnect — tickByTickData
    is per-session, so IBKR clears them when the socket drops."""

    async def on_reconnect(self, ib: Any) -> None:
        await _resubscribe_all(ib)


_client = _TicksClient(client_id=_TICKS_CLIENT_ID, name="ticks")


@dataclass
class _TickSub:
    symbol: str
    ticker: Any = None
    quote_ticker: Any = None  # separate top-of-book subscription for aggressor tagging
    contract: Any = None
    tape: Deque[Dict[str, Any]] = field(default_factory=lambda: deque(maxlen=ROLLING_TAPE_LEN))
    subscribers: Set[WebSocket] = field(default_factory=set)
    # The bound tickByTickAllLast callback currently installed on the ib
    # object — kept so we can detach it cleanly during a reconnect.
    handler: Any = None


_subs: Dict[str, _TickSub] = {}
_lock = asyncio.Lock()


def _classify_side(price: float, bid: Optional[float], ask: Optional[float]) -> str:
    if ask is not None and price >= ask:
        return "buy"
    if bid is not None and price <= bid:
        return "sell"
    return "mid"


def _make_tick_handler(sub: "_TickSub"):
    """Build the per-symbol tickByTickAllLast handler.

    ib_async fires ``tickByTickAllLastEvent`` for every symbol on the
    connection, so each handler self-filters by conId. Kept as its own
    factory so the reconnect path can install a fresh handler against the
    new ib object without leaking the stale one."""
    target_conid = getattr(sub.contract, "conId", None) if sub.contract else None

    def _on_tick(tk, tbt):
        # Only handle prints for the contract this sub owns.
        if target_conid is not None:
            tk_conid = getattr(tk.contract, "conId", None) if getattr(tk, "contract", None) else None
            if tk_conid is not None and tk_conid != target_conid:
                return
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

        quote_ticker = sub.quote_ticker
        bid = _safe(getattr(quote_ticker, "bid", None)) if quote_ticker else None
        ask = _safe(getattr(quote_ticker, "ask", None)) if quote_ticker else None
        side = _classify_side(price, bid, ask)

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

    return _on_tick


async def _open_sub(ib: Any, sub: "_TickSub") -> bool:
    """(Re-)open the IBKR tick-by-tick subscription on the given ib handle."""
    symbol = sub.symbol
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
        handler = _make_tick_handler(sub)
        # Drop any handler the previous incarnation installed before
        # attaching the new one — otherwise prints get duplicated after
        # each reconnect.
        prev = sub.handler
        if prev is not None:
            try:
                ib.tickByTickAllLastEvent -= prev
            except Exception:  # noqa: BLE001
                pass
        ib.tickByTickAllLastEvent += handler
        sub.handler = handler
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("reqTickByTickData(%s) failed: %s", symbol, e)
        sub.ticker = None
        sub.contract = None
        sub.quote_ticker = None
        return False


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
        ok = await _open_sub(ib, sub)
        if not ok:
            return None
        _subs[symbol] = sub
        return sub


async def _resubscribe_all(ib: Any) -> None:
    """Replay every tick subscription on a freshly reconnected socket."""
    if not _subs:
        return
    logger.info("ticks: replaying %d subscription(s) after reconnect", len(_subs))
    for sub in list(_subs.values()):
        sub.ticker = None
        sub.contract = None
        sub.quote_ticker = None
        # The old handler was attached to the dead ib object — its
        # reference dies with it, but null the slot so _open_sub doesn't
        # try to detach a stale callback from the new ib.
        sub.handler = None
        await _open_sub(ib, sub)


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


def start_heartbeat() -> None:
    """Start the resilient client's heartbeat loop. Idempotent."""
    _client.start_heartbeat()


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
