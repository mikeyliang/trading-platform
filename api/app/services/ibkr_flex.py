"""IBKR Flex Web Service client — full execution history backfill.

The live TWS / Gateway API only exposes same-trading-day executions. To
backfill years of trade history we use IBKR's separate Flex Web Service,
which serves XML reports off a saved Flex Query.

Flow:
    1. POST SendRequest?t=<token>&q=<queryId>&v=3
       Response: <FlexStatementResponse><ReferenceCode>...
    2. POST GetStatement?q=<refCode>&t=<token>&v=3
       Poll until status=Success (IBKR may return Warn/1019 while the
       report is still being assembled).
    3. Parse the FlexQueryResponse XML — pull rows out of <Trades> and
       <OptionEAE>, map to the trade_history row shape.

The Flex query itself carries the default date range (e.g. "Last 365
Calendar Days"). Callers can override per-call via from_date / to_date
to slice multi-year backfills around the 365-day cap.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from xml.etree import ElementTree as ET

import httpx

logger = logging.getLogger(__name__)

_SEND_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest"
_GET_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement"
_API_VERSION = "3"
# IBKR returns Warn/1019 while the report is being assembled. Poll with
# backoff up to this many seconds before giving up.
_POLL_INTERVAL_SEC = 5.0
_POLL_BACKOFF_MAX = 20.0

# Transient SendRequest errors — retry these inside pull_trades before
# declaring the slice dead. Code 1003 in particular fires erratically:
# the same date range can succeed, then fail, then succeed again.
_TRANSIENT_CODES = {"1003"}
_TRANSIENT_RETRIES = 2
_TRANSIENT_BACKOFF_SEC = (10.0, 30.0)  # one entry per retry attempt

# IBKR throttle. When we trip code 1025 the token is soft-locked — any
# further request makes the lockout worse. Track a process-local
# cooldown so the rest of the app refuses to call Flex until it clears.
_COOLDOWN_DURATION_SEC = 20 * 60
_cooldown_until_mono: float = 0.0


class FlexError(RuntimeError):
    """Raised on any non-recoverable Flex Web Service failure."""

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


class FlexCooldownError(FlexError):
    """Raised when the token is in IBKR's temporary lockout (code 1025) or
    we've set a local cooldown after seeing one. ``retry_after_sec`` is
    the conservative wait estimate."""

    def __init__(self, retry_after_sec: float) -> None:
        super().__init__(
            f"IBKR Flex token in cooldown — retry in ~{retry_after_sec:.0f}s",
            code="1025",
        )
        self.retry_after_sec = retry_after_sec


def cooldown_remaining_sec() -> float:
    """Seconds left on the current cooldown (0 if none active)."""
    rem = _cooldown_until_mono - _mono()
    return max(0.0, rem)


def _mono() -> float:
    return asyncio.get_event_loop().time()


def _set_cooldown(seconds: float = _COOLDOWN_DURATION_SEC) -> None:
    """Bump the cooldown floor. Idempotent — multiple 1025s extend the wait."""
    global _cooldown_until_mono
    target = _mono() + seconds
    if target > _cooldown_until_mono:
        _cooldown_until_mono = target
        logger.warning("flex: cooldown active for %.0fs", seconds)


def _check_cooldown() -> None:
    rem = cooldown_remaining_sec()
    if rem > 0:
        raise FlexCooldownError(rem)


@dataclass
class FlexPullResult:
    trades: List[Dict[str, Any]]            # mapped to trade_history row shape
    option_eae: List[Dict[str, Any]]        # exercises / assignments / expirations
    accounts: List[str]
    raw_xml: str


async def pull_trades(
    token: str,
    query_id: str,
    *,
    from_date: Optional[str] = None,  # yyyymmdd
    to_date: Optional[str] = None,    # yyyymmdd
    timeout: float = 180.0,
) -> FlexPullResult:
    """Run the configured Flex query and return parsed trades.

    Transient SendRequest errors (code 1003) are retried with backoff so
    flaky availability doesn't abort a multi-slice sweep. Token lockouts
    (code 1025) short-circuit immediately as ``FlexCooldownError`` — any
    further requests until the cooldown clears will fail without hitting
    IBKR, preventing the lockout from compounding.
    """
    if not token or not query_id:
        raise FlexError("IBKR Flex token / query id not configured")

    _check_cooldown()

    last_err: Optional[FlexError] = None
    for attempt in range(_TRANSIENT_RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=30.0) as http:
                ref_code = await _send_request(http, token, query_id, from_date, to_date)
                logger.info("flex: got reference code %s (query %s)", ref_code, query_id)
                xml_text = await _poll_statement(http, token, ref_code, deadline_sec=timeout)
            parsed = _parse_response(xml_text)
            logger.info(
                "flex: parsed %d trades, %d option-eae across accounts %s",
                len(parsed.trades), len(parsed.option_eae), parsed.accounts,
            )
            return parsed
        except FlexCooldownError:
            raise
        except FlexError as e:
            last_err = e
            if attempt < _TRANSIENT_RETRIES and e.code in _TRANSIENT_CODES:
                wait = _TRANSIENT_BACKOFF_SEC[attempt]
                logger.info("flex: transient %s, retrying in %.0fs", e.code, wait)
                await asyncio.sleep(wait)
                continue
            raise
    # _TRANSIENT_RETRIES exhausted — surface the last error.
    assert last_err is not None
    raise last_err


async def _send_request(
    http: httpx.AsyncClient,
    token: str,
    query_id: str,
    from_date: Optional[str],
    to_date: Optional[str],
) -> str:
    params: Dict[str, str] = {"t": token, "q": query_id, "v": _API_VERSION}
    if from_date:
        params["fd"] = from_date
    if to_date:
        params["td"] = to_date
    resp = await http.get(_SEND_URL, params=params)
    resp.raise_for_status()
    root = _parse_xml(resp.text)
    flex_status = (root.findtext("Status") or "").strip()
    if flex_status != "Success":
        code = (root.findtext("ErrorCode") or "").strip() or None
        msg = root.findtext("ErrorMessage") or "(no message)"
        # 1025 = "Too many failed attempts" — token is soft-locked. Engage
        # the local cooldown so other callers don't pile on.
        if code == "1025":
            _set_cooldown()
            raise FlexCooldownError(cooldown_remaining_sec())
        raise FlexError(
            f"SendRequest failed (status={flex_status}, code={code or '?'}): {msg}",
            code=code,
        )
    ref = (root.findtext("ReferenceCode") or "").strip()
    if not ref:
        raise FlexError("SendRequest returned success but no ReferenceCode")
    return ref


async def _poll_statement(
    http: httpx.AsyncClient,
    token: str,
    ref_code: str,
    *,
    deadline_sec: float,
) -> str:
    """Poll GetStatement until the report is ready or deadline elapses."""
    started = asyncio.get_event_loop().time()
    delay = _POLL_INTERVAL_SEC
    last_msg = "unknown"
    while True:
        params = {"q": ref_code, "t": token, "v": _API_VERSION}
        resp = await http.get(_GET_URL, params=params)
        resp.raise_for_status()
        text = resp.text
        # A "still generating" response is a small XML <FlexStatementResponse>
        # with Status=Warn. A finished response is a large <FlexQueryResponse>.
        root = _parse_xml(text)
        if root.tag == "FlexQueryResponse":
            return text
        status = (root.findtext("Status") or "").strip()
        code = (root.findtext("ErrorCode") or "").strip()
        last_msg = (root.findtext("ErrorMessage") or "").strip() or last_msg
        # 1019 = "Statement generation in progress" → keep polling.
        if status == "Warn" and code == "1019":
            elapsed = asyncio.get_event_loop().time() - started
            if elapsed >= deadline_sec:
                raise FlexError(
                    f"GetStatement timed out after {elapsed:.0f}s: {last_msg}",
                    code="1019",
                )
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, _POLL_BACKOFF_MAX)
            continue
        if code == "1025":
            _set_cooldown()
            raise FlexCooldownError(cooldown_remaining_sec())
        raise FlexError(
            f"GetStatement failed (status={status}, code={code}): {last_msg}",
            code=code or None,
        )


def _parse_xml(text: str) -> ET.Element:
    try:
        return ET.fromstring(text)
    except ET.ParseError as e:
        raise FlexError(f"could not parse Flex XML: {e}") from e


def _parse_response(xml_text: str) -> FlexPullResult:
    root = _parse_xml(xml_text)
    if root.tag != "FlexQueryResponse":
        raise FlexError(f"unexpected root element <{root.tag}>")

    trades: List[Dict[str, Any]] = []
    option_eae: List[Dict[str, Any]] = []
    accounts: List[str] = []

    for stmt in root.iter("FlexStatement"):
        acct = stmt.attrib.get("accountId")
        if acct and acct not in accounts:
            accounts.append(acct)
        # <Trades><Trade .../>... or, when only summary level was selected,
        # rows may appear at a wrapping <Trade levelOfDetail="EXECUTION">.
        for t in stmt.iter("Trade"):
            row = _map_trade(t)
            if row is not None:
                trades.append(row)
        for eae in stmt.iter("OptionEAE"):
            row = _map_option_eae(eae)
            if row is not None:
                option_eae.append(row)

    return FlexPullResult(
        trades=trades,
        option_eae=option_eae,
        accounts=accounts,
        raw_xml=xml_text,
    )


# ── Row mappers ───────────────────────────────────────────────────────────

# Map Flex transactionType / assetCategory + symbol to a clean display
# symbol. For options we want the OSI-ish string (e.g. AAPL 240119C00190000)
# kept on metadata, with the human "underlying symbol" on the main row.
_OPT_ASSETS = {"OPT", "FOP"}


def _map_trade(t: ET.Element) -> Optional[Dict[str, Any]]:
    a = t.attrib
    # Flex emits roll-up "ORDER" rows in addition to per-execution rows. We
    # want EXECUTION rows so each fill is its own ledger entry.
    lod = (a.get("levelOfDetail") or "").upper()
    if lod and lod != "EXECUTION":
        return None
    ts = _best_timestamp(a)
    side_raw = (a.get("buySell") or "").upper()
    side = "buy" if side_raw.startswith("B") else "sell" if side_raw.startswith("S") else None
    if side is None:
        return None
    try:
        qty = abs(float(a.get("quantity") or 0))
        price = float(a.get("tradePrice") or 0)
    except ValueError:
        return None
    asset = (a.get("assetCategory") or "").upper()
    underlying = a.get("underlyingSymbol") or a.get("symbol") or ""
    symbol = underlying or a.get("symbol") or ""
    pnl = _try_float(a.get("fifoPnlRealized"))
    commission = _try_float(a.get("ibCommission"))
    metadata = {
        "source_row": "Trade",
        "asset_category": asset,
        "ib_symbol": a.get("symbol"),
        "underlying_symbol": underlying or None,
        "conid": a.get("conid"),
        "trade_id": a.get("tradeID"),
        "ib_exec_id": a.get("ibExecID"),
        "ib_order_id": a.get("ibOrderID"),
        "account_id": a.get("accountId"),
        "currency": a.get("currency"),
        "exchange": a.get("exchange"),
        "transaction_type": a.get("transactionType"),
        "open_close": a.get("openCloseIndicator"),
        "commission": commission,
        "commission_currency": a.get("ibCommissionCurrency"),
        "net_cash": _try_float(a.get("netCash")),
        "proceeds": _try_float(a.get("proceeds")),
        "fx_rate_to_base": _try_float(a.get("fxRateToBase")),
        "notes": a.get("notes"),
    }
    # Option-specific contract details
    if asset in _OPT_ASSETS:
        metadata.update({
            "option_strike": _try_float(a.get("strike")),
            "option_expiry": a.get("expiry"),
            "option_right": a.get("putCall"),  # P / C
            "multiplier": _try_float(a.get("multiplier")),
        })
    # IBKR's tradeID is the per-execution unique key — used by the importer
    # for dedup via the (source, external_id) unique index.
    external_id = a.get("ibExecID") or a.get("tradeID")
    if not external_id:
        return None
    return {
        "external_id": external_id,
        "source": "ibkr_flex",
        "timestamp": ts,
        "symbol": symbol,
        "side": side,
        "quantity": qty,
        "price": price,
        "order_type": a.get("orderType"),
        "status": "filled",
        "pnl": pnl,
        "pnl_percentage": None,
        "strategy": None,
        "agent_id": None,
        "metadata_": metadata,
    }


def _map_option_eae(eae: ET.Element) -> Optional[Dict[str, Any]]:
    """OptionEAE rows describe exercises, assignments, and expirations —
    these don't appear in <Trades> but materially change positions, so we
    record them as synthetic trade rows tagged transaction_type=EXERCISE
    /ASSIGNMENT/EXPIRATION."""
    a = eae.attrib
    tx_type = (a.get("transactionType") or "").upper()
    if not tx_type:
        return None
    ts = _best_timestamp(a)
    qty_raw = _try_float(a.get("quantity")) or 0.0
    # IBKR signs the EAE quantity; positive = added, negative = removed.
    # Map to buy/sell so the existing schema stays valid.
    side = "buy" if qty_raw >= 0 else "sell"
    qty = abs(qty_raw)
    price = _try_float(a.get("tradePrice")) or 0.0
    external_id = (
        a.get("transactionID")
        or a.get("ibOrderID")
        or f"eae:{a.get('symbol')}:{a.get('date')}:{a.get('transactionType')}"
    )
    return {
        "external_id": external_id,
        "source": "ibkr_flex",
        "timestamp": ts,
        "symbol": a.get("underlyingSymbol") or a.get("symbol") or "",
        "side": side,
        "quantity": qty,
        "price": price,
        "order_type": tx_type,
        "status": "filled",
        "pnl": _try_float(a.get("realizedPnl")),
        "pnl_percentage": None,
        "strategy": None,
        "agent_id": None,
        "metadata_": {
            "source_row": "OptionEAE",
            "asset_category": "OPT",
            "ib_symbol": a.get("symbol"),
            "underlying_symbol": a.get("underlyingSymbol"),
            "conid": a.get("conid"),
            "account_id": a.get("accountId"),
            "transaction_type": tx_type,
            "option_strike": _try_float(a.get("strike")),
            "option_expiry": a.get("expiry"),
            "option_right": a.get("putCall"),
            "multiplier": _try_float(a.get("multiplier")),
            "notes": a.get("notes"),
        },
    }


# ── Helpers ───────────────────────────────────────────────────────────────

def _try_float(s: Optional[str]) -> Optional[float]:
    if s is None or s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _parse_timestamp(date_part: Optional[str], time_part: Optional[str]) -> Optional[datetime]:
    """Flex emits dates as yyyyMMdd and times as HHmmss, often joined by a
    ';' separator. We accept the joined form OR a separate date+time."""
    if not date_part:
        return None
    # Strip any trailing time embedded with semicolon, hyphen, or space.
    joined = date_part
    if time_part:
        joined = f"{date_part};{time_part}"
    s = joined.replace(";", "").replace("-", "").replace(":", "").replace(" ", "")
    try:
        if len(s) >= 14:
            return datetime.strptime(s[:14], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        if len(s) >= 8:
            return datetime.strptime(s[:8], "%Y%m%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return None


def _best_timestamp(a: Dict[str, str]) -> Optional[datetime]:
    """Pick the most precise timestamp available on a Flex row.

    Different Activity Flex configs emit different attributes — try the
    intraday-precision combinations first, fall back to date-only.
    """
    # Pairs ordered preferred → fallback.
    for date_attr, time_attr in (
        ("tradeDate", "tradeTime"),     # Trade rows, time included
        ("dateTime", None),             # Combined yyyyMMdd;HHmmss
        ("orderTime", None),
        ("reportDate", "tradeTime"),
        ("date", None),                 # OptionEAE rows
        ("tradeDate", None),
        ("reportDate", None),
        ("settleDate", None),
    ):
        ts = _parse_timestamp(a.get(date_attr), a.get(time_attr) if time_attr else None)
        if ts is not None and (time_attr is None or ts.hour or ts.minute or ts.second):
            return ts
    # Fall back to a date-only stamp from whatever's first available.
    for date_attr in ("tradeDate", "date", "reportDate", "settleDate"):
        ts = _parse_timestamp(a.get(date_attr), None)
        if ts is not None:
            return ts
    return None
