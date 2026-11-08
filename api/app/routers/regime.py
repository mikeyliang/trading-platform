"""Regime context and historical odds for Rule One spreads.

  GET /api/regime/now?symbol=SPX      live VIX / trend plus how each strategy on
                                      that underlying fared in this regime since 2005
  GET /api/regime/odds?strategy=space&delta=21&days_left=14
                                      past trades that sat at the same delta with the
                                      same time left, and what happened to them
  GET /api/regime/open-spreads        every open spread (exit monitor + OKW tracker)
                                      with its delta, cushion, Thursday line and odds
  GET /api/regime/summary             the full evidence tables for the History tab

Live numbers come from the market bars route (Web API first, Gateway second),
so this degrades to history-only when neither is up instead of failing.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query

from ..config import settings
from ..services import market_source, okw_store, spread_history
from ..services import monitor as exit_monitor
from ..services.spread_model import (
    STRATEGIES,
    STRATEGIES_FOR_UNDERLYING,
    index_vol_for,
    last_trade_day,
    normalize_strategy,
    put_delta,
)
from . import market

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/regime", tags=["regime"])

_UNDERLYING_FOR_SYMBOL = {"RUT": "RUT", "IWM": "RUT", "SPX": "SPX", "SPY": "SPX"}
TREND_DAYS = 50  # daily analogue of the 10-week average the replay uses


async def _daily_closes(symbol: str, days: int, allow_proxy: bool = False) -> List[float]:
    """Daily closes from the market bars route, or [] when nothing real is available.

    Synthetic (mock-mode) bars are never used: a made-up VIX would print as a
    regime. ETF-proxy bars are allowed only where the caller wants a trend,
    because SPY levels are not SPX levels.
    """
    try:
        resp = await market.get_bars(symbol, "1d", days)
    except Exception as e:  # noqa: BLE001
        logger.info("regime bars %s unavailable: %s", symbol, e)
        return []
    if resp.get("source") in ("synthetic", "unavailable"):
        return []
    if resp.get("proxy_used") and not allow_proxy:
        return []
    bars = resp.get("bars") or []
    return [float(b["close"]) for b in bars if b.get("close") is not None]


async def _spot(symbol: str) -> Optional[float]:
    if settings.mock_mode:
        return None
    try:
        q = await market_source.web_quote(symbol)
        if q and q.get("last") is not None:
            return float(q["last"])
        q = await market._resolve_quote(symbol)  # pylint: disable=protected-access
        if q and q.get("last") is not None:
            return float(q["last"])
    except Exception as e:  # noqa: BLE001
        logger.info("regime quote %s unavailable: %s", symbol, e)
    return None


async def _is_proxy(symbol: str) -> bool:
    try:
        resp = await market.get_bars(symbol, "1d", 120)
    except Exception:  # noqa: BLE001
        return True
    return bool(resp.get("proxy_used"))


async def live_regime(underlying: str) -> Dict[str, Any]:
    closes, vix, spot, rvx = await asyncio.gather(
        _daily_closes(underlying, 120, allow_proxy=True),
        _daily_closes("VIX", 30),
        _spot(underlying),
        _daily_closes("RVX", 10) if underlying == "RUT" else asyncio.sleep(0, result=[]),
    )
    # Trend compares the series against its own average, so a proxy series is
    # fine there; the spot used for cushions and deltas must be the index itself.
    ma = None
    trend = None
    if len(closes) >= TREND_DAYS:
        window = closes[-TREND_DAYS:]
        ma = sum(window) / len(window)
        trend = "up" if closes[-1] >= ma else "down"
    if spot is None and closes and not (await _is_proxy(underlying)):
        spot = closes[-1]
    vix_now = vix[-1] if vix else None
    vix_week_ago = vix[-6] if len(vix) >= 6 else None
    return {
        "underlying": underlying,
        "spot": round(spot, 2) if spot is not None else None,
        "avg_50d": round(ma, 2) if ma is not None else None,
        "trend": trend,
        "vix": round(vix_now, 2) if vix_now is not None else None,
        "vix_week_ago": round(vix_week_ago, 2) if vix_week_ago is not None else None,
        "vix_bucket": spread_history.vix_bucket(vix_now),
        "rvx": round(rvx[-1], 2) if rvx else None,
        "index_vol": round(index_vol_for(underlying, vix_now, rvx[-1] if rvx else None), 2)
        if vix_now is not None else None,
        "live": spot is not None and vix_now is not None,
        "as_of": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/now")
async def regime_now(symbol: str = Query("SPX", description="RUT / IWM / SPX / SPY")) -> Dict[str, Any]:
    underlying = _UNDERLYING_FOR_SYMBOL.get(symbol.upper())
    if not underlying:
        return {"symbol": symbol.upper(), "underlying": None, "strategies": [], "live": None}
    live = await live_regime(underlying)
    strategies = [
        spread_history.regime_stats(sid, live["vix"], live["trend"])
        for sid in STRATEGIES_FOR_UNDERLYING[underlying]
    ]
    return {
        "symbol": symbol.upper(),
        "underlying": underlying,
        "live": live,
        "coverage": spread_history.coverage(),
        "strategies": strategies,
    }


@router.get("/odds")
async def regime_odds(
    strategy: str = Query(..., description="rut | mars | marsmax | space"),
    delta: float = Query(..., ge=0, le=100, description="short-leg delta in points (0-100)"),
    days_left: int = Query(..., ge=0, le=60),
) -> Dict[str, Any]:
    return spread_history.odds(strategy, delta, days_left)


@router.get("/summary")
async def regime_summary() -> Dict[str, Any]:
    return spread_history.summary()


# ---------------------------------------------------------------------------
# open spreads: exit monitor entries + OKW tracker rows, one shape
# ---------------------------------------------------------------------------

def _parse_expiry(s: str) -> Optional[date]:
    try:
        return datetime.strptime(s, "%Y%m%d").date()
    except (TypeError, ValueError):
        pass
    try:
        return date.fromisoformat(s[:10])
    except (TypeError, ValueError):
        return None


def _row(
    *,
    source: str,
    ref: str,
    symbol: str,
    strategy: Optional[str],
    expiry: Optional[date],
    short_strike: float,
    long_strike: float,
    contracts: int,
    delta: Optional[float],
    delta_source: str,
    spot: Optional[float],
    today: date,
) -> Dict[str, Any]:
    spec = STRATEGIES.get(strategy or "")
    days_left = (expiry - today).days if expiry else None
    cushion = round((spot / short_strike - 1) * 100, 2) if spot and short_strike else None
    buffer_pct = spec.last_day_buffer * 100 if spec else None
    line = round(short_strike * (1 + spec.last_day_buffer), 2) if spec else None
    exit_delta = round(spec.exit_delta * 100) if spec else None
    history = None
    if spec and delta is not None and days_left is not None:
        history = spread_history.odds(spec.id, delta, max(days_left, 0))
    headroom = round(exit_delta - delta, 1) if exit_delta is not None and delta is not None else None
    if delta is None or exit_delta is None:
        status = "unknown"
    elif delta >= exit_delta:
        status = "trigger"
    elif headroom is not None and headroom <= 12:
        status = "warning"
    else:
        status = "safe"
    return {
        "id": f"{source}:{ref}",
        "source": source,
        "symbol": symbol,
        "strategy": spec.id if spec else strategy,
        "strategy_label": spec.label if spec else (strategy or "spread"),
        "expiry": expiry.isoformat() if expiry else None,
        "last_trade_day": last_trade_day(expiry).isoformat() if expiry else None,
        "days_left": days_left,
        "short_strike": short_strike,
        "long_strike": long_strike,
        "contracts": contracts,
        "spot": spot,
        "cushion_pct": cushion,
        "delta": delta,
        "delta_source": delta_source,   # "chain" | "model" | "none"
        "exit_delta": exit_delta,
        "headroom": headroom,
        "status": status,
        "last_day_buffer_pct": buffer_pct,
        "last_day_line": line,
        "history": history,
    }


@router.get("/open-spreads")
async def open_spreads() -> Dict[str, Any]:
    today = date.today()
    rows: List[Dict[str, Any]] = []
    seen: set = set()

    # 1. Exit monitor entries carry a live chain delta.
    for e in exit_monitor.state.entries.values():
        strategy = normalize_strategy(e.spread_type)
        key = (e.symbol.upper(), e.expiry, float(e.short_strike))
        seen.add(key)
        rows.append(_row(
            source="monitor", ref=e.spread_id, symbol=e.symbol.upper(), strategy=strategy,
            expiry=_parse_expiry(e.expiry), short_strike=float(e.short_strike),
            long_strike=float(e.long_strike), contracts=int(e.quantity),
            delta=e.current_delta, delta_source="chain" if e.current_delta is not None else "none",
            spot=e.underlying_price, today=today,
        ))

    # 2. OKW tracker rows have no live delta; model it from spot and VIX.
    try:
        okw_rows = await okw_store.list_trades(status="open", limit=200)
    except Exception as e:  # noqa: BLE001
        logger.info("okw trades unavailable: %s", e)
        okw_rows = []
    regimes: Dict[str, Dict[str, Any]] = {}
    for t in okw_rows:
        symbol = str(t.get("symbol", "")).upper()
        underlying = _UNDERLYING_FOR_SYMBOL.get(symbol, symbol)
        expiry = _parse_expiry(str(t.get("expiry", "")))
        short_strike = float(t.get("short_strike") or 0)
        key = (symbol, expiry.strftime("%Y%m%d") if expiry else "", short_strike)
        if key in seen or not short_strike:
            continue
        if underlying not in regimes:
            regimes[underlying] = await live_regime(underlying)
        live = regimes[underlying]
        delta = None
        delta_source = "none"
        if live.get("spot") and live.get("index_vol") and expiry:
            years = max((expiry - today).days, 1) / 365
            delta = round(put_delta(live["spot"], short_strike, live["index_vol"] / 100, years) * 100, 1)
            delta_source = "model"
        rows.append(_row(
            source="okw", ref=str(t.get("id")), symbol=symbol,
            strategy=normalize_strategy(str(t.get("trade_type") or "")),
            expiry=expiry, short_strike=short_strike, long_strike=float(t.get("long_strike") or 0),
            contracts=int(t.get("contracts") or 1), delta=delta, delta_source=delta_source,
            spot=live.get("spot"), today=today,
        ))

    rows.sort(key=lambda r: (r["days_left"] if r["days_left"] is not None else 999, r["symbol"]))
    return {
        "as_of": datetime.now(timezone.utc).isoformat(),
        "spreads": rows,
        "coverage": spread_history.coverage(),
    }
