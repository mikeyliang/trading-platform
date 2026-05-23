"""Rule One cycle endpoint.

A "cycle" is one monthly bull-put trade in Jamal Hobson's Rule One advanced
course: enter ~25 DTE before a 3rd-Friday expiry, exit on expiration day
(or when the short-leg delta crosses the strategy's exit threshold).

This endpoint returns a single payload the dashboard's RuleOneCycleCard
renders: the cycle's three key dates, plus the best candidate per applicable
strategy for the symbol.

Cached for 30 min per (symbol, expiry) — fresh enough for an intraday view
of strike picks, gentle enough that ten dashboard refreshes don't multiply
into ten full scans of the chain.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query

from ..services import spread_finder, scan_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ruleone", tags=["ruleone"])


# Map dashboard chart symbols → the strategy underlying the scanner uses.
# RUT/IWM share the RUT-family setups; SPX/SPY share Space.
_UNDERLYING_FOR_SYMBOL: Dict[str, str] = {
    "RUT": "RUT",
    "IWM": "RUT",
    "SPX": "SPX",
    "SPY": "SPX",
}

# Course target: enter at ~25 DTE. The actual entry day shifts a bit to land
# on a weekday; we just report the unadjusted target and let the UI label it.
ENTRY_TARGET_DTE = 25

# Short-lived in-process cache keyed by (symbol). Half-hour lifetime so the
# scanner doesn't fire on every dashboard tab focus.
_CYCLE_CACHE: Dict[str, tuple[float, Dict[str, Any]]] = {}
_CACHE_TTL_S = 1800.0


@router.get("/cycle")
async def cycle(
    symbol: str = Query(..., description="RUT / IWM / SPX / SPY"),
    force: bool = Query(False, description="Bypass the 30-min cache"),
) -> Dict[str, Any]:
    sym = symbol.upper()
    underlying = _UNDERLYING_FOR_SYMBOL.get(sym)
    if not underlying:
        return _empty(sym, reason="not a Rule One underlying")

    if not force:
        cached = _CYCLE_CACHE.get(sym)
        if cached and (time.time() - cached[0]) < _CACHE_TTL_S:
            return cached[1]

    today = date.today()
    expiry_d = _next_third_friday_at_least(today, min_dte=14)
    entry_d = expiry_d - timedelta(days=ENTRY_TARGET_DTE)
    # Thursday-before-expiration — when exit-rule #2 ("within X% of short
    # strike") becomes active. For European-style index options, Thursday is
    # the last trading day; underlying gaps Friday morning to settle the
    # cash value, so we cannot react on Friday.
    last_trade_day = expiry_d - timedelta(days=1)

    candidates: List[Dict[str, Any]] = []
    scan_recommendation: Optional[Dict[str, Any]] = None
    scanner_error: Optional[str] = None
    try:
        # The scanner figures out which strategies apply to the underlying
        # internally (rut/mars/marsmax for RUT, space for SPX).
        result = await spread_finder.scan(symbol=underlying, side="put", max_per_type=1)
        trade_types = result.get("trade_types") or {}
        for tt_id, rows in trade_types.items():
            if not rows:
                continue
            best = rows[0]
            candidates.append(_candidate_dto(tt_id, best))
        scan_recommendation = result.get("recommendation")
        # Persist so /api/ruleone/history can draw past short-strike lines.
        # Tagged "cycle" to distinguish from manual or scheduled scans.
        if candidates:
            await scan_store.save_scan(scope="cycle", symbol=underlying, payload=result)
        # If the scanner produced no rows for any strategy, surface the
        # per-underlying error string so the UI can explain why (typically
        # missing IBKR data subscription for index spot prices).
        if not candidates:
            errors = result.get("errors") or {}
            err = errors.get(underlying)
            if err:
                scanner_error = err
    except Exception as e:  # noqa: BLE001
        logger.exception("ruleone cycle scan failed for %s: %s", sym, e)
        scanner_error = f"{type(e).__name__}: {e}"

    payload = {
        "symbol": sym,
        "underlying": underlying,
        "cycle_label": _cycle_label(expiry_d),
        "today": today.isoformat(),
        "entry_date": entry_d.isoformat(),
        "expiry_date": expiry_d.isoformat(),
        "last_trade_day": last_trade_day.isoformat(),
        "days_to_entry": (entry_d - today).days,
        "days_to_expiry": (expiry_d - today).days,
        "days_to_last_trade_day": (last_trade_day - today).days,
        "refreshed_at": datetime.now(timezone.utc).isoformat(),
        "candidates": candidates,
        "recommendation": scan_recommendation,
        "scanner_error": scanner_error,
    }
    _CYCLE_CACHE[sym] = (time.time(), payload)
    return payload


def _candidate_dto(strategy_id: str, row: Dict[str, Any]) -> Dict[str, Any]:
    """Strip the scanner row to what the card needs to render."""
    passes = row.get("passes") or {}
    all_pass = bool(passes) and all(passes.values())
    fail_reasons = [k for k, v in passes.items() if not v]
    return {
        "strategy_id": strategy_id,
        "short_strike": row.get("short_strike"),
        "long_strike": row.get("long_strike"),
        "side": row.get("side"),
        "credit": row.get("credit"),
        "short_delta": row.get("short_delta"),
        "aroc_pct": row.get("aroc_pct"),
        "kelly_pct": row.get("kelly_pct"),
        "adj_distance_pct": row.get("adj_distance_pct"),
        "dte": row.get("dte"),
        "passes": all_pass,
        "fail_reasons": fail_reasons,
        # Automation payload — alert prices, exit rules, sizing, expected loss
        "alert_price": row.get("alert_price"),
        "last_day_buffer_price": row.get("last_day_buffer_price"),
        "last_day_buffer_pct": row.get("last_day_buffer_pct"),
        "delta_exit_pct": row.get("delta_exit_pct"),
        "recommended_capital_pct": row.get("recommended_capital_pct"),
        "max_loss_per_contract": row.get("max_loss_per_contract"),
        "credit_per_contract": row.get("credit_per_contract"),
        "expected_avg_loss_per_contract": row.get("expected_avg_loss_per_contract"),
        "worst_historical_loss_per_contract": row.get("worst_historical_loss_per_contract"),
    }


def _next_third_friday_at_least(today: date, min_dte: int) -> date:
    """First monthly OPEX expiry that's at least ``min_dte`` days out.

    Below 14 DTE the trade is past its entry window, so we roll the cycle
    to the next month even if this month's 3rd Friday hasn't expired yet.
    """
    y, m = today.year, today.month
    for _ in range(3):  # this month + 2 ahead is plenty
        candidate = _third_friday(y, m)
        if (candidate - today).days >= min_dte:
            return candidate
        m += 1
        if m > 12:
            m = 1
            y += 1
    return _third_friday(y, m)


def _third_friday(year: int, month: int) -> date:
    first = date(year, month, 1)
    # weekday(): Mon=0 .. Fri=4 .. Sun=6
    offset = (4 - first.weekday()) % 7
    return first + timedelta(days=offset + 14)


def _cycle_label(expiry: date) -> str:
    return expiry.strftime("%b '%y").upper()


@router.get("/history")
async def history(
    symbol: str = Query(..., description="RUT / IWM / SPX / SPY"),
    limit: int = Query(12, ge=1, le=36, description="Max historical cycles to return"),
) -> Dict[str, Any]:
    """Historical short-strike picks per past 3rd-Friday cycle.

    Walks the persisted scan history (newest first), groups by (expiry,
    strategy_id), and returns the best candidate per cycle. Used by the
    chart's historical short-strike overlay to draw faded segments at
    each past cycle's short strike, spanning that cycle's window.
    """
    sym = symbol.upper()
    underlying = _UNDERLYING_FOR_SYMBOL.get(sym)
    if not underlying:
        return {"symbol": sym, "underlying": None, "cycles": []}

    # We pull a generous window of past scans (one per day at most, but
    # often several manual scans on the same day). De-dupe so each (expiry,
    # strategy) only appears once — keep the freshest pick.
    rows = await scan_store.recent_scans(limit=200, symbol=underlying)

    seen: set[tuple[str, str]] = set()
    cycles: List[Dict[str, Any]] = []
    for row in rows:
        payload = row.get("payload") or {}
        trade_types = payload.get("trade_types") or {}
        ran_at = row.get("ran_at")
        for strategy_id, candidates in trade_types.items():
            if not candidates:
                continue
            best = candidates[0]
            expiry = best.get("expiry")
            short_strike = best.get("short_strike")
            if not expiry or short_strike is None:
                continue
            key = (expiry, strategy_id)
            if key in seen:
                continue
            seen.add(key)
            cycles.append({
                "expiry": expiry,                 # YYYYMMDD
                "strategy_id": strategy_id,
                "short_strike": short_strike,
                "side": best.get("side"),
                "ran_at": ran_at,
                "dte_at_scan": best.get("dte"),
            })
        if len(cycles) >= limit * 4:  # 4 strategies max per cycle
            break

    # Sort newest expiry first for the UI.
    cycles.sort(key=lambda c: c["expiry"], reverse=True)
    return {"symbol": sym, "underlying": underlying, "cycles": cycles}


def _empty(symbol: str, reason: str) -> Dict[str, Any]:
    return {
        "symbol": symbol,
        "underlying": None,
        "cycle_label": None,
        "today": date.today().isoformat(),
        "entry_date": None,
        "expiry_date": None,
        "days_to_entry": None,
        "days_to_expiry": None,
        "refreshed_at": datetime.now(timezone.utc).isoformat(),
        "candidates": [],
        "scanner_error": None,
        "reason": reason,
    }
