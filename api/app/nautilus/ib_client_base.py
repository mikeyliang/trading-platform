"""
Resilient ib_async client base.

Every long-lived IBKR client in this app (options chains, DOM, time & sales,
orders) needs the same three things:

  1. Exponential-backoff reconnect when connectAsync() fails or the socket
     drops mid-session.
  2. Heartbeat monitoring so a dead TCP connection (the gateway "looks
     logged in" but ib_async's socket is frozen) is detected within seconds
     rather than waiting for the next user request to time out.
  3. A hook so subclasses can re-establish state — DOM subscriptions, tick
     streams, etc. — after a reconnect, since IBKR clears all subscription
     state when the API session goes away.

This module centralises that logic. Each subclass just picks a client_id
and a name; the loop and the watchdog are shared.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from ..config import settings

logger = logging.getLogger(__name__)

try:
    from ib_async import IB  # type: ignore
    IB_ASYNC_AVAILABLE = True
except Exception as e:  # noqa: BLE001
    IB_ASYNC_AVAILABLE = False
    logger.warning(f"ib_async not available, IB clients will be disabled: {e}")


# IBKR "system" error codes that indicate a market-data farm or HMDS
# connection has dropped on the gateway side even though our TCP socket is
# still up. Treat these as soft-disconnects: surface them and trigger
# subscription replay once the farm comes back.
#   1100: Connectivity between IB and TWS has been lost.
#   1101: Connectivity restored, data lost — must resubscribe.
#   1102: Connectivity restored, data maintained.
#   1300: TWS socket disconnected (hard).
#   2103/2104/2105/2106/2107/2108: data farm status — informational, but
#   2103/2105/2107 (broken) trigger replay; 2104/2106/2108 (ok) clear it.
_FARM_LOST_CODES = {1100, 1101, 1300, 2103, 2105, 2107}
_FARM_OK_CODES = {1102, 2104, 2106, 2108}

# IBKR per-request errors that mean "you asked for data this account is not
# entitled to". The errorString IBKR sends with these *names the data line*
# (e.g. "...RUSSELL/IND/CBOE...") — that is the only authoritative source for
# which subscription is missing, so we capture it per-symbol instead of
# discarding it like the other per-request rejections.
#   354:   Requested market data is not subscribed (live snapshot/stream).
#   10089/10090: Requested market data requires additional subscription for API.
#   10167/10168: Requested market data is not subscribed; delayed (not) enabled.
#   10197: No market data during competing live session.
#   162:   Historical Market Data Service error — "No market data permissions for …".
_MKT_DATA_PERMISSION_CODES = {354, 10089, 10090, 10167, 10168, 10197, 162}

# Curated, best-effort hint of the IBKR Account Management subscription that
# unlocks each index. IBKR renames these periodically, so the verbatim
# errorString we capture alongside is authoritative — this only gives the
# user a clean name to search for. Keyed by contract.symbol (upper-cased).
_SUBSCRIPTION_HINTS = {
    "RUT": "Cboe Global Indexes (covers Russell US indices / RUSSELL)",
    "SPX": "Cboe Global Indexes (S&P US index data)",
    "VIX": "Cboe Global Indexes (CFE volatility indices)",
    "NDX": "Nasdaq (Network C/UTP) — Nasdaq US index data",
    "DJX": "Cboe Global Indexes (Dow Jones US index data)",
}

# symbol (upper) -> {"code", "message", "hint", "exchange"} for the most
# recent market-data permission rejection. Process-wide and intentionally
# unbounded-ish (one entry per distinct symbol the user touches). Read by the
# market router to tell the UI which subscription is missing.
_subscription_errors: dict[str, dict[str, Any]] = {}


def _looks_like_permission(message: str) -> bool:
    """True when an IBKR error message is about a missing data entitlement
    rather than a transient/availability problem."""
    m = (message or "").lower()
    return ("permission" in m or "not subscribed" in m
            or "requires additional subscription" in m)


def record_subscription_error(symbol: str, code: int, message: str,
                              exchange: Optional[str] = None) -> None:
    """Remember that ``symbol`` was rejected for lack of a data subscription."""
    sym = (symbol or "").upper().lstrip("^")
    if not sym:
        return
    _subscription_errors[sym] = {
        "code": code,
        "message": (message or "").strip(),
        "hint": _SUBSCRIPTION_HINTS.get(sym),
        "exchange": exchange,
    }


def get_subscription_error(symbol: str) -> Optional[dict[str, Any]]:
    """Return the last captured market-data permission error for ``symbol``,
    or None if we've never seen one (or data is flowing fine)."""
    return _subscription_errors.get((symbol or "").upper().lstrip("^"))


def clear_subscription_error(symbol: str) -> None:
    """Drop a remembered error — call once data for ``symbol`` flows, so a
    transient/resolved entitlement issue doesn't haunt the UI forever."""
    _subscription_errors.pop((symbol or "").upper().lstrip("^"), None)

# Defaults tuned for IB Gateway behaviour: heartbeats every 15s catch a
# silent socket death within one cycle; the backoff schedule reaches its
# cap after ~2 minutes which matches how long the gateway can take to
# re-accept API connections after a relogin.
HEARTBEAT_INTERVAL_S = 15.0
HEARTBEAT_TIMEOUT_S = 10.0
RECONNECT_BACKOFF_INITIAL_S = 2.0
RECONNECT_BACKOFF_MAX_S = 60.0
RECONNECT_BACKOFF_FACTOR = 2.0
CONNECT_TIMEOUT_S = 10.0


class ResilientIBClient:
    """Lazy IB connection with reconnect + heartbeat.

    Subclasses can override ``on_reconnect`` (async, called after a fresh
    connection is established) to re-issue any market-data subscriptions
    that IBKR clears on session loss.
    """

    def __init__(self, client_id: int, name: str):
        self.client_id = client_id
        self.name = name
        self._ib: Optional[Any] = None
        self._lock = asyncio.Lock()
        # Set whenever we detect the gateway has dropped (socket close or
        # 1100/1101/1300/2103/2105/2107). The watchdog reads this and
        # forces a reconnect cycle.
        self._needs_reconnect = asyncio.Event()
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._closing = False

    # -- public API --------------------------------------------------------

    @property
    def is_connected(self) -> bool:
        return bool(self._ib and self._ib.isConnected())

    async def get(self) -> Optional[Any]:
        """Return a connected IB handle, reconnecting on demand.

        Returns ``None`` when ib_async is unavailable, mock_mode is on, or
        every retry in this call exhausts (in which case the caller should
        fall back to its empty/None contract — the watchdog will keep
        trying in the background)."""
        if not IB_ASYNC_AVAILABLE or settings.mock_mode:
            return None
        async with self._lock:
            if self.is_connected and not self._needs_reconnect.is_set():
                return self._ib
            await self._connect_with_backoff()
            return self._ib if self.is_connected else None

    async def disconnect(self) -> None:
        self._closing = True
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._heartbeat_task = None
        async with self._lock:
            if self._ib is not None:
                try:
                    if self._ib.isConnected():
                        self._ib.disconnect()
                except Exception as e:  # noqa: BLE001
                    logger.debug("%s disconnect raised: %s", self.name, e)
                self._ib = None

    def start_heartbeat(self) -> None:
        """Spawn the background heartbeat task. Idempotent.

        Must be called from a running event loop (the FastAPI lifespan is
        the natural place). Without this, ``get()`` still works but a
        frozen socket won't be detected until the next request fails."""
        if self._heartbeat_task and not self._heartbeat_task.done():
            return
        if not IB_ASYNC_AVAILABLE or settings.mock_mode:
            return
        self._heartbeat_task = asyncio.create_task(
            self._heartbeat_loop(), name=f"ib_heartbeat[{self.name}]"
        )

    # -- subclass hook -----------------------------------------------------

    async def on_reconnect(self, ib: Any) -> None:
        """Override to restore subscriptions after a fresh connection.

        Called exactly once per successful reconnect, while the connect
        lock is held — safe to issue qualify/subscribe calls here."""
        return None

    # -- internals ---------------------------------------------------------

    async def _connect_with_backoff(self) -> None:
        """Connect once with exponential backoff. Caller holds ``_lock``.

        We try up to ~5 attempts in one ``get()`` so a transient flap
        doesn't immediately return an empty result; if it's a longer
        outage the watchdog keeps retrying in the background and the
        next ``get()`` will pick up the restored session."""
        if self.is_connected and not self._needs_reconnect.is_set():
            return

        # Make sure we don't carry over a half-dead socket.
        if self._ib is not None:
            try:
                if self._ib.isConnected():
                    self._ib.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self._ib = None

        delay = RECONNECT_BACKOFF_INITIAL_S
        attempts = 0
        max_attempts = 5
        while attempts < max_attempts and not self._closing:
            attempts += 1
            ib = IB()
            try:
                await ib.connectAsync(
                    settings.ib_gateway_host,
                    settings.ib_gateway_port,
                    clientId=self.client_id,
                    timeout=CONNECT_TIMEOUT_S,
                )
                self._ib = ib
                self._wire_events(ib)
                self._needs_reconnect.clear()
                logger.info("%s connected to %s:%s (clientId=%s, attempt=%d)",
                            self.name, settings.ib_gateway_host,
                            settings.ib_gateway_port, self.client_id, attempts)
                try:
                    await self.on_reconnect(ib)
                except Exception as e:  # noqa: BLE001
                    logger.exception("%s on_reconnect failed: %s", self.name, e)
                return
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "%s connect attempt %d/%d failed (%s); backing off %.1fs",
                    self.name, attempts, max_attempts, e, delay,
                )
                try:
                    ib.disconnect()
                except Exception:  # noqa: BLE001
                    pass
                if attempts < max_attempts:
                    await asyncio.sleep(delay)
                    delay = min(delay * RECONNECT_BACKOFF_FACTOR,
                                RECONNECT_BACKOFF_MAX_S)
        logger.error("%s exhausted %d connect attempts; will retry via watchdog",
                     self.name, max_attempts)

    def _wire_events(self, ib: Any) -> None:
        """Attach disconnect + error listeners so we mark the client as
        needing reconnect promptly instead of waiting for the next call to
        time out."""
        try:
            ib.disconnectedEvent += self._on_disconnected
        except Exception:  # noqa: BLE001
            pass
        try:
            ib.errorEvent += self._on_error
        except Exception:  # noqa: BLE001
            pass

    def _on_disconnected(self) -> None:
        if self._closing:
            return
        logger.warning("%s socket disconnected — flagging for reconnect", self.name)
        self._needs_reconnect.set()

    def _on_error(self, reqId, errorCode, errorString, contract) -> None:
        # ib_async fans every IBKR error through this event, including
        # benign per-request rejections (200, 354, ...). We only react to
        # the connectivity-level system codes; everything else is the
        # caller's problem.
        try:
            code = int(errorCode)
        except (TypeError, ValueError):
            return
        if code in _FARM_LOST_CODES:
            logger.warning("%s farm/socket dropped (code %s: %s) — will reconnect",
                           self.name, code, errorString)
            self._needs_reconnect.set()
        elif code in _FARM_OK_CODES:
            logger.info("%s farm status ok (code %s: %s)",
                        self.name, code, errorString)
        elif code in _MKT_DATA_PERMISSION_CODES:
            # Per-request entitlement rejection. The contract tells us which
            # symbol, the errorString names the data line — stash both so the
            # market router can tell the UI exactly which subscription to buy.
            # Code 162 is HMDS-generic: it fires both for genuine "No market
            # data permissions for …" AND for benign "No historical market
            # data for …" (e.g. an unsupported whatToShow). Only the former is
            # a subscription issue — gate on the wording so we don't tell the
            # user to buy data they already have.
            msg = str(errorString)
            if code == 162 and not _looks_like_permission(msg):
                return
            sym = getattr(contract, "symbol", None) or getattr(contract, "localSymbol", None)
            exch = getattr(contract, "primaryExchange", None) or getattr(contract, "exchange", None)
            if sym:
                record_subscription_error(str(sym), code, msg, exch)
                logger.info("%s market-data not entitled (code %s) for %s: %s",
                            self.name, code, sym, errorString)

    async def _heartbeat_loop(self) -> None:
        """Probe the gateway on a fixed cadence and trigger a reconnect
        whenever the probe fails or our flag has been set.

        ``reqCurrentTimeAsync`` is the lightest round-trip ib_async exposes
        — IBKR replies in a few ms with the gateway's clock — and unlike
        ``isConnected()`` it actually exercises the socket, so a half-open
        TCP connection (which is the failure mode the user is hitting:
        "logged in but data disappears") gets caught here within one
        cycle."""
        while not self._closing:
            try:
                await asyncio.sleep(HEARTBEAT_INTERVAL_S)
                if self._closing:
                    return
                if self._needs_reconnect.is_set() or not self.is_connected:
                    async with self._lock:
                        await self._connect_with_backoff()
                    continue
                try:
                    await asyncio.wait_for(
                        self._ib.reqCurrentTimeAsync(),
                        timeout=HEARTBEAT_TIMEOUT_S,
                    )
                except (asyncio.TimeoutError, Exception) as e:  # noqa: BLE001
                    logger.warning("%s heartbeat failed (%s) — reconnecting",
                                   self.name, e)
                    self._needs_reconnect.set()
                    async with self._lock:
                        await self._connect_with_backoff()
            except asyncio.CancelledError:
                return
            except Exception as e:  # noqa: BLE001
                logger.debug("%s heartbeat loop error: %s", self.name, e)
