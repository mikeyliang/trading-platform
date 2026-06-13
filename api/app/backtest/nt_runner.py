"""
Real NautilusTrader backtest: BacktestEngine + ConfluenceStrategy.

Flow: yfinance bars -> signal frame (signals.py, causal) -> NT Bar stream ->
strategy trades them with bracket orders (ATR stop / R-multiple target) ->
positions report + per-bar equity curve -> BacktestResult + chart payload.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from nautilus_trader.backtest.engine import BacktestEngine, BacktestEngineConfig
from nautilus_trader.config import LoggingConfig, StrategyConfig
from nautilus_trader.model.currencies import USD
from nautilus_trader.model.data import Bar, BarType
from nautilus_trader.model.enums import AccountType, OmsType, OrderSide, TimeInForce
from nautilus_trader.model.identifiers import InstrumentId, Symbol, TraderId, Venue
from nautilus_trader.model.instruments import Equity
from nautilus_trader.model.objects import Money, Price, Quantity
from nautilus_trader.trading.strategy import Strategy

from .data import get_bars
from .regime import apply_regime_gates
from .signals import DEFAULT_PARAMS, compute_signal_frame, signal_reasons

logger = logging.getLogger(__name__)

VENUE = Venue("SIM")

_TF_TO_NT = {
    "1m": "1-MINUTE", "5m": "5-MINUTE", "15m": "15-MINUTE", "30m": "30-MINUTE",
    "1h": "1-HOUR", "4h": "4-HOUR", "1d": "1-DAY",
}
# bars per trading year, for Sharpe annualization (yf RTH bar counts)
_BARS_PER_YEAR = {
    "1m": 98_280, "5m": 19_656, "15m": 6_552, "30m": 3_276,
    "1h": 1_764, "4h": 504, "1d": 252,
}


def _make_instrument(symbol: str) -> Equity:
    iid = InstrumentId(Symbol(symbol), VENUE)
    return Equity(
        instrument_id=iid,
        raw_symbol=Symbol(symbol),
        currency=USD,
        price_precision=2,
        price_increment=Price.from_str("0.01"),
        lot_size=Quantity.from_int(1),
        ts_event=0,
        ts_init=0,
    )


def _df_to_bars(df: pd.DataFrame, bar_type: BarType) -> List[Bar]:
    bars = []
    for ts, row in df.iterrows():
        ns = int(ts.value)
        bars.append(Bar(
            bar_type=bar_type,
            open=Price(round(float(row["open"]), 2), 2),
            high=Price(round(float(max(row["high"], row["open"], row["close"])), 2), 2),
            low=Price(round(float(min(row["low"], row["open"], row["close"])), 2), 2),
            close=Price(round(float(row["close"]), 2), 2),
            volume=Quantity(max(float(row["volume"]), 0.0), 0),
            ts_event=ns,
            ts_init=ns,
        ))
    return bars


class ConfluenceConfig(StrategyConfig, frozen=True):
    instrument_id: str
    bar_type: str
    risk_pct: float = 0.01
    max_position_pct: float = 0.95
    atr_stop_mult: float = 2.0
    rr_target: float = 2.0
    allow_short: bool = False
    trail_atr_mult: float = 0.0   # > 0: chandelier trailing stop, no fixed TP
    signal_exit: bool = True      # exit on structure/score flip
    breakeven_r: float = 0.0      # > 0: stop ratchets to entry after +R move
    partial_tp_r: float = 0.0     # > 0: scale half out at this R multiple
    dd_throttle_at: float = 0.0   # > 0: account DD level that throttles risk
    dd_throttle_mult: float = 0.5  # risk multiplier while throttled


class ConfluenceStrategy(Strategy):
    """Trades the precomputed confluence signal frame.

    The frame is injected post-construction (`set_signal_frame`) — it is
    strictly causal, so reading row i inside on_bar(bar_i) is lookahead-free.
    """

    def __init__(self, config: ConfluenceConfig):
        super().__init__(config)
        self._signals: Dict[int, dict] = {}
        self.equity_curve: List[Dict[str, float]] = []
        self.signal_markers: List[Dict[str, Any]] = []
        self._instrument = None
        self._stop_px: Optional[float] = None
        self._target_px: Optional[float] = None
        self._peak_eq: float = 0.0           # high-water mark for DD throttle
        self._entry_stop_dist: Optional[float] = None  # R unit of open trade

    def set_signal_frame(self, frame: pd.DataFrame) -> None:
        cols = [c for c in frame.columns if c not in ("open", "high", "low", "volume")]
        for ts, row in frame[cols].iterrows():
            self._signals[int(ts.value)] = row.to_dict()

    def on_start(self) -> None:
        iid = InstrumentId.from_str(self.config.instrument_id)
        self._instrument = self.cache.instrument(iid)
        self.subscribe_bars(BarType.from_str(self.config.bar_type))

    def _equity(self, close: float) -> float:
        account = self.portfolio.account(VENUE)
        bal = account.balance_total(USD).as_double()
        pos_val = 0.0
        is_cash = bool(getattr(account, "is_cash_account", True))
        for pos in self.cache.positions_open(instrument_id=self._instrument.id):
            sq = float(pos.signed_qty)
            if is_cash:
                # purchase debited the balance — add back market value
                pos_val += sq * close
            else:
                # margin: balance holds cash + realized; add unrealized only
                pos_val += sq * (close - float(pos.avg_px_open))
        return bal + pos_val

    def on_bar(self, bar: Bar) -> None:
        sig = self._signals.get(bar.ts_event)
        if sig is None:
            return
        close = float(bar.close)
        equity = self._equity(close)
        self._peak_eq = max(self._peak_eq, equity)
        self.equity_curve.append({"time": bar.ts_event // 1_000_000_000, "value": round(equity, 2)})

        open_positions = self.cache.positions_open(instrument_id=self._instrument.id)
        in_pos = len(open_positions) > 0

        if in_pos:
            pos = open_positions[0]
            is_long = pos.side.name == "LONG"
            atr_now = sig.get("atr") or 0.0
            # stop management: chandelier trail and/or breakeven ratchet
            trail_on = self.config.trail_atr_mult > 0 and atr_now > 0 and not np.isnan(atr_now)
            be_floor = None
            if self.config.breakeven_r > 0 and self._entry_stop_dist:
                entry_px = float(pos.avg_px_open)
                trig = self.config.breakeven_r * self._entry_stop_dist
                if (is_long and close >= entry_px + trig) or (not is_long and close <= entry_px - trig):
                    be_floor = entry_px
            if trail_on or be_floor is not None:
                trail_dist = self.config.trail_atr_mult * atr_now
                for order in self.cache.orders_open(instrument_id=self._instrument.id):
                    if order.order_type.name != "STOP_MARKET":
                        continue
                    cur = float(order.trigger_price)
                    new = cur
                    if trail_on:
                        t = close - trail_dist if is_long else close + trail_dist
                        new = max(new, t) if is_long else min(new, t)
                    if be_floor is not None:
                        new = max(new, be_floor) if is_long else min(new, be_floor)
                    if (is_long and new > cur) or (not is_long and new < cur):
                        try:
                            self.modify_order(order, trigger_price=Price(round(new, 2), 2))
                        except Exception:  # order may be filling this bar
                            pass
            # signal-based exit (bracket child orders handle stop/target)
            flip = sig["exit_long"] if is_long else sig["exit_short"]
            if self.config.signal_exit and flip:
                self.close_position(pos)
                self.cancel_all_orders(self._instrument.id)
                self.signal_markers.append({
                    "time": bar.ts_event // 1_000_000_000,
                    "type": "exit", "side": "long" if is_long else "short",
                    "price": close, "reason": "structure/score flip",
                })
            return

        atr = sig.get("atr") or 0.0
        if atr <= 0 or np.isnan(atr):
            return

        side = None
        if sig.get("enter_long"):
            side = OrderSide.BUY
        elif self.config.allow_short and sig.get("enter_short"):
            side = OrderSide.SELL
        if side is None:
            return

        stop_dist = self.config.atr_stop_mult * atr
        risk_dollars = equity * self.config.risk_pct
        # drawdown throttle: trade smaller while the account is under water
        if self.config.dd_throttle_at > 0 and self._peak_eq > 0:
            dd = 1.0 - equity / self._peak_eq
            if dd > self.config.dd_throttle_at:
                risk_dollars *= self.config.dd_throttle_mult
        qty = int(min(risk_dollars / stop_dist, equity * self.config.max_position_pct / close))
        if qty < 1:
            return

        # trailing mode: park the TP far away — the ratcheting SL is the exit
        rr = 1000.0 if self.config.trail_atr_mult > 0 else self.config.rr_target
        if side == OrderSide.BUY:
            sl = close - stop_dist
            tp = close + stop_dist * rr
        else:
            sl = close + stop_dist
            tp = max(close - stop_dist * rr, 0.02)
        if sl <= 0 or tp <= 0:
            return

        def bracket(q: int, tp_px: float) -> None:
            self.submit_order_list(self.order_factory.bracket(
                instrument_id=self._instrument.id,
                order_side=side,
                quantity=Quantity.from_int(q),
                sl_trigger_price=Price(round(sl, 2), 2),
                tp_price=Price(round(tp_px, 2), 2),
                time_in_force=TimeInForce.GTC,
            ))

        self._entry_stop_dist = stop_dist
        if self.config.partial_tp_r > 0 and qty >= 2:
            # scale-out: half banks at partial_tp_r x R, half rides the trail/TP
            half = qty // 2
            ptp = (close + stop_dist * self.config.partial_tp_r if side == OrderSide.BUY
                   else max(close - stop_dist * self.config.partial_tp_r, 0.02))
            bracket(half, ptp)
            bracket(qty - half, tp)
        else:
            bracket(qty, tp)
        comp = "long" if side == OrderSide.BUY else "short"
        self.signal_markers.append({
            "time": bar.ts_event // 1_000_000_000,
            "type": "entry", "side": comp, "price": close,
            "score": int(sig.get(f"{comp}_score", 0)),
            "reasons": signal_reasons(pd.Series(sig), comp),
            "stop": round(sl, 2), "target": round(tp, 2),
        })

    def on_stop(self) -> None:
        for pos in self.cache.positions_open(instrument_id=self._instrument.id):
            self.close_position(pos)
        self.cancel_all_orders(self._instrument.id)


def run_nt_backtest(
    symbol: str,
    timeframe: str,
    start: datetime,
    end: datetime,
    initial_capital: float,
    params: Optional[dict] = None,
) -> Dict[str, Any]:
    """Run one symbol/timeframe through NautilusTrader. Returns dict with
    `stats`, `trades`, `equity_curve`, and `chart` (candles + indicators +
    markers + volume profile) ready for API/UI serialization."""
    p = {**DEFAULT_PARAMS, **(params or {})}
    df = get_bars(symbol, timeframe, start, end)
    frame = compute_signal_frame(df, p)
    frame = apply_regime_gates(frame, symbol, p)

    instrument = _make_instrument(symbol)
    bar_type = BarType.from_str(f"{instrument.id}-{_TF_TO_NT[timeframe]}-LAST-EXTERNAL")

    engine = BacktestEngine(BacktestEngineConfig(
        trader_id=TraderId("BACKTEST-001"),
        logging=LoggingConfig(log_level="ERROR", bypass_logging=True),
    ))
    # CASH accounts reject short sells and any order beyond available cash —
    # use MARGIN (with matching leverage) when shorts are on or sizing may
    # exceed 1x equity (max_position_pct > 1 = intraday margin).
    use_margin = p["allow_short"] or float(p["max_position_pct"]) > 1.0
    engine.add_venue(
        venue=VENUE,
        oms_type=OmsType.NETTING,
        account_type=AccountType.MARGIN if use_margin else AccountType.CASH,
        base_currency=USD,
        starting_balances=[Money(initial_capital, USD)],
        default_leverage=Decimal(str(max(1.0, float(p["max_position_pct"])))),
    )
    engine.add_instrument(instrument)
    engine.add_data(_df_to_bars(df, bar_type))

    strat = ConfluenceStrategy(ConfluenceConfig(
        instrument_id=str(instrument.id),
        bar_type=str(bar_type),
        risk_pct=float(p["risk_pct"]),
        max_position_pct=float(p["max_position_pct"]),
        atr_stop_mult=float(p["atr_stop_mult"]),
        rr_target=float(p["rr_target"]),
        allow_short=bool(p["allow_short"]),
        trail_atr_mult=float(p.get("trail_atr_mult", 0.0)),
        signal_exit=bool(p.get("signal_exit", True)),
        breakeven_r=float(p.get("breakeven_r", 0.0)),
        partial_tp_r=float(p.get("partial_tp_r", 0.0)),
        dd_throttle_at=float(p.get("dd_throttle_at", 0.0)),
        dd_throttle_mult=float(p.get("dd_throttle_mult", 0.5)),
    ))
    strat.set_signal_frame(frame)
    engine.add_strategy(strat)
    engine.run()

    trades = _extract_trades(engine)
    equity_curve = strat.equity_curve or [
        {"time": int(df.index[0].value // 1e9), "value": initial_capital}]
    stats = _compute_stats(trades, equity_curve, initial_capital, timeframe)
    # honesty benchmark: what doing nothing would have returned
    stats["buy_hold_return_pct"] = round(
        (float(df["close"].iloc[-1]) / float(df["close"].iloc[0]) - 1) * 100, 2)
    chart = _build_chart_payload(df, frame, strat.signal_markers, p)

    engine.reset()
    engine.dispose()

    return {
        "stats": stats,
        "trades": trades,
        "equity_curve": equity_curve,
        "markers": strat.signal_markers,
        "chart": chart,
    }


def _extract_trades(engine: BacktestEngine) -> List[Dict[str, Any]]:
    rep = engine.trader.generate_positions_report()
    if rep is None or len(rep) == 0:
        return []
    trades = []
    for _, r in rep.iterrows():
        try:
            entry_ts = pd.Timestamp(r["ts_opened"])
            exit_ts = pd.Timestamp(r["ts_closed"]) if pd.notna(r.get("ts_closed")) else None
            qty = float(r.get("peak_qty", 0) or 0)
            avg_open = float(r["avg_px_open"])
            avg_close = float(r["avg_px_close"]) if pd.notna(r.get("avg_px_close")) else None
            pnl_raw = r.get("realized_pnl")
            pnl = float(str(pnl_raw).split(" ")[0].replace(",", "")) if pnl_raw is not None else None
            side = "BUY" if str(r.get("entry", "BUY")).upper() in ("BUY", "LONG") else "SELL"
            denom = avg_open * qty
            trades.append({
                "entry_time": entry_ts.isoformat(),
                "exit_time": exit_ts.isoformat() if exit_ts is not None else None,
                "side": side,
                "entry_price": round(avg_open, 4),
                "exit_price": round(avg_close, 4) if avg_close is not None else None,
                "quantity": qty,
                "pnl": round(pnl, 2) if pnl is not None else None,
                "pnl_pct": round(pnl / denom * 100, 3) if (pnl is not None and denom) else None,
            })
        except Exception as e:  # report row shape drift — skip rather than fail the run
            logger.warning("skipping malformed position row: %s", e)
    trades.sort(key=lambda t: t["entry_time"])
    return trades


def _compute_stats(trades: List[Dict], equity_curve: List[Dict],
                   initial_capital: float, timeframe: str) -> Dict[str, Any]:
    closed = [t for t in trades if t["pnl"] is not None]
    wins = [t for t in closed if t["pnl"] > 0]
    losses = [t for t in closed if t["pnl"] <= 0]
    gross_win = sum(t["pnl"] for t in wins)
    gross_loss = sum(t["pnl"] for t in losses)

    vals = [e["value"] for e in equity_curve]
    final = vals[-1] if vals else initial_capital
    peak = -np.inf
    max_dd = 0.0
    for v in vals:
        peak = max(peak, v)
        if peak > 0:
            max_dd = max(max_dd, (peak - v) / peak)

    rets = np.diff(vals) / np.array(vals[:-1]) if len(vals) > 2 else np.array([])
    ann = _BARS_PER_YEAR.get(timeframe, 252)
    sharpe = float(rets.mean() / rets.std() * np.sqrt(ann)) if len(rets) > 2 and rets.std() > 0 else 0.0
    downside = rets[rets < 0]
    sortino = float(rets.mean() / downside.std() * np.sqrt(ann)) if len(downside) > 2 and downside.std() > 0 else 0.0

    durations = []
    for t in closed:
        if t["exit_time"]:
            durations.append((pd.Timestamp(t["exit_time"]) - pd.Timestamp(t["entry_time"])).total_seconds() / 3600)

    return {
        "initial_capital": initial_capital,
        "final_capital": round(final, 2),
        "total_return": round(final - initial_capital, 2),
        "total_return_pct": round((final - initial_capital) / initial_capital * 100, 2),
        "max_drawdown": round(max_dd * initial_capital, 2),
        "max_drawdown_pct": round(max_dd * 100, 2),
        "sharpe_ratio": round(sharpe, 2),
        "sortino_ratio": round(sortino, 2),
        "win_rate": round(len(wins) / len(closed) * 100, 1) if closed else 0.0,
        "total_trades": len(closed),
        "winning_trades": len(wins),
        "losing_trades": len(losses),
        "avg_win": round(gross_win / len(wins), 2) if wins else 0.0,
        "avg_loss": round(gross_loss / len(losses), 2) if losses else 0.0,
        "profit_factor": round(abs(gross_win / gross_loss), 2) if gross_loss != 0 else (99.0 if gross_win > 0 else 0.0),
        "expectancy": round((gross_win + gross_loss) / len(closed), 2) if closed else 0.0,
        "avg_trade_hours": round(float(np.mean(durations)), 1) if durations else None,
    }


def _build_chart_payload(df: pd.DataFrame, frame: pd.DataFrame,
                         markers: List[Dict], p: dict) -> Dict[str, Any]:
    from .indicators import volume_profile

    t = (df.index.asi8 // 1_000_000_000).tolist()

    def series(col, nd=4):
        return [None if (v is None or (isinstance(v, float) and np.isnan(v))) else round(float(v), nd)
                for v in frame[col].tolist()]

    vp = volume_profile(df)
    choch_events = []
    for i, v in enumerate(frame["choch"].tolist()):
        if v != 0:
            choch_events.append({"time": t[i], "dir": int(v), "price": float(frame["close"].iloc[i])})
    bos_events = []
    for i, v in enumerate(frame["bos"].tolist()):
        if v != 0:
            bos_events.append({"time": t[i], "dir": int(v), "price": float(frame["close"].iloc[i])})

    return {
        "candles": [
            {"time": t[i], "open": round(float(df["open"].iloc[i]), 4),
             "high": round(float(df["high"].iloc[i]), 4),
             "low": round(float(df["low"].iloc[i]), 4),
             "close": round(float(df["close"].iloc[i]), 4),
             "volume": float(df["volume"].iloc[i])}
            for i in range(len(df))
        ],
        "overlays": {
            "vwap": series("vwap"), "ema_fast": series("ema_fast"),
            "ema_slow": series("ema_slow"), "ema_trend": series("ema_trend"),
        },
        "panes": {
            "rsi": series("rsi", 2),
            "macd": series("macd", 4), "macd_signal": series("macd_signal", 4),
            "macd_hist": series("macd_hist", 4),
            "stoch_k": series("stoch_k", 2), "stoch_d": series("stoch_d", 2),
            "smi": series("smi", 2), "smi_signal": series("smi_signal", 2),
            "long_score": series("long_score", 0), "short_score": series("short_score", 0),
        },
        "structure": {"choch": choch_events, "bos": bos_events},
        "volume_profile": {"bins": vp.bins, "volumes": vp.volumes,
                           "poc": vp.poc, "vah": vp.vah, "val": vp.val},
        "markers": markers,
        "params": {k: v for k, v in p.items() if not isinstance(v, (list, dict))},
    }
