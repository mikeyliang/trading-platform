import asyncio
import time
from fastapi import APIRouter, HTTPException
from typing import List, Dict, Optional, Tuple
from ..config import settings
from ..models.schemas import WatchlistAddRequest, WatchlistDeleteResponse, WatchlistItem
from ..nautilus import ib_options
from ..nautilus.ib_node import ib_node
from ..nautilus.mock.data import (
    get_sector_for_symbol, get_name_for_symbol,
    simulate_tick,
)

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

# in-memory store (persisted across requests, reset on restart)
_watchlist: Dict[str, WatchlistItem] = {}

# Quote-snapshot TTL cache. The frontend polls every 15s; without this,
# each poll re-snapshots every symbol from IBKR — at ~1.3s/symbol over a
# ~10-symbol list, that's a 13s response and back-to-back requests pile
# up. A 5s TTL drops typical latency to a single round trip for the
# first request in each window; subsequent polls within the window are
# served from memory.
_QUOTE_TTL = 5.0
_quote_cache: Dict[str, Tuple[float, Optional[float], Optional[float], Optional[float]]] = {}

# seed with default symbols. The first four are the Rule One strategy
# underlyings (RUT/IWM → RUT-family setups, SPX/SPY → Space) and are
# pinned at the top so the strategy overlays are one click away.
def _seed_defaults():
    defaults = ["RUT", "IWM", "SPX", "SPY", "AAPL", "MSFT", "NVDA", "TSLA", "JPM", "XOM", "AMZN"]
    for sym in defaults:
        _watchlist[sym] = WatchlistItem(
            symbol=sym,
            sector=get_sector_for_symbol(sym),
            name=get_name_for_symbol(sym),
        )

_seed_defaults()


async def _fetch_quote(sym: str) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """Resolve last / change_pct / volume for one symbol.

    Try the streaming Nautilus path first (instant if subscribed), fall
    back to a one-shot ib_async snapshot, then the TTL cache for stale
    data. Returns (None, None, None) only when every source fails.
    """
    now = time.monotonic()
    cached = _quote_cache.get(sym)

    last = change_pct = volume = None

    if ib_node.is_connected:
        await ib_node.ensure_subscribed(sym)
        q = ib_node.latest_quote(sym)
        if q:
            last = q.get("last")
            change_pct = q.get("change_pct")
            volume = q.get("volume")
    elif settings.mock_mode:
        tick = simulate_tick(sym)
        last, change_pct, volume = tick["last"], tick["change_pct"], tick["volume"]

    # Snapshot fallback when streaming has nothing yet. ~1-2s per call so
    # we do it in parallel for all symbols (see asyncio.gather in the
    # route handler) instead of serially.
    if last is None and not settings.mock_mode:
        q = await ib_options.get_quote(sym)
        if q:
            last = q.get("last")
            change_pct = q.get("change_pct")
            volume = q.get("volume")

    # Last-resort: re-use a still-warm cached value rather than show null
    # in the UI. The frontend polls every 15s so a 5s-stale price beats
    # an empty row.
    if last is None and cached and (now - cached[0]) < _QUOTE_TTL * 3:
        return cached[1], cached[2], cached[3]

    if last is not None:
        _quote_cache[sym] = (now, last, change_pct, volume)
    return last, change_pct, volume


@router.get(
    "",
    response_model=List[WatchlistItem],
    summary="Get watchlist with live quotes",
    description=(
        "Returns every watchlist symbol with its most recent quote. "
        "Quotes are served from a 5s in-memory cache when warm, otherwise "
        "they're fetched from IBKR in parallel."
    ),
)
async def get_watchlist():
    now = time.monotonic()

    # Serve everything from cache when it's all fresh. Avoids re-hitting
    # IBKR on every 15s frontend poll just to return the same numbers.
    syms = list(_watchlist.keys())
    all_fresh = all(
        sym in _quote_cache and (now - _quote_cache[sym][0]) < _QUOTE_TTL
        for sym in syms
    )
    if all_fresh and syms:
        return [
            WatchlistItem(
                symbol=_watchlist[sym].symbol,
                sector=_watchlist[sym].sector,
                name=_watchlist[sym].name,
                last=_quote_cache[sym][1],
                change_pct=_quote_cache[sym][2],
                volume=_quote_cache[sym][3],
            )
            for sym in syms
        ]

    # Parallel fetch — each symbol's snapshot is independent, so doing
    # them concurrently turns N×1.3s into ~max(1.3s, …) ≈ 1-2s total.
    quotes = await asyncio.gather(*(_fetch_quote(sym) for sym in syms))
    items: List[WatchlistItem] = []
    for sym, (last, change_pct, volume) in zip(syms, quotes):
        item = _watchlist[sym]
        items.append(WatchlistItem(
            symbol=item.symbol,
            sector=item.sector,
            name=item.name,
            last=last,
            change_pct=change_pct,
            volume=volume,
        ))
    return items


@router.post(
    "",
    response_model=WatchlistItem,
    status_code=201,
    summary="Add a symbol to the watchlist",
    description=(
        "Adds ``symbol`` to the in-memory watchlist. Idempotent — re-adding "
        "an existing symbol returns the existing row without modifying it."
    ),
    responses={
        201: {"description": "Symbol added (or already present)."},
        422: {"description": "Symbol failed validation."},
    },
)
def add_to_watchlist(req: WatchlistAddRequest):
    sym = req.symbol.upper()
    if sym in _watchlist:
        return _watchlist[sym]

    item = WatchlistItem(
        symbol=sym,
        sector=req.sector or get_sector_for_symbol(sym),
        name=req.name or get_name_for_symbol(sym),
    )
    _watchlist[sym] = item
    return item


@router.delete(
    "/{symbol}",
    response_model=WatchlistDeleteResponse,
    summary="Remove a symbol from the watchlist",
    responses={404: {"description": "Symbol is not in the watchlist."}},
)
def remove_from_watchlist(symbol: str) -> WatchlistDeleteResponse:
    sym = symbol.upper()
    if sym not in _watchlist:
        raise HTTPException(status_code=404, detail=f"{sym} not in watchlist")
    del _watchlist[sym]
    return WatchlistDeleteResponse(removed=sym)
