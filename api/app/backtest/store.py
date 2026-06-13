"""
Simulation run registry: background multi-symbol NautilusTrader runs with
progress tracking, persisted to disk so results survive API restarts.

Layout: /app/data/backtests/{run_id}.json   (full run: stats+trades+charts)
        in-memory _runs dict mirrors summaries for fast listing.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

RUNS_DIR = Path(os.environ.get("BACKTESTS_DIR", "/app/data/backtests"))

_runs: Dict[str, Dict[str, Any]] = {}   # run_id -> full run doc (charts included)
_lock = threading.Lock()
_loaded = False

# Strategy presets surfaced in the UI. Params overlay signals.DEFAULT_PARAMS.
# Pruned 2026-06 to the four sweep survivors — one per role (baseline /
# daily scalp / swing / position). Retired: confluence-strict (PF 0.81),
# confluence-ls (shorts always lost), confluence-fast + trend-rider +
# trend-rider-tight (superseded by scalp-daily / trend-max).
PRESETS = [
    {
        "id": "confluence-core",
        "name": "Confluence Core",
        "description": "Baseline reference: structure-gated confluence (CHoCH/BOS trend + EMA, MACD, SMI, RSI, stoch, VWAP scoring), 2x ATR stop, 2R target, 1% risk.",
        "params": {},
    },
    {
        "id": "scalp-daily",
        "name": "Scalp Daily",
        "description": "Daily cadence (bot default), tuned for 3x ETFs on 15m bars: 4-of-7 score, 1.5x ATR stop, 3x ATR trail, scale half out at +1.5R (rest rides, stop >= entry), EMA 5/20/100 filter, 2% risk throttled to half while account DD > 12%, 2x Reg-T margin, regime-gated (VIX<=24, sector RS rising) — ~2-3 trades/day. 59d ETF sample: +50.0%, PF 3.3, Sharpe 6.7, 6.3% DD, 56% WR; 2y 1h proxy: DD 16.3%, WR 41%. Run on 15m.",
        "params": {"min_score": 4, "atr_stop_mult": 1.5, "trail_atr_mult": 3.0, "risk_pct": 0.02,
                   "max_position_pct": 2.0, "ema_fast": 5, "ema_slow": 20, "ema_trend": 100,
                   "vix_gate_max": 24.0, "sector_gate": True,
                   "partial_tp_r": 1.5, "dd_throttle_at": 0.12},
    },
    {
        "id": "trend-max",
        "name": "Trend Max",
        "description": "Swing, 1h bars: 6-of-7 entries, structure-flip exit OFF — pure 4x ATR chandelier trail — 2% risk. Stocks 1y: +34%, PF 2.4, 14% DD; ETF universe 2y: +93%, PF 1.6, 21% DD; out-of-universe PF 1.2.",
        "params": {"min_score": 6, "atr_stop_mult": 2.5, "trail_atr_mult": 4.0, "signal_exit": False, "risk_pct": 0.02},
    },
    {
        "id": "rider-15m",
        "name": "Rider 15m",
        "description": "Intraday trend rider, highest WR config: rider engine (2.5x ATR stop -> 8x ATR trail, no signal exit, 15% risk) on 15m bars with 4h EMA 20/100 trend gate + VIX<=24 + sector RS, half banked at +1.5R. 59d ETF sample: +38.5%, PF 5.1, Sharpe 5.6, 8.5% DD, 61% WR, ~0.7 trades/day. Drop partial_tp_r for max return: +69.6%, PF 6.5, 12.2% DD. 15m data caps at ~59d — no long-window validation possible; the 1h rider proxy FAILED (DD 48%), treat as bull-regime config. Run on 15m.",
        "params": {"min_score": 4, "atr_stop_mult": 2.5, "trail_atr_mult": 8.0, "signal_exit": False,
                   "risk_pct": 0.15, "ema_fast": 5, "ema_slow": 20, "ema_trend": 100,
                   "htf_fast": 20, "htf_slow": 100, "htf_tf": "4h",
                   "vix_gate_max": 24.0, "sector_gate": True, "partial_tp_r": 1.5},
    },
    {
        "id": "etf-rider",
        "name": "ETF Rider",
        "description": "Position flagship for 3x ETFs on 1d bars — 5-of-7 entries gated on EMA 20/100 trend + VIX<=24 + sector RS, 2.5x ATR stop widening to an 8x ATR trail, half banked at +1.5R, no signal exit, 15% risk sizing. 2.5y: +132%, PF 13.7, 29% DD, 78% WR; 5y: +266%, PF 16.0, 31% DD, 79% WR — consistent across windows. (min_score 4 + partial 2.0 = old v2: +132%/65% WR; drop partial for max return: ms5 only = +298%/5y, 76% WR.) Run on 1d.",
        "params": {"min_score": 5, "atr_stop_mult": 2.5, "trail_atr_mult": 8.0, "signal_exit": False,
                   "risk_pct": 0.15, "ema_fast": 5, "ema_slow": 20, "ema_trend": 100,
                   "htf_fast": 20, "htf_slow": 100, "vix_gate_max": 24.0, "sector_gate": True,
                   "partial_tp_r": 1.5},
    },
]


def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        for f in sorted(RUNS_DIR.glob("*.json")):
            try:
                doc = json.loads(f.read_text())
                _runs[doc["id"]] = doc
            except Exception as e:
                logger.warning("skipping unreadable run file %s: %s", f.name, e)
        _loaded = True


def _persist(doc: Dict[str, Any]) -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RUNS_DIR / f".{doc['id']}.tmp"
    tmp.write_text(json.dumps(doc))
    tmp.replace(RUNS_DIR / f"{doc['id']}.json")


def _summary(doc: Dict[str, Any]) -> Dict[str, Any]:
    return {k: doc.get(k) for k in (
        "id", "label", "preset", "symbols", "timeframe", "start_date", "end_date",
        "initial_capital", "params", "status", "progress", "error", "created_at",
        "finished_at", "aggregate",
    )}


def start_run(
    symbols: List[str],
    timeframe: str,
    start_date: str,
    end_date: str,
    initial_capital: float,
    params: Optional[dict] = None,
    preset: str = "confluence-core",
    label: str = "",
) -> Dict[str, Any]:
    """Kick off a background run over all symbols; returns the summary doc."""
    _ensure_loaded()
    preset_params = next((p["params"] for p in PRESETS if p["id"] == preset), {})
    merged = {**preset_params, **(params or {})}
    run_id = uuid.uuid4().hex[:10]
    doc: Dict[str, Any] = {
        "id": run_id,
        "label": label or f"{preset} {','.join(symbols)} {timeframe}",
        "preset": preset,
        "symbols": [s.upper() for s in symbols],
        "timeframe": timeframe,
        "start_date": start_date,
        "end_date": end_date,
        "initial_capital": initial_capital,
        "params": merged,
        "status": "running",
        "progress": {"done": 0, "total": len(symbols), "current": symbols[0] if symbols else None},
        "error": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "results": {},      # symbol -> {stats, trades, equity_curve, markers, chart}
        "aggregate": None,
    }
    with _lock:
        _runs[run_id] = doc

    t = threading.Thread(target=_execute, args=(run_id,), daemon=True, name=f"sim-{run_id}")
    t.start()
    return _summary(doc)


def _execute(run_id: str) -> None:
    from .nt_runner import run_nt_backtest  # late import: heavy

    doc = _runs[run_id]
    start = datetime.strptime(doc["start_date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end = datetime.strptime(doc["end_date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    errors: List[str] = []

    for i, sym in enumerate(doc["symbols"]):
        doc["progress"] = {"done": i, "total": len(doc["symbols"]), "current": sym}
        try:
            res = run_nt_backtest(
                symbol=sym,
                timeframe=doc["timeframe"],
                start=start,
                end=end,
                initial_capital=doc["initial_capital"],
                params=doc["params"],
            )
            doc["results"][sym] = res
        except Exception as e:
            logger.exception("sim %s: %s failed", run_id, sym)
            errors.append(f"{sym}: {e}")
            doc["results"][sym] = {"error": str(e)}

    ok = {s: r for s, r in doc["results"].items() if "stats" in r}
    doc["aggregate"] = _aggregate(ok, doc["initial_capital"]) if ok else None
    doc["progress"] = {"done": len(doc["symbols"]), "total": len(doc["symbols"]), "current": None}
    doc["status"] = "completed" if ok else "error"
    doc["error"] = "; ".join(errors) if errors else None
    doc["finished_at"] = datetime.now(timezone.utc).isoformat()
    try:
        _persist(doc)
    except Exception:
        logger.exception("sim %s: persist failed", run_id)


def _aggregate(ok: Dict[str, dict], initial_capital: float) -> Dict[str, Any]:
    """Portfolio-level view: equal-weight average of per-symbol stats plus
    combined trade tallies. (Each symbol ran with its own full capital, so
    return percentages average rather than sum.)"""
    stats = [r["stats"] for r in ok.values()]
    n = len(stats)
    total_trades = sum(s["total_trades"] for s in stats)
    wins = sum(s["winning_trades"] for s in stats)
    gross_win = sum(s["avg_win"] * s["winning_trades"] for s in stats)
    gross_loss = sum(s["avg_loss"] * s["losing_trades"] for s in stats)
    best = max(ok, key=lambda s: ok[s]["stats"]["total_return_pct"])
    worst = min(ok, key=lambda s: ok[s]["stats"]["total_return_pct"])
    return {
        "symbols_ok": n,
        "avg_return_pct": round(sum(s["total_return_pct"] for s in stats) / n, 2),
        "avg_sharpe": round(sum(s["sharpe_ratio"] for s in stats) / n, 2),
        "avg_max_drawdown_pct": round(sum(s["max_drawdown_pct"] for s in stats) / n, 2),
        "total_trades": total_trades,
        "win_rate": round(wins / total_trades * 100, 1) if total_trades else 0.0,
        "profit_factor": round(abs(gross_win / gross_loss), 2) if gross_loss else (99.0 if gross_win > 0 else 0.0),
        "best_symbol": {"symbol": best, "return_pct": ok[best]["stats"]["total_return_pct"]},
        "worst_symbol": {"symbol": worst, "return_pct": ok[worst]["stats"]["total_return_pct"]},
    }


def list_runs() -> List[Dict[str, Any]]:
    _ensure_loaded()
    with _lock:
        docs = sorted(_runs.values(), key=lambda d: d["created_at"], reverse=True)
        return [_summary(d) for d in docs]


def get_run(run_id: str, include_charts: bool = False) -> Optional[Dict[str, Any]]:
    _ensure_loaded()
    doc = _runs.get(run_id)
    if doc is None:
        return None
    out = _summary(doc)
    out["results"] = {
        sym: (r if include_charts else {k: v for k, v in r.items() if k != "chart"})
        for sym, r in doc.get("results", {}).items()
    }
    return out


def get_chart(run_id: str, symbol: str) -> Optional[Dict[str, Any]]:
    _ensure_loaded()
    doc = _runs.get(run_id)
    if doc is None:
        return None
    res = doc.get("results", {}).get(symbol.upper())
    if not res or "chart" not in res:
        return None
    return {
        "chart": res["chart"],
        "trades": res.get("trades", []),
        "equity_curve": res.get("equity_curve", []),
        "stats": res.get("stats", {}),
    }


def delete_run(run_id: str) -> bool:
    _ensure_loaded()
    with _lock:
        doc = _runs.pop(run_id, None)
    if doc is None:
        return False
    try:
        (RUNS_DIR / f"{run_id}.json").unlink(missing_ok=True)
    except Exception:
        logger.warning("could not remove run file for %s", run_id)
    return True
