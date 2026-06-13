"""Scheduled auto-analysis of open option positions.

Runs the multi-agent AI pipeline (news + underlying + option + decay +
synthesis) on every open option position and stores the verdict to
``ai_runs``. Wired into the scheduler (daily, after the close) so the
Insights timeline fills itself over time — letting the user watch how the
agents' read on a held position drifts day to day, without manually
clicking through the analyzer.

Token-aware: skips contracts already analysed today (unless forced) and
runs positions sequentially so a fleet of holdings can't burst the free
OpenRouter tier.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from ..nautilus import ib_options
from . import db

logger = logging.getLogger(__name__)

# Pause between positions so we don't hammer the free model tier.
_INTER_POSITION_DELAY_S = 3.0


def _g(d: Optional[Dict[str, Any]], key: str, default: Any = None) -> Any:
    return d.get(key, default) if isinstance(d, dict) else default


def _build_request(analysis: Dict[str, Any]):
    """Map an ``/analyze`` result dict onto an AgentRunRequest, mirroring the
    dashboard's ``buildRequestBody``. Returns None if the analysis is too
    thin to be worth a run."""
    from ..routers.ai_agents import AgentRunRequest  # lazy: avoid import cycle

    und = analysis.get("underlying") or {}
    opt = analysis.get("option") or {}
    greeks = analysis.get("greeks") or {}
    prob = analysis.get("probability") or {}
    sigma = analysis.get("sigma_ranges") or {}
    liq = analysis.get("liquidity") or {}
    vol = analysis.get("vol_context") or {}
    advice = analysis.get("advice") or {}
    fe = analysis.get("forecast_ensemble") or {}
    ens = (fe.get("ensemble") or {}) if isinstance(fe, dict) else {}
    ens5 = (ens.get("horizons") or {}).get("5") or {}
    cal = ens.get("calibration") or {}
    si = analysis.get("signal_inputs") or {}
    chart_tf = (si.get("chart_tf") or {}) if isinstance(si, dict) else {}

    spot = analysis.get("spot")
    if spot is None:
        return None

    chart_bars = (analysis.get("chart") or {}).get("bars") or []
    recent_bars = [
        {"t": b.get("time"), "o": b.get("open"), "h": b.get("high"),
         "l": b.get("low"), "c": b.get("close"), "v": b.get("volume")}
        for b in chart_bars[-25:]
    ]

    is_long = bool(analysis.get("is_long"))
    right = analysis.get("right")
    side = f"{'long' if is_long else 'short'}_{'call' if right == 'C' else 'put'}"

    return AgentRunRequest(
        symbol=analysis["symbol"],
        strike=float(analysis["strike"]),
        expiry=analysis["expiry"],
        right=right,
        quantity=int(analysis.get("quantity") or 1),
        is_long=is_long,
        dte=int(analysis.get("dte") or 0),
        side=side,
        spot=float(spot),
        breakeven=float(analysis.get("breakeven") or spot),
        distance_pct=float(analysis.get("distance_pct") or 0.0),
        entry_price=float(_g(opt, "entry_price") or _g(opt, "mid") or 0.0),
        mid=_g(opt, "mid"), bid=_g(opt, "bid"), ask=_g(opt, "ask"), last=_g(opt, "last"),
        iv=float(_g(opt, "iv") or 0.0),
        delta=_g(greeks, "delta"), gamma=_g(greeks, "gamma"),
        theta=_g(greeks, "theta"), vega=_g(greeks, "vega"),
        rsi=_g(und, "rsi"), macd_hist=_g(und, "macd_hist"),
        trend_score=_g(und, "trend_score"),
        ema9=_g(und, "ema9"), ema21=_g(und, "ema21"),
        ema50=_g(und, "ema50"), ema200=_g(und, "ema200"),
        chart_tf=_g(chart_tf, "timeframe"),
        chart_tf_rsi=_g(chart_tf, "rsi"),
        chart_tf_macd_hist=_g(chart_tf, "macd_hist"),
        chart_tf_macd_hist_prev=_g(chart_tf, "macd_hist_prev"),
        chart_tf_smi=_g(chart_tf, "smi"),
        chart_tf_smi_signal=_g(chart_tf, "smi_signal"),
        chart_tf_vwap=_g(chart_tf, "vwap"),
        rv30=_g(vol, "realized_vol_30d"), rv90=_g(vol, "realized_vol_90d"),
        iv_to_rv_ratio=_g(vol, "iv_to_rv_ratio"),
        spread=_g(liq, "spread"), spread_pct=_g(liq, "spread_pct"),
        liquidity_grade=_g(liq, "grade"), volume=_g(liq, "volume"),
        open_interest=_g(liq, "open_interest"),
        pop=_g(prob, "pop"), prob_itm=_g(prob, "prob_itm"),
        expected_move_pct=_g(sigma, "expected_move_pct"),
        expected_move_abs=_g(sigma, "expected_move_abs"),
        sigma1_low=_g(sigma, "sigma1_low"), sigma1_high=_g(sigma, "sigma1_high"),
        sigma2_low=_g(sigma, "sigma2_low"), sigma2_high=_g(sigma, "sigma2_high"),
        forecast_5d_return_pct=_g(ens5, "expected_return_pct"),
        forecast_5d_band_pct=_g(ens5, "band_pct"),
        forecast_agreement=_g(fe.get("agreement") if isinstance(fe, dict) else None, "5"),
        forecast_members=fe.get("members") if isinstance(fe, dict) else None,
        forecast_calibration_coverage=_g(cal.get("coverage_observed_per_h") if isinstance(cal, dict) else None, "5"),
        forecast_calibration_samples=_g(cal, "samples"),
        forecast_horizons_other=ens.get("horizons") if isinstance(ens, dict) else None,
        multi_tf=analysis.get("multi_tf"),
        recommended_chart_tf=analysis.get("recommended_chart_tf"),
        recent_bars=recent_bars,
        decay_profile=analysis.get("decay_profile"),
        max_profit=analysis.get("max_profit"), max_loss=analysis.get("max_loss"),
        advice_label=_g(advice, "label"), advice_score=_g(advice, "score"),
        advice_notes=_g(advice, "notes", []) or [],
        narrative=analysis.get("narrative"),
    )


async def _already_analysed_today(symbol: str, strike: float, expiry: str, right: str) -> bool:
    pool = db.pool()
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT 1 FROM ai_runs
                WHERE symbol = $1 AND strike = $2 AND expiry = $3 AND right_ = $4
                  AND ran_at::date = NOW()::date
                LIMIT 1
                """,
                symbol.upper(), strike, expiry, right.upper(),
            )
            return row is not None
    except Exception as e:  # noqa: BLE001
        logger.warning("dedupe check failed: %s", e)
        return False


async def analyze_open_positions(force: bool = False) -> Dict[str, Any]:
    """Run the agent pipeline on every open option position. ``force``
    re-runs even contracts already analysed today. Returns a summary."""
    from ..routers.ai_agents import run_and_store  # lazy: avoid import cycle
    from ..routers.option_analyzer import analyze_option  # lazy

    positions = await ib_options.get_positions()
    options = [
        p for p in positions
        if p.get("is_option") and p.get("strike") and p.get("expiry") and p.get("right")
    ]
    summary: Dict[str, Any] = {
        "open_options": len(options),
        "analysed": 0,
        "skipped": 0,
        "failed": 0,
        "runs": [],
    }
    if not options:
        return summary

    for i, p in enumerate(options):
        symbol = str(p["symbol"]).upper()
        strike = float(p["strike"])
        expiry = str(p["expiry"])
        right = str(p["right"]).upper()
        qty = int(p.get("quantity") or 0)
        label = f"{symbol} {strike:g}{right} ×{qty}"
        try:
            if not force and await _already_analysed_today(symbol, strike, expiry, right):
                summary["skipped"] += 1
                continue
            analysis = await analyze_option(
                symbol=symbol, strike=strike, expiry=expiry, right=right,
                quantity=qty or (1 if right else 1), entry_price=None, timeframe="1d",
            )
            if not isinstance(analysis, dict):
                summary["failed"] += 1
                continue
            req = _build_request(analysis)
            if req is None:
                summary["failed"] += 1
                continue
            run_id = await run_and_store(req)
            summary["analysed"] += 1
            summary["runs"].append({"contract": label, "run_id": run_id})
            logger.info("position analysis: stored run %s for %s", run_id, label)
        except Exception as e:  # noqa: BLE001
            summary["failed"] += 1
            logger.warning("position analysis failed for %s: %s", label, e)
        # Throttle between positions (skip the wait after the last one).
        if i < len(options) - 1:
            await asyncio.sleep(_INTER_POSITION_DELAY_S)

    logger.info(
        "position analysis complete: %d analysed, %d skipped, %d failed (of %d open)",
        summary["analysed"], summary["skipped"], summary["failed"], summary["open_options"],
    )
    return summary
