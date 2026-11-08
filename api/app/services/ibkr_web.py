"""IBKR Web API client (api.ibkr.com) over OAuth 1.0a.

Serves the dashboard's polled feeds with no IB Gateway: account summary,
positions, quotes, history bars and option chains. Streaming prints,
depth of market and the bot's order execution stay on ib_async; see
``market_source`` for how the two are combined.

Session model:
  * ``ensure_session()`` derives a live session token (LST), opens the
    brokerage session (``/iserver/auth/ssodh/init``) and remembers the
    account id. It is cheap to call; it only does work when the session
    is missing, expired or has failed.
  * ``run_keepalive()`` tickles the session every minute so IBKR keeps the
    brokerage session open; ``main.py`` starts it as a background task.
  * Every failure is recorded in ``state`` so ``/health`` can show why the
    feed fell back to the gateway.

All responses are mapped to the dict shapes ``ib_options`` already returns,
so the routers do not care which source answered.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import httpx

from ..config import settings
from . import ibkr_web_oauth as oauth

logger = logging.getLogger(__name__)

# ── snapshot field ids (IBKR "fields" parameter) ─────────────────────────────
# Kept in one table so a wrong id is a one-line fix.
F_LAST = "31"
F_BID = "84"
F_ASK = "86"
F_VOLUME = "87"
F_CHANGE = "82"
F_CHANGE_PCT = "83"
F_PRIOR_CLOSE = "7296"
F_DELTA = "7308"
F_GAMMA = "7309"
F_THETA = "7310"
F_VEGA = "7311"
F_IV = "7633"
F_MARK = "7635"
F_OPEN_INTEREST = "7638"

QUOTE_FIELDS = [F_LAST, F_BID, F_ASK, F_VOLUME, F_CHANGE, F_CHANGE_PCT, F_PRIOR_CLOSE]
OPTION_FIELDS = [F_LAST, F_BID, F_ASK, F_VOLUME, F_DELTA, F_GAMMA, F_THETA, F_VEGA, F_IV, F_OPEN_INTEREST]

# Dashboard timeframe → IBKR history bar size.
BAR_SIZE = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1d"}

INDEX_SYMBOLS = {"SPX", "RUT", "NDX", "VIX", "DJX", "XSP", "OEX"}
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

LST_SAFETY_S = 5 * 60          # refresh the LST this long before IBKR's expiry
KEEPALIVE_S = 60               # IBKR drops brokerage sessions idle for a few minutes
SNAPSHOT_RETRY_DELAY_S = 0.4   # first snapshot after subscribing often lacks the price


class WebApiError(RuntimeError):
    pass


@dataclass
class WebApiState:
    enabled: bool = False
    authenticated: bool = False
    account_id: Optional[str] = None
    lst_expires_at: Optional[float] = None
    last_ok_at: Optional[float] = None
    last_error: Optional[str] = None
    last_error_at: Optional[float] = None
    requests: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "authenticated": self.authenticated,
            "account_id": self.account_id,
            "lst_expires_at": _iso(self.lst_expires_at),
            "last_ok_at": _iso(self.last_ok_at),
            "last_error": self.last_error,
            "last_error_at": _iso(self.last_error_at),
            "requests": self.requests,
        }


def _iso(ts: Optional[float]) -> Optional[str]:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None


def load_credentials() -> Optional[oauth.OAuthCredentials]:
    """Build credentials from settings. None when the Web API is not configured,
    which is the normal state for a Gateway-only deployment."""
    s = settings
    if not s.ibkr_web_enabled:
        return None
    missing = [n for n in ("ibkr_web_consumer_key", "ibkr_web_access_token", "ibkr_web_access_token_secret",
                           "ibkr_web_dh_prime", "ibkr_web_signature_key_fp", "ibkr_web_encryption_key_fp")
               if not getattr(s, n)]
    if missing:
        raise WebApiError(f"IBKR Web API enabled but missing settings: {', '.join(missing)}")
    sig = Path(s.ibkr_web_signature_key_fp)
    enc = Path(s.ibkr_web_encryption_key_fp)
    for p in (sig, enc):
        if not p.is_file():
            raise WebApiError(f"IBKR Web API key file not found: {p}")
    return oauth.OAuthCredentials(
        consumer_key=s.ibkr_web_consumer_key.strip().upper(),
        access_token=s.ibkr_web_access_token.strip(),
        access_token_secret=s.ibkr_web_access_token_secret.strip(),
        dh_prime_hex=s.ibkr_web_dh_prime.strip().lower(),
        signature_key_pem=sig.read_bytes(),
        encryption_key_pem=enc.read_bytes(),
        realm=s.ibkr_web_realm,
    )


class IbkrWebClient:
    def __init__(self, creds: Optional[oauth.OAuthCredentials], base_url: str,
                 transport: Optional[httpx.AsyncBaseTransport] = None):
        self._creds = creds
        self._base = base_url.rstrip("/")
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=10.0), transport=transport,
                                       headers={"User-Agent": "trading-platform/1.0", "Accept": "application/json"})
        self._lst: Optional[str] = None
        self._session_lock = asyncio.Lock()
        self._conids: Dict[Tuple[str, str], int] = {}
        self._month_cache: Dict[int, List[str]] = {}
        self.state = WebApiState(enabled=creds is not None)

    # ── session ─────────────────────────────────────────────────────────────

    @property
    def available(self) -> bool:
        return self._creds is not None

    def _session_fresh(self) -> bool:
        exp = self.state.lst_expires_at
        return bool(self._lst and self.state.authenticated and exp and time.time() < exp - LST_SAFETY_S)

    async def ensure_session(self) -> bool:
        if not self._creds:
            return False
        if self._session_fresh():
            return True
        async with self._session_lock:
            if self._session_fresh():
                return True
            try:
                await self._request_lst()
                await self._open_brokerage_session()
                await self._resolve_account()
                self.state.authenticated = True
                self.state.last_error = None
                logger.info("IBKR Web API session ready for account %s", self.state.account_id)
                return True
            except Exception as e:  # noqa: BLE001
                self._fail(f"session: {e}")
                return False

    async def _request_lst(self) -> None:
        assert self._creds
        url = f"{self._base}/oauth/live_session_token"
        private = oauth.dh_private()
        prepend = oauth.access_token_secret_prepend(self._creds)
        headers = oauth.lst_request_headers(self._creds, url, oauth.dh_challenge(self._creds, private), prepend)
        resp = await self._http.post(url, headers=headers)
        if resp.status_code != 200:
            raise WebApiError(f"live_session_token HTTP {resp.status_code}: {resp.text[:200]}")
        body = resp.json()
        lst = oauth.live_session_token(self._creds, private, body["diffie_hellman_response"], prepend)
        if not oauth.validate_live_session_token(self._creds, lst, body["live_session_token_signature"]):
            raise WebApiError("live session token failed validation (check DH prime and key files)")
        self._lst = lst
        self.state.lst_expires_at = float(body.get("live_session_token_expiration", 0)) / 1000 or time.time() + 23 * 3600

    async def _open_brokerage_session(self) -> None:
        body = await self._call("POST", "/iserver/auth/ssodh/init", json={"publish": True, "compete": True})
        if isinstance(body, dict) and body.get("authenticated") is False:
            raise WebApiError(f"brokerage session not authenticated: {body}")

    async def _resolve_account(self) -> None:
        accounts = await self._call("GET", "/portfolio/accounts")
        if not isinstance(accounts, list) or not accounts:
            raise WebApiError("no brokerage accounts returned")
        preferred = settings.ibkr_web_account_id
        ids = [a.get("accountId") or a.get("id") for a in accounts]
        self.state.account_id = preferred if preferred in ids else ids[0]
        # Market data endpoints require /iserver/accounts to have been called once.
        await self._call("GET", "/iserver/accounts")

    async def run_keepalive(self) -> None:
        """Background task: keep the brokerage session alive. Never raises."""
        while True:
            await asyncio.sleep(KEEPALIVE_S)
            if not self._creds:
                continue
            try:
                if self._lst:
                    body = await self._call("POST", "/tickle")
                    auth = (body or {}).get("iserver", {}).get("authStatus", {}) if isinstance(body, dict) else {}
                    if auth and not auth.get("authenticated", True):
                        self.state.authenticated = False
                else:
                    await self.ensure_session()
            except Exception as e:  # noqa: BLE001
                self._fail(f"keepalive: {e}")

    async def aclose(self) -> None:
        await self._http.aclose()

    # ── transport ───────────────────────────────────────────────────────────

    async def _call(self, method: str, path: str, params: Optional[Dict[str, Any]] = None,
                    json: Optional[Dict[str, Any]] = None) -> Any:
        assert self._creds and self._lst, "session not established"
        url = f"{self._base}{path}"
        query = {k: str(v) for k, v in (params or {}).items() if v is not None}
        headers = oauth.signed_headers(self._creds, self._lst, method, url, query)
        self.state.requests += 1
        resp = await self._http.request(method, url, params=query, json=json, headers=headers)
        if resp.status_code == 401:
            self.state.authenticated = False
            raise WebApiError(f"{path} 401 (session lost)")
        if resp.status_code >= 400:
            raise WebApiError(f"{path} HTTP {resp.status_code}: {resp.text[:200]}")
        self.state.last_ok_at = time.time()
        if not resp.content:
            return None
        return resp.json()

    async def _get(self, path: str, **params: Any) -> Any:
        if not await self.ensure_session():
            raise WebApiError(self.state.last_error or "no session")
        try:
            return await self._call("GET", path, params)
        except WebApiError as e:
            self._fail(str(e))
            raise

    def _fail(self, msg: str) -> None:
        self.state.last_error = msg[:300]
        self.state.last_error_at = time.time()
        if "session" in msg or "401" in msg:
            self.state.authenticated = False
        logger.warning("IBKR Web API: %s", msg)

    # ── contracts ───────────────────────────────────────────────────────────

    async def conid(self, symbol: str, sec_type: Optional[str] = None) -> Optional[int]:
        symbol = symbol.upper()
        sec_type = sec_type or ("IND" if symbol in INDEX_SYMBOLS else "STK")
        key = (symbol, sec_type)
        if key in self._conids:
            return self._conids[key]
        rows = await self._get("/iserver/secdef/search", symbol=symbol, secType=sec_type)
        cid = pick_conid(rows if isinstance(rows, list) else [], symbol, sec_type)
        if cid is not None:
            self._conids[key] = cid
            months = option_months(rows if isinstance(rows, list) else [], cid)
            if months:
                self._month_cache[cid] = months
        return cid

    # ── feeds ───────────────────────────────────────────────────────────────

    async def snapshot(self, conids: Sequence[int], fields: Sequence[str]) -> Dict[int, Dict[str, Any]]:
        if not conids:
            return {}
        params = {"conids": ",".join(str(c) for c in conids), "fields": ",".join(fields)}
        rows = await self._get("/iserver/marketdata/snapshot", **params)
        out = _index_snapshot(rows)
        # IBKR answers the first request for a conid with the subscription
        # acknowledgement and fills the values on the next. One short retry
        # covers that without turning every quote into a polling loop.
        if any(F_LAST in fields and F_LAST not in out.get(c, {}) and F_BID not in out.get(c, {}) for c in conids):
            await asyncio.sleep(SNAPSHOT_RETRY_DELAY_S)
            rows = await self._get("/iserver/marketdata/snapshot", **params)
            for cid, row in _index_snapshot(rows).items():
                out.setdefault(cid, {}).update(row)
        return out

    async def quote(self, symbol: str) -> Optional[Dict[str, Any]]:
        cid = await self.conid(symbol)
        if cid is None:
            return None
        snap = await self.snapshot([cid], QUOTE_FIELDS)
        return map_quote(symbol, snap.get(cid, {}))

    async def bars(self, symbol: str, timeframe: str, days: int) -> List[Dict[str, Any]]:
        cid = await self.conid(symbol)
        if cid is None:
            return []
        bar = BAR_SIZE.get(timeframe)
        if not bar:
            return []
        body = await self._get("/iserver/marketdata/history", conid=cid, period=f"{int(days)}d", bar=bar,
                               outsideRth="false")
        return map_bars(body)

    async def account_summary(self) -> Optional[Dict[str, Any]]:
        if not await self.ensure_session():
            return None
        acct = self.state.account_id
        body = await self._get(f"/portfolio/{acct}/summary")
        return map_account_summary(body, acct)

    async def positions(self) -> List[Dict[str, Any]]:
        if not await self.ensure_session():
            return []
        acct = self.state.account_id
        rows: List[Dict[str, Any]] = []
        for page in range(0, 10):
            batch = await self._get(f"/portfolio/{acct}/positions/{page}")
            if not isinstance(batch, list) or not batch:
                break
            rows.extend(batch)
            if len(batch) < 100:
                break
        return [p for p in (map_position(r) for r in rows) if p is not None]

    async def chain(self, symbol: str, expiration: Optional[str] = None) -> Dict[str, Any]:
        """Option chain in the ``ib_options.get_chain`` shape. Without an
        expiration: expirations and strikes only. With one: calls and puts
        with greeks for the strikes around spot."""
        symbol = symbol.upper()
        empty = {"symbol": symbol, "expirations": [], "strikes": [], "calls": [], "puts": [], "underlying_price": None}
        cid = await self.conid(symbol)
        if cid is None:
            return empty
        months = self._month_cache.get(cid) or []
        if not months:
            return empty
        spot = None
        try:
            q = await self.quote(symbol)
            spot = (q or {}).get("last")
        except WebApiError:
            pass
        if not expiration:
            expirations: List[str] = []
            strikes: List[float] = []
            for month in months[: settings.ibkr_web_chain_months]:
                info = await self._get("/iserver/secdef/strikes", conid=cid, sectype="OPT", month=month)
                month_strikes = sorted({float(s) for s in (info or {}).get("put", []) + (info or {}).get("call", [])})
                if not strikes:
                    strikes = month_strikes
                # Expiry dates live on the contract rows; probe one strike per month.
                probe = nearest(month_strikes, spot)
                if probe is None:
                    continue
                rows = await self._get("/iserver/secdef/info", conid=cid, sectype="OPT", month=month, strike=probe, right="P")
                for r in rows or []:
                    d = str(r.get("maturityDate") or "")
                    if len(d) == 8 and d not in expirations:
                        expirations.append(d)
            return {**empty, "expirations": sorted(expirations), "strikes": strikes, "underlying_price": spot}

        month = month_code(expiration)
        if month not in months:
            return {**empty, "underlying_price": spot}
        info = await self._get("/iserver/secdef/strikes", conid=cid, sectype="OPT", month=month)
        all_strikes = sorted({float(s) for s in (info or {}).get("put", []) + (info or {}).get("call", [])})
        window = select_window(all_strikes, spot, settings.ibkr_web_chain_window)
        contracts: Dict[int, Dict[str, Any]] = {}
        for strike in window:
            for right in ("C", "P"):
                rows = await self._get("/iserver/secdef/info", conid=cid, sectype="OPT", month=month,
                                       strike=strike, right=right)
                for r in rows or []:
                    if str(r.get("maturityDate")) == expiration and r.get("conid"):
                        contracts[int(r["conid"])] = {"strike": strike, "right": right, "expiry": expiration}
        calls: List[Dict[str, Any]] = []
        puts: List[Dict[str, Any]] = []
        ids = list(contracts)
        for i in range(0, len(ids), 50):
            snap = await self.snapshot(ids[i:i + 50], OPTION_FIELDS)
            for c in ids[i:i + 50]:
                row = map_option_row(contracts[c], snap.get(c, {}))
                (calls if row["right"] == "C" else puts).append(row)
        calls.sort(key=lambda r: r["strike"])
        puts.sort(key=lambda r: r["strike"])
        return {**empty, "expirations": [expiration], "strikes": all_strikes, "calls": calls, "puts": puts,
                "underlying_price": spot}


# ── pure mappers (unit tested) ───────────────────────────────────────────────

def pick_conid(rows: List[Dict[str, Any]], symbol: str, sec_type: str) -> Optional[int]:
    """Choose the contract for ``symbol`` from ``/iserver/secdef/search``.
    Prefer an exact symbol match whose sections include ``sec_type`` on a US
    listing; fall back to the first exact symbol match."""
    exact = [r for r in rows if str(r.get("symbol", "")).upper() == symbol.upper()]
    for r in exact:
        sections = r.get("sections") or []
        if any(str(s.get("secType", "")).upper() == sec_type for s in sections):
            try:
                return int(r["conid"])
            except (KeyError, TypeError, ValueError):
                continue
    for r in exact or rows:
        try:
            return int(r["conid"])
        except (KeyError, TypeError, ValueError):
            continue
    return None


def option_months(rows: List[Dict[str, Any]], conid: int) -> List[str]:
    for r in rows:
        try:
            if int(r.get("conid")) != conid:
                continue
        except (TypeError, ValueError):
            continue
        for s in r.get("sections") or []:
            if str(s.get("secType", "")).upper() == "OPT" and s.get("months"):
                return [m for m in str(s["months"]).split(";") if m]
    return []


def month_code(expiration: str) -> str:
    """'20261120' → 'NOV26'."""
    return f"{MONTHS[int(expiration[4:6]) - 1]}{expiration[2:4]}"


def nearest(strikes: List[float], spot: Optional[float]) -> Optional[float]:
    if not strikes:
        return None
    if spot is None:
        return strikes[len(strikes) // 2]
    return min(strikes, key=lambda s: abs(s - spot))


def select_window(strikes: List[float], spot: Optional[float], window: int) -> List[float]:
    if not strikes:
        return []
    if spot is None:
        mid = len(strikes) // 2
    else:
        mid = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
    lo = max(0, mid - window)
    return strikes[lo: mid + window + 1]


def _num(v: Any) -> Optional[float]:
    """IBKR snapshot values are strings and may carry a status prefix
    ('C' closed, 'H' halted) or thousands separators."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "")
    while s and s[0] in "CHch":
        s = s[1:]
    if s.endswith("%"):
        s = s[:-1]
    try:
        return float(s)
    except ValueError:
        return None


def _index_snapshot(rows: Any) -> Dict[int, Dict[str, Any]]:
    out: Dict[int, Dict[str, Any]] = {}
    for r in rows if isinstance(rows, list) else []:
        try:
            out[int(r["conid"])] = r
        except (KeyError, TypeError, ValueError):
            continue
    return out


def map_quote(symbol: str, row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    last = _num(row.get(F_LAST))
    bid = _num(row.get(F_BID))
    ask = _num(row.get(F_ASK))
    if last is None and bid is None and ask is None:
        return None
    change = _num(row.get(F_CHANGE))
    change_pct = _num(row.get(F_CHANGE_PCT))
    prior = _num(row.get(F_PRIOR_CLOSE))
    if change is None and last is not None and prior:
        change = round(last - prior, 4)
    if change_pct is None and change is not None and prior:
        change_pct = round(change / prior * 100, 4)
    return {
        "symbol": symbol.upper(),
        "last": last,
        "bid": bid,
        "ask": ask,
        "change": change,
        "change_pct": change_pct,
        "volume": _num(row.get(F_VOLUME)),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": "web",
    }


def map_bars(body: Any) -> List[Dict[str, Any]]:
    data = (body or {}).get("data") if isinstance(body, dict) else None
    out: List[Dict[str, Any]] = []
    for b in data or []:
        try:
            out.append({
                "time": int(int(b["t"]) / 1000),
                "open": round(float(b["o"]), 2),
                "high": round(float(b["h"]), 2),
                "low": round(float(b["l"]), 2),
                "close": round(float(b["c"]), 2),
                "volume": float(b.get("v") or 0),
            })
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _amount(body: Dict[str, Any], *keys: str) -> float:
    for k in keys:
        v = body.get(k)
        if isinstance(v, dict):
            v = v.get("amount")
        n = _num(v)
        if n is not None:
            return n
    return 0.0


def map_account_summary(body: Any, account_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not isinstance(body, dict) or not body:
        return None
    return {
        "balance": _amount(body, "totalcashvalue", "cashbalance"),
        "equity": _amount(body, "netliquidation"),
        "buying_power": _amount(body, "buyingpower"),
        "unrealized_pnl": _amount(body, "unrealizedpnl"),
        "realized_pnl": _amount(body, "realizedpnl"),
        "locked": _amount(body, "initmarginreq") or None,
        "currency": (body.get("netliquidation") or {}).get("currency", "USD") if isinstance(body.get("netliquidation"), dict) else "USD",
        "account_id": account_id,
        "mode": "paper" if str(account_id or "").upper().startswith("DU") else "live",
    }


def map_position(r: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    qty = _num(r.get("position"))
    if not qty:
        return None
    asset = str(r.get("assetClass") or "").upper()
    is_option = asset in ("OPT", "FOP")
    multiplier = _num(r.get("multiplier")) or (100.0 if is_option else 1.0)
    avg_price = _num(r.get("avgPrice"))
    if avg_price is None:
        avg_cost = _num(r.get("avgCost")) or 0.0
        avg_price = avg_cost / multiplier if is_option and multiplier else avg_cost
    mark = _num(r.get("mktPrice"))
    upnl = _num(r.get("unrealizedPnl")) or 0.0
    cost = abs(qty) * avg_price * multiplier
    symbol = str(r.get("ticker") or r.get("undSym") or r.get("contractDesc") or "?").split(" ")[0].upper()
    out: Dict[str, Any] = {
        "symbol": symbol,
        "quantity": qty,
        "avg_price": round(avg_price, 4),
        "current_price": round(mark if mark is not None else avg_price, 4),
        "unrealized_pnl": round(upnl, 2),
        "unrealized_pnl_pct": round(upnl / cost * 100, 2) if cost else 0.0,
        "is_option": is_option,
        "multiplier": multiplier,
        "mark_source": "live" if mark is not None else "stale",
        "conid": r.get("conid"),
        "source": "web",
    }
    if is_option:
        out["strike"] = _num(r.get("strike"))
        out["expiry"] = str(r.get("expiry") or "")[:8] or None
        right = str(r.get("putOrCall") or r.get("right") or "").upper()[:1]
        out["right"] = right or None
    return out


def map_option_row(contract: Dict[str, Any], row: Dict[str, Any]) -> Dict[str, Any]:
    bid = _num(row.get(F_BID))
    ask = _num(row.get(F_ASK))
    last = _num(row.get(F_LAST))
    mid = (bid + ask) / 2 if bid and ask else last or bid or ask
    iv = _num(row.get(F_IV))
    oi = _num(row.get(F_OPEN_INTEREST))
    vol = _num(row.get(F_VOLUME))
    return {
        "strike": float(contract["strike"]),
        "expiry": contract["expiry"],
        "right": contract["right"],
        "bid": bid,
        "ask": ask,
        "last": last,
        "iv": round(iv / 100, 6) if iv is not None and iv > 3 else iv,   # IBKR reports IV as a percentage
        "delta": _num(row.get(F_DELTA)),
        "gamma": _num(row.get(F_GAMMA)),
        "theta": _num(row.get(F_THETA)),
        "vega": _num(row.get(F_VEGA)),
        "oi": int(oi) if oi is not None else None,
        "vol": int(vol) if vol is not None else None,
        "mid": round(mid, 4) if mid else None,
    }


# ── module singleton ─────────────────────────────────────────────────────────

_client: Optional[IbkrWebClient] = None


def client() -> IbkrWebClient:
    """Process-wide client. Credentials are read once; a misconfiguration is
    recorded in state rather than raised, so the API still boots on Gateway."""
    global _client
    if _client is None:
        creds = None
        error = None
        try:
            creds = load_credentials()
        except WebApiError as e:
            error = str(e)
        _client = IbkrWebClient(creds, settings.ibkr_web_base_url)
        if error:
            _client.state.enabled = True
            _client._fail(error)
    return _client


def reset_client_for_tests(c: Optional[IbkrWebClient]) -> None:
    global _client
    _client = c
