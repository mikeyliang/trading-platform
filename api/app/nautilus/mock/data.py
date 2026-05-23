"""
synthetic price data generator for dev/demo without IB connection
"""
import random
import time
import math
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Tuple
import numpy as np


SECTORS: Dict[str, List[Tuple[str, str]]] = {
    "Technology": [
        ("AAPL", "Apple Inc."),
        ("MSFT", "Microsoft Corp."),
        ("NVDA", "NVIDIA Corp."),
        ("GOOGL", "Alphabet Inc."),
        ("META", "Meta Platforms"),
        ("AMD", "Advanced Micro Devices"),
        ("TSM", "Taiwan Semiconductor"),
        ("ORCL", "Oracle Corp."),
        ("CRM", "Salesforce Inc."),
        ("ADBE", "Adobe Inc."),
        ("AVGO", "Broadcom Inc."),
        ("QCOM", "Qualcomm Inc."),
        ("INTC", "Intel Corp."),
        ("MU", "Micron Technology"),
        ("CSCO", "Cisco Systems"),
        ("IBM", "IBM Corp."),
    ],
    "Consumer Discretionary": [
        ("AMZN", "Amazon.com Inc."),
        ("TSLA", "Tesla Inc."),
        ("NKE", "Nike Inc."),
        ("SBUX", "Starbucks Corp."),
        ("HD", "Home Depot"),
        ("MCD", "McDonald's Corp."),
        ("LOW", "Lowe's Cos."),
    ],
    "Financial": [
        ("JPM", "JPMorgan Chase"),
        ("GS", "Goldman Sachs"),
        ("V", "Visa Inc."),
        ("MA", "Mastercard Inc."),
        ("BAC", "Bank of America"),
        ("WFC", "Wells Fargo"),
        ("C", "Citigroup"),
        ("MS", "Morgan Stanley"),
    ],
    "Energy": [
        ("XOM", "Exxon Mobil"),
        ("CVX", "Chevron Corp."),
        ("COP", "ConocoPhillips"),
        ("OXY", "Occidental Petroleum"),
        ("USO", "United States Oil Fund"),
        ("UNG", "United States Natural Gas Fund"),
        ("SLB", "Schlumberger"),
    ],
    "Healthcare": [
        ("UNH", "UnitedHealth Group"),
        ("JNJ", "Johnson & Johnson"),
        ("PFE", "Pfizer Inc."),
        ("MRNA", "Moderna Inc."),
        ("LLY", "Eli Lilly"),
        ("ABBV", "AbbVie Inc."),
        ("MRK", "Merck & Co."),
    ],
    "Industrials": [
        ("CAT", "Caterpillar Inc."),
        ("DE", "Deere & Company"),
        ("BA", "Boeing Co."),
        ("GE", "GE Aerospace"),
        ("UPS", "United Parcel Service"),
    ],
    "ETF": [
        ("SPY", "SPDR S&P 500 ETF"),
        ("QQQ", "Invesco QQQ Trust"),
        ("IWM", "iShares Russell 2000 ETF"),
        ("DIA", "SPDR Dow Jones ETF"),
        ("VOO", "Vanguard S&P 500 ETF"),
        ("VTI", "Vanguard Total Stock Market"),
        ("EEM", "iShares MSCI Emerging Markets"),
        ("TLT", "iShares 20+ Year Treasury Bond"),
        ("GLD", "SPDR Gold Shares"),
        ("SLV", "iShares Silver Trust"),
    ],
    "Index": [
        ("SPX", "S&P 500 Index"),
        ("RUT", "Russell 2000 Index"),
        ("NDX", "Nasdaq-100 Index"),
        ("VIX", "CBOE Volatility Index"),
        ("DJX", "Dow Jones Index"),
    ],
}

# seed prices (realistic approximations)
BASE_PRICES: Dict[str, float] = {
    "AAPL": 185.0, "MSFT": 415.0, "NVDA": 875.0, "GOOGL": 175.0,
    "META": 510.0, "AMD": 170.0, "TSM": 145.0,
    "AMZN": 190.0, "TSLA": 175.0, "NKE": 92.0, "SBUX": 78.0,
    "JPM": 200.0, "GS": 480.0, "V": 275.0, "MA": 465.0,
    "XOM": 115.0, "CVX": 155.0, "COP": 120.0,
    "UNH": 540.0, "JNJ": 155.0, "PFE": 27.0, "MRNA": 95.0,
    "CAT": 350.0, "DE": 390.0, "BA": 195.0,
}

# current simulated prices (mutable state)
_current_prices: Dict[str, float] = {k: v for k, v in BASE_PRICES.items()}


def get_all_symbols() -> List[Dict]:
    result = []
    for sector, stocks in SECTORS.items():
        for symbol, name in stocks:
            result.append({"symbol": symbol, "name": name, "sector": sector})
    return result


def get_sector_for_symbol(symbol: str) -> str:
    for sector, stocks in SECTORS.items():
        for sym, _ in stocks:
            if sym == symbol:
                return sector
    return "Unknown"


def get_name_for_symbol(symbol: str) -> str:
    for _, stocks in SECTORS.items():
        for sym, name in stocks:
            if sym == symbol:
                return name
    return symbol


def simulate_tick(symbol: str) -> Dict:
    """generate a single realistic price tick"""
    base = _current_prices.get(symbol, BASE_PRICES.get(symbol, 100.0))

    # gbm-style tick with slight mean reversion
    drift = 0.00002
    volatility = 0.0015
    dt = 1.0 / (252 * 6.5 * 60)  # per-second in trading year
    shock = random.gauss(0, 1)
    pct_change = drift * dt + volatility * math.sqrt(dt) * shock

    new_price = base * (1 + pct_change)
    new_price = max(new_price, base * 0.8)  # floor
    _current_prices[symbol] = round(new_price, 2)

    spread = new_price * 0.0002
    volume = random.randint(100, 5000)
    base_price = BASE_PRICES.get(symbol, 100.0)
    change = new_price - base_price
    change_pct = (change / base_price) * 100

    return {
        "symbol": symbol,
        "bid": round(new_price - spread, 2),
        "ask": round(new_price + spread, 2),
        "last": round(new_price, 2),
        "volume": volume,
        "change": round(change, 2),
        "change_pct": round(change_pct, 3),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def generate_historical_bars(
    symbol: str,
    timeframe: str = "15m",
    days: int = 90,
) -> List[Dict]:
    """generate synthetic OHLCV bars for backtesting/charting"""
    tf_minutes = _timeframe_to_minutes(timeframe)
    bars_per_day = int(6.5 * 60 / tf_minutes)
    total_bars = days * bars_per_day

    base = BASE_PRICES.get(symbol, 100.0)
    price = base * random.uniform(0.7, 0.9)  # start lower to show movement
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days)

    bars = []
    t = start

    # skip weekends
    while t < now:
        if t.weekday() >= 5:
            t += timedelta(days=1)
            continue

        day_open = t.replace(hour=9, minute=30, second=0, microsecond=0)
        day_close = t.replace(hour=16, minute=0, second=0, microsecond=0)

        bar_t = day_open
        while bar_t < day_close and bar_t < now:
            o = price
            drift = 0.00005
            vol = 0.003
            changes = [random.gauss(drift, vol) for _ in range(tf_minutes)]
            cum = np.cumsum(changes)
            intrabar = o * (1 + np.concatenate([[0], cum]))
            h = float(np.max(intrabar))
            l = float(np.min(intrabar))
            c = float(intrabar[-1])

            volume = random.randint(50_000, 500_000)

            bars.append({
                "time": int(bar_t.timestamp()),
                "open": round(o, 2),
                "high": round(max(o, h, c) * random.uniform(1.0, 1.002), 2),
                "low": round(min(o, l, c) * random.uniform(0.998, 1.0), 2),
                "close": round(c, 2),
                "volume": volume,
            })
            price = c
            bar_t += timedelta(minutes=tf_minutes)

        t += timedelta(days=1)

    return bars


def _timeframe_to_minutes(tf: str) -> int:
    mapping = {
        "1m": 1, "3m": 3, "5m": 5, "15m": 15,
        "30m": 30, "1h": 60, "2h": 120, "4h": 240, "1d": 390,
    }
    return mapping.get(tf, 15)
