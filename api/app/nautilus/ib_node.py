"""
Live NautilusTrader node wired to Interactive Brokers Gateway.

Owns one long-running TradingNode that holds the IB data + execution clients.
Bridges NT events (quote ticks, trade ticks, bars, position updates) into the
FastAPI WebSocket manager, and exposes async helpers the REST routers call.

Includes a robust reconnection supervisor: connection drops are detected via
a periodic keepalive ping; failed connects/disconnects trigger an exponential-
backoff retry loop so transient gateway hiccups recover automatically without
restarting the API process.

Falls back to a no-op stub when nautilus_trader / IB adapter aren't importable
or when MOCK_MODE is on, so the rest of the API keeps working.
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

from ..config import settings
from ..ws.manager import manager

logger = logging.getLogger(__name__)


# -- import guards -----------------------------------------------------------
# NT + the IB adapter are heavy and may be missing in dev. Import lazily and
# remember whether we got everything.

try:
    from nautilus_trader.adapters.interactive_brokers.config import (
        InteractiveBrokersDataClientConfig,
        InteractiveBrokersExecClientConfig,
        InteractiveBrokersInstrumentProviderConfig,
    )
    from nautilus_trader.adapters.interactive_brokers.factories import (
        InteractiveBrokersLiveDataClientFactory,
        InteractiveBrokersLiveExecClientFactory,
    )
    from nautilus_trader.config import LoggingConfig
    from nautilus_trader.live.config import (
        LiveDataEngineConfig,
        LiveExecEngineConfig,
        RoutingConfig,
        TradingNodeConfig,
    )
    from nautilus_trader.live.node import TradingNode
    from nautilus_trader.model.data import Bar, BarType, QuoteTick, TradeTick
    from nautilus_trader.model.enums import AccountType, OmsType
    from nautilus_trader.model.identifiers import InstrumentId, TraderId, Venue
    from nautilus_trader.trading.strategy import Strategy, StrategyConfig

    NT_IB_AVAILABLE = True
except Exception as e:  # noqa: BLE001
    NT_IB_AVAILABLE = False
    _IMPORT_ERR = e
    logger.warning(f"NautilusTrader IB adapter not importable: {e}")


IB_VENUE = "INTERACTIVE_BROKERS"


# ── Connection state machine ────────────────────────────────────────────────
# Pushed to the WS layer so the dashboard can render an accurate status pill.
class ConnectionState:
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    FAILED = "failed"


# Tuning constants for the reconnect / keepalive supervisor.
_RECONNECT_BASE_DELAY = 2.0     # seconds
_RECONNECT_MAX_DELAY = 60.0     # cap exponential backoff at 60s
_RECONNECT_MAX_ATTEMPTS = 0     # 0 == infinite
_KEEPALIVE_INTERVAL = 15.0      # ping every 15s while connected
_KEEPALIVE_TIMEOUT = 8.0        # any single keepalive call must complete this fast
_CONNECT_TIMEOUT = 60.0         # how long to wait for TradingNode.is_running
_KEEPALIVE_FAIL_THRESHOLD = 2   # consecutive keepalive failures -> declare drop


@dataclass
class _LiveState:
    """In-memory cache of latest IB-sourced data, kept in sync via NT events."""
    quotes: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    last_bars: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    positions: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    account: Dict[str, Any] = field(default_factory=dict)
    subscriptions: Set[str] = field(default_factory=set)
    trades: List[Dict[str, Any]] = field(default_factory=list)  # captured fills


class IBNode:
    """Owns the NautilusTrader TradingNode and exposes a small async API.

    Public surface:
      await start() / await stop()
      is_connected -> bool
      connection_state -> str ("disconnected" | "connecting" | "connected" | "reconnecting" | "failed")
      await ensure_subscribed(symbol)
      latest_quote(symbol)
      latest_positions() / latest_account()
      await request_historical_bars(symbol, timeframe, days) -> list[bar]

    Reconnection model
    ------------------
    A supervisor task runs for the lifetime of start() / stop():

      * On start(): attempts an initial connect; if it fails we fall into the
        reconnect loop (exp backoff + jitter, capped at 60s) until success.
      * On stop(): supervisor exits cleanly.
      * Once connected: a keepalive task pings the gateway every 15s. Two
        consecutive failures (or a TradingNode that's stopped running) demote
        the state to RECONNECTING and re-enter the reconnect loop. Subscribed
        symbols are remembered and re-subscribed automatically after a
        successful reconnect.
    """

    def __init__(self):
        self.state = _LiveState()
        self._node: Optional[Any] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._ready = asyncio.Event()
        self._lock = asyncio.Lock()
        self._strategy: Optional[Any] = None
        self._connection_state: str = ConnectionState.DISCONNECTED
        self._last_error: Optional[str] = None
        self._reconnect_attempt = 0
        self._supervisor_task: Optional[asyncio.Task] = None
        self._keepalive_task: Optional[asyncio.Task] = None
        self._stop_requested = False
        self._sticky_subscriptions: Set[str] = set()  # survive reconnects
        self._last_state_broadcast: float = 0.0

    # -- lifecycle ----------------------------------------------------------

    @property
    def is_available(self) -> bool:
        return NT_IB_AVAILABLE and not settings.mock_mode

    @property
    def is_connected(self) -> bool:
        return (
            bool(self._node)
            and self._ready.is_set()
            and self._connection_state == ConnectionState.CONNECTED
        )

    @property
    def connection_state(self) -> str:
        return self._connection_state

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    def _set_state(self, new_state: str, error: Optional[str] = None) -> None:
        """Update connection state and emit a WS notification."""
        prev = self._connection_state
        if prev == new_state and error == self._last_error:
            return
        self._connection_state = new_state
        if error is not None:
            self._last_error = error
        elif new_state == ConnectionState.CONNECTED:
            self._last_error = None
        logger.info("IBNode state: %s -> %s%s",
                    prev, new_state,
                    f" ({error})" if error else "")
        self._broadcast_state()

    def _broadcast_state(self) -> None:
        """Push the current connection state to the WS layer. Throttled to
        ~1Hz so a flapping connection can't spam clients."""
        now = time.monotonic()
        if now - self._last_state_broadcast < 0.5:
            return
        self._last_state_broadcast = now
        payload = {
            "type": "ib_state",
            "data": {
                "state": self._connection_state,
                "connected": self.is_connected,
                "error": self._last_error,
                "attempt": self._reconnect_attempt,
                "subscriptions": sorted(self._sticky_subscriptions),
            },
        }
        _schedule(manager.broadcast(payload))

    async def start(self) -> None:
        """Start the reconnection supervisor. Returns once the first attempt
        has been initiated — actual connect happens in the background so a
        slow / unavailable gateway can't block FastAPI startup."""
        if not self.is_available:
            logger.info(
                "IBNode disabled (mock_mode=%s, nt_ib=%s) - serving mock data",
                settings.mock_mode,
                NT_IB_AVAILABLE,
            )
            self._set_state(ConnectionState.DISCONNECTED)
            return

        self._stop_requested = False
        if self._supervisor_task is None or self._supervisor_task.done():
            self._loop = asyncio.get_running_loop()
            self._supervisor_task = asyncio.create_task(self._supervisor_loop())
            logger.info("IBNode supervisor started")

    async def _supervisor_loop(self) -> None:
        """Long-running task: drives connect/keepalive/reconnect cycles."""
        try:
            while not self._stop_requested:
                # Try to bring the node up. The connect call sets state to
                # CONNECTING/CONNECTED/FAILED internally.
                ok = await self._try_connect()
                if not ok:
                    await self._sleep_with_backoff()
                    continue

                # Connected — re-subscribe sticky symbols and start keepalive.
                await self._resubscribe_sticky()
                self._reconnect_attempt = 0
                self._keepalive_task = asyncio.create_task(self._keepalive_loop())
                try:
                    await self._keepalive_task
                except asyncio.CancelledError:
                    pass

                if self._stop_requested:
                    break

                # Keepalive returned -> connection dropped. Tear down + retry.
                logger.warning("IBNode: keepalive ended — tearing down and reconnecting")
                self._set_state(ConnectionState.RECONNECTING, error="connection drop detected")
                await self._teardown_node()
                await self._sleep_with_backoff()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.exception("IBNode supervisor crashed: %s", e)
            self._set_state(ConnectionState.FAILED, error=f"supervisor crash: {e}")

    async def _try_connect(self) -> bool:
        """Single connect attempt. Returns True iff TradingNode reached
        is_running and we've flipped state to CONNECTED."""
        async with self._lock:
            if self._stop_requested:
                return False
            self._set_state(ConnectionState.CONNECTING)
            try:
                account_id = await self._discover_account_id()
                if not account_id:
                    err = (
                        f"could not discover an account on ib-gateway "
                        f"{settings.ib_gateway_host}:{settings.ib_gateway_port} — "
                        "gateway may not be fully logged in yet"
                    )
                    logger.error("IBNode: %s", err)
                    self._set_state(ConnectionState.RECONNECTING, error=err)
                    return False

                logger.info("IBNode: using account %s", account_id)
                self._node = self._build_node(account_id)
                self._node.build()
                self._loop = asyncio.get_running_loop()
                self._run_task = asyncio.create_task(self._node.run_async())

                # Wait up to _CONNECT_TIMEOUT for the TradingNode to report
                # is_running. Poll cadence stays modest so we don't busy-wait.
                deadline = time.monotonic() + _CONNECT_TIMEOUT
                while time.monotonic() < deadline:
                    if self._node.is_running:
                        break
                    if self._stop_requested:
                        return False
                    await asyncio.sleep(0.5)

                if not self._node.is_running:
                    err = f"timed out after {_CONNECT_TIMEOUT}s waiting for TradingNode to start"
                    logger.error("IBNode: %s", err)
                    await self._teardown_node_unlocked()
                    self._set_state(ConnectionState.RECONNECTING, error=err)
                    return False

                self._ready.set()
                self._set_state(ConnectionState.CONNECTED)
                logger.info(
                    "IBNode connected to ib-gateway %s:%s",
                    settings.ib_gateway_host, settings.ib_gateway_port,
                )
                return True

            except Exception as e:  # noqa: BLE001
                logger.exception("IBNode connect attempt failed: %s", e)
                await self._teardown_node_unlocked()
                self._set_state(ConnectionState.RECONNECTING, error=str(e))
                return False

    async def _keepalive_loop(self) -> None:
        """Probe the gateway periodically. If the probe fails twice in a row,
        or the TradingNode reports it's no longer running, return so the
        supervisor can drive a reconnect."""
        failures = 0
        while not self._stop_requested:
            await asyncio.sleep(_KEEPALIVE_INTERVAL)
            if self._stop_requested:
                return

            # First, cheap structural check: is the TradingNode still alive?
            try:
                node_alive = bool(self._node) and bool(self._node.is_running)
            except Exception:  # noqa: BLE001
                node_alive = False
            if not node_alive:
                logger.warning("IBNode keepalive: TradingNode is_running=False")
                return

            # Now an active probe — ask the gateway for accountSummary via
            # ib_async (cheap and independent of NT's internal cache). Any
            # exception or timeout is a strike.
            try:
                ok = await asyncio.wait_for(self._keepalive_probe(), timeout=_KEEPALIVE_TIMEOUT)
            except asyncio.TimeoutError:
                ok = False
                logger.warning("IBNode keepalive: probe timed out after %ss", _KEEPALIVE_TIMEOUT)
            except Exception as e:  # noqa: BLE001
                ok = False
                logger.warning("IBNode keepalive: probe error: %s", e)

            if ok:
                failures = 0
            else:
                failures += 1
                logger.warning("IBNode keepalive failure %d/%d", failures, _KEEPALIVE_FAIL_THRESHOLD)
                if failures >= _KEEPALIVE_FAIL_THRESHOLD:
                    return  # supervisor will reconnect

    async def _keepalive_probe(self) -> bool:
        """Cheap independent gateway-liveness check.

        We connect a separate ib_async client briefly and ask for the managed
        accounts list. This avoids tangling with NT's internal state — if the
        gateway socket has dropped silently, this will hang or error out
        within _KEEPALIVE_TIMEOUT and we treat it as a strike.
        """
        try:
            from ib_async import IB
        except Exception:  # noqa: BLE001
            # Without ib_async we fall back to trusting NT's is_running flag.
            return bool(self._node) and bool(self._node.is_running)

        ib = IB()
        try:
            await ib.connectAsync(
                host=settings.ib_gateway_host,
                port=settings.ib_gateway_port,
                # Distinct client id from the data/exec clients AND from the
                # account-discovery probe.
                clientId=settings.ib_client_id + 200,
                timeout=max(2, int(_KEEPALIVE_TIMEOUT) - 2),
            )
            accounts = list(ib.managedAccounts() or [])
            return len(accounts) > 0
        finally:
            try:
                ib.disconnect()
            except Exception:  # noqa: BLE001
                pass

    async def _sleep_with_backoff(self) -> None:
        """Exponential backoff with full jitter, capped at _RECONNECT_MAX_DELAY.

        Sequence: ~2s, 4s, 8s, 16s, 32s, 60s, 60s, ... (each ±25% jitter).
        Honours stop_requested every 500ms so shutdown is responsive even
        deep into a long wait.
        """
        if self._stop_requested:
            return
        self._reconnect_attempt += 1
        if _RECONNECT_MAX_ATTEMPTS and self._reconnect_attempt > _RECONNECT_MAX_ATTEMPTS:
            self._set_state(ConnectionState.FAILED,
                            error=f"exceeded {_RECONNECT_MAX_ATTEMPTS} reconnect attempts")
            self._stop_requested = True
            return

        base = min(_RECONNECT_BASE_DELAY * (2 ** (self._reconnect_attempt - 1)),
                   _RECONNECT_MAX_DELAY)
        # Full jitter (±25%) so multiple replicas don't all retry in lockstep.
        delay = base * random.uniform(0.75, 1.25)
        delay = min(delay, _RECONNECT_MAX_DELAY)
        logger.info(
            "IBNode: reconnect attempt %d — sleeping %.1fs before retry",
            self._reconnect_attempt, delay,
        )
        self._set_state(ConnectionState.RECONNECTING)
        # Sleep in small chunks so stop_requested can interrupt promptly.
        end = time.monotonic() + delay
        while not self._stop_requested and time.monotonic() < end:
            await asyncio.sleep(0.5)

    async def _teardown_node(self) -> None:
        async with self._lock:
            await self._teardown_node_unlocked()

    async def _teardown_node_unlocked(self) -> None:
        """Drop the current TradingNode without changing high-level state.
        Caller is responsible for transitioning to RECONNECTING / FAILED /
        DISCONNECTED as appropriate."""
        if not self._node:
            self._ready.clear()
            return
        node = self._node
        self._node = None
        self._ready.clear()
        try:
            await asyncio.wait_for(node.stop_async(), timeout=10.0)
        except asyncio.TimeoutError:
            logger.warning("IBNode teardown: stop_async timed out")
        except Exception as e:  # noqa: BLE001
            logger.warning("IBNode teardown stop error: %s", e)
        try:
            node.dispose()
        except Exception as e:  # noqa: BLE001
            logger.debug("IBNode teardown dispose error: %s", e)
        run_task = getattr(self, "_run_task", None)
        if run_task and not run_task.done():
            run_task.cancel()
            try:
                await run_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    async def _resubscribe_sticky(self) -> None:
        """After a successful reconnect, re-subscribe to every symbol that was
        active before the drop. Quotes will resume streaming without the
        dashboard having to do anything."""
        # Reset the per-NT subscription tracker — those subscriptions died
        # with the old node.
        self.state.subscriptions = set()
        for sym in list(self._sticky_subscriptions):
            try:
                await self.ensure_subscribed(sym, _sticky=False)
            except Exception as e:  # noqa: BLE001
                logger.warning("resubscribe %s failed: %s", sym, e)

    async def _discover_account_id(self) -> Optional[str]:
        """Connect briefly with ib_async to grab the managed account list, then drop.

        IBKR returns the list of accounts associated with the login immediately on
        connect. We use a separate temporary client_id to avoid colliding with
        NautilusTrader's data/exec clients.
        """
        import os
        env_acct = os.environ.get("TWS_ACCOUNT", "").strip()
        if env_acct:
            return env_acct

        try:
            from ib_async import IB
        except Exception as e:  # noqa: BLE001
            logger.warning("ib_async not available for account discovery: %s", e)
            return None

        ib = IB()
        try:
            await ib.connectAsync(
                host=settings.ib_gateway_host,
                port=settings.ib_gateway_port,
                clientId=settings.ib_client_id + 100,  # well away from NT client ids
                timeout=10,
            )
            accounts = list(ib.managedAccounts() or [])
            return accounts[0] if accounts else None
        except Exception as e:  # noqa: BLE001
            logger.warning("account discovery failed: %s", e)
            return None
        finally:
            try:
                ib.disconnect()
            except Exception:  # noqa: BLE001
                pass

    async def stop(self) -> None:
        """Halt the supervisor and the underlying TradingNode."""
        self._stop_requested = True
        # Cancel keepalive first — it's the inner loop.
        if self._keepalive_task and not self._keepalive_task.done():
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._keepalive_task = None
        # Then the supervisor.
        if self._supervisor_task and not self._supervisor_task.done():
            self._supervisor_task.cancel()
            try:
                await self._supervisor_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._supervisor_task = None
        await self._teardown_node()
        self._set_state(ConnectionState.DISCONNECTED)

    async def force_reconnect(self) -> None:
        """Operator hook: rebuild the connection immediately without waiting
        for keepalive to notice. Used by /admin/reconnect-style endpoints."""
        logger.info("IBNode: force reconnect requested")
        if self._keepalive_task and not self._keepalive_task.done():
            self._keepalive_task.cancel()
        await self._teardown_node()
        # Supervisor loop notices the keepalive returned and reconnects.

    # -- node config --------------------------------------------------------

    def _build_node(self, account_id: str):
        """Construct a TradingNode with IB data + exec clients pointed at our gateway."""
        instrument_provider = InteractiveBrokersInstrumentProviderConfig(
            load_ids=frozenset(),  # lazy: load on subscribe rather than upfront
            cache_validity_days=1,
        )

        data_cfg = InteractiveBrokersDataClientConfig(
            ibg_host=settings.ib_gateway_host,
            ibg_port=settings.ib_gateway_port,
            ibg_client_id=settings.ib_client_id,
            use_regular_trading_hours=True,
            instrument_provider=instrument_provider,
        )

        exec_cfg = InteractiveBrokersExecClientConfig(
            ibg_host=settings.ib_gateway_host,
            ibg_port=settings.ib_gateway_port,
            ibg_client_id=settings.ib_client_id + 1,  # separate client id for exec
            account_id=account_id,
            instrument_provider=instrument_provider,
            routing=RoutingConfig(default=True),
        )

        node_cfg = TradingNodeConfig(
            trader_id=TraderId("TRADER-001"),
            logging=LoggingConfig(log_level=settings.log_level),
            data_clients={IB_VENUE: data_cfg},
            exec_clients={IB_VENUE: exec_cfg},
            data_engine=LiveDataEngineConfig(),
            exec_engine=LiveExecEngineConfig(),
        )

        node = TradingNode(config=node_cfg)
        node.add_data_client_factory(IB_VENUE, InteractiveBrokersLiveDataClientFactory)
        node.add_exec_client_factory(IB_VENUE, InteractiveBrokersLiveExecClientFactory)

        # Bridge strategy: subscribes to symbols on demand and forwards events.
        self._strategy = _BridgeStrategy(self)
        node.trader.add_strategy(self._strategy)
        return node

    # -- subscription -------------------------------------------------------

    async def ensure_subscribed(self, symbol: str, *, _sticky: bool = True) -> None:
        """Subscribe the bridge strategy to quote ticks for symbol if not already.

        The symbol is remembered in `_sticky_subscriptions` so it can be
        restored after a reconnect. Pass _sticky=False during the
        re-subscribe pass so we don't re-add the same set we're iterating.
        """
        symbol = symbol.upper()
        if _sticky:
            self._sticky_subscriptions.add(symbol)
        if not self.is_connected or symbol in self.state.subscriptions:
            return
        try:
            self._strategy.subscribe_symbol(symbol)
            self.state.subscriptions.add(symbol)
        except Exception as e:  # noqa: BLE001
            logger.debug("subscribe %s failed: %s", symbol, e)

    # -- accessors ----------------------------------------------------------

    def latest_quote(self, symbol: str) -> Optional[Dict[str, Any]]:
        return self.state.quotes.get(symbol.upper())

    def latest_positions(self) -> List[Dict[str, Any]]:
        return list(self.state.positions.values())

    def latest_account(self) -> Dict[str, Any]:
        return dict(self.state.account)

    def latest_trades(self) -> List[Dict[str, Any]]:
        # newest first
        return list(reversed(self.state.trades))

    def status_snapshot(self) -> Dict[str, Any]:
        """Compact view used by /health and the WS snapshot broadcaster."""
        return {
            "state": self._connection_state,
            "connected": self.is_connected,
            "error": self._last_error,
            "attempt": self._reconnect_attempt,
            "subscriptions": sorted(self._sticky_subscriptions),
            "host": settings.ib_gateway_host,
            "port": settings.ib_gateway_port,
        }

    # -- historical bars ----------------------------------------------------

    async def request_historical_bars(
        self,
        symbol: str,
        timeframe: str,
        days: int,
    ) -> List[Dict[str, Any]]:
        """Request historical bars via NT IB adapter."""
        if not self.is_connected:
            return []
        try:
            return await self._strategy.request_bars(symbol, timeframe, days)
        except Exception as e:  # noqa: BLE001
            logger.warning("historical bars %s/%s failed: %s", symbol, timeframe, e)
            return []

    # -- event sinks (called by bridge strategy) ----------------------------

    def _on_quote(self, symbol: str, payload: Dict[str, Any]) -> None:
        self.state.quotes[symbol] = payload
        _schedule(manager.broadcast_quote(symbol, payload))

    def _on_bar(self, symbol: str, payload: Dict[str, Any]) -> None:
        self.state.last_bars[symbol] = payload
        _schedule(manager.broadcast_bar(symbol, payload))

    def _on_position(self, payload: Dict[str, Any]) -> None:
        sym = payload.get("symbol")
        if not sym:
            return
        if payload.get("quantity", 0) == 0:
            self.state.positions.pop(sym, None)
        else:
            self.state.positions[sym] = payload
        # Intentionally do NOT broadcast individual position events here.
        # Nautilus's stream emits transient quantity=0 closures during
        # reconciliation that conflict with the ib_async-based snapshot in
        # main._status_broadcaster. The 10s snapshot is the only source of
        # position state pushed to clients.

    def _on_account(self, payload: Dict[str, Any]) -> None:
        self.state.account.update(payload)

    def _on_fill(self, payload: Dict[str, Any]) -> None:
        # cap memory — keep last 1000 fills
        self.state.trades.append(payload)
        if len(self.state.trades) > 1000:
            self.state.trades = self.state.trades[-1000:]
        _schedule(manager.broadcast({"type": "trade", "data": payload}))


def _schedule(coro: Awaitable[Any]) -> None:
    """Fire-and-forget a coroutine on the running loop without blocking the caller."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.create_task(coro)
        else:
            loop.run_until_complete(coro)
    except Exception:  # noqa: BLE001
        # never let a broadcast failure poison the data path
        pass


# -- bridge strategy ---------------------------------------------------------
# Lives inside the NT trader so we can use NT's subscribe_quote_ticks API and
# receive on_* callbacks. Keep it thin: translate NT objects to plain dicts
# and hand them to the IBNode sinks.

if NT_IB_AVAILABLE:

    class _BridgeStrategyConfig(StrategyConfig, frozen=True):
        instrument_ids: List[str] = []

    class _BridgeStrategy(Strategy):
        """Subscribes to instruments and forwards ticks/bars/positions to IBNode."""

        def __init__(self, node: "IBNode"):
            super().__init__(config=_BridgeStrategyConfig())
            self._ibnode = node
            self._subscribed: Set[str] = set()

        # NT lifecycle hooks
        def on_start(self) -> None:
            self.log.info("bridge strategy online")
            # seed initial state from portfolio + positions already known to the cache
            self._sync_positions()
            self._sync_account()
            # spawn a background poll for account snapshots — NT updates them
            # frequently but there is no direct on_account hook on Strategy.
            try:
                self._account_poll_task = asyncio.create_task(self._poll_account())
            except Exception:  # noqa: BLE001
                self._account_poll_task = None

        async def _poll_account(self) -> None:
            while True:
                try:
                    self._sync_account()
                except Exception as e:  # noqa: BLE001
                    logger.debug("account sync error: %s", e)
                await asyncio.sleep(3)

        def _sync_account(self) -> None:
            try:
                venue = Venue(IB_VENUE)
                account = self.portfolio.account(venue)
                if not account:
                    return
                # balances_total() -> {Currency: Money}; pick USD if present, else first
                totals = account.balances_total()
                free_d = account.balances_free()
                locked_d = account.balances_locked()
                if not totals:
                    return
                # prefer USD
                key = next((c for c in totals if str(c) == "USD"), next(iter(totals)))
                total = float(totals[key]) if totals.get(key) is not None else 0.0
                free = float(free_d.get(key)) if free_d.get(key) is not None else 0.0
                locked = float(locked_d.get(key)) if locked_d.get(key) is not None else 0.0
                payload = {
                    "balance": total,
                    "equity": total,
                    "buying_power": free,
                    "locked": locked,
                    "currency": str(key),
                    "account_id": str(account.id) if hasattr(account, "id") else None,
                    "mode": "paper",
                }
                self._ibnode._on_account(payload)
            except Exception as e:  # noqa: BLE001
                logger.debug("account sync error: %s", e)

        def _sync_positions(self) -> None:
            try:
                for pos in self.cache.positions():
                    self._push_position(pos)
            except Exception:  # noqa: BLE001
                pass

        def _push_position(self, pos) -> None:  # type: ignore[no-untyped-def]
            try:
                sym = str(pos.instrument_id.symbol)
                qty = float(pos.signed_qty) if hasattr(pos, "signed_qty") else float(pos.quantity)
                avg = float(pos.avg_px_open) if hasattr(pos, "avg_px_open") else 0.0
                # current price: try the live quote cache, fall back to avg
                quote = self._ibnode.state.quotes.get(sym) or {}
                cp = float(quote.get("last") or quote.get("bid") or avg)
                upnl = (cp - avg) * qty if avg else 0.0
                payload = {
                    "symbol": sym,
                    "quantity": qty,
                    "avg_price": avg,
                    "current_price": cp,
                    "unrealized_pnl": round(upnl, 2),
                    "unrealized_pnl_pct": round((cp - avg) / avg * 100, 2) if avg else 0.0,
                    "side": "BUY" if qty >= 0 else "SELL",
                    "sector": None,
                }
                self._ibnode._on_position(payload)
            except Exception as e:  # noqa: BLE001
                logger.debug("push_position error: %s", e)

        def on_position_opened(self, event) -> None:  # type: ignore[override, no-untyped-def]
            try:
                pos = self.cache.position(event.position_id)
                if pos is not None:
                    self._push_position(pos)
            except Exception:  # noqa: BLE001
                pass

        def on_position_changed(self, event) -> None:  # type: ignore[override, no-untyped-def]
            try:
                pos = self.cache.position(event.position_id)
                if pos is not None:
                    self._push_position(pos)
            except Exception:  # noqa: BLE001
                pass

        def on_position_closed(self, event) -> None:  # type: ignore[override, no-untyped-def]
            try:
                pos = self.cache.position(event.position_id)
                if pos is not None:
                    sym = str(pos.instrument_id.symbol)
                    # quantity=0 triggers removal in _on_position
                    self._ibnode._on_position({"symbol": sym, "quantity": 0})
            except Exception:  # noqa: BLE001
                pass

        def on_order_filled(self, event) -> None:  # type: ignore[override, no-untyped-def]
            """Capture every fill into the live trades buffer."""
            try:
                ts = getattr(event, "ts_event", None)
                if ts is None:
                    ts_iso = datetime.now(timezone.utc).isoformat()
                else:
                    ts_iso = datetime.fromtimestamp(int(ts) / 1e9, tz=timezone.utc).isoformat()

                last_qty = float(getattr(event, "last_qty", 0) or 0)
                last_px = float(getattr(event, "last_px", 0) or 0)
                side = str(getattr(event, "order_side", "BUY"))

                # find originating strategy if NT recorded it
                strategy = None
                try:
                    order = self.cache.order(event.client_order_id)
                    if order is not None:
                        sid = getattr(order, "strategy_id", None)
                        strategy = str(sid) if sid else None
                except Exception:  # noqa: BLE001
                    pass

                # try to compute realized PnL for closing fills
                pnl = None
                try:
                    pos = self.cache.position(event.position_id) if event.position_id else None
                    if pos is not None and hasattr(pos, "realized_pnl"):
                        pnl = float(pos.realized_pnl) if pos.realized_pnl is not None else None
                except Exception:  # noqa: BLE001
                    pass

                payload = {
                    "id": str(getattr(event, "trade_id", event.client_order_id)),
                    "symbol": str(event.instrument_id.symbol),
                    "side": "BUY" if "BUY" in side else "SELL",
                    "quantity": last_qty,
                    "price": last_px,
                    "pnl": pnl,
                    "strategy": strategy,
                    "timestamp": ts_iso,
                }
                self._ibnode._on_fill(payload)
            except Exception as e:  # noqa: BLE001
                logger.debug("on_order_filled error: %s", e)

        def subscribe_symbol(self, symbol: str) -> None:
            if symbol in self._subscribed:
                return
            instrument_id = InstrumentId.from_str(f"{symbol}.{IB_VENUE}")
            try:
                self.subscribe_quote_ticks(instrument_id)
                self.subscribe_trade_ticks(instrument_id)
            except Exception as e:  # noqa: BLE001
                logger.debug("nt subscribe %s failed: %s", symbol, e)
                return
            self._subscribed.add(symbol)

        def on_quote_tick(self, tick: QuoteTick) -> None:  # type: ignore[override]
            symbol = str(tick.instrument_id.symbol)
            payload = {
                "symbol": symbol,
                "bid": float(tick.bid_price),
                "ask": float(tick.ask_price),
                "last": (float(tick.bid_price) + float(tick.ask_price)) / 2,
                "volume": 0.0,
                "change": 0.0,
                "change_pct": 0.0,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            self._ibnode._on_quote(symbol, payload)

        def on_trade_tick(self, tick: TradeTick) -> None:  # type: ignore[override]
            symbol = str(tick.instrument_id.symbol)
            existing = self._ibnode.state.quotes.get(symbol, {})
            existing["last"] = float(tick.price)
            existing["symbol"] = symbol
            existing["timestamp"] = datetime.now(timezone.utc).isoformat()
            self._ibnode._on_quote(symbol, existing)

        def on_bar(self, bar: Bar) -> None:  # type: ignore[override]
            symbol = str(bar.bar_type.instrument_id.symbol)
            payload = {
                "time": int(bar.ts_event // 1_000_000_000),
                "open": float(bar.open),
                "high": float(bar.high),
                "low": float(bar.low),
                "close": float(bar.close),
                "volume": float(bar.volume),
            }
            self._ibnode._on_bar(symbol, payload)

        async def request_bars(self, symbol: str, timeframe: str, days: int) -> List[Dict[str, Any]]:
            """Request historical bars and collect them via on_historical_data."""
            instrument_id = InstrumentId.from_str(f"{symbol}.{IB_VENUE}")
            bar_type = BarType.from_str(f"{instrument_id}-{_nt_bar_spec(timeframe)}-EXTERNAL")
            collected: List[Dict[str, Any]] = []
            done = asyncio.Event()

            def _on_hist(bars):
                for b in bars:
                    collected.append({
                        "time": int(b.ts_event // 1_000_000_000),
                        "open": float(b.open),
                        "high": float(b.high),
                        "low": float(b.low),
                        "close": float(b.close),
                        "volume": float(b.volume),
                    })
                done.set()

            # NT exposes request_bars on Strategy; delivery comes through on_historical_data.
            self.request_bars(bar_type)
            try:
                await asyncio.wait_for(done.wait(), timeout=15)
            except asyncio.TimeoutError:
                logger.debug("historical bars timeout for %s/%s", symbol, timeframe)
            return collected
else:
    # Stub class so attribute references don't blow up at import time.
    class _BridgeStrategy:  # type: ignore[no-redef]
        def __init__(self, *_a, **_kw): ...
        def subscribe_symbol(self, *_a, **_kw): ...


_TF_TO_NT = {
    "1m": "1-MINUTE-LAST",
    "5m": "5-MINUTE-LAST",
    "15m": "15-MINUTE-LAST",
    "30m": "30-MINUTE-LAST",
    "1h": "1-HOUR-LAST",
    "4h": "4-HOUR-LAST",
    "1d": "1-DAY-LAST",
}


def _nt_bar_spec(tf: str) -> str:
    return _TF_TO_NT.get(tf, "15-MINUTE-LAST")


# Singleton — imported by main.py lifespan and routers.
ib_node = IBNode()
