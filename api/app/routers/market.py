"""Market data endpoints — IBKR is the sole upstream source.

Bars / quotes come straight from the gateway via ``ib_node``. When the
gateway is unreachable and ``mock_mode`` is on, synthetic data fills in.
Otherwise we return an empty payload so the dashboard can render an
unambiguous "no data" state instead of stale fallbacks.
"""
import asyncio
import logging

from fastapi import APIRouter, Query

from ..config import settings
from ..nautilus import ib_options
from ..nautilus.ib_node import ib_node
from ..nautilus.mock.data import (
    SECTORS, generate_historical_bars, get_all_symbols, simulate_tick,
)
from ..util.cache import TTLCache

logger = logging.getLogger(__name__)

# Per-timeframe TTLs. Daily bars don't change intraday, so a long TTL is
# fine and dramatically cuts IBKR load. Intraday bars stay short so a
# fresh print arrives within a minute.
_BARS_TTL = {
    "1m": 60, "5m": 60, "15m": 120, "30m": 180,
    "1h": 300, "4h": 600, "1d": 3600,
}
_bars_cache = TTLCache(ttl_seconds=300)        # fallback TTL; per-call override below
_indicators_cache = TTLCache(ttl_seconds=300)

# Request coalescing — if /bars and /indicators fire concurrently for the
# same symbol on a cold cache, both miss and both hit IBKR. The inflight
# table holds an asyncio.Future per (symbol, timeframe, days) so the second
# caller awaits the first's result.
_bars_inflight: dict[tuple, asyncio.Future] = {}

# Cash-settled indices many IBKR accounts aren't entitled for. When IBKR
# rejects historical bars for these, fall back to the liquid ETF proxy so
# the chart still has something meaningful. The strategy overlays (fib,
# adjusted-OTM) are scale-invariant so IWM works fine in place of RUT.
_INDEX_PROXY = {"RUT": "IWM", "SPX": "SPY", "NDX": "QQQ", "DJX": "DIA"}

router = APIRouter(prefix="/api/market", tags=["market"])


@router.get("/symbols")
def list_symbols():
    return get_all_symbols()


@router.get("/sectors")
def list_sectors():
    return {
        sector: [{"symbol": s, "name": n} for s, n in stocks]
        for sector, stocks in SECTORS.items()
    }


@router.get("/bars/{symbol}")
async def get_bars(
    symbol: str,
    timeframe: str = Query("15m", description="1m 5m 15m 30m 1h 4h 1d"),
    days: int = Query(30, ge=1, le=3650),
):
    symbol = symbol.upper()
    cache_key = (symbol, timeframe, days)
    cached = _bars_cache.get(cache_key)
    if cached is not None:
        return cached

    # Coalesce concurrent requests so we don't double-hit IBKR when /bars
    # and /indicators both fire on chart mount.
    pending = _bars_inflight.get(cache_key)
    if pending is not None:
        return await pending

    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()
    _bars_inflight[cache_key] = future
    try:
        resp = await _fetch_bars(symbol, timeframe, days, cache_key)
        future.set_result(resp)
        return resp
    except Exception as e:
        future.set_exception(e)
        raise
    finally:
        _bars_inflight.pop(cache_key, None)


async def _fetch_bars(symbol: str, timeframe: str, days: int, cache_key: tuple):
    ttl = _BARS_TTL.get(timeframe, 300)
    if ib_node.is_connected:
        bars = await ib_options.get_bars(symbol, timeframe, days)
        if bars:
            resp = {"symbol": symbol, "timeframe": timeframe, "bars": bars, "source": "ibkr"}
            _bars_cache.set(cache_key, resp, ttl_seconds=ttl)
            return resp
        # IBKR rejected (often: no subscription for the cash index). Try the
        # ETF proxy so the chart still has data; the dashboard sees the
        # requested symbol in the payload with ``proxy_used`` annotated.
        proxy = _INDEX_PROXY.get(symbol)
        if proxy:
            proxy_bars = await ib_options.get_bars(proxy, timeframe, days)
            if proxy_bars:
                resp = {
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "bars": proxy_bars,
                    "source": "ibkr",
                    "proxy_used": proxy,
                }
                _bars_cache.set(cache_key, resp, ttl_seconds=ttl)
                return resp

    if settings.mock_mode:
        bars = generate_historical_bars(symbol, timeframe, days=days)
        return {"symbol": symbol, "timeframe": timeframe, "bars": bars, "source": "synthetic"}

    # Cache "unavailable" briefly so we don't refire every render cycle.
    empty = {"symbol": symbol, "timeframe": timeframe, "bars": [], "source": "unavailable"}
    _bars_cache.set(cache_key, empty, ttl_seconds=30)
    return empty


@router.get("/quote/{symbol}")
async def get_quote(symbol: str):
    symbol = symbol.upper()
    if ib_node.is_connected:
        await ib_node.ensure_subscribed(symbol)
        live = ib_node.latest_quote(symbol)
        if live and live.get("last") is not None:
            return live
        # NT bridge hasn't delivered ticks yet — fall back to an ib_async snapshot.
        snap = await ib_options.get_quote(symbol)
        if snap:
            return snap
    if settings.mock_mode:
        return simulate_tick(symbol)
    return {"symbol": symbol, "last": None, "bid": None, "ask": None, "change_pct": None, "volume": None}


@router.get("/quotes")
async def get_quotes(symbols: str = Query(..., description="comma-separated symbols")):
    syms = [s.strip().upper() for s in symbols.split(",")]
    out = []
    for s in syms:
        if ib_node.is_connected:
            await ib_node.ensure_subscribed(s)
            live = ib_node.latest_quote(s)
            if live and live.get("last") is not None:
                out.append(live)
                continue
            snap = await ib_options.get_quote(s)
            if snap:
                out.append(snap)
                continue
        if settings.mock_mode:
            out.append(simulate_tick(s))
        else:
            out.append({"symbol": s, "last": None, "bid": None, "ask": None, "change_pct": None, "volume": None})
    return out


@router.get("/indicators/{symbol}")
async def get_indicators(
    symbol: str,
    timeframe: str = Query("15m"),
    days: int = Query(30, ge=1, le=90),
):
    from ..nautilus.strategies.smi import (
        compute_ema_series,
        compute_smi_series,
        compute_rsi_series,
        compute_macd_series,
        compute_vwap_series,
    )

    symbol = symbol.upper()
    ind_key = (symbol, timeframe, days)
    cached = _indicators_cache.get(ind_key)
    if cached is not None:
        return cached
    bars_resp = await get_bars(symbol, timeframe, days)
    bars = bars_resp["bars"]
    if len(bars) < 30:
        return {
            "symbol": symbol,
            "smi": [], "smi_signal": [],
            "ema_fast": [], "ema_slow": [],
            "rsi": [],
            "macd": [], "macd_signal": [], "macd_hist": [],
            "vwap": [],
        }

    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    closes = [b["close"] for b in bars]
    volumes = [b.get("volume", 0) for b in bars]
    times = [b["time"] for b in bars]

    smi_data = compute_smi_series(highs, lows, closes)
    ema_f = compute_ema_series(closes, 9)
    ema_s = compute_ema_series(closes, 21)
    rsi = compute_rsi_series(closes, 14)
    macd = compute_macd_series(closes)
    daily_reset = timeframe not in ("1d", "1w", "1mo")
    vwap = compute_vwap_series(highs, lows, closes, volumes, times, daily_reset=daily_reset)

    resp = {
        "symbol": symbol,
        "timeframe": timeframe,
        "smi": [{"time": times[i], "value": smi_data["smi"][i]} for i in range(len(times))],
        "smi_signal": [{"time": times[i], "value": smi_data["signal"][i]} for i in range(len(times))],
        "ema_fast": [{"time": times[i], "value": round(ema_f[i], 2)} for i in range(len(times))],
        "ema_slow": [{"time": times[i], "value": round(ema_s[i], 2)} for i in range(len(times))],
        "rsi": [{"time": times[i], "value": rsi[i]} for i in range(len(times))],
        "macd": [{"time": times[i], "value": macd["macd"][i]} for i in range(len(times))],
        "macd_signal": [{"time": times[i], "value": macd["signal"][i]} for i in range(len(times))],
        "macd_hist": [{"time": times[i], "value": macd["hist"][i]} for i in range(len(times))],
        "vwap": [{"time": times[i], "value": vwap[i]} for i in range(len(times))],
    }
    _indicators_cache.set(ind_key, resp)
    return resp


@router.get("/volume-profile/{symbol}")
async def get_volume_profile(
    symbol: str,
    timeframe: str = Query("15m"),
    days: int = Query(20, ge=1, le=365),
    bins: int = Query(40, ge=10, le=120),
):
    """Volume-by-price histogram over the last ``days`` of bars.

    Buckets each bar's volume into ``bins`` equal-width price bands across
    the high-low range, then derives the POC (point of control — busiest
    band) and value area (70% of volume around the POC). Output is the
    canonical input for a horizontal volume-profile chart.
    """
    symbol = symbol.upper()
    bars_resp = await get_bars(symbol, timeframe, days)
    bars = bars_resp.get("bars") or []
    if len(bars) < 5:
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "days": days,
            "bins": [],
            "poc": None,
            "value_area_low": None,
            "value_area_high": None,
            "total_volume": 0.0,
        }

    hi = max(b["high"] for b in bars)
    lo = min(b["low"] for b in bars)
    if hi <= lo:
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "days": days,
            "bins": [],
            "poc": None,
            "value_area_low": None,
            "value_area_high": None,
            "total_volume": 0.0,
        }

    band = (hi - lo) / bins
    counts = [0.0] * bins
    for b in bars:
        vol = float(b.get("volume", 0) or 0)
        if vol <= 0:
            continue
        # Distribute each bar's volume uniformly across the price bins it
        # spans — a single-band attribution at the close would bias the
        # profile toward end-of-bar prices and obscure ranges.
        b_lo, b_hi = b["low"], b["high"]
        lo_idx = max(0, min(bins - 1, int((b_lo - lo) / band)))
        hi_idx = max(0, min(bins - 1, int((b_hi - lo) / band)))
        span = hi_idx - lo_idx + 1
        per = vol / span
        for i in range(lo_idx, hi_idx + 1):
            counts[i] += per

    profile = []
    for i, c in enumerate(counts):
        p_lo = round(lo + i * band, 2)
        p_hi = round(lo + (i + 1) * band, 2)
        profile.append({"price_low": p_lo, "price_high": p_hi,
                        "price_mid": round((p_lo + p_hi) / 2, 2),
                        "volume": round(c, 2)})

    total = sum(counts)
    poc_idx = max(range(bins), key=lambda i: counts[i])
    poc_price = profile[poc_idx]["price_mid"]

    # Value area: walk outward from POC until cumulative volume reaches 70%
    # of total — IBKR / TradingView convention.
    target = total * 0.70
    cum = counts[poc_idx]
    lo_i = hi_i = poc_idx
    while cum < target and (lo_i > 0 or hi_i < bins - 1):
        left = counts[lo_i - 1] if lo_i > 0 else -1
        right = counts[hi_i + 1] if hi_i < bins - 1 else -1
        if right >= left:
            hi_i += 1
            cum += counts[hi_i]
        else:
            lo_i -= 1
            cum += counts[lo_i]

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "days": days,
        "bins": profile,
        "poc": poc_price,
        "value_area_low": profile[lo_i]["price_low"],
        "value_area_high": profile[hi_i]["price_high"],
        "total_volume": round(total, 2),
    }
