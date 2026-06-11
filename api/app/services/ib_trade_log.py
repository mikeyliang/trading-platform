"""IBKR execution → trade-history sync.

Pulls real fills from the connected IBKR gateway (``reqExecutions``) and
logs them into the ``trade_history`` store, deduplicated by IBKR's
execution id. This is what makes the Trade History page and the chart
trade-markers reflect what the account actually did — no manual CSV
import required.

Notes on the IBKR API surface:
  * ``reqExecutions`` returns executions for the **current day** only
    (since the last gateway restart). Run the sync periodically during
    market hours (scheduler job) plus on demand (sync endpoint) and the
    log stays complete going forward.
  * Each ``Fill`` carries ``contract`` / ``execution`` / ``commissionReport``.
    The commission report includes ``realizedPNL`` on closing fills, which
    we persist as the trade's ``pnl``. IBKR uses DBL_MAX as a "no value"
    sentinel there — filtered out.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from ..nautilus.ib_options import _client as _ib_client  # shared resilient connection
from . import trade_history_store

logger = logging.getLogger(__name__)

# IBKR's "no value" sentinel for commissionReport.realizedPNL.
_IB_NO_VALUE = 1.7e308

# Option fills are priced per share but quantity is in contracts; keep the
# per-share price (matches how the analyzer and positions panel display
# premium) and record the multiplier in metadata for P&L math.


def _fill_to_trade(fill: Any) -> Optional[Dict[str, Any]]:
    """Map an ib_async Fill onto a trade_history payload. None if the fill
    is malformed (no exec id / no symbol)."""
    exe = getattr(fill, "execution", None)
    con = getattr(fill, "contract", None)
    if exe is None or con is None:
        return None
    exec_id = getattr(exe, "execId", "") or ""
    symbol = getattr(con, "symbol", "") or ""
    if not exec_id or not symbol:
        return None

    side_raw = (getattr(exe, "side", "") or "").upper()
    side = "BUY" if side_raw in ("BOT", "BUY") else "SELL"
    qty = float(getattr(exe, "shares", 0) or 0)
    price = float(getattr(exe, "price", 0) or 0)
    if qty <= 0 or price <= 0:
        return None

    sec_type = getattr(con, "secType", "") or ""
    is_option = sec_type == "OPT"

    meta: Dict[str, Any] = {
        "source": "ibkr",
        "exec_id": exec_id,
        "sec_type": sec_type,
        "exchange": getattr(exe, "exchange", "") or "",
        "order_id": getattr(exe, "orderId", None),
        "perm_id": getattr(exe, "permId", None),
        "account": getattr(exe, "acctNumber", "") or "",
    }
    if is_option:
        meta["strike"] = float(getattr(con, "strike", 0) or 0) or None
        meta["expiry"] = getattr(con, "lastTradeDateOrContractMonth", "") or None
        meta["right"] = getattr(con, "right", "") or None
        meta["multiplier"] = float(getattr(con, "multiplier", "") or 100)

    pnl: Optional[float] = None
    cr = getattr(fill, "commissionReport", None)
    if cr is not None:
        commission = getattr(cr, "commission", None)
        if commission is not None and abs(commission) < _IB_NO_VALUE:
            meta["commission"] = round(float(commission), 4)
        realized = getattr(cr, "realizedPNL", None)
        if realized is not None and abs(realized) < _IB_NO_VALUE and realized != 0:
            pnl = round(float(realized), 2)

    ts = getattr(exe, "time", None)  # tz-aware datetime from ib_async

    return {
        "timestamp": ts,
        "symbol": symbol.upper(),
        "side": side,
        "quantity": qty,
        "price": round(price, 4),
        "order_type": "market",  # exec reports don't carry the order type
        "status": "FILLED",
        "pnl": pnl,
        "pnl_percentage": None,
        "strategy": (getattr(exe, "orderRef", "") or None),
        "agent_id": None,
        "metadata_": meta,
    }


async def fetch_executions() -> List[Dict[str, Any]]:
    """Current-session fills from IBKR, mapped to trade payloads.
    Empty list when the gateway is unreachable."""
    ib = await _ib_client.get()
    if ib is None:
        return []
    try:
        fills = await ib.reqExecutionsAsync()
    except Exception as e:  # noqa: BLE001
        logger.warning("reqExecutions failed: %s", e)
        return []
    out: List[Dict[str, Any]] = []
    for f in fills or []:
        row = _fill_to_trade(f)
        if row is not None:
            out.append(row)
    return out


async def sync_executions() -> Dict[str, Any]:
    """Fetch fills from IBKR and insert the ones not already logged.

    Returns {"fetched", "inserted", "skipped", "error"} — error is set when
    the gateway or the DB is unavailable so callers can surface it.
    """
    trades = await fetch_executions()
    if not trades:
        return {"fetched": 0, "inserted": 0, "skipped": 0,
                "error": None if _ib_client.is_connected() else "ibkr_unavailable"}

    exec_ids = [t["metadata_"]["exec_id"] for t in trades]
    known = await trade_history_store.existing_exec_ids(exec_ids)
    if known is None:
        return {"fetched": len(trades), "inserted": 0, "skipped": 0,
                "error": "db_unavailable"}

    fresh = [t for t in trades if t["metadata_"]["exec_id"] not in known]
    inserted = await trade_history_store.bulk_insert_trades(fresh) if fresh else 0
    if fresh and inserted == 0:
        return {"fetched": len(trades), "inserted": 0,
                "skipped": len(trades) - len(fresh), "error": "db_unavailable"}
    return {
        "fetched": len(trades),
        "inserted": inserted,
        "skipped": len(trades) - len(fresh),
        "error": None,
    }
