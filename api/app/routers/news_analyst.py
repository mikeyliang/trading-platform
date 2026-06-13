"""
AI news analyst — one cheap OpenRouter call over recent headlines for a
symbol, returning a verdict-led, symmetric read (working FOR / AGAINST)
plus a numeric bias the trading bot can gate entries on.

GET /api/news-analyst/{symbol}            (10-min cache per symbol)

Reuses the news fetchers in services.news (Yahoo RSS → Google News) and
the free-model fallback chain from routers.llm_read.
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..services.news import fetch_news
from .llm_read import _FALLBACK_MODELS, _PRIMARY_MODEL, _call_openrouter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/news-analyst", tags=["news-analyst"])

_CACHE_TTL = 10 * 60  # seconds
_cache: Dict[str, tuple[float, Dict[str, Any]]] = {}


class NewsAnalystResponse(BaseModel):
    symbol: str
    verdict: str                  # bullish | bearish | neutral | mixed
    confidence: int               # 0-100
    bias_score: float             # -1.0 (max bearish) .. +1.0 (max bullish)
    summary: str                  # one-paragraph verdict-led read
    working_for: List[str]        # evidence FOR the bull case
    working_against: List[str]    # evidence AGAINST the bull case
    headlines: List[Dict[str, Any]]
    model: str
    as_of: str
    cached: bool = False


def _build_prompt(symbol: str, items: List[dict]) -> str:
    lines = [
        f"- [{it.get('published', '?')}] {it.get('title', '')} ({it.get('source', '?')})"
        for it in items
    ]
    headlines = "\n".join(lines)
    return f"""You are an equity news analyst on a trading desk. Read the recent headlines
for {symbol} and give a balanced, verdict-led read for a short/mid-term swing trader
(holding days to weeks).

HEADLINES (newest first):
{headlines}

Rules:
- Lead with the verdict the headlines actually support. Don't default to caution.
- Be symmetric: list what's genuinely working FOR the stock and what's working AGAINST it.
- If headlines are stale, thin, or routine noise, say verdict "neutral" with low confidence —
  don't manufacture a story.
- Confidence reflects how much signal is in these headlines, not your general view of the company.

Output strict JSON:
{{
  "verdict": "bullish" | "bearish" | "neutral" | "mixed",
  "confidence": <int 0-100>,
  "bias_score": <float -1.0..1.0, sign matches verdict, magnitude matches confidence>,
  "summary": "2-3 sentences, verdict first, citing the specific headlines that drive it",
  "working_for": ["specific positive driver", ...up to 4, can be empty],
  "working_against": ["specific negative driver", ...up to 4, can be empty]
}}""".strip()


@router.get("/{symbol}", response_model=NewsAnalystResponse)
async def news_read(symbol: str, limit: int = Query(10, ge=3, le=20)) -> NewsAnalystResponse:
    symbol = symbol.strip().upper()
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="OPENROUTER_API_KEY not set on the API server")

    now = time.monotonic()
    hit = _cache.get(symbol)
    if hit and (now - hit[0]) < _CACHE_TTL:
        return NewsAnalystResponse(**hit[1], cached=True)

    items = await fetch_news(symbol, limit=limit)
    if not items:
        payload = {
            "symbol": symbol,
            "verdict": "neutral",
            "confidence": 0,
            "bias_score": 0.0,
            "summary": "No recent headlines found for this symbol — no news signal either way.",
            "working_for": [],
            "working_against": [],
            "headlines": [],
            "model": "none",
            "as_of": datetime.now(timezone.utc).isoformat(),
        }
        _cache[symbol] = (now, payload)
        return NewsAnalystResponse(**payload, cached=False)

    prompt = _build_prompt(symbol, items)
    chain = [_PRIMARY_MODEL] + [m for m in _FALLBACK_MODELS if m != _PRIMARY_MODEL]
    parsed: Optional[Dict[str, Any]] = None
    used_model = chain[0]
    last_err: Optional[HTTPException] = None
    for model in chain:
        try:
            parsed = await _call_openrouter(api_key, prompt, model)
            used_model = model
            break
        except HTTPException as e:
            last_err = e
            if e.status_code in (429, 402, 503, 404, 400):
                logger.warning("news-analyst: model %s unavailable (%s) — falling back",
                               model, e.status_code)
                continue
            raise
    if parsed is None:
        raise last_err or HTTPException(status_code=503, detail="all models rate-limited")

    verdict = str(parsed.get("verdict", "neutral")).lower()
    if verdict not in ("bullish", "bearish", "neutral", "mixed"):
        verdict = "neutral"
    try:
        confidence = max(0, min(100, int(parsed.get("confidence", 0))))
    except (TypeError, ValueError):
        confidence = 0
    try:
        bias = max(-1.0, min(1.0, float(parsed.get("bias_score", 0.0))))
    except (TypeError, ValueError):
        bias = 0.0

    def _str_list(v: Any) -> List[str]:
        if not isinstance(v, list):
            return []
        return [str(x).strip() for x in v if str(x).strip()][:4]

    payload = {
        "symbol": symbol,
        "verdict": verdict,
        "confidence": confidence,
        "bias_score": round(bias, 3),
        "summary": str(parsed.get("summary", "")).strip() or "(empty)",
        "working_for": _str_list(parsed.get("working_for")),
        "working_against": _str_list(parsed.get("working_against")),
        "headlines": [
            {
                "title": it.get("title"),
                "source": it.get("source"),
                "published": it.get("published"),
                "link": it.get("link"),
            }
            for it in items
        ],
        "model": used_model,
        "as_of": datetime.now(timezone.utc).isoformat(),
    }
    _cache[symbol] = (now, payload)
    return NewsAnalystResponse(**payload, cached=False)
