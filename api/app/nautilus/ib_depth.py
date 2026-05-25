"""
Level 2 market-depth helper.

IBKR streams DOM (depth-of-market) updates via ``reqMktDepth``; ib_async
exposes them as ``ticker.domBids`` / ``ticker.domAsks`` lists of
``DOMLevel(price, size, marketMaker)``. We hold one subscription per
symbol and fan-out snapshots to any number of WebSocket clients.

Returns empty levels when no depth subscription is entitled — the UI
renders an "awaiting subscription" empty state in that case rather than
silently showing stale data.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from fastapi import WebSocket

from ..config import settings
from .ib_client_base import ResilientIBClient

logger = logging.getLogger(__name__)

try:
    from ib_async import IB  # type: ignore
    from .ib_options import _resolve_contract  # reuse Stock/Index resolution
    IB_ASYNC_AVAILABLE = True
except Exception as e:  # noqa: BLE001
    IB_ASYNC_AVAILABLE = False
    logger.warning(f"ib_async not available, depth endpoints will return empty: {e}")


# Far from NT clients (1, 2) and ib_options (50).
_DEPTH_CLIENT_ID = 60
# IBKR caps depth at 10 rows for most non-pro entitlements; ArcaBook /
# TotalView allow more but 10 is a sane default for the ladder UI.
DEFAULT_DEPTH_ROWS = 10
# Pushed snapshots are throttled to this interval per symbol — DOM update
# storms can otherwise saturate the WS loop with 50+ msgs/sec.
PUSH_INTERVAL_S = 0.25


class _DepthClient(ResilientIBClient):
    """Dedicated IB connection for depth subscriptions.

    Restores every active DOM subscription on reconnect; without this the
    ladder UI silently freezes whenever the gateway flaps."""

    async def on_reconnect(self, ib: Any) -> None:
        # Replay every known subscription. _resubscribe_all handles the
        # logging / per-symbol error trapping.
        await _resubscribe_all(ib)


_client = _DepthClient(client_id=_DEPTH_CLIENT_ID, name="depth")


@dataclass
class _DepthSub:
    symbol: str
    ticker: Any = None
    contract: Any = None
    subscribers: Set[WebSocket] = field(default_factory=set)
    last_push: float = 0.0
    # Last serialized snapshot — used for REST and for hydration on connect.
    snapshot: Dict[str, Any] = field(default_factory=dict)
    # Remembered numRows so we can replay reqMktDepth after a reconnect.
    rows: int = 10


_subs: Dict[str, _DepthSub] = {}
_lock = asyncio.Lock()


def _serialize(ticker: Any, symbol: str) -> Dict[str, Any]:
    """DOM levels → serializable bids/asks lists, sorted bids-desc / asks-asc."""
    def levels(rows):
        out = []
        for r in rows or []:
            price = getattr(r, "price", None)
            size = getattr(r, "size", None)
            mm = getattr(r, "marketMaker", "") or ""
            if price is None or size is None:
                continue
            try:
                p = float(price)
                s = float(size)
            except (TypeError, ValueError):
                continue
            if p <= 0 or p != p:  # NaN check
                continue
            out.append({"price": round(p, 4), "size": s, "mm": mm})
        return out

    bids = sorted(levels(getattr(ticker, "domBids", None)), key=lambda x: -x["price"])
    asks = sorted(levels(getattr(ticker, "domAsks", None)), key=lambda x:  x["price"])

    bid_size = sum(b["size"] for b in bids) or 0
    ask_size = sum(a["size"] for a in asks) or 0
    imbalance = None
    total = bid_size + ask_size
    if total > 0:
        imbalance = round((bid_size - ask_size) / total, 4)

    return {
        "symbol": symbol,
        "ts": time.time(),
        "bids": bids,
        "asks": asks,
        "bid_size_total": bid_size,
        "ask_size_total": ask_size,
        "imbalance": imbalance,
    }


async def _open_sub(ib: Any, sub: _DepthSub) -> bool:
    """(Re-)open the IBKR depth subscription on the given ib handle and
    wire the update callback into ``sub``. Returns True on success.

    Split out from ``_ensure_sub`` so the reconnect hook can call it
    without needing the global ``_lock`` (we're already under the client
    lock at that point)."""
    symbol = sub.symbol
    try:
        contract = _resolve_contract(symbol)
        await ib.qualifyContractsAsync(contract)
        # isSmartDepth=False is required for index DOM and works fine for
        # equities when the user has a single-exchange entitlement
        # (ArcaBook etc.). isSmartDepth=True requires a SMART depth bundle.
        ticker = ib.reqMktDepth(contract, numRows=sub.rows, isSmartDepth=False)
        sub.contract = contract
        sub.ticker = ticker

        def _on_update(tk):
            # Fires on every DOM update. We throttle the WS fan-out so
            # bursty updates don't drown the event loop.
            now = time.time()
            if now - sub.last_push < PUSH_INTERVAL_S:
                return
            sub.last_push = now
            snap = _serialize(tk, symbol)
            sub.snapshot = snap
            if sub.subscribers:
                asyncio.create_task(_broadcast(sub, snap))

        ticker.updateEvent += _on_update
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("reqMktDepth(%s) failed: %s", symbol, e)
        sub.ticker = None
        sub.contract = None
        return False


async def _ensure_sub(symbol: str, rows: int) -> Optional[_DepthSub]:
    """Open (or return existing) depth subscription for ``symbol``."""
    symbol = symbol.upper()
    if symbol in _subs and _subs[symbol].ticker is not None:
        return _subs[symbol]

    ib = await _client.get()
    if ib is None:
        return None

    async with _lock:
        if symbol in _subs and _subs[symbol].ticker is not None:
            return _subs[symbol]

        sub = _subs.get(symbol) or _DepthSub(symbol=symbol, rows=rows)
        sub.rows = rows
        ok = await _open_sub(ib, sub)
        if not ok:
            return None
        _subs[symbol] = sub
        # Seed the snapshot once so the first REST/WS hit has data.
        await asyncio.sleep(0.5)
        sub.snapshot = _serialize(sub.ticker, symbol)
        return sub


async def _resubscribe_all(ib: Any) -> None:
    """Replay every active depth subscription on a freshly reconnected
    socket. Called from ResilientIBClient.on_reconnect; runs sequentially
    to respect IBKR's per-message pacing."""
    if not _subs:
        return
    logger.info("depth: replaying %d subscription(s) after reconnect", len(_subs))
    for sub in list(_subs.values()):
        # Stale ticker is owned by the dead socket — drop the reference.
        sub.ticker = None
        sub.contract = None
        await _open_sub(ib, sub)


async def _broadcast(sub: _DepthSub, snap: Dict[str, Any]) -> None:
    dead: List[WebSocket] = []
    for ws in list(sub.subscribers):
        try:
            await ws.send_json({"type": "depth", "data": snap})
        except Exception:  # noqa: BLE001
            dead.append(ws)
    for ws in dead:
        sub.subscribers.discard(ws)


async def get_snapshot(symbol: str, rows: int = DEFAULT_DEPTH_ROWS) -> Dict[str, Any]:
    """One-shot REST snapshot. Opens a subscription if needed."""
    sub = await _ensure_sub(symbol, rows)
    if sub is None:
        return {
            "symbol": symbol.upper(),
            "ts": time.time(),
            "bids": [],
            "asks": [],
            "bid_size_total": 0,
            "ask_size_total": 0,
            "imbalance": None,
            "available": False,
        }
    return {**sub.snapshot, "available": True}


async def add_subscriber(symbol: str, ws: WebSocket, rows: int = DEFAULT_DEPTH_ROWS) -> bool:
    sub = await _ensure_sub(symbol, rows)
    if sub is None:
        return False
    sub.subscribers.add(ws)
    # Hydrate with current snapshot so the UI doesn't have to wait for the
    # next DOM update tick.
    try:
        await ws.send_json({"type": "depth", "data": sub.snapshot})
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
                    ib.cancelMktDepth(sub.contract, isSmartDepth=False)
        except Exception:  # noqa: BLE001
            pass
    await _client.disconnect()
