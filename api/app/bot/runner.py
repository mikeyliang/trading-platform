"""
Paper-trading bot — runs the SAME confluence signal engine the NautilusTrader
backtest validated, on live yfinance bars, with an AI news-analyst gate.

Safety model:
  * Starts ONLY when a completed simulation run validates the chosen
    preset+timeframe (profit factor >= 1.0 and avg return > 0) — or with an
    explicit force flag. The validating run id is recorded in bot state.
  * Execution is paper-internal: fills are simulated at the latest bar close
    (+ slippage). No real orders are sent anywhere. IB wiring can come later
    only after paper performance holds up.

Decision cycle (every ~60s, acts once per newly closed bar per symbol):
  1. fresh bars -> signal frame (signals.compute_signal_frame)
  2. open position? check ATR stop / R target intra-bar, then signal exits
  3. flat + enter_long fired? ask the news analyst; block if bias too bearish
  4. size by risk_pct of equity / stop distance; record decision with reasons

State persists to /app/data/bot/state.json across API restarts; the loop
auto-resumes if it was running.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)

BOT_DIR = Path(os.environ.get("BOT_DIR", "/app/data/bot"))
STATE_PATH = BOT_DIR / "state.json"

_TF_MINUTES = {"15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440}
_LOOKBACK_DAYS = {"5m": 20, "15m": 30, "30m": 45, "1h": 120, "4h": 240, "1d": 400}

DEFAULT_CONFIG = {
    # 3x leveraged ETFs: trend cleaner than single names (50% WR vs 39% in the
    # 2026-06 sweep) and carry built-in leverage on top of the margin sizing.
    "symbols": ["TQQQ", "SOXL", "SPXL", "TECL", "NVDL"],
    "timeframe": "15m",
    "preset": "scalp-daily",
    "params": {},                  # overlays signals.DEFAULT_PARAMS
    "initial_capital": 100_000.0,
    "max_positions": 3,
    "slippage_bps": 5,             # paper-fill slippage per side
    "news_gate": True,
    "news_block_below": -0.3,      # block longs when bias_score <= this
    "news_size_boost_above": 0.5,  # +25% size when news strongly aligned
}


class BotEngine:
    def __init__(self) -> None:
        self.state: Dict[str, Any] = {
            "status": "stopped",            # stopped | running
            "config": dict(DEFAULT_CONFIG),
            "validated_by": None,           # sim run id that gated this config
            "started_at": None,
            "cash": DEFAULT_CONFIG["initial_capital"],
            "positions": {},                # symbol -> position dict
            "closed_trades": [],
            "decisions": [],                # rolling decision/event log
            "equity_history": [],           # {time, value}
            "last_bar_ts": {},              # symbol -> last acted-on bar ts
            "last_cycle_at": None,
            "last_error": None,
        }
        self._task: Optional[asyncio.Task] = None
        self._load()

    # ── persistence ──────────────────────────────────────────────────

    def _load(self) -> None:
        try:
            if STATE_PATH.exists():
                self.state.update(json.loads(STATE_PATH.read_text()))
        except Exception:
            logger.exception("bot: could not load state")

    def _save(self) -> None:
        try:
            BOT_DIR.mkdir(parents=True, exist_ok=True)
            tmp = BOT_DIR / ".state.tmp"
            # cap rolling logs so the file stays small
            self.state["decisions"] = self.state["decisions"][-400:]
            self.state["equity_history"] = self.state["equity_history"][-5000:]
            tmp.write_text(json.dumps(self.state))
            tmp.replace(STATE_PATH)
        except Exception:
            logger.exception("bot: could not save state")

    def _log(self, kind: str, symbol: str, message: str, **extra: Any) -> None:
        self.state["decisions"].append({
            "time": datetime.now(timezone.utc).isoformat(),
            "kind": kind, "symbol": symbol, "message": message, **extra,
        })

    # ── gate: simulation must validate the config ────────────────────

    @staticmethod
    def find_validating_run(preset: str, timeframe: str) -> Optional[Dict[str, Any]]:
        from ..backtest import store
        for run in store.list_runs():
            if (run["status"] == "completed" and run["preset"] == preset
                    and run["timeframe"] == timeframe and run["aggregate"]):
                agg = run["aggregate"]
                if agg["profit_factor"] >= 1.0 and agg["avg_return_pct"] > 0:
                    return run
        return None

    # ── lifecycle ────────────────────────────────────────────────────

    async def start(self, config: Dict[str, Any], force: bool = False) -> Dict[str, Any]:
        if self.state["status"] == "running":
            raise ValueError("bot already running — stop it first")

        cfg = {**DEFAULT_CONFIG, **config}
        # resolve preset params so the bot trades exactly what the sim validated
        from ..backtest.store import PRESETS
        preset_params = next((p["params"] for p in PRESETS if p["id"] == cfg["preset"]), {})
        cfg["params"] = {**preset_params, **(cfg.get("params") or {})}
        validating = self.find_validating_run(cfg["preset"], cfg["timeframe"])
        if validating is None and not force:
            raise ValueError(
                f"no completed simulation validates preset '{cfg['preset']}' on "
                f"{cfg['timeframe']} (need profit factor >= 1.0 and positive avg return). "
                "Run a simulation first, or start with force=true."
            )

        fresh_start = not self.state.get("positions") and not self.state.get("closed_trades")
        self.state["config"] = cfg
        self.state["validated_by"] = validating["id"] if validating else None
        self.state["status"] = "running"
        self.state["started_at"] = datetime.now(timezone.utc).isoformat()
        self.state["last_error"] = None
        if fresh_start:
            self.state["cash"] = float(cfg["initial_capital"])
            self.state["equity_history"] = []
        self._log("lifecycle", "*", f"bot started ({'sim-validated: ' + validating['id'] if validating else 'FORCED without validation'})")
        self._save()
        self._ensure_task()
        return self.snapshot()

    async def stop(self) -> Dict[str, Any]:
        self.state["status"] = "stopped"
        self._log("lifecycle", "*", "bot stopped")
        self._save()
        if self._task:
            self._task.cancel()
            self._task = None
        return self.snapshot()

    def resume_if_running(self) -> None:
        """Called at API startup — restart the loop if state says running."""
        if self.state["status"] == "running":
            self._log("lifecycle", "*", "bot loop resumed after API restart")
            self._ensure_task()

    def _ensure_task(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run_loop(), name="trading-bot")

    # ── main loop ────────────────────────────────────────────────────

    async def _run_loop(self) -> None:
        logger.info("bot loop started")
        try:
            while self.state["status"] == "running":
                try:
                    await self._cycle()
                    self.state["last_error"] = None
                except Exception as e:
                    logger.exception("bot cycle failed")
                    self.state["last_error"] = str(e)
                    self._log("error", "*", f"cycle error: {e}")
                self.state["last_cycle_at"] = datetime.now(timezone.utc).isoformat()
                self._save()
                await asyncio.sleep(60)
        except asyncio.CancelledError:
            pass
        logger.info("bot loop exited")

    async def _cycle(self) -> None:
        from ..backtest.data import get_bars
        from ..backtest.signals import DEFAULT_PARAMS, compute_signal_frame, signal_reasons

        cfg = self.state["config"]
        tf = cfg["timeframe"]
        p = {**DEFAULT_PARAMS, **cfg.get("params", {})}
        lookback = _LOOKBACK_DAYS.get(tf, 120)
        now = datetime.now(timezone.utc)

        last_closes: Dict[str, float] = {}

        for i, symbol in enumerate(cfg["symbols"]):
            if i:
                await asyncio.sleep(2)  # stagger fetches — avoid yfinance burst limits
            # blocking yfinance call → thread
            try:
                df = await asyncio.to_thread(
                    get_bars, symbol, tf, now - timedelta(days=lookback), None, True
                )
            except Exception as e:
                self._log("data", symbol, f"bar fetch failed: {e}")
                continue
            if len(df) < 60:
                continue

            # drop the (possibly) still-forming last bar: act on closed bars only
            bar_minutes = _TF_MINUTES.get(tf, 60)
            if (now - df.index[-1]).total_seconds() < bar_minutes * 60:
                df = df.iloc[:-1]
            if len(df) < 60:
                continue

            frame = compute_signal_frame(df, p)
            try:
                from ..backtest.regime import apply_regime_gates
                gated = await asyncio.to_thread(apply_regime_gates, frame, symbol, p)
                if "regime_ok" in gated.columns and bool(frame["enter_long"].iloc[-1]) \
                        and not bool(gated["regime_ok"].iloc[-1]):
                    self._log("blocked", symbol,
                              "entry signal BLOCKED by regime gate (VIX/sector)")
                frame = gated
            except Exception as e:
                self._log("regime", symbol, f"regime gates unavailable ({e}) — proceeding")
            row = frame.iloc[-1]
            ts = int(df.index[-1].value // 1_000_000_000)
            close = float(row["close"])
            last_closes[symbol] = close

            if self.state["last_bar_ts"].get(symbol) == ts:
                continue  # already acted on this bar
            self.state["last_bar_ts"][symbol] = ts

            pos = self.state["positions"].get(symbol)
            if pos:
                self._manage_position(symbol, pos, row, close, p)
            elif bool(row.get("enter_long")) and len(self.state["positions"]) < int(cfg["max_positions"]):
                await self._try_enter(symbol, row, close, p, signal_reasons)

        # mark-to-market equity
        equity = self.state["cash"]
        for sym, pos in self.state["positions"].items():
            px = last_closes.get(sym, pos["last_price"])
            pos["last_price"] = px
            equity += pos["qty"] * px
        self.state["equity_history"].append(
            {"time": int(now.timestamp()), "value": round(equity, 2)})

    # ── position management ──────────────────────────────────────────

    def _fill_price(self, close: float, side: str) -> float:
        slip = float(self.state["config"].get("slippage_bps", 5)) / 10_000
        return close * (1 + slip) if side == "buy" else close * (1 - slip)

    def _manage_position(self, symbol: str, pos: Dict[str, Any], row: Any, close: float,
                         p: Dict[str, Any]) -> None:
        high = float(row["high"])
        low = float(row["low"])
        trail_mult = float(p.get("trail_atr_mult", 0.0))
        atr_now = float(row.get("atr") or 0)
        r_dist = float(pos.get("r_dist") or (pos["entry_price"] - pos["stop"]) or 0)

        # scale-out: bank half at partial_tp_r x R, rest rides with stop >= entry
        partial_r = float(p.get("partial_tp_r", 0.0))
        if partial_r > 0 and r_dist > 0 and not pos.get("scaled") and pos["qty"] >= 2:
            ptp = pos["entry_price"] + partial_r * r_dist
            if high >= ptp:
                half = pos["qty"] // 2
                proceeds = half * ptp
                pnl = proceeds - half * pos["entry_price"]
                self.state["cash"] += proceeds
                pos["qty"] -= half
                pos["scaled"] = True
                pos["stop"] = max(pos["stop"], pos["entry_price"])
                self.state["closed_trades"].append({
                    "symbol": symbol,
                    "entry_time": pos["entry_time"],
                    "exit_time": datetime.now(timezone.utc).isoformat(),
                    "entry_price": pos["entry_price"], "exit_price": round(ptp, 4),
                    "qty": half, "pnl": round(pnl, 2),
                    "pnl_pct": round(pnl / (half * pos["entry_price"]) * 100, 3),
                    "reason": "partial target", "entry_score": pos.get("entry_score"),
                    "news_bias": pos.get("news_bias"),
                })
                self._log("exit", symbol,
                          f"scaled out {half} @ {ptp:.2f} (partial target) pnl {pnl:+.2f}, "
                          f"stop -> breakeven", pnl=round(pnl, 2))

        if trail_mult > 0 and atr_now > 0:
            new_stop = round(close - trail_mult * atr_now, 4)
            if new_stop > pos["stop"]:
                pos["stop"] = new_stop
        # breakeven ratchet: once +breakeven_r x R, the stop never sits below entry
        be_r = float(p.get("breakeven_r", 0.0))
        if be_r > 0 and r_dist > 0 and high >= pos["entry_price"] + be_r * r_dist:
            pos["stop"] = max(pos["stop"], pos["entry_price"])
        exit_reason = None
        exit_px = None

        if low <= pos["stop"]:
            exit_reason, exit_px = "stop hit", pos["stop"]
        elif trail_mult <= 0 and high >= pos["target"]:
            exit_reason, exit_px = "target hit", pos["target"]
        elif bool(p.get("signal_exit", True)) and bool(row.get("exit_long")):
            exit_reason, exit_px = "structure/score flip", self._fill_price(close, "sell")

        if exit_reason is None:
            return

        proceeds = pos["qty"] * exit_px
        pnl = proceeds - pos["qty"] * pos["entry_price"]
        self.state["cash"] += proceeds
        trade = {
            "symbol": symbol,
            "entry_time": pos["entry_time"], "exit_time": datetime.now(timezone.utc).isoformat(),
            "entry_price": pos["entry_price"], "exit_price": round(exit_px, 4),
            "qty": pos["qty"], "pnl": round(pnl, 2),
            "pnl_pct": round(pnl / (pos["qty"] * pos["entry_price"]) * 100, 3),
            "reason": exit_reason, "entry_score": pos.get("entry_score"),
            "news_bias": pos.get("news_bias"),
        }
        self.state["closed_trades"].append(trade)
        del self.state["positions"][symbol]
        self._log("exit", symbol,
                  f"closed {pos['qty']} @ {exit_px:.2f} ({exit_reason}) pnl {pnl:+.2f}",
                  pnl=round(pnl, 2))

    async def _try_enter(self, symbol: str, row: Any, close: float, p: Dict, signal_reasons) -> None:
        import pandas as pd

        cfg = self.state["config"]
        score = int(row.get("long_score", 0))
        reasons = signal_reasons(pd.Series(row.to_dict()), "long")

        # AI news gate
        news_bias: Optional[float] = None
        news_verdict = "skipped"
        size_mult = 1.0
        if cfg.get("news_gate", True):
            try:
                from ..routers.news_analyst import news_read
                read = await news_read(symbol)
                news_bias = read.bias_score
                news_verdict = read.verdict
                if news_bias <= float(cfg["news_block_below"]):
                    self._log("blocked", symbol,
                              f"entry signal (score {score}) BLOCKED by news analyst: "
                              f"{news_verdict} bias {news_bias:+.2f} — {read.summary[:140]}",
                              score=score, news_bias=news_bias)
                    return
                if news_bias >= float(cfg["news_size_boost_above"]):
                    size_mult = 1.25
            except Exception as e:
                # news unavailable → trade the technicals, but say so
                self._log("news", symbol, f"news gate unavailable ({e}) — proceeding on technicals")

        atr = float(row.get("atr") or 0)
        if atr <= 0 or np.isnan(atr):
            return
        gross = sum(
            pos["qty"] * pos["last_price"] for pos in self.state["positions"].values())
        equity = self.state["cash"] + gross
        stop_dist = float(p["atr_stop_mult"]) * atr
        risk_dollars = equity * float(p["risk_pct"]) * size_mult
        # drawdown throttle: trade smaller while under the high-water mark
        dd_at = float(p.get("dd_throttle_at", 0.0))
        if dd_at > 0:
            peak = max((e["value"] for e in self.state["equity_history"]), default=equity)
            peak = max(peak, equity)
            if 1.0 - equity / peak > dd_at:
                risk_dollars *= float(p.get("dd_throttle_mult", 0.5))
        fill = self._fill_price(close, "buy")
        # exposure cap: total gross (this position included) bounded by
        # max_position_pct × equity; >1 = margin, cash may go negative (loan)
        headroom = equity * float(p["max_position_pct"]) - gross
        qty = int(min(risk_dollars / stop_dist, max(0.0, headroom) / fill))
        if qty < 1:
            return

        cost = qty * fill
        self.state["cash"] -= cost
        self.state["positions"][symbol] = {
            "qty": qty, "entry_price": round(fill, 4),
            "entry_time": datetime.now(timezone.utc).isoformat(),
            "stop": round(fill - stop_dist, 4),
            "target": round(fill + stop_dist * float(p["rr_target"]), 4),
            "r_dist": round(stop_dist, 4), "scaled": False,
            "last_price": close,
            "entry_score": score, "entry_reasons": reasons,
            "news_bias": news_bias, "news_verdict": news_verdict,
        }
        self._log("entry", symbol,
                  f"LONG {qty} @ {fill:.2f} (score {score}: {'+'.join(reasons)}; "
                  f"news {news_verdict}{f' {news_bias:+.2f}' if news_bias is not None else ''}; "
                  f"stop {fill - stop_dist:.2f}, target {fill + stop_dist * float(p['rr_target']):.2f})",
                  score=score, news_bias=news_bias, qty=qty)

    # ── reporting ────────────────────────────────────────────────────

    def snapshot(self) -> Dict[str, Any]:
        closed = self.state["closed_trades"]
        wins = [t for t in closed if t["pnl"] > 0]
        equity = self.state["cash"] + sum(
            p["qty"] * p["last_price"] for p in self.state["positions"].values())
        initial = float(self.state["config"]["initial_capital"])
        return {
            "status": self.state["status"],
            "config": self.state["config"],
            "validated_by": self.state["validated_by"],
            "started_at": self.state["started_at"],
            "last_cycle_at": self.state["last_cycle_at"],
            "last_error": self.state["last_error"],
            "cash": round(self.state["cash"], 2),
            "equity": round(equity, 2),
            "total_return_pct": round((equity - initial) / initial * 100, 3) if initial else 0.0,
            "positions": self.state["positions"],
            "open_count": len(self.state["positions"]),
            "closed_trades": closed[-100:],
            "trade_count": len(closed),
            "win_rate": round(len(wins) / len(closed) * 100, 1) if closed else 0.0,
            "decisions": self.state["decisions"][-100:],
            "equity_history": self.state["equity_history"][-1500:],
        }

    def reset_paper(self) -> Dict[str, Any]:
        if self.state["status"] == "running":
            raise ValueError("stop the bot before resetting")
        cfg = self.state["config"]
        self.state.update({
            "cash": float(cfg["initial_capital"]),
            "positions": {}, "closed_trades": [], "decisions": [],
            "equity_history": [], "last_bar_ts": {}, "validated_by": None,
            "started_at": None, "last_error": None,
        })
        self._log("lifecycle", "*", "paper account reset")
        self._save()
        return self.snapshot()


bot_engine = BotEngine()
