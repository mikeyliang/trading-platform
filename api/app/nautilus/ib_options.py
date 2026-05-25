"""
Options chain + Greeks helper.

NautilusTrader's IB adapter is great for live ticks and execution but the
options chain discovery flow (reqSecDefOptParams + per-strike Greeks) is
much cleaner via ib_async. We open a separate client connection (different
client_id) to the same gateway for these one-shot admin queries.

All entry points are async and degrade to empty results if ib_async or the
gateway isn't reachable.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..config import settings
from .ib_client_base import ResilientIBClient

logger = logging.getLogger(__name__)

try:
    from ib_async import IB, Stock, Index, Option, util  # type: ignore
    IB_ASYNC_AVAILABLE = True
except Exception as e:  # noqa: BLE001
    IB_ASYNC_AVAILABLE = False
    logger.warning(f"ib_async not available, options endpoints will return empty: {e}")


# Use a dedicated client id far from the NT clients (1, 2) to avoid collisions.
_OPTIONS_CLIENT_ID = 50

# Strikes either side of spot to include in the per-expiry chain. Set
# wide enough to reach Rule One Δ-0.05 strikes on the index-wide tickers:
# RUT puts at Δ ~0.10 sit ~300 points below spot at 25-DTE; with $5
# strike spacing that's ~60 strikes. 240 contracts (60 × 2 sides × 2
# rights) snapshot in ~10-15s with the 0.7 ratio early-exit.
STRIKE_WINDOW = 60
# Max seconds to wait for streaming ticks to populate before returning.
# A wider chain means more contracts to populate — bump the deadline so
# the snapshot wave has room to complete on bigger underlyings.
TICK_WAIT_DEADLINE_S = 15.0


class _OptionsClient(ResilientIBClient):
    """Lazy singleton IB connection for options queries.

    No subscriptions to restore on reconnect — every options call here uses
    short-lived snapshot subscriptions that auto-cancel, so a fresh socket
    just works."""


_client = _OptionsClient(client_id=_OPTIONS_CLIENT_ID, name="options")

# Short-lived cache keyed on (symbol, expiration). Repeated clicks on the
# same expiry within CHAIN_CACHE_TTL_S re-use the last result instead of
# hitting IBKR again, which avoids burning the gateway's tickerId space
# and gives the UI an instant refresh.
CHAIN_CACHE_TTL_S = 20.0
_chain_cache: Dict[tuple, tuple[float, Dict[str, Any]]] = {}


async def get_chain(symbol: str, expiration: Optional[str] = None) -> Dict[str, Any]:
    """Return option chain for symbol, optionally filtered to one expiry (YYYYMMDD).

    Shape:
      { symbol, expirations: [YYYYMMDD], strikes: [float], calls: [...], puts: [...] }

    Each call/put: { strike, expiry, bid, ask, last, iv, delta, gamma, theta, vega, oi, vol }
    Greeks are populated only when expiration is given (one-shot reqMktData per contract is heavy).
    """
    cache_key = (symbol.upper(), expiration or "")
    cached = _chain_cache.get(cache_key)
    if cached and (asyncio.get_event_loop().time() - cached[0]) < CHAIN_CACHE_TTL_S:
        return cached[1]

    ib = await _client.get()
    if ib is None:
        return _empty_chain(symbol)

    try:
        # Set market data type at the start of every chain query — closed
        # markets return -1 sentinels on type 1 (realtime), so we always
        # ask for frozen quotes (type 2) which fall back to the last live
        # tick before the market closed. During RTH, frozen returns the
        # same value as realtime, so this is safe in both regimes.
        try:
            ib.reqMarketDataType(2)
        except Exception:  # noqa: BLE001
            pass

        # Cash-settled indices (RUT, SPX, NDX, …) need Index(exchange) not Stock(SMART).
        underlying = _resolve_contract(symbol)
        await ib.qualifyContractsAsync(underlying)

        chains = await ib.reqSecDefOptParamsAsync(
            underlyingSymbol=underlying.symbol,
            futFopExchange="",
            underlyingSecType=underlying.secType,
            underlyingConId=underlying.conId,
        )
        if not chains:
            return _empty_chain(symbol)

        # IBKR returns multiple chain rows per underlying: one per (exchange,
        # tradingClass) combo. For indices like RUT we get RUT (monthly, AM)
        # AND RUTW (weeklies, PM). Prefer the row whose tradingClass matches
        # the requested symbol — that's the canonical monthly chain.
        #
        # Exchange preference: for cash-settled indices, options only resolve
        # when qualified on the index's primary exchange (RUSSELL for RUT,
        # CBOE for SPX). SMART routing does not work for these — qualification
        # returns "No security definition". For stock options, SMART is fine.
        sym_u = symbol.upper()
        primary_exchange = _INDEX_SYMBOLS.get(sym_u)  # RUSSELL, CBOE, NASDAQ…
        if primary_exchange:
            chain = (
                next((c for c in chains if c.tradingClass == sym_u and c.exchange == primary_exchange), None)
                or next((c for c in chains if c.exchange == primary_exchange), None)
                or next((c for c in chains if c.tradingClass == sym_u), None)
                or chains[0]
            )
        else:
            chain = (
                next((c for c in chains if c.tradingClass == sym_u and c.exchange == "SMART"), None)
                or next((c for c in chains if c.tradingClass == sym_u), None)
                or next((c for c in chains if c.exchange == "SMART"), None)
                or chains[0]
            )
        opt_exchange = chain.exchange  # used when building Option contracts below
        opt_multiplier = chain.multiplier or "100"
        opt_trading_class = chain.tradingClass or sym_u
        expirations = sorted(chain.expirations)
        strikes = sorted(chain.strikes)

        # Resolve the spot price up front. Callers without an expiration
        # (e.g. the spread scanner picking monthly expirations) still need
        # it to compute distance_pct, and we'd rather pay the snapshot once
        # than have downstream code error out with "no underlying price".
        underlying_price = await _resolve_underlying_price(ib, underlying, symbol)

        result: Dict[str, Any] = {
            "symbol": symbol.upper(),
            "expirations": expirations,
            "strikes": strikes,
            "calls": [],
            "puts": [],
            "underlying_price": underlying_price,
        }

        if expiration is None:
            return result

        if expiration not in expirations:
            logger.warning("expiration %s not in chain for %s", expiration, symbol)
            return result

        # Narrow to ~15 strikes either side of spot before qualification —
        # qualifying every strike is the bulk of the wall-clock time and
        # produces "Unknown contract" warnings for far-OTM strikes that don't
        # exist for this expiry. If we couldn't resolve spot, take the middle
        # slice of the strike list as a reasonable default.
        strikes = _select_strikes(strikes, underlying_price, window=STRIKE_WINDOW)

        contracts: List[Any] = []
        for k in strikes:
            for right in ("C", "P"):
                opt = Option(symbol.upper(), expiration, k, right, opt_exchange, opt_multiplier, "USD")
                # tradingClass disambiguates index options (e.g. SPX vs SPXW).
                opt.tradingClass = opt_trading_class
                contracts.append(opt)

        # Qualify in batches to respect IB pacing — but run the batches
        # concurrently so wall-clock time is bounded by the slowest batch
        # rather than the sum. IB internally serializes the underlying
        # request stream, so concurrency here is safe and just avoids
        # per-batch round-trip latency stacking up.
        async def _qualify_batch(batch: List[Any]) -> List[Any]:
            try:
                return list(await ib.qualifyContractsAsync(*batch))
            except Exception as e:  # noqa: BLE001
                logger.debug("qualify batch failed: %s", e)
                return []

        batch_results = await asyncio.gather(
            *(_qualify_batch(b) for b in _chunked(contracts, 50))
        )
        qualified = [c for batch in batch_results for c in batch if getattr(c, "conId", 0)]

        # Single snapshot pass: bid/ask/last + model greeks. Snapshots auto-
        # close on the gateway, so we don't have to track or cancel each
        # subscription — that keeps the IB tickerId space clean across
        # repeated chain requests. We drop generic-tick volume/open-interest
        # to avoid Warning 321 (snapshot+generic ticks unsupported).
        tickers = [ib.reqMktData(c, "", snapshot=True, regulatorySnapshot=False)
                   for c in qualified]
        await _wait_for_ticks(tickers, deadline_s=TICK_WAIT_DEADLINE_S, ratio=0.7)

        for c, t in zip(qualified, tickers):
            row = _ticker_to_row(c, t)
            (result["calls"] if c.right == "C" else result["puts"]).append(row)

        result["calls"].sort(key=lambda r: r["strike"])
        result["puts"].sort(key=lambda r: r["strike"])
        _chain_cache[cache_key] = (asyncio.get_event_loop().time(), result)
        return result

    except Exception as e:  # noqa: BLE001
        logger.exception("get_chain(%s) failed: %s", symbol, e)
        return _empty_chain(symbol)


def _merge_ticker(snap: Any, stream: Any) -> Any:
    """Combine a snapshot ticker (bid/ask/last + greeks) with a streaming
    ticker (option-vol / open-interest generic ticks). Returns a proxy whose
    attribute lookups prefer ``snap`` and fall back to ``stream`` when the
    snap field is None/NaN.
    """
    class _Proxy:
        def __getattr__(self, name):
            v = getattr(snap, name, None)
            if v is None or (isinstance(v, float) and v != v):
                return getattr(stream, name, None)
            return v
    return _Proxy()


def _ticker_to_row(contract: Any, ticker: Any) -> Dict[str, Any]:
    greeks = ticker.modelGreeks or ticker.bidGreeks or ticker.askGreeks
    bid = _safe_price(ticker.bid)
    ask = _safe_price(ticker.ask)
    last = _safe_price(ticker.last)
    mid = None
    if bid and ask:
        mid = (bid + ask) / 2
    elif last:
        mid = last
    elif bid:
        mid = bid
    elif ask:
        mid = ask
    return {
        "strike": float(contract.strike),
        "expiry": contract.lastTradeDateOrContractMonth,
        "right": contract.right,
        "bid": _safe_price(ticker.bid),
        "ask": _safe_price(ticker.ask),
        "last": _safe_price(ticker.last),
        "iv": _safe(getattr(greeks, "impliedVol", None)) if greeks else None,
        "delta": _safe(getattr(greeks, "delta", None)) if greeks else None,
        "gamma": _safe(getattr(greeks, "gamma", None)) if greeks else None,
        "theta": _safe(getattr(greeks, "theta", None)) if greeks else None,
        "vega": _safe(getattr(greeks, "vega", None)) if greeks else None,
        "oi": _safe_price(getattr(ticker, "callOpenInterest", None)
                          if contract.right == "C"
                          else getattr(ticker, "putOpenInterest", None)),
        "vol": _safe_price(ticker.volume),
        "mid": round(mid, 4) if mid else None,
    }


async def _resolve_underlying_price(ib: Any, underlying: Any, symbol: str) -> Optional[float]:
    """Best-effort spot lookup: snapshot first, daily-close bar fallback."""
    try:
        ticker = ib.reqMktData(underlying, "", snapshot=True, regulatorySnapshot=False)
        await asyncio.sleep(1.5)
        for candidate in (ticker.last, ticker.marketPrice(), ticker.close, ticker.bid, ticker.ask):
            v = _safe_price(candidate)
            if v is not None:
                ib.cancelMktData(underlying)
                return v
        ib.cancelMktData(underlying)
    except Exception:  # noqa: BLE001
        pass
    try:
        bars = await get_bars(symbol, "1d", 5)
        if bars:
            return float(bars[-1]["close"])
    except Exception:  # noqa: BLE001
        pass
    return None


def _select_strikes(strikes: List[float], spot: Optional[float], window: int) -> List[float]:
    """Pick ``window`` strikes either side of spot, or the centre slice if spot is unknown."""
    if not strikes:
        return strikes
    if spot is None:
        mid = len(strikes) // 2
        lo = max(0, mid - window)
        hi = min(len(strikes), mid + window + 1)
        return strikes[lo:hi]
    # nearest by absolute distance, then re-sorted ascending
    by_dist = sorted(strikes, key=lambda k: abs(k - spot))[: window * 2 + 1]
    return sorted(by_dist)


async def _wait_for_ticks(tickers: List[Any], deadline_s: float, ratio: float) -> None:
    """Poll tickers until ``ratio`` of them have usable data or ``deadline_s`` elapses.

    A ticker counts as populated when it has any of bid, ask, last, or model
    delta — that covers both quoted contracts and ones for which only Greeks
    are streaming.
    """
    if not tickers:
        return
    target = max(1, int(len(tickers) * ratio))
    elapsed = 0.0
    step = 0.5
    while elapsed < deadline_s:
        await asyncio.sleep(step)
        elapsed += step
        ready = 0
        for t in tickers:
            if _ticker_has_data(t):
                ready += 1
                if ready >= target:
                    return


def _ticker_has_data(t: Any) -> bool:
    for f in (t.bid, t.ask, t.last):
        v = _safe_price(f)
        if v is not None:
            return True
    greeks = t.modelGreeks or t.bidGreeks or t.askGreeks
    if greeks and _safe(getattr(greeks, "delta", None)) is not None:
        return True
    return False


def _safe(v) -> Optional[float]:
    """Coerce IB's NaN/None sentinels to None. Negatives are kept — put
    delta is in [-1, 0] and theta is almost always negative."""
    if v is None:
        return None
    try:
        f = float(v)
        if f != f:
            return None
        return round(f, 4)
    except (TypeError, ValueError):
        return None


def _safe_price(v) -> Optional[float]:
    """Like ``_safe`` but also treats IBKR's ``-1`` no-quote sentinel as missing.
    Use for bid/ask/last/volume/OI — not for greeks."""
    f = _safe(v)
    if f is None or f < 0:
        return None
    return f


def _chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _empty_chain(symbol: str) -> Dict[str, Any]:
    return {
        "symbol": symbol.upper(),
        "expirations": [],
        "strikes": [],
        "calls": [],
        "puts": [],
        "underlying_price": None,
    }


_INDEX_SYMBOLS = {"RUT": "RUSSELL", "SPX": "CBOE", "NDX": "NASDAQ", "DJX": "CBOE", "VIX": "CBOE"}


def _resolve_contract(symbol: str):
    """Return an ib_async contract for ``symbol``.

    Cash-settled indices need ``Index`` with their primary exchange; equities
    and ETFs route via SMART. Anything not in the index map is treated as a
    stock.
    """
    s = symbol.upper().lstrip("^")
    if s in _INDEX_SYMBOLS:
        return Index(s, _INDEX_SYMBOLS[s], "USD")
    return Stock(s, "SMART", "USD")


# ib_async bar-size + duration strings keyed off the app's timeframe codes.
_BAR_SIZE = {
    "1m":  "1 min",
    "5m":  "5 mins",
    "15m": "15 mins",
    "30m": "30 mins",
    "1h":  "1 hour",
    "4h":  "4 hours",
    "1d":  "1 day",
    "1w":  "1 week",
}


def _duration_for(timeframe: str, days: int) -> str:
    """IB historical-data duration string. Caps respect IB's per-request limits."""
    if timeframe in ("1d", "1w"):
        # IB allows up to 15 Y for daily/weekly. Weekly bars want a wider
        # window — 3+ years to render usefully for LEAPs.
        years = max(1, min((days + 364) // 365, 15))
        return f"{years} Y"
    # Minute/hour bars: IB allows up to ~60 days of intraday — cap to 60.
    return f"{min(max(days, 1), 60)} D"


async def get_bars(symbol: str, timeframe: str, days: int) -> list[dict]:
    """Historical OHLCV bars from IBKR via ib_async. Empty list on failure."""
    ib = await _client.get()
    if ib is None:
        return []
    bar_size = _BAR_SIZE.get(timeframe, "15 mins")
    duration = _duration_for(timeframe, days)
    try:
        contract = _resolve_contract(symbol)
        await ib.qualifyContractsAsync(contract)
        bars = await ib.reqHistoricalDataAsync(
            contract,
            endDateTime="",
            durationStr=duration,
            barSizeSetting=bar_size,
            whatToShow="TRADES" if not isinstance(contract, Index) else "MIDPOINT",
            useRTH=True,
            formatDate=2,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("get_bars %s/%s failed: %s", symbol, timeframe, e)
        return []
    out = []
    for b in bars or []:
        ts = b.date
        # ib_async returns date or datetime depending on bar size
        if hasattr(ts, "timestamp"):
            t = int(ts.timestamp())
        else:
            from datetime import datetime as _dt
            t = int(_dt(ts.year, ts.month, ts.day).timestamp())
        out.append({
            "time": t,
            "open": round(float(b.open), 2),
            "high": round(float(b.high), 2),
            "low": round(float(b.low), 2),
            "close": round(float(b.close), 2),
            "volume": float(b.volume) if b.volume else 0.0,
        })
    return out


async def get_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """Snapshot quote from IBKR. Returns None if unavailable.

    IBKR returns NaN for unsubscribed fields, which is not JSON-serializable.
    Every field is routed through ``_safe`` to coerce NaN/None/-1 sentinels
    to ``None`` and the change-pct math only runs on clean numbers.
    """
    ib = await _client.get()
    if ib is None:
        return None
    try:
        # Frozen quotes (type 2) — when the market is closed, realtime
        # (type 1) returns -1 sentinels and the watchlist / position-mark
        # refresh both blank out. Frozen falls back to the last live tick
        # before close, which is what we want for unrealized P&L. During
        # RTH it returns the same value as realtime.
        try:
            ib.reqMarketDataType(2)
        except Exception:  # noqa: BLE001
            pass
        contract = _resolve_contract(symbol)
        await ib.qualifyContractsAsync(contract)
        ticker = ib.reqMktData(contract, "", snapshot=True, regulatorySnapshot=False)
        await asyncio.sleep(1.2)
        last_raw = ticker.last
        if last_raw is None or (isinstance(last_raw, float) and last_raw != last_raw):
            last_raw = ticker.marketPrice()
        if last_raw is None or (isinstance(last_raw, float) and last_raw != last_raw):
            last_raw = ticker.close
        last = _safe_price(last_raw)
        prev = _safe_price(ticker.close)
        change_pct: Optional[float] = None
        change: Optional[float] = None
        if last is not None and prev and prev != 0:
            change_pct = round((last - prev) / prev * 100, 2)
            change = round(last - prev, 4)
        ib.cancelMktData(contract)
        return {
            "symbol": symbol.upper(),
            "last": last,
            "bid": _safe_price(ticker.bid),
            "ask": _safe_price(ticker.ask),
            "change": change,
            "change_pct": change_pct,
            "volume": _safe_price(ticker.volume),
        }
    except Exception as e:  # noqa: BLE001
        logger.warning("get_quote %s failed: %s", symbol, e)
        return None


async def get_positions() -> List[Dict[str, Any]]:
    """Read account positions directly from ib_async.

    Returns dicts shaped to match the ``Position`` schema. The ``symbol``
    field is the underlying ticker (e.g. ``USO``) so it logo-resolves
    and groups multi-leg holdings naturally; option-specific metadata
    (strike, expiry, right, multiplier) is exposed as separate fields the
    UI can render as a subtitle and the analyzer route can deep-link to.
    """
    from .mock.data import get_sector_for_symbol  # local to avoid circular

    ib = await _client.get()
    if ib is None:
        return []
    try:
        raw_positions = await ib.reqPositionsAsync()
    except Exception as e:  # noqa: BLE001
        logger.warning("ib_async positions request failed: %s", e)
        return []

    # Filter out zero-quantity (closed) positions and dedupe by conId —
    # IBKR sometimes sends multiple position updates per contract.
    by_conid: Dict[int, Any] = {}
    for p in raw_positions:
        qty = float(getattr(p, "position", 0) or 0)
        if qty == 0:
            continue
        con = p.contract
        conid = getattr(con, "conId", 0) or id(con)
        by_conid[conid] = p

    out: List[Dict[str, Any]] = []
    for p in by_conid.values():
        con = p.contract
        qty = float(p.position)
        avg = float(getattr(p, "avgCost", 0) or 0)
        sec_type = getattr(con, "secType", "")
        is_option = sec_type == "OPT"
        multiplier = float(getattr(con, "multiplier", "") or 1) or 1
        # For options IBKR reports avgCost as full premium (× multiplier);
        # divide so the UI can render per-contract premium.
        avg_price = avg / multiplier if is_option else avg
        underlying = getattr(con, "symbol", "?")
        row = {
            "symbol": underlying,
            "quantity": qty,
            "avg_price": round(avg_price, 4),
            "current_price": round(avg_price, 4),  # mark refresh happens upstream
            "unrealized_pnl": 0.0,
            "unrealized_pnl_pct": 0.0,
            "sector": get_sector_for_symbol(underlying),
            "is_option": is_option,
            "multiplier": multiplier,
            "_conId": getattr(con, "conId", None),
            "_secType": sec_type,
            "_multiplier": multiplier,
        }
        if is_option:
            row["strike"] = float(getattr(con, "strike", 0) or 0) or None
            row["expiry"] = getattr(con, "lastTradeDateOrContractMonth", "") or None
            row["right"] = getattr(con, "right", "") or None
        out.append(row)
    return out


# Account-summary cache. accountSummaryAsync round-trips IBKR (~200ms) and
# the values barely move tick-to-tick; a short TTL eliminates repeat hits
# from the 5s WS broadcaster + REST /account hydration.
_ACCOUNT_SUMMARY_TTL_S = 3.0
_account_summary_cache: tuple[float, Optional[Dict[str, Any]]] = (0.0, None)


async def get_account_summary() -> Optional[Dict[str, Any]]:
    """Direct IBKR account snapshot via ib_async — bypasses Nautilus's
    ``balances_total / balances_free`` abstraction, which conflates
    NetLiquidation with cash and undercounts margin-aware BuyingPower on
    portfolio/Reg-T accounts (typically 2-4× AvailableFunds).

    Returns the same shape the WS/REST broadcasters merge onto
    ``_EMPTY_ACCOUNT``, i.e. ``equity`` / ``buying_power`` keyed.
    """
    global _account_summary_cache
    ib = await _client.get()
    if ib is None:
        return None
    loop = asyncio.get_event_loop()
    ts, cached = _account_summary_cache
    if cached is not None and (loop.time() - ts) < _ACCOUNT_SUMMARY_TTL_S:
        return cached
    tags: Dict[str, float] = {}
    currency = "USD"
    account_id: Optional[str] = None

    def _absorb(values: List[Any]) -> None:
        """Merge account values into the tag dict. IBKR emits multiple rows
        per tag (one per currency, plus -C/-S segment variants). We prefer
        the USD/base-tag entry; segment suffixes are kept under their own
        keys so callers can still see breakdowns if they want.

        Order of preference for the unsuffixed tag (e.g. ``NetLiquidation``):
          1. an explicit USD entry (these reflect the consolidated USD view),
          2. an entry whose currency is empty/BASE (server-side aggregate),
          3. anything else.
        """
        nonlocal currency, account_id
        priority = {"USD": 3, "": 2, "BASE": 2}
        chosen_priority: Dict[str, int] = {}
        for v in values:
            if account_id is None and getattr(v, "account", None):
                account_id = v.account
            c = getattr(v, "currency", "") or ""
            if c and c != "BASE":
                currency = c
            try:
                val = float(v.value)
            except (TypeError, ValueError):
                continue
            p = priority.get(c, 1)
            if p >= chosen_priority.get(v.tag, 0):
                tags[v.tag] = val
                chosen_priority[v.tag] = p

    # accountValues() is fed by reqAccountUpdates which ib_async auto-issues on
    # connect — so the wrapper cache is populated and the call is non-blocking.
    # accountSummaryAsync is a one-shot req/resp that occasionally times out
    # silently; treat it as a top-up only.
    try:
        _absorb(ib.accountValues())
    except Exception as e:  # noqa: BLE001
        logger.debug("ib.accountValues() raised: %s", e)
    try:
        _absorb(await ib.accountSummaryAsync())
    except Exception as e:  # noqa: BLE001
        logger.debug("accountSummaryAsync raised: %s", e)

    if not tags:
        logger.warning("get_account_summary: ib_async returned no account tags "
                       "(accountValues + accountSummaryAsync both empty)")
        return None

    # IBKR's NetLiquidation occasionally lags or misreports: we've observed
    # GrossPositionValue=0 alongside a non-zero OptionMarketValue, which
    # silently collapses NetLiq down to just TotalCashValue and hides the
    # market value of open positions. Always recompute equity = cash +
    # segment market values so EQ on the dashboard means
    # "cash + what your positions are worth" — and use IBKR's reported
    # NetLiq only when it's strictly larger (it can include accrued cash /
    # dividends we don't sum here).
    cash = tags.get("TotalCashValue") or 0.0
    option_mv = tags.get("OptionMarketValue") or 0.0
    stock_mv = tags.get("StockMarketValue") or 0.0
    fund_mv = tags.get("FundValue") or 0.0
    computed_equity = cash + option_mv + stock_mv + fund_mv
    reported_equity = (
        tags.get("NetLiquidation")
        or tags.get("EquityWithLoanValue")
        or 0.0
    )
    equity = max(reported_equity, computed_equity)

    buying_power = (
        tags.get("BuyingPower")
        or tags.get("AvailableFunds")
        or tags.get("ExcessLiquidity")
        or 0.0
    )
    logger.debug(
        "get_account_summary: equity=%s (reported=%s computed=%s) "
        "BP=%s Cash=%s OptionMV=%s StockMV=%s",
        equity, reported_equity, computed_equity, buying_power,
        cash, option_mv, stock_mv,
    )

    payload = {
        "balance": cash or equity,
        "equity": equity,
        "buying_power": buying_power,
        "locked": tags.get("MaintMarginReq") or 0.0,
        "currency": currency,
        "account_id": account_id,
        "mode": settings.trading_mode,
    }
    _account_summary_cache = (loop.time(), payload)
    return payload


# Snapshot cache for the per-contract direct fetch path. Greeks/IV barely
# change in the few seconds it takes to tweak qty/entry sliders on the UI,
# so a short TTL eliminates the 5-8s round trip on every analyzer re-run.
_OPTION_SNAPSHOT_TTL_S = 30.0
_option_snap_cache: Dict[tuple, tuple[float, Dict[str, Any]]] = {}
_option_snap_inflight: Dict[tuple, asyncio.Future] = {}

# Per-symbol option-chain metadata (exchange + tradingClass) — needed to
# qualify a contract but extremely expensive to fetch (reqSecDefOptParams +
# qualifyContracts roundtrip). Cached for the life of the process; the
# contract spec for an underlying is effectively static.
_chain_meta_cache: Dict[str, tuple[str, str, str]] = {}  # symbol → (exchange, tradingClass, multiplier)

# Single-contract snapshot wait deadline. The chain snapshot uses 8s because
# it waits for ~30 contracts in parallel; one contract usually populates in
# under 2s, so 4s is a healthy upper bound that doesn't punish cold calls.
_SINGLE_TICK_DEADLINE_S = 4.0


async def _get_chain_meta(ib: Any, symbol: str) -> Optional[tuple[str, str, str]]:
    """Resolve (exchange, tradingClass, multiplier) for ``symbol``'s option
    chain. Cached per-process — the underlying's chain spec is static."""
    sym_u = symbol.upper()
    if sym_u in _chain_meta_cache:
        return _chain_meta_cache[sym_u]

    underlying = _resolve_contract(symbol)
    await ib.qualifyContractsAsync(underlying)
    chains = await ib.reqSecDefOptParamsAsync(
        underlyingSymbol=underlying.symbol,
        futFopExchange="",
        underlyingSecType=underlying.secType,
        underlyingConId=underlying.conId,
    )
    if not chains:
        return None

    primary_exchange = _INDEX_SYMBOLS.get(sym_u)
    if primary_exchange:
        chain = (
            next((c for c in chains if c.tradingClass == sym_u and c.exchange == primary_exchange), None)
            or next((c for c in chains if c.exchange == primary_exchange), None)
            or next((c for c in chains if c.tradingClass == sym_u), None)
            or chains[0]
        )
    else:
        chain = (
            next((c for c in chains if c.tradingClass == sym_u and c.exchange == "SMART"), None)
            or next((c for c in chains if c.tradingClass == sym_u), None)
            or next((c for c in chains if c.exchange == "SMART"), None)
            or chains[0]
        )
    meta = (chain.exchange, chain.tradingClass or sym_u, chain.multiplier or "100")
    _chain_meta_cache[sym_u] = meta
    return meta


async def get_option_snapshot(
    symbol: str,
    strike: float,
    expiry: str,
    right: str,
) -> Optional[Dict[str, Any]]:
    """Direct per-contract snapshot for an arbitrary strike — including
    strikes outside the chain endpoint's ±STRIKE_WINDOW band.

    Cached for 30s and request-coalesced, so the analyzer's qty/entry
    sliders don't re-hit IBKR on every keystroke. The chain metadata
    (exchange + tradingClass) is cached for the process lifetime to skip
    the ~1s reqSecDefOptParams + qualify roundtrip after the first call.
    """
    sym_u = symbol.upper()
    right_u = right.upper()
    key = (sym_u, float(strike), expiry, right_u)

    # Fresh-cache hit
    cached = _option_snap_cache.get(key)
    if cached and (asyncio.get_event_loop().time() - cached[0]) < _OPTION_SNAPSHOT_TTL_S:
        return cached[1]

    # Coalesce concurrent calls for the same contract
    pending = _option_snap_inflight.get(key)
    if pending is not None:
        return await pending

    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()
    _option_snap_inflight[key] = future
    try:
        result = await _fetch_option_snapshot(sym_u, float(strike), expiry, right_u)
        if result is not None:
            _option_snap_cache[key] = (loop.time(), result)
        future.set_result(result)
        return result
    except Exception as e:
        future.set_exception(e)
        raise
    finally:
        _option_snap_inflight.pop(key, None)


async def _fetch_option_snapshot(
    sym_u: str, strike: float, expiry: str, right_u: str,
) -> Optional[Dict[str, Any]]:
    ib = await _client.get()
    if ib is None:
        return None
    try:
        # Frozen market data so we get last-known values when the market
        # is closed — same convention used by get_chain.
        try:
            ib.reqMarketDataType(2)
        except Exception:  # noqa: BLE001
            pass

        meta = await _get_chain_meta(ib, sym_u)
        if meta is None:
            return None
        exchange, trading_class, multiplier = meta

        opt = Option(sym_u, expiry, strike, right_u, exchange, multiplier, "USD")
        opt.tradingClass = trading_class
        qualified = await ib.qualifyContractsAsync(opt)
        if not qualified or not getattr(qualified[0], "conId", 0):
            logger.warning("get_option_snapshot: qualify failed for %s %s %s%s",
                           sym_u, expiry, strike, right_u)
            return None
        contract = qualified[0]

        # Snapshots auto-cancel; no need to track / cancel manually.
        ticker = ib.reqMktData(contract, "", snapshot=True, regulatorySnapshot=False)
        await _wait_for_ticks([ticker], deadline_s=_SINGLE_TICK_DEADLINE_S, ratio=1.0)
        return _ticker_to_row(contract, ticker)
    except Exception as e:  # noqa: BLE001
        logger.exception("get_option_snapshot(%s %s %s%s) failed: %s",
                         sym_u, expiry, strike, right_u, e)
        return None


async def get_option_mark(conid: int) -> Optional[float]:
    """Snapshot mark for an option contract identified by conId. Returns
    the mid (or last/bid/ask fallback) per-contract premium, suitable for
    PnL recomputation.
    """
    ib = await _client.get()
    if ib is None or not conid:
        return None
    try:
        try:
            ib.reqMarketDataType(2)  # frozen — last quote before close
        except Exception:  # noqa: BLE001
            pass
        # Build a stub Option from just the conId; IBKR fills in the rest
        # during qualification.
        opt = Option(conId=conid, exchange="SMART")
        qualified = await ib.qualifyContractsAsync(opt)
        if not qualified or not getattr(qualified[0], "conId", 0):
            return None
        contract = qualified[0]
        ticker = ib.reqMktData(contract, "", snapshot=True, regulatorySnapshot=False)
        # Snapshot subscriptions auto-close on the gateway side; no
        # explicit cancelMktData needed (which would race other concurrent
        # callers and trigger "Can't find EId" errors on a shared client).
        for _ in range(16):  # up to 8s
            await asyncio.sleep(0.5)
            if _ticker_has_data(ticker):
                break
        bid = _safe_price(ticker.bid)
        ask = _safe_price(ticker.ask)
        last = _safe_price(ticker.last)
        logger.debug("get_option_mark conid=%s bid=%s ask=%s last=%s", conid, bid, ask, last)
        if bid is not None and ask is not None:
            return round((bid + ask) / 2, 4)
        return last or bid or ask
    except Exception as e:  # noqa: BLE001
        logger.warning("get_option_mark(conid=%s) failed: %s", conid, e)
        return None


def start_heartbeat() -> None:
    """Start the resilient client's heartbeat loop. Idempotent."""
    _client.start_heartbeat()


async def shutdown():
    await _client.disconnect()
