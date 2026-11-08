"""Chooses where each polled feed comes from: IBKR Web API first when it is
configured and its session is up, the IB Gateway (ib_async) otherwise.

Routers call these functions instead of ``ib_options`` directly. Each one
returns the same dict shape the Gateway path returned, so nothing
downstream changes. ``last_sources`` records which source answered each
feed most recently; ``/health`` exposes it and the settings page shows it.

Streaming prints, depth of market and order execution are not routed
here: they stay on ib_async by design.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from ..nautilus import ib_options
from ..nautilus.ib_node import ib_node
from . import ibkr_web

logger = logging.getLogger(__name__)

FEEDS = ("account", "positions", "quotes", "bars", "chain")

# feed -> {"source": "web"|"gateway"|"none", "at": epoch}
last_sources: Dict[str, Dict[str, Any]] = {f: {"source": "none", "at": None} for f in FEEDS}


def _note(feed: str, source: str) -> None:
    last_sources[feed] = {"source": source, "at": time.time()}


def web_ready() -> bool:
    c = ibkr_web.client()
    return c.available and c.state.authenticated


async def _try_web(feed: str, coro_factory):
    """Run a Web API call when the Web API is configured. Returns None when
    it is not configured or the call failed, so the caller falls back."""
    c = ibkr_web.client()
    if not c.available:
        return None
    try:
        result = await coro_factory(c)
    except Exception as e:  # noqa: BLE001
        logger.info("Web API %s failed, falling back to gateway: %s", feed, e)
        return None
    if result in (None, [], {}):
        return None
    _note(feed, "web")
    return result


async def account_summary() -> Optional[Dict[str, Any]]:
    acct = await _try_web("account", lambda c: c.account_summary())
    if acct is not None:
        return acct
    if ib_node.is_connected:
        acct = await ib_options.get_account_summary() or ib_node.latest_account()
        if acct:
            _note("account", "gateway")
            return acct
    return None


async def positions() -> List[Dict[str, Any]]:
    rows = await _try_web("positions", lambda c: c.positions())
    if rows is not None:
        return rows
    if ib_node.is_connected:
        rows = await ib_options.get_positions()
        _note("positions", "gateway")
        return rows
    return []


async def web_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """Web API quote or None; the market router keeps its own Gateway path."""
    return await _try_web("quotes", lambda c: c.quote(symbol))


async def web_bars(symbol: str, timeframe: str, days: int) -> Optional[List[Dict[str, Any]]]:
    """Web API bars or None; the market router keeps its proxy and cache logic."""
    return await _try_web("bars", lambda c: c.bars(symbol, timeframe, days))


async def chain(symbol: str, expiration: Optional[str] = None) -> Dict[str, Any]:
    raw = await _try_web("chain", lambda c: _web_chain(c, symbol, expiration))
    if raw is not None:
        return raw
    raw = await ib_options.get_chain(symbol, expiration)
    if _has_chain(raw):
        _note("chain", "gateway")
    return raw


async def _web_chain(c: ibkr_web.IbkrWebClient, symbol: str, expiration: Optional[str]):
    raw = await c.chain(symbol, expiration)
    return raw if _has_chain(raw) else None


def _has_chain(raw: Any) -> bool:
    return bool(raw) and bool(raw.get("expirations") or raw.get("calls") or raw.get("puts"))


def health() -> Dict[str, Any]:
    c = ibkr_web.client()
    return {
        "web_api": c.state.as_dict(),
        "gateway_connected": ib_node.is_connected,
        "sources": {
            f: {**v, "at": _iso(v["at"])} for f, v in last_sources.items()
        },
    }


def _iso(ts: Optional[float]) -> Optional[str]:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None
