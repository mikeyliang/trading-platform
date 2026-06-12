"""Exit-trigger monitor for open credit spreads.

Watches every open spread and applies both exit rules from webinar1:
  Rule #1 — close when short-leg |Δ| ≥ trade-type threshold
            (30 / 36 / 42 / 32 for RUT / Mars / Mars Max / Space)
  Rule #2 — on the Thursday before expiration, close when underlying is
            within ``last_day_buffer_pct`` of the short strike
            (3% for traditional RUT, 2% for Mars / Mars Max / Space).

State lives in-process. The scheduler refreshes the cache every few
minutes; ``GET /api/monitor/state`` returns the latest snapshot for the
dashboard, which is much cheaper than the UI fetching chains directly.

Threshold semantics:
  * "safe"     — short Δ at least 12 below trigger AND not within last-day buffer
  * "warning"  — short Δ within 12 of trigger, OR within last-day buffer
                 but still safe on Δ
  * "trigger"  — short Δ at or above trigger, OR exit-rule #2 fired
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Dict, Optional

from ..nautilus import ib_options
from ..nautilus.ib_orders import OpenSpread, orders_client
from ..ws.manager import manager

logger = logging.getLogger(__name__)

# Default exit threshold (the traditional RUT trade — most conservative).
# Spread.spread_type comes from ib_orders and may be "bull_put", "mars",
# "mars_max", "space", etc. We match it loosely.
_DEFAULT_EXIT_DELTA = 30.0
_DEFAULT_LAST_DAY_BUFFER_PCT = 3.0  # traditional RUT

_TYPE_TO_EXIT = {
    "bull_put": 30.0,
    "rut":      30.0,
    "mars":     36.0,
    "marsmax":  42.0,
    "mars_max": 42.0,
    "space":    32.0,
}

_TYPE_TO_LAST_DAY_BUFFER = {
    "bull_put": 3.0,
    "rut":      3.0,
    "mars":     2.0,
    "marsmax":  2.0,
    "mars_max": 2.0,
    "space":    2.0,
}


def _exit_delta_for(spread: OpenSpread) -> float:
    """Pick the exit-Δ threshold by spread_type, with a fallback default."""
    key = (spread.spread_type or "").lower().replace(" ", "_")
    if key in _TYPE_TO_EXIT:
        return _TYPE_TO_EXIT[key]
    # See if any known type substring matches (e.g. "rut_mars_bull_put")
    for prefix, val in _TYPE_TO_EXIT.items():
        if prefix in key:
            return val
    return _DEFAULT_EXIT_DELTA


def _last_day_buffer_for(spread: OpenSpread) -> float:
    key = (spread.spread_type or "").lower().replace(" ", "_")
    if key in _TYPE_TO_LAST_DAY_BUFFER:
        return _TYPE_TO_LAST_DAY_BUFFER[key]
    for prefix, val in _TYPE_TO_LAST_DAY_BUFFER.items():
        if prefix in key:
            return val
    return _DEFAULT_LAST_DAY_BUFFER_PCT


def _is_last_trade_day(expiry_yyyymmdd: str, today: Optional[date] = None) -> bool:
    """True when today is the last day the spread can still be traded.

    European-style index options stop trading Thursday close; Friday opens
    only to settle the cash value — so the canonical case is "the Thursday
    before expiration Friday". We also fire on expiration day itself
    (AM-settlement risk if the position somehow survived Thursday) and on a
    Wednesday/any weekday when expiry is ≤ 1 day away — that covers
    holiday-shifted weeks where Thursday is closed, instead of silently
    never firing rule #2.
    """
    try:
        exp = datetime.strptime(expiry_yyyymmdd, "%Y%m%d").date()
    except (ValueError, TypeError):
        return False
    today = today or date.today()
    days_left = (exp - today).days
    return 0 <= days_left <= 1 and today.weekday() < 5


def _rule2_levels(
    short_strike: float,
    short_right: str,
    buffer_pct: float,
) -> tuple[float, float]:
    """(trigger_price, soft_band_price) for exit-rule #2, side-aware.

    Bull put (short P): danger is the underlying FALLING toward the strike —
    trigger sits ``buffer_pct`` ABOVE the strike and fires when price ≤ it.
    Bear call (short C): mirrored — trigger sits below, fires when price ≥ it.
    The soft band (1.5× buffer) is the early-warning level on the same side.
    """
    if short_right == "C":
        trigger = round(short_strike * (1 - buffer_pct / 100), 2)
        soft = round(short_strike * (1 - 1.5 * buffer_pct / 100), 2)
    else:
        trigger = round(short_strike * (1 + buffer_pct / 100), 2)
        soft = round(short_strike * (1 + 1.5 * buffer_pct / 100), 2)
    return trigger, soft


def _rule2_breached(underlying: float, level: float, short_right: str) -> bool:
    """Has the underlying crossed a rule-#2 level? Puts breach downward
    (price ≤ level), calls breach upward (price ≥ level)."""
    return underlying >= level if short_right == "C" else underlying <= level


@dataclass
class MonitorEntry:
    spread_id: str
    symbol: str
    expiry: str
    spread_type: str
    short_strike: float
    long_strike: float
    quantity: int
    exit_delta: float
    current_delta: Optional[float]
    headroom: Optional[float]            # exit_delta - current_delta
    status: str                          # "safe" | "warning" | "trigger" | "unknown"
    updated_at: str
    note: Optional[str] = None
    # Rule #2 — last-trade-day buffer rule fields
    last_day_buffer_pct: float = _DEFAULT_LAST_DAY_BUFFER_PCT
    last_day_buffer_price: Optional[float] = None  # underlying level at which
                                                   # the rule fires (≈ short
                                                   # × (1 + buffer/100))
    underlying_price: Optional[float] = None
    is_last_trade_day: bool = False
    rule2_fired: bool = False            # underlying within buffer on Thursday

    def to_dict(self) -> Dict[str, Any]:
        return {
            "spread_id": self.spread_id,
            "symbol": self.symbol,
            "expiry": self.expiry,
            "spread_type": self.spread_type,
            "short_strike": self.short_strike,
            "long_strike": self.long_strike,
            "quantity": self.quantity,
            "exit_delta": self.exit_delta,
            "current_delta": self.current_delta,
            "headroom": self.headroom,
            "status": self.status,
            "updated_at": self.updated_at,
            "note": self.note,
            "last_day_buffer_pct": self.last_day_buffer_pct,
            "last_day_buffer_price": self.last_day_buffer_price,
            "underlying_price": self.underlying_price,
            "is_last_trade_day": self.is_last_trade_day,
            "rule2_fired": self.rule2_fired,
        }


@dataclass
class MonitorState:
    entries: Dict[str, MonitorEntry] = field(default_factory=dict)
    last_run: Optional[str] = None
    last_error: Optional[str] = None
    running: bool = False

    def snapshot(self) -> Dict[str, Any]:
        return {
            "entries": [e.to_dict() for e in self.entries.values()],
            "last_run": self.last_run,
            "last_error": self.last_error,
            "running": self.running,
            "count": len(self.entries),
            "triggered": sum(1 for e in self.entries.values() if e.status == "trigger"),
            "warning":   sum(1 for e in self.entries.values() if e.status == "warning"),
        }


state = MonitorState()


def _classify(current_delta: Optional[float], exit_delta: float) -> str:
    if current_delta is None:
        return "unknown"
    if current_delta >= exit_delta:
        return "trigger"
    if exit_delta - current_delta <= 12.0:
        return "warning"
    return "safe"


async def refresh() -> Dict[str, Any]:
    """Run a single monitor pass. Safe to call concurrently — only one
    refresh runs at a time; overlapping calls return the current snapshot."""
    if state.running:
        return state.snapshot()
    state.running = True
    try:
        spreads = [s for s in orders_client.list_open() if s.status == "open"]
        new_entries: Dict[str, MonitorEntry] = {}

        # Fetch each symbol+expiry chain once and reuse for all legs sharing it.
        chain_cache: Dict[tuple, Optional[Dict[str, Any]]] = {}

        for sp in spreads:
            key = (sp.symbol.upper(), sp.expiry)
            if key not in chain_cache:
                try:
                    chain_cache[key] = await ib_options.get_chain(sp.symbol, sp.expiry)
                except Exception as e:  # noqa: BLE001
                    logger.warning("monitor chain fetch failed %s/%s: %s", sp.symbol, sp.expiry, e)
                    chain_cache[key] = None
            chain = chain_cache[key]

            short_delta = None
            underlying_price = None
            if chain:
                row = _row_for_short_leg(chain, sp)
                if row and row.get("delta") is not None:
                    short_delta = round(abs(float(row["delta"])) * 100, 1)
                up = chain.get("underlying_price")
                if up is not None:
                    underlying_price = float(up)

            exit_d = _exit_delta_for(sp)
            headroom = round(exit_d - short_delta, 1) if short_delta is not None else None

            # ---------- Exit rule #2 (last trade day / buffer pct) ----------
            buf_pct = _last_day_buffer_for(sp)
            short_strike = float(sp.short_strike)
            # Side-aware buffer level: bull puts fire as price falls toward
            # the strike, bear calls as it rises. Mirrored math, same rule.
            short_leg = next((leg for leg in sp.legs if leg.action == "SELL"), None)
            short_right = (getattr(short_leg, "right", "") or "P").upper()
            buf_price, soft_band = _rule2_levels(short_strike, short_right, buf_pct)
            is_last = _is_last_trade_day(sp.expiry)
            rule2_fired = (
                is_last
                and underlying_price is not None
                and _rule2_breached(underlying_price, buf_price, short_right)
            )

            status = _classify(short_delta, exit_d)
            note = None
            if rule2_fired:
                status = "trigger"
                note = (
                    f"Exit rule #2: it is the last trade day and the "
                    f"underlying is within {buf_pct:.0f}% of the short strike."
                )
            elif is_last and underlying_price is not None and status == "safe":
                # On the last day even a "safe" delta is worth a warning when
                # we're approaching the buffer (within 1.5× buffer of strike).
                if _rule2_breached(underlying_price, soft_band, short_right):
                    status = "warning"
                    note = (
                        f"Last trade day — underlying {underlying_price:.2f} "
                        f"approaching exit-rule-2 trigger at {buf_price:.2f}."
                    )

            entry = MonitorEntry(
                spread_id=sp.id,
                symbol=sp.symbol,
                expiry=sp.expiry,
                spread_type=sp.spread_type or "spread",
                short_strike=sp.short_strike,
                long_strike=sp.long_strike,
                quantity=sp.quantity,
                exit_delta=exit_d,
                current_delta=short_delta,
                headroom=headroom,
                status=status,
                updated_at=datetime.now(timezone.utc).isoformat(),
                note=note,
                last_day_buffer_pct=buf_pct,
                last_day_buffer_price=buf_price,
                underlying_price=underlying_price,
                is_last_trade_day=is_last,
                rule2_fired=rule2_fired,
            )
            new_entries[sp.id] = entry

            # Broadcast a status crossing event if this entry just moved from
            # safe → warning, or warning → trigger.
            prev = state.entries.get(sp.id)
            prev_status = prev.status if prev else None
            if entry.status != prev_status and entry.status in ("warning", "trigger"):
                await manager.broadcast({
                    "type": "monitor_alert",
                    "data": entry.to_dict(),
                })

        state.entries = new_entries
        state.last_run = datetime.now(timezone.utc).isoformat()
        state.last_error = None
    except Exception as e:  # noqa: BLE001
        logger.exception("monitor refresh failed")
        state.last_error = str(e)
    finally:
        state.running = False
    return state.snapshot()


def _row_for_short_leg(chain: Dict[str, Any], sp: OpenSpread) -> Optional[Dict[str, Any]]:
    """Find the chain row matching the spread's short leg (strike + right)."""
    short_leg = next((leg for leg in sp.legs if leg.action == "SELL"), None)
    if not short_leg:
        return None
    rows = chain.get("puts") if short_leg.right == "P" else chain.get("calls")
    if not rows:
        return None
    for r in rows:
        if abs(float(r["strike"]) - float(short_leg.strike)) < 0.01:
            return r
    return None
