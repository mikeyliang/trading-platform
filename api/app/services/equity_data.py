"""Free market-data fetcher for the equity research desk.

Supports stocks/ETFs (Stooq daily CSV — no API key) and crypto
(CoinGecko public API — no API key). Returns a normalized snapshot of
daily closes plus derived indicators that the research agents consume
as a text briefing. All fetches degrade gracefully: a dead source
raises ``MarketDataError`` so the caller can fail the run *before*
charging credits.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

_TIMEOUT_S = 15

# CoinGecko ids for the majors so we skip the /search round-trip.
_COINGECKO_IDS: Dict[str, str] = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "XRP": "ripple",
    "BNB": "binancecoin",
    "ADA": "cardano",
    "DOGE": "dogecoin",
    "AVAX": "avalanche-2",
    "DOT": "polkadot",
    "LINK": "chainlink",
    "MATIC": "matic-network",
    "LTC": "litecoin",
    "UNI": "uniswap",
    "ATOM": "cosmos",
    "NEAR": "near",
}


class MarketDataError(Exception):
    """Raised when no usable price history could be fetched."""


@dataclass
class MarketSnapshot:
    symbol: str
    asset_class: str  # stock | etf | crypto
    name: str
    currency: str
    closes: List[float]
    volumes: List[float]
    dates: List[str]
    indicators: Dict[str, float] = field(default_factory=dict)

    @property
    def last_close(self) -> float:
        return self.closes[-1]

    def summary(self) -> Dict[str, object]:
        """Compact dict for the UI header / persistence."""
        return {
            "symbol": self.symbol,
            "asset_class": self.asset_class,
            "name": self.name,
            "currency": self.currency,
            "last_close": round(self.last_close, 6),
            "as_of": self.dates[-1],
            "bars": len(self.closes),
            **{k: (round(v, 4) if isinstance(v, float) else v) for k, v in self.indicators.items()},
        }


# ── indicator math (pure python on daily closes) ─────────────────────

def _sma(values: List[float], n: int) -> Optional[float]:
    if len(values) < n:
        return None
    return sum(values[-n:]) / n


def _ema_series(values: List[float], n: int) -> List[float]:
    if not values:
        return []
    k = 2 / (n + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def _rsi(values: List[float], n: int = 14) -> Optional[float]:
    if len(values) < n + 1:
        return None
    gains, losses = [], []
    for prev, cur in zip(values[-(n + 1):-1], values[-n:]):
        change = cur - prev
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))
    avg_gain = sum(gains) / n
    avg_loss = sum(losses) / n
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def _pct_return(values: List[float], days: int) -> Optional[float]:
    if len(values) <= days:
        return None
    base = values[-(days + 1)]
    if base == 0:
        return None
    return (values[-1] / base - 1) * 100


def compute_indicators(closes: List[float]) -> Dict[str, float]:
    out: Dict[str, float] = {}
    if len(closes) < 2:
        return out
    for n in (20, 50, 200):
        v = _sma(closes, n)
        if v is not None:
            out[f"sma{n}"] = v
    ema12 = _ema_series(closes, 12)
    ema26 = _ema_series(closes, 26)
    if len(closes) >= 26:
        macd_line = [a - b for a, b in zip(ema12, ema26)]
        signal = _ema_series(macd_line, 9)
        out["macd"] = macd_line[-1]
        out["macd_signal"] = signal[-1]
        out["macd_hist"] = macd_line[-1] - signal[-1]
    rsi = _rsi(closes)
    if rsi is not None:
        out["rsi14"] = rsi
    # Annualized realized vol over the last 30 sessions.
    if len(closes) >= 31:
        rets = [math.log(closes[i] / closes[i - 1]) for i in range(len(closes) - 30, len(closes))]
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
        out["rv30_annualized_pct"] = math.sqrt(var) * math.sqrt(252) * 100
    for label, days in (("ret_1w_pct", 5), ("ret_1m_pct", 21), ("ret_3m_pct", 63), ("ret_1y_pct", 252)):
        v = _pct_return(closes, days)
        if v is not None:
            out[label] = v
    window = closes[-252:] if len(closes) >= 252 else closes
    hi, lo = max(window), min(window)
    out["dist_52w_high_pct"] = (closes[-1] / hi - 1) * 100 if hi else 0.0
    out["dist_52w_low_pct"] = (closes[-1] / lo - 1) * 100 if lo else 0.0
    # Max drawdown over the window.
    peak, mdd = window[0], 0.0
    for c in window:
        peak = max(peak, c)
        mdd = min(mdd, c / peak - 1)
    out["max_drawdown_1y_pct"] = mdd * 100
    return out


# ── fetchers ─────────────────────────────────────────────────────────

async def _fetch_stooq(symbol: str, asset_class: str) -> MarketSnapshot:
    """Daily OHLCV CSV from Stooq. US tickers need the `.us` suffix."""
    sym = symbol.lower()
    candidates = [sym if "." in sym else f"{sym}.us", sym]
    async with httpx.AsyncClient(timeout=_TIMEOUT_S, follow_redirects=True) as client:
        for cand in candidates:
            url = f"https://stooq.com/q/d/l/?s={cand}&i=d"
            try:
                resp = await client.get(url)
            except httpx.HTTPError as e:
                raise MarketDataError(f"stooq unreachable: {e}") from e
            if resp.status_code != 200:
                continue
            lines = [ln for ln in resp.text.strip().splitlines() if ln]
            if len(lines) < 30 or not lines[0].lower().startswith("date"):
                continue
            dates, closes, volumes = [], [], []
            for ln in lines[1:]:
                parts = ln.split(",")
                if len(parts) < 5:
                    continue
                try:
                    close = float(parts[4])
                except ValueError:
                    continue
                dates.append(parts[0])
                closes.append(close)
                try:
                    volumes.append(float(parts[5]) if len(parts) > 5 and parts[5] else 0.0)
                except ValueError:
                    volumes.append(0.0)
            if len(closes) >= 30:
                # Keep ~2y of history; agents only need recent structure.
                dates, closes, volumes = dates[-504:], closes[-504:], volumes[-504:]
                snap = MarketSnapshot(
                    symbol=symbol.upper(), asset_class=asset_class, name=symbol.upper(),
                    currency="USD", closes=closes, volumes=volumes, dates=dates,
                )
                snap.indicators = compute_indicators(closes)
                return snap
    raise MarketDataError(f"no daily history for '{symbol}' on stooq")


async def _resolve_coingecko_id(client: httpx.AsyncClient, symbol: str) -> str:
    if symbol.upper() in _COINGECKO_IDS:
        return _COINGECKO_IDS[symbol.upper()]
    resp = await client.get("https://api.coingecko.com/api/v3/search", params={"query": symbol})
    if resp.status_code == 200:
        for coin in resp.json().get("coins", []):
            if coin.get("symbol", "").upper() == symbol.upper():
                return coin["id"]
    raise MarketDataError(f"unknown crypto symbol '{symbol}'")


async def _fetch_coingecko(symbol: str) -> MarketSnapshot:
    """Daily price/volume series from CoinGecko's public market_chart."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            coin_id = await _resolve_coingecko_id(client, symbol)
            resp = await client.get(
                f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart",
                params={"vs_currency": "usd", "days": "365", "interval": "daily"},
            )
    except httpx.HTTPError as e:
        raise MarketDataError(f"coingecko unreachable: {e}") from e
    if resp.status_code != 200:
        raise MarketDataError(f"coingecko {resp.status_code} for '{symbol}'")
    body = resp.json()
    prices = body.get("prices") or []
    vols = body.get("total_volumes") or []
    if len(prices) < 30:
        raise MarketDataError(f"insufficient crypto history for '{symbol}'")
    from datetime import datetime, timezone  # local import keeps module load light
    dates = [datetime.fromtimestamp(p[0] / 1000, tz=timezone.utc).strftime("%Y-%m-%d") for p in prices]
    closes = [float(p[1]) for p in prices]
    volumes = [float(v[1]) for v in vols] if len(vols) == len(prices) else [0.0] * len(prices)
    snap = MarketSnapshot(
        symbol=symbol.upper(), asset_class="crypto", name=coin_id,
        currency="USD", closes=closes, volumes=volumes, dates=dates,
    )
    snap.indicators = compute_indicators(closes)
    return snap


async def fetch_snapshot(symbol: str, asset_class: str) -> MarketSnapshot:
    """Fetch + enrich a snapshot, or raise MarketDataError."""
    if asset_class == "crypto":
        return await _fetch_coingecko(symbol)
    return await _fetch_stooq(symbol, asset_class)


# ── briefing text (shared prompt context for every agent in a run) ───

def _fmt(v: Optional[float], spec: str = ",.2f") -> str:
    if v is None:
        return "—"
    return f"{v:{spec}}"


def build_briefing(snap: MarketSnapshot, news_items: List[dict]) -> str:
    """Human-readable, line-oriented market briefing. This block is
    byte-identical across every agent call in a run so the prompt
    cache can serve it after the first agent writes it."""
    ind = snap.indicators
    lines = [
        f"ASSET: {snap.symbol} ({snap.asset_class}, {snap.name}) — prices in {snap.currency}",
        f"LAST CLOSE: {_fmt(snap.last_close)} as of {snap.dates[-1]} ({len(snap.closes)} daily bars)",
        (
            f"RETURNS: 1w {_fmt(ind.get('ret_1w_pct'), '+.2f')}%  1m {_fmt(ind.get('ret_1m_pct'), '+.2f')}%  "
            f"3m {_fmt(ind.get('ret_3m_pct'), '+.2f')}%  1y {_fmt(ind.get('ret_1y_pct'), '+.2f')}%"
        ),
        (
            f"TREND: SMA20 {_fmt(ind.get('sma20'))}  SMA50 {_fmt(ind.get('sma50'))}  "
            f"SMA200 {_fmt(ind.get('sma200'))}"
        ),
        (
            f"MOMENTUM: RSI14 {_fmt(ind.get('rsi14'), '.0f')}  MACD {_fmt(ind.get('macd'), '+.4f')}  "
            f"signal {_fmt(ind.get('macd_signal'), '+.4f')}  hist {_fmt(ind.get('macd_hist'), '+.4f')}"
        ),
        (
            f"VOL/RANGE: RV30 {_fmt(ind.get('rv30_annualized_pct'), '.1f')}% ann.  "
            f"vs 52w high {_fmt(ind.get('dist_52w_high_pct'), '+.1f')}%  "
            f"vs 52w low {_fmt(ind.get('dist_52w_low_pct'), '+.1f')}%  "
            f"max DD 1y {_fmt(ind.get('max_drawdown_1y_pct'), '.1f')}%"
        ),
    ]
    # Recent closes, weekly-sampled, so agents see price *structure* not
    # just endpoint stats.
    tail = list(zip(snap.dates, snap.closes))[-90:]
    sampled = tail[::5] + ([tail[-1]] if (len(tail) - 1) % 5 else [])
    lines.append("RECENT CLOSES (weekly samples, last ~90 sessions):")
    lines.append("  " + "  ".join(f"{d}:{_fmt(c)}" for d, c in sampled))
    if news_items:
        lines.append(f"RECENT HEADLINES ({len(news_items)}):")
        for item in news_items[:10]:
            lines.append(f"  • {item.get('title', '')} — {item.get('source', '')} ({item.get('published', '')})")
    else:
        lines.append("RECENT HEADLINES: none found on free feeds — treat the absence of news as a signal, do not fabricate headlines.")
    return "\n".join(lines)
