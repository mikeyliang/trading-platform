"""
SMI (Stochastic Momentum Index) + EMA crossover strategy
- SMI measures momentum relative to mid-point of recent high/low range
- EMA filter confirms trend direction
- suitable for short (15m) and mid-term (4h/1d) timeframes
"""
from typing import List


def compute_ema(values: List[float], period: int) -> float:
    if not values or len(values) < period:
        return values[-1] if values else 0.0
    multiplier = 2.0 / (period + 1)
    ema = values[0]
    for v in values[1:]:
        ema = v * multiplier + ema * (1 - multiplier)
    return ema


def compute_ema_series(values: List[float], period: int) -> List[float]:
    if not values:
        return []
    multiplier = 2.0 / (period + 1)
    result = [values[0]]
    for v in values[1:]:
        result.append(v * multiplier + result[-1] * (1 - multiplier))
    return result


def compute_smi_series(
    highs: List[float],
    lows: List[float],
    closes: List[float],
    period: int = 13,
    smooth1: int = 25,
    smooth2: int = 2,
    signal: int = 9,
) -> dict:
    """
    returns dict with 'smi' and 'signal' lists aligned to the input bars
    smi range: typically -100 to +100, overbought >40, oversold <-40
    """
    n = len(closes)
    smi_out = [None] * n
    sig_out = [None] * n

    m_vals = []  # close - midpoint
    d_vals = []  # half range

    for i in range(n):
        start = max(0, i - period + 1)
        hh = max(highs[start : i + 1])
        ll = min(lows[start : i + 1])
        mid = (hh + ll) / 2.0
        d = (hh - ll) / 2.0
        m_vals.append(closes[i] - mid)
        d_vals.append(d)

    # double smooth m and d
    m1 = compute_ema_series(m_vals, smooth1)
    m2 = compute_ema_series(m1, smooth2)
    d1 = compute_ema_series(d_vals, smooth1)
    d2 = compute_ema_series(d1, smooth2)

    raw_smi = []
    for i in range(n):
        dv = d2[i]
        smi_out[i] = round((m2[i] / dv) * 100, 2) if dv != 0 else 0.0
        raw_smi.append(smi_out[i])

    sig_series = compute_ema_series(raw_smi, signal)
    for i in range(n):
        sig_out[i] = round(sig_series[i], 2)

    return {"smi": smi_out, "signal": sig_out}


def compute_rsi_series(closes: List[float], period: int = 14) -> List[float]:
    """Wilder's RSI. Returns 0.0 for warm-up bars."""
    n = len(closes)
    if n < 2:
        return [50.0] * n
    deltas = [closes[i] - closes[i - 1] for i in range(1, n)]
    gains = [max(d, 0.0) for d in deltas]
    losses = [-min(d, 0.0) for d in deltas]
    avg_gain = sum(gains[:period]) / period if n > period else (sum(gains) / max(1, len(gains)))
    avg_loss = sum(losses[:period]) / period if n > period else (sum(losses) / max(1, len(losses)))
    out = [50.0]  # first bar has no delta
    for i in range(1, n):
        if i <= period:
            g = avg_gain
            loss = avg_loss
        else:
            g = (avg_gain * (period - 1) + gains[i - 1]) / period
            loss = (avg_loss * (period - 1) + losses[i - 1]) / period
            avg_gain, avg_loss = g, loss
        if loss == 0:
            out.append(100.0)
        else:
            rs = g / loss
            out.append(round(100.0 - (100.0 / (1.0 + rs)), 2))
    return out


def compute_macd_series(
    closes: List[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> dict:
    """Standard MACD: fast EMA - slow EMA, signal = EMA of MACD, histogram = MACD - signal."""
    ema_fast = compute_ema_series(closes, fast)
    ema_slow = compute_ema_series(closes, slow)
    macd = [round(ema_fast[i] - ema_slow[i], 4) for i in range(len(closes))]
    signal_line = [round(v, 4) for v in compute_ema_series(macd, signal)]
    hist = [round(macd[i] - signal_line[i], 4) for i in range(len(closes))]
    return {"macd": macd, "signal": signal_line, "hist": hist}


def compute_vwap_series(
    highs: List[float],
    lows: List[float],
    closes: List[float],
    volumes: List[float],
    times: List[int],
    daily_reset: bool = True,
) -> List[float]:
    """
    Volume-weighted average price. Standard formula:
        VWAP = sum(typical_price * volume) / sum(volume)
    Typical price = (high + low + close) / 3.

    When daily_reset=True (default), cumulative sums reset at each new UTC
    trading day — matches how intraday charts on Bloomberg/TWS render VWAP.
    For daily-or-longer timeframes the reset never fires so it acts as
    rolling cumulative since-listing, which is usually not what you want.
    """
    from datetime import datetime, timezone
    n = len(closes)
    out = [0.0] * n
    if n == 0:
        return out

    cum_pv = 0.0
    cum_v = 0.0
    last_day: int | None = None

    for i in range(n):
        if daily_reset:
            day = datetime.fromtimestamp(times[i], tz=timezone.utc).toordinal()
            if last_day is None or day != last_day:
                cum_pv = 0.0
                cum_v = 0.0
                last_day = day

        typical = (highs[i] + lows[i] + closes[i]) / 3.0
        vol = max(volumes[i], 0.0)
        cum_pv += typical * vol
        cum_v += vol
        out[i] = round(cum_pv / cum_v, 4) if cum_v > 0 else round(typical, 4)
    return out


def generate_signals(
    bars: List[dict],
    smi_period: int = 13,
    smi_smooth1: int = 25,
    smi_smooth2: int = 2,
    smi_signal: int = 9,
    ema_fast: int = 9,
    ema_slow: int = 21,
    smi_overbought: float = 40.0,
    smi_oversold: float = -40.0,
) -> List[dict]:
    """
    returns list of signal dicts: {bar_index, time, signal, smi, smi_signal, ema_fast, ema_slow}
    signal: 'BUY' | 'SELL' | None
    """
    if not bars:
        return []

    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    closes = [b["close"] for b in bars]

    smi_data = compute_smi_series(highs, lows, closes, smi_period, smi_smooth1, smi_smooth2, smi_signal)
    smi_vals = smi_data["smi"]
    sig_vals = smi_data["signal"]

    ema_f = compute_ema_series(closes, ema_fast)
    ema_s = compute_ema_series(closes, ema_slow)

    results = []
    min_idx = max(smi_period + smi_smooth1, ema_slow) + 2

    for i in range(min_idx, len(bars)):
        smi_now = smi_vals[i]
        smi_prev = smi_vals[i - 1]
        sig_now = sig_vals[i]
        sig_prev = sig_vals[i - 1]

        signal = None

        # buy: smi crosses above signal line while in/near oversold zone + uptrend filter
        if (smi_prev < sig_prev and smi_now >= sig_now
                and smi_prev < (smi_overbought * 0.5)  # below midpoint (not already overbought)
                and ema_f[i] > ema_s[i]):
            signal = "BUY"

        # sell: smi crosses below signal line (exit regardless of EMA direction — protect profits)
        elif (smi_prev > sig_prev and smi_now <= sig_now
              and smi_prev > (smi_oversold * 0.5)):  # above midpoint (not already oversold)
            signal = "SELL"

        results.append({
            "bar_index": i,
            "time": bars[i]["time"],
            "signal": signal,
            "smi": smi_now,
            "smi_signal": sig_now,
            "ema_fast": round(ema_f[i], 2),
            "ema_slow": round(ema_s[i], 2),
            "price": bars[i]["close"],
        })

    return results
