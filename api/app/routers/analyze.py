"""
Position / symbol analyzer.

Bundles price snapshot + technicals (SMI, RSI, MACD, EMA trend) + any open
spread Greeks/distance into a single payload, plus a deterministic algorithmic
verdict (-100..+100 sell/hold score). The frontend renders this; the AI
co-pilot can also be invoked for narrative.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, Query

from ..forecast import chronos
from ..nautilus.ib_node import ib_node
from ..nautilus.ib_orders import orders_client
from ..nautilus.strategies.smi import (
    compute_ema_series,
    compute_macd_series,
    compute_rsi_series,
    compute_smi_series,
    compute_vwap_series,
)
from ..util.cache import TTLCache
from .market import get_bars

# 60s cache — analyze re-runs Chronos every call (slow ~200ms) plus indicators.
# Frontend auto-refreshes positions every ~30s, so 60s keeps the bar low.
_analyze_cache = TTLCache(ttl_seconds=60)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/analyze", tags=["analyze"])


@router.get("/{symbol}")
async def analyze_symbol(
    symbol: str,
    timeframe: str = Query("1d"),
    days: int = Query(60, ge=10, le=365),
):
    symbol = symbol.upper()
    cache_key = (symbol, timeframe, days)
    cached = _analyze_cache.get(cache_key)
    if cached is not None:
        return cached

    # 1. bars + indicators
    bars_resp = await get_bars(symbol, timeframe, days)
    bars = bars_resp.get("bars", [])
    if len(bars) < 30:
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "source": bars_resp.get("source"),
            "error": "not_enough_data",
            "signals": [],
            "verdict": {"score": 0, "label": "insufficient_data", "reasons": []},
        }

    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    closes = [b["close"] for b in bars]
    volumes = [b.get("volume", 0) for b in bars]
    times = [b["time"] for b in bars]
    last = bars[-1]
    prev = bars[-2] if len(bars) >= 2 else last

    smi_data = compute_smi_series(highs, lows, closes)
    rsi = compute_rsi_series(closes, 14)
    macd = compute_macd_series(closes)
    ema_f = compute_ema_series(closes, 9)
    ema_s = compute_ema_series(closes, 21)
    ema_200 = compute_ema_series(closes, 200) if len(closes) >= 200 else None
    vwap_daily_reset = timeframe not in ("1d", "1w", "1mo")
    vwap = compute_vwap_series(highs, lows, closes, volumes, times, daily_reset=vwap_daily_reset)

    smi_now = smi_data["smi"][-1]
    smi_prev = smi_data["smi"][-2] if len(smi_data["smi"]) >= 2 else smi_now
    smi_sig_now = smi_data["signal"][-1]
    rsi_now = rsi[-1]
    macd_now = macd["macd"][-1]
    macd_sig_now = macd["signal"][-1]
    macd_hist_now = macd["hist"][-1]
    macd_hist_prev = macd["hist"][-2] if len(macd["hist"]) >= 2 else macd_hist_now
    ef = ema_f[-1]
    es = ema_s[-1]
    e200 = ema_200[-1] if ema_200 else None
    price = float(last["close"])
    change_pct = ((price - float(prev["close"])) / float(prev["close"]) * 100) if prev["close"] else 0.0

    # 2. signal list — each is a -2..+2 bullish-for-the-underlying score with a reason
    signals: List[Dict[str, Any]] = []

    # SMI zone
    if smi_now > 40:
        signals.append({"name": "SMI overbought", "score": -2, "detail": f"SMI {smi_now:.1f} > 40 — pullback risk"})
    elif smi_now < -40:
        signals.append({"name": "SMI oversold", "score": +2, "detail": f"SMI {smi_now:.1f} < -40 — bounce setup"})
    elif smi_now > smi_sig_now and smi_prev <= smi_data["signal"][-2]:
        signals.append({"name": "SMI bullish cross", "score": +1, "detail": "SMI crossed above signal line"})
    elif smi_now < smi_sig_now and smi_prev >= smi_data["signal"][-2]:
        signals.append({"name": "SMI bearish cross", "score": -1, "detail": "SMI crossed below signal line"})
    else:
        signals.append({"name": "SMI neutral", "score": 0, "detail": f"SMI {smi_now:.1f}"})

    # RSI
    if rsi_now >= 70:
        signals.append({"name": "RSI overbought", "score": -2, "detail": f"RSI {rsi_now:.1f} ≥ 70 — momentum stretched"})
    elif rsi_now <= 30:
        signals.append({"name": "RSI oversold", "score": +2, "detail": f"RSI {rsi_now:.1f} ≤ 30 — momentum exhausted"})
    elif rsi_now >= 60:
        signals.append({"name": "RSI strong", "score": +1, "detail": f"RSI {rsi_now:.1f} — momentum bullish"})
    elif rsi_now <= 40:
        signals.append({"name": "RSI weak", "score": -1, "detail": f"RSI {rsi_now:.1f} — momentum bearish"})
    else:
        signals.append({"name": "RSI neutral", "score": 0, "detail": f"RSI {rsi_now:.1f}"})

    # MACD
    if macd_hist_now > 0 and macd_hist_prev <= 0:
        signals.append({"name": "MACD bullish cross", "score": +2, "detail": "histogram flipped positive"})
    elif macd_hist_now < 0 and macd_hist_prev >= 0:
        signals.append({"name": "MACD bearish cross", "score": -2, "detail": "histogram flipped negative"})
    elif macd_hist_now > 0:
        signals.append({"name": "MACD positive", "score": +1, "detail": f"hist {macd_hist_now:+.3f}"})
    elif macd_hist_now < 0:
        signals.append({"name": "MACD negative", "score": -1, "detail": f"hist {macd_hist_now:+.3f}"})

    # Trend filter
    if ef > es:
        signals.append({"name": "EMA9 > EMA21", "score": +1, "detail": "short-term uptrend"})
    else:
        signals.append({"name": "EMA9 < EMA21", "score": -1, "detail": "short-term downtrend"})

    # VWAP — only meaningful on intraday timeframes
    if vwap_daily_reset and vwap and vwap[-1] > 0:
        vwap_now = vwap[-1]
        diff_pct = (price - vwap_now) / vwap_now * 100
        if diff_pct >= 1.0:
            signals.append({"name": "Above VWAP", "score": +1, "detail": f"price {diff_pct:+.2f}% over VWAP {vwap_now:.2f}"})
        elif diff_pct <= -1.0:
            signals.append({"name": "Below VWAP", "score": -1, "detail": f"price {diff_pct:.2f}% under VWAP {vwap_now:.2f}"})
        else:
            signals.append({"name": "At VWAP", "score": 0, "detail": f"price {diff_pct:+.2f}% from VWAP {vwap_now:.2f}"})
    if e200 is not None:
        if price > e200:
            signals.append({"name": "Above 200 EMA", "score": +1, "detail": f"price {price:.2f} > 200EMA {e200:.2f}"})
        else:
            signals.append({"name": "Below 200 EMA", "score": -1, "detail": f"price {price:.2f} < 200EMA {e200:.2f}"})

    # 3. open spread context (bull put spreads tracked by orders_client)
    spread_info = None
    try:
        for s in orders_client.list_open():
            if s.symbol == symbol:
                expiry_date = _parse_yyyymmdd(s.expiry)
                dte = (expiry_date - datetime.now(timezone.utc).date()).days if expiry_date else None
                # distance from short strike (% OTM for a bull put: spot above short)
                short_strike = float(s.short_strike)
                spot_to_short_pct = ((price - short_strike) / short_strike * 100) if short_strike else None
                # spread-level signals
                if spot_to_short_pct is not None:
                    if spot_to_short_pct < 1.0:
                        signals.append({"name": "Short strike threatened", "score": -3, "detail": f"spot only {spot_to_short_pct:.1f}% above {short_strike}"})
                    elif spot_to_short_pct < 3.0:
                        signals.append({"name": "Short strike near", "score": -1, "detail": f"spot {spot_to_short_pct:.1f}% above {short_strike}"})
                    else:
                        signals.append({"name": "Short strike safe", "score": +1, "detail": f"spot {spot_to_short_pct:.1f}% above {short_strike}"})
                if dte is not None:
                    if dte <= 7:
                        signals.append({"name": "DTE critical", "score": -2, "detail": f"{dte}d to expiry — assignment risk"})
                    elif dte <= 21:
                        signals.append({"name": "DTE in mgmt zone", "score": +1, "detail": f"{dte}d — typical 50% profit window"})
                spread_info = {
                    "id": s.id,
                    "spread_type": s.spread_type,
                    "expiry": s.expiry,
                    "dte": dte,
                    "short_strike": short_strike,
                    "long_strike": float(s.long_strike),
                    "credit_received": float(s.credit_received),
                    "quantity": int(s.quantity),
                    "max_profit": float(s.max_profit),
                    "max_loss": float(s.max_loss),
                    "spot_to_short_pct": round(spot_to_short_pct, 2) if spot_to_short_pct is not None else None,
                }
                break
    except Exception as e:  # noqa: BLE001
        logger.debug("spread context fetch failed: %s", e)

    # 4. stock position context (qty + unrealized PnL)
    position_info = None
    try:
        for p in ib_node.latest_positions():
            if p.get("symbol") == symbol:
                position_info = {
                    "quantity": p.get("quantity"),
                    "avg_price": p.get("avg_price"),
                    "current_price": p.get("current_price"),
                    "unrealized_pnl": p.get("unrealized_pnl"),
                    "unrealized_pnl_pct": p.get("unrealized_pnl_pct"),
                    "side": p.get("side"),
                }
                # signal: large unrealized loss is a hold-or-fold signal
                upct = p.get("unrealized_pnl_pct") or 0
                if upct > 25:
                    signals.append({"name": "Up >25%", "score": -1, "detail": "consider taking profits"})
                elif upct < -15:
                    signals.append({"name": "Down >15%", "score": -1, "detail": "stop-loss territory"})
                break
    except Exception as e:  # noqa: BLE001
        logger.debug("position context fetch failed: %s", e)

    # 4b. probabilistic forecast (Chronos)
    fc = chronos.forecast(closes, horizon=5)
    if fc:
        expected = fc["expected_return_pct"]
        band = fc["band_pct"]
        if expected > 3.0:
            signals.append({"name": "Forecast bullish", "score": +2, "detail": f"5d model median +{expected:.1f}% (±{band:.1f}%)"})
        elif expected > 0.5:
            signals.append({"name": "Forecast mild bull", "score": +1, "detail": f"5d model median +{expected:.1f}% (±{band:.1f}%)"})
        elif expected < -3.0:
            signals.append({"name": "Forecast bearish", "score": -2, "detail": f"5d model median {expected:.1f}% (±{band:.1f}%)"})
        elif expected < -0.5:
            signals.append({"name": "Forecast mild bear", "score": -1, "detail": f"5d model median {expected:.1f}% (±{band:.1f}%)"})
        else:
            signals.append({"name": "Forecast flat", "score": 0, "detail": f"5d model median {expected:+.1f}% (±{band:.1f}%)"})

    # 5. roll up into a verdict
    total = sum(s["score"] for s in signals)
    max_possible = sum(abs(s["score"]) for s in signals) or 1
    # normalize to -100..+100; positive = bullish-for-holding (don't sell), negative = sell-friendly
    score = round(total / max_possible * 100)
    label = _verdict_label(score, spread=bool(spread_info), position=bool(position_info))

    resp = {
        "symbol": symbol,
        "timeframe": timeframe,
        "source": bars_resp.get("source"),
        "as_of": last["time"],
        "price": price,
        "change_pct": round(change_pct, 2),
        "technicals": {
            "smi": smi_now, "smi_signal": smi_sig_now,
            "rsi": rsi_now,
            "macd": macd_now, "macd_signal": macd_sig_now, "macd_hist": macd_hist_now,
            "ema_fast": round(ef, 2), "ema_slow": round(es, 2),
            "ema_200": round(e200, 2) if e200 else None,
            "vwap": round(vwap[-1], 2) if (vwap and vwap[-1] > 0) else None,
        },
        "spread": spread_info,
        "position": position_info,
        "forecast": fc,
        "signals": signals,
        "verdict": {"score": score, "label": label, "reasons": [s["name"] for s in signals if abs(s["score"]) >= 1]},
    }
    _analyze_cache.set(cache_key, resp)
    return resp


def _verdict_label(score: int, spread: bool, position: bool) -> str:
    """Translate the -100..+100 score into a human-friendly verdict.

    For a held position (stock or spread), positive score = bullish = HOLD, negative = SELL.
    For a watched-but-not-held symbol, positive = BUY-OK / WAIT-LOWER, etc.
    """
    held = spread or position
    if held:
        if score >= 40:
            return "Hold — bullish setup"
        if score >= 15:
            return "Hold with caution"
        if score >= -15:
            return "Mixed — review manually"
        if score >= -40:
            return "Reduce or close"
        return "Sell — bearish setup"
    if score >= 40:
        return "Strong buy setup"
    if score >= 15:
        return "Buy on pullback"
    if score >= -15:
        return "Wait — mixed signals"
    if score >= -40:
        return "Avoid — momentum weak"
    return "Avoid — bearish"


def _parse_yyyymmdd(s: str):
    try:
        return datetime.strptime(s, "%Y%m%d").date()
    except (ValueError, TypeError):
        return None
