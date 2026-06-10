"""
NautilusTrader engine wrapper.
handles both backtest (via BacktestEngine) and live modes.
falls back gracefully when NT or IB is unavailable.
"""
import dataclasses
import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any

from ..models.schemas import (
    BacktestRequest, BacktestResult, BacktestTrade,
    OrderSide, StrategyInfo, StrategyStatus,
)
from ..strategies.bull_put_spread import BullPutSpreadConfig, BullPutSpreadStrategy
from .strategies.smi import generate_signals
from .mock.data import generate_historical_bars

logger = logging.getLogger(__name__)

try:

    NAUTILUS_AVAILABLE = True
    logger.info("NautilusTrader loaded successfully")
except Exception as e:
    NAUTILUS_AVAILABLE = False
    logger.warning(f"NautilusTrader not available, using built-in engine: {e}")


class StrategyState:
    def __init__(self, strategy_id: str, name: str, description: str, symbols: List[str], timeframe: str, params: Dict):
        self.id = strategy_id
        self.name = name
        self.description = description
        self.symbols = symbols
        self.timeframe = timeframe
        self.params = params
        self.status = StrategyStatus.STOPPED
        self.pnl = 0.0
        self.trades = 0
        self.winning_trades = 0

    @property
    def win_rate(self) -> float:
        return (self.winning_trades / self.trades * 100) if self.trades > 0 else 0.0

    def to_schema(self) -> StrategyInfo:
        return StrategyInfo(
            id=self.id,
            name=self.name,
            description=self.description,
            status=self.status,
            symbols=self.symbols,
            timeframe=self.timeframe,
            pnl=self.pnl,
            trades=self.trades,
            win_rate=self.win_rate,
            params=self.params,
        )


class TradingEngine:
    def __init__(self):
        self._strategies: Dict[str, StrategyState] = {}
        self._runners: Dict[str, Any] = {}  # strategy_id -> live runner instance
        self._backtest_results: Dict[str, BacktestResult] = {}
        self._initialize_default_strategies()

    def _initialize_default_strategies(self):
        strategies = [
            StrategyState(
                strategy_id="bull-put-spy",
                name="SPY Bull Put Spread",
                description="Sells 25-delta SPY put credit spreads at 30-45 DTE, $5 wide. Closes at 50% profit, 2x stop, or 21 DTE.",
                symbols=["SPY"],
                timeframe="daily-scan",
                params={"target_dte_min": 30, "target_dte_max": 45, "short_delta": 0.25,
                        "wing_width": 5, "quantity": 1, "max_concurrent": 3,
                        "profit_target_pct": 0.50, "stop_loss_mult": 2.0, "time_stop_dte": 21},
            ),
            StrategyState(
                strategy_id="bull-put-rut",
                name="RUT Bull Put Spread",
                description="Sells 25-delta RUT (cash-settled index) put credit spreads at 30-45 DTE, 20 wide. Section 1256 tax treatment.",
                symbols=["RUT"],
                timeframe="daily-scan",
                params={"target_dte_min": 30, "target_dte_max": 45, "short_delta": 0.25,
                        "wing_width": 20, "quantity": 1, "max_concurrent": 2,
                        "profit_target_pct": 0.50, "stop_loss_mult": 2.0, "time_stop_dte": 21},
            ),
            StrategyState(
                strategy_id="bull-put-iwm",
                name="IWM Bull Put Spread",
                description="Sells 25-delta IWM (Russell 2000 ETF) put credit spreads at 30-45 DTE, $2 wide. Easier sizing than RUT.",
                symbols=["IWM"],
                timeframe="daily-scan",
                params={"target_dte_min": 30, "target_dte_max": 45, "short_delta": 0.25,
                        "wing_width": 2, "quantity": 1, "max_concurrent": 3,
                        "profit_target_pct": 0.50, "stop_loss_mult": 2.0, "time_stop_dte": 21},
            ),
            StrategyState(
                strategy_id="smi-short",
                name="SMI Momentum (Short-term)",
                description="SMI crossover with EMA trend filter on 15m bars. Backtest-only for now.",
                symbols=["AAPL", "NVDA", "AMD", "TSLA"],
                timeframe="15m",
                params={"smi_period": 13, "smooth1": 25, "smooth2": 2, "signal": 9, "ema_fast": 9, "ema_slow": 21},
            ),
        ]
        for s in strategies:
            self._strategies[s.id] = s

    # --- strategies ---

    def list_strategies(self) -> List[StrategyInfo]:
        return [s.to_schema() for s in self._strategies.values()]

    def get_strategy(self, strategy_id: str) -> Optional[StrategyInfo]:
        s = self._strategies.get(strategy_id)
        return s.to_schema() if s else None

    async def start_strategy(self, strategy_id: str, symbols: List[str], timeframe: str, params: Dict) -> Optional[StrategyInfo]:
        s = self._strategies.get(strategy_id)
        if not s:
            return None
        s.symbols = symbols or s.symbols
        s.timeframe = timeframe or s.timeframe
        s.params.update(params)

        # Spawn the actual runner for live strategies. SMI is backtest-only for now.
        if strategy_id.startswith("bull-put-"):
            if strategy_id in self._runners:
                await self._runners[strategy_id].stop()
            valid_fields = {f.name for f in dataclasses.fields(BullPutSpreadConfig)}
            cfg_kwargs = {k: v for k, v in s.params.items() if k in valid_fields}
            cfg = BullPutSpreadConfig(symbol=s.symbols[0], **cfg_kwargs)
            runner = BullPutSpreadStrategy(strategy_id, cfg)
            await runner.start()
            self._runners[strategy_id] = runner

        s.status = StrategyStatus.RUNNING
        logger.info(f"strategy {strategy_id} started on {s.symbols}")
        return s.to_schema()

    async def stop_strategy(self, strategy_id: str) -> Optional[StrategyInfo]:
        s = self._strategies.get(strategy_id)
        if not s:
            return None
        runner = self._runners.pop(strategy_id, None)
        if runner:
            await runner.stop()
            s.pnl = round(runner.stats.get("realized_pnl", 0.0), 2)
            s.trades = (runner.stats.get("entries", 0))
        s.status = StrategyStatus.STOPPED
        return s.to_schema()

    def get_runner(self, strategy_id: str):
        return self._runners.get(strategy_id)

    def runner_snapshot(self, strategy_id: str) -> Optional[Dict[str, Any]]:
        runner = self._runners.get(strategy_id)
        return runner.snapshot() if runner else None

    # --- backtest ---

    def run_backtest(self, request: BacktestRequest) -> BacktestResult:
        if NAUTILUS_AVAILABLE:
            try:
                return self._run_nautilus_backtest(request)
            except Exception as e:
                logger.warning(f"NautilusTrader backtest failed, using fallback: {e}")

        return self._run_builtin_backtest(request)

    def _run_builtin_backtest(self, request: BacktestRequest) -> BacktestResult:
        """custom backtest using SMI signals on synthetic or fetched data"""

        result_id = str(uuid.uuid4())[:8]
        bars = self._fetch_bars_for_backtest(request)

        p = request.params
        signals = generate_signals(
            bars,
            smi_period=p.get("smi_period", 13),
            smi_smooth1=p.get("smooth1", 25),
            smi_smooth2=p.get("smooth2", 2),
            smi_signal=p.get("signal", 9),
            ema_fast=p.get("ema_fast", 9),
            ema_slow=p.get("ema_slow", 21),
            smi_overbought=p.get("smi_overbought", 40.0),
            smi_oversold=p.get("smi_oversold", -40.0),
        )

        # simulate trades
        capital = request.initial_capital
        position: Optional[Dict] = None
        trades: List[BacktestTrade] = []
        equity_curve = [{"time": bars[0]["time"] if bars else 0, "value": capital}]

        for sig in signals:
            if sig["signal"] == "BUY" and position is None:
                shares = (capital * 0.95) / sig["price"]
                position = {
                    "entry_time": datetime.fromtimestamp(sig["time"], tz=timezone.utc),
                    "entry_price": sig["price"],
                    "quantity": shares,
                    "side": OrderSide.BUY,
                }

            elif sig["signal"] == "SELL" and position is not None:
                # `or {}` keeps pylint's flow analysis happy — it can't narrow
                # Optional[Dict] through the compound elif guard above.
                pos: Dict[str, Any] = position or {}
                exit_price = sig["price"]
                pnl = (exit_price - pos["entry_price"]) * pos["quantity"]
                pnl_pct = (exit_price - pos["entry_price"]) / pos["entry_price"] * 100
                capital += pnl

                trades.append(BacktestTrade(
                    entry_time=pos["entry_time"],
                    exit_time=datetime.fromtimestamp(sig["time"], tz=timezone.utc),
                    side=OrderSide.BUY,
                    entry_price=round(pos["entry_price"], 2),
                    exit_price=round(exit_price, 2),
                    quantity=round(pos["quantity"], 2),
                    pnl=round(pnl, 2),
                    pnl_pct=round(pnl_pct, 2),
                ))
                equity_curve.append({"time": sig["time"], "value": round(capital, 2)})
                position = None

        # close open position at last bar
        if position and bars:
            last = bars[-1]
            exit_price = last["close"]
            pnl = (exit_price - position["entry_price"]) * position["quantity"]
            capital += pnl
            trades.append(BacktestTrade(
                entry_time=position["entry_time"],
                exit_time=datetime.fromtimestamp(last["time"], tz=timezone.utc),
                side=OrderSide.BUY,
                entry_price=round(position["entry_price"], 2),
                exit_price=round(exit_price, 2),
                quantity=round(position["quantity"], 2),
                pnl=round(pnl, 2),
                pnl_pct=round(pnl / (position["entry_price"] * position["quantity"]) * 100, 2),
            ))
            equity_curve.append({"time": last["time"], "value": round(capital, 2)})

        winning = [t for t in trades if t.pnl and t.pnl > 0]
        losing = [t for t in trades if t.pnl and t.pnl <= 0]
        avg_win = sum(t.pnl for t in winning) / len(winning) if winning else 0
        avg_loss = sum(t.pnl for t in losing) / len(losing) if losing else 0
        profit_factor = abs(sum(t.pnl for t in winning) / sum(t.pnl for t in losing)) if losing and sum(t.pnl for t in losing) != 0 else 0

        # max drawdown
        peak = request.initial_capital
        max_dd = 0.0
        running_cap = request.initial_capital
        for t in trades:
            running_cap += t.pnl or 0
            peak = max(peak, running_cap)
            dd = (peak - running_cap) / peak
            max_dd = max(max_dd, dd)

        total_return = capital - request.initial_capital
        total_return_pct = total_return / request.initial_capital * 100

        # sharpe approximation
        if len(equity_curve) > 2:
            vals = [e["value"] for e in equity_curve]
            returns = [(vals[i] - vals[i - 1]) / vals[i - 1] for i in range(1, len(vals))]
            import statistics
            mean_r = statistics.mean(returns) if returns else 0
            std_r = statistics.stdev(returns) if len(returns) > 1 else 1
            sharpe = (mean_r / std_r) * (252 ** 0.5) if std_r > 0 else 0
        else:
            sharpe = 0.0

        # attach SMI data for chart overlay
        if bars and signals:
            smi_chart = [{"time": s["time"], "smi": s["smi"], "signal": s["smi_signal"]} for s in signals]
        else:
            smi_chart = []

        result = BacktestResult(
            id=result_id,
            strategy=request.strategy,
            symbol=request.symbol,
            timeframe=request.timeframe,
            start_date=request.start_date,
            end_date=request.end_date,
            initial_capital=request.initial_capital,
            final_capital=round(capital, 2),
            total_return=round(total_return, 2),
            total_return_pct=round(total_return_pct, 2),
            max_drawdown=round(max_dd * request.initial_capital, 2),
            max_drawdown_pct=round(max_dd * 100, 2),
            sharpe_ratio=round(sharpe, 2),
            win_rate=round(len(winning) / len(trades) * 100, 1) if trades else 0.0,
            total_trades=len(trades),
            winning_trades=len(winning),
            losing_trades=len(losing),
            avg_win=round(avg_win, 2),
            avg_loss=round(avg_loss, 2),
            profit_factor=round(profit_factor, 2),
            trades=trades,
            equity_curve=equity_curve,
            smi_data=smi_chart,
        )
        self._backtest_results[result_id] = result
        return result

    def _run_nautilus_backtest(self, request: BacktestRequest) -> BacktestResult:
        """run using NautilusTrader BacktestEngine"""

        # for now, delegate to built-in until full NT strategy is wired
        return self._run_builtin_backtest(request)

    def _fetch_bars_for_backtest(self, request: BacktestRequest) -> List[Dict]:
        """Use synthetic data — the backtest engine isn't wired to IBKR
        historical-data requests yet (would need a sync wrapper around the
        async ib_node API). Good enough for the in-app simulator; real
        backtests should run outside this process against actual data files."""
        start = datetime.strptime(request.start_date, "%Y-%m-%d")
        end = datetime.strptime(request.end_date, "%Y-%m-%d")
        days = (end - start).days
        return generate_historical_bars(request.symbol, request.timeframe, days=max(days, 30))

    def get_backtest_result(self, result_id: str) -> Optional[BacktestResult]:
        return self._backtest_results.get(result_id)

    def list_backtest_results(self) -> List[BacktestResult]:
        return list(self._backtest_results.values())


engine = TradingEngine()
