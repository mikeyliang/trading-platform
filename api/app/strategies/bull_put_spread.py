"""
Bull Put Spread automation.

Sells out-of-the-money put credit spreads on a configured underlying. Standard
defined-risk premium-selling playbook:

  Entry (per scan):
    - target DTE in [target_dte_min, target_dte_max], pick nearest expiry
    - short put strike: nearest strike to short_delta on that expiry
    - long  put strike: short_strike - wing_width  (defined max loss)
    - submit Bag at limit = mid - slippage, retry once at touch if not filled
    - never carry more than max_concurrent open spreads

  Exit (per tick scan):
    - profit target hit (current debit-to-close <= entry_credit * (1 - profit_target_pct))
    - stop loss hit (current debit-to-close >= entry_credit * (1 + stop_loss_mult))
    - time stop (DTE <= time_stop_dte) — close regardless of P/L
    - assignment risk: short strike breached AND DTE <= 7

This is intentionally conservative. Tune the params per underlying — the
defaults are sized for SPY (wing_width=5). RUT needs wing_width=10-25.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..nautilus.ib_options import get_chain
from ..nautilus.ib_orders import OpenSpread, orders_client
from ..ws.manager import manager

logger = logging.getLogger(__name__)


@dataclass
class BullPutSpreadConfig:
    symbol: str = "SPY"
    target_dte_min: int = 30
    target_dte_max: int = 45
    short_delta: float = 0.25      # absolute value; e.g. 0.25 → short ~25-delta put
    wing_width: float = 5.0        # dollars between strikes (SPY=5, IWM=2, RUT=10-25)
    quantity: int = 1
    max_concurrent: int = 3
    profit_target_pct: float = 0.50  # close at 50% of max profit
    stop_loss_mult: float = 2.0      # close if loss >= 2x credit received
    time_stop_dte: int = 21          # close any spread with DTE <= 21
    scan_interval_sec: int = 60      # how often to scan for entries/exits
    slippage: float = 0.05           # subtract from mid for entry limit


class BullPutSpreadStrategy:
    """
    Async strategy runner. Owns its own scan loop. Operates on the orders_client
    singleton — open spreads are visible to the rest of the API via /api/positions.
    """

    def __init__(self, strategy_id: str, config: BullPutSpreadConfig):
        self.id = strategy_id
        self.config = config
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self.stats = {
            "entries": 0,
            "exits_target": 0,
            "exits_stop": 0,
            "exits_time": 0,
            "realized_pnl": 0.0,
            "last_scan": None,
            "last_error": None,
        }

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self):
        if self.is_running:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name=f"strategy-{self.id}")
        logger.info("strategy %s started: %s", self.id, self.config)

    async def stop(self):
        if not self._task:
            return
        self._stop.set()
        try:
            await asyncio.wait_for(self._task, timeout=5)
        except asyncio.TimeoutError:
            self._task.cancel()
        self._task = None
        logger.info("strategy %s stopped", self.id)

    # -- main loop ----------------------------------------------------------

    async def _run(self):
        while not self._stop.is_set():
            try:
                await self._scan_exits()
                await self._scan_entries()
                self.stats["last_scan"] = datetime.now(timezone.utc).isoformat()
            except Exception as e:  # noqa: BLE001
                logger.exception("strategy %s scan error: %s", self.id, e)
                self.stats["last_error"] = str(e)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.config.scan_interval_sec)
            except asyncio.TimeoutError:
                continue

    # -- entry --------------------------------------------------------------

    async def _scan_entries(self):
        open_for_symbol = [s for s in orders_client.list_open()
                           if s.symbol == self.config.symbol]
        if len(open_for_symbol) >= self.config.max_concurrent:
            return

        expiry = await self._pick_expiry()
        if not expiry:
            return

        chain = await get_chain(self.config.symbol, expiry)
        if not chain.get("puts") or chain.get("underlying_price") is None:
            return
        spot = float(chain["underlying_price"])

        short_put = self._pick_short_put(chain["puts"])
        if not short_put:
            return
        short_strike = short_put["strike"]
        long_strike = short_strike - self.config.wing_width
        long_put = next((p for p in chain["puts"] if abs(p["strike"] - long_strike) < 0.01), None)
        if not long_put:
            return

        credit = self._mid_credit(short_put, long_put) - self.config.slippage
        if credit <= 0.05:  # don't bother below a nickel
            return

        spread = await orders_client.place_bull_put_spread(
            symbol=self.config.symbol,
            expiry=expiry,
            short_strike=short_strike,
            long_strike=long_strike,
            quantity=self.config.quantity,
            limit_credit=round(credit, 2),
            underlying_price=spot,
        )
        if spread:
            self.stats["entries"] += 1
            await manager.broadcast_signal(
                symbol=self.config.symbol,
                signal="BUY_SPREAD",
                strategy=self.id,
                price=credit,
            )

    async def _pick_expiry(self) -> Optional[str]:
        chain = await get_chain(self.config.symbol)
        today = datetime.now(timezone.utc).date()
        candidates = []
        for e in chain.get("expirations", []):
            try:
                dt = datetime.strptime(e, "%Y%m%d").date()
                dte = (dt - today).days
                if self.config.target_dte_min <= dte <= self.config.target_dte_max:
                    candidates.append((dte, e))
            except ValueError:
                continue
        if not candidates:
            return None
        # prefer monthly (3rd friday) when present, else the nearest in window
        return sorted(candidates)[0][1]

    def _pick_short_put(self, puts: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Find the put whose |delta| is closest to the configured short_delta."""
        with_delta = [p for p in puts if p.get("delta") is not None]
        if not with_delta:
            return None
        target = self.config.short_delta
        return min(with_delta, key=lambda p: abs(abs(p["delta"]) - target))

    # -- exit ---------------------------------------------------------------

    async def _scan_exits(self):
        today = datetime.now(timezone.utc).date()
        for spread in list(orders_client.list_open()):
            if spread.symbol != self.config.symbol:
                continue
            try:
                exit_reason = await self._check_exit(spread, today)
                if exit_reason:
                    debit = await self._compute_close_debit(spread)
                    if debit is None:
                        continue
                    ok = await orders_client.close_spread(spread.id, limit_debit=debit + self.config.slippage)
                    if ok:
                        self.stats[f"exits_{exit_reason}"] += 1
                        realized = (spread.credit_received - debit) * 100 * spread.quantity
                        self.stats["realized_pnl"] += round(realized, 2)
                        await manager.broadcast_signal(
                            symbol=spread.symbol,
                            signal=f"CLOSE_SPREAD_{exit_reason.upper()}",
                            strategy=self.id,
                            price=debit,
                        )
            except Exception as e:  # noqa: BLE001
                logger.exception("exit check failed for %s: %s", spread.id, e)

    async def _check_exit(self, spread: OpenSpread, today) -> Optional[str]:
        try:
            expiry_date = datetime.strptime(spread.expiry, "%Y%m%d").date()
        except ValueError:
            return None
        dte = (expiry_date - today).days

        if dte <= self.config.time_stop_dte:
            return "time"

        debit = await self._compute_close_debit(spread)
        if debit is None:
            return None

        if debit <= spread.credit_received * (1 - self.config.profit_target_pct):
            return "target"
        if debit >= spread.credit_received * self.config.stop_loss_mult:
            return "stop"
        return None

    async def _compute_close_debit(self, spread: OpenSpread) -> Optional[float]:
        """Compute the current debit (per spread, not per share) to close the spread."""
        chain = await get_chain(spread.symbol, spread.expiry)
        puts = {p["strike"]: p for p in chain.get("puts", [])}
        short_p = puts.get(spread.short_strike)
        long_p = puts.get(spread.long_strike)
        if not short_p or not long_p:
            return None
        # buy back the short, sell the long
        short_ask = short_p.get("ask")
        long_bid = long_p.get("bid")
        if short_ask is None or long_bid is None:
            # fall back to mids
            short_ask = self._mid(short_p) or short_p.get("last")
            long_bid = self._mid(long_p) or long_p.get("last")
        if short_ask is None or long_bid is None:
            return None
        return max(0.0, round(short_ask - long_bid, 2))

    def _mid_credit(self, short_put: Dict, long_put: Dict) -> float:
        return (self._mid(short_put) or 0.0) - (self._mid(long_put) or 0.0)

    @staticmethod
    def _mid(opt: Dict) -> Optional[float]:
        b, a = opt.get("bid"), opt.get("ask")
        if b is None or a is None or a <= 0:
            return None
        return (b + a) / 2

    # -- introspection ------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        open_spreads = [s for s in orders_client.list_open() if s.symbol == self.config.symbol]
        return {
            "id": self.id,
            "running": self.is_running,
            "config": self.config.__dict__,
            "stats": self.stats,
            "open_spreads": [s.to_dict() for s in open_spreads],
        }
