"""Lightweight news fetcher for the analyzer's news agent.

No paid data — falls through a chain of free public RSS feeds and gives
up gracefully if all are dead. The LLM agent prompt should treat "no
news" as a real signal, not fake-narrate one.
"""
from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from typing import List, TypedDict

import httpx

logger = logging.getLogger(__name__)


class NewsItem(TypedDict):
    title: str
    source: str
    published: str  # ISO-ish; whatever the feed gave us
    link: str
    snippet: str   # may be empty


# Stripped HTML — RSS descriptions often arrive as HTML fragments.
_TAG_RE = re.compile(r"<[^>]+>")


def _strip(html: str | None) -> str:
    if not html:
        return ""
    return _TAG_RE.sub("", html).strip()


async def _try_yahoo(client: httpx.AsyncClient, symbol: str) -> List[NewsItem]:
    # Yahoo Finance discontinued some RSS endpoints but the headline
    # feed still works for many tickers as of writing.
    url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US"
    resp = await client.get(url)
    if resp.status_code != 200 or not resp.text.strip():
        return []
    try:
        root = ET.fromstring(resp.text)
    except ET.ParseError:
        return []
    out: List[NewsItem] = []
    for item in root.iter("item"):
        out.append({
            "title": (item.findtext("title") or "").strip(),
            "source": "Yahoo Finance",
            "published": (item.findtext("pubDate") or "").strip(),
            "link": (item.findtext("link") or "").strip(),
            "snippet": _strip(item.findtext("description")),
        })
        if len(out) >= 10:
            break
    return out


async def _try_google(client: httpx.AsyncClient, symbol: str) -> List[NewsItem]:
    # Google News RSS is broadly available and tolerant of any query
    # string — we get back the same fields shape as Yahoo.
    url = (
        f"https://news.google.com/rss/search"
        f"?q={symbol}+stock+OR+{symbol}+ETF&hl=en-US&gl=US&ceid=US:en"
    )
    resp = await client.get(url)
    if resp.status_code != 200 or not resp.text.strip():
        return []
    try:
        root = ET.fromstring(resp.text)
    except ET.ParseError:
        return []
    out: List[NewsItem] = []
    for item in root.iter("item"):
        out.append({
            "title": (item.findtext("title") or "").strip(),
            "source": (item.findtext("source") or "Google News").strip(),
            "published": (item.findtext("pubDate") or "").strip(),
            "link": (item.findtext("link") or "").strip(),
            "snippet": _strip(item.findtext("description")),
        })
        if len(out) >= 10:
            break
    return out


async def fetch_news(symbol: str, limit: int = 8) -> List[NewsItem]:
    """Try Yahoo → Google News in order. Returns first non-empty list."""
    symbol = symbol.upper()
    headers = {
        # Yahoo serves an HTML 404 page to bare clients; the UA fixes it.
        "User-Agent": "Mozilla/5.0 (compatible; TradingDashboard/1.0)",
    }
    async with httpx.AsyncClient(timeout=12, headers=headers, follow_redirects=True) as client:
        for fetcher in (_try_yahoo, _try_google):
            try:
                items = await fetcher(client, symbol)
                if items:
                    return items[:limit]
            except Exception as e:  # noqa: BLE001
                logger.warning("news fetcher %s failed for %s: %s", fetcher.__name__, symbol, e)
                continue
    return []
