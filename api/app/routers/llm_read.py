"""Lightweight LLM "AI read" endpoint for the options analyzer page.

Different from /api/agents (the heavy multi-agent LangGraph debate that
takes ~30s + multiple LLM calls). This endpoint makes ONE prompt to a
fast/cheap OpenRouter model and returns four short analyst paragraphs:

  - underlying : trend / momentum / forecast read
  - option     : IV-vs-RV, contract setup, liquidity
  - position   : keep / close / hedge recommendation
  - risk       : the single biggest thing that hurts this trade

Designed to complement (not replace) the rule-based insights — the LLM
sees the same numbers the trader sees plus cross-position synthesis
that's hard to encode as deterministic rules.

Caches per (symbol, strike, expiry, right, quantity, is_long) for 5
minutes so repeat clicks don't re-spend tokens. Falls back gracefully
when OPENROUTER_API_KEY isn't set.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/options", tags=["analyzer"])

# Free model fallback chain. We try each in order until one accepts the
# request (free tier on OpenRouter is shared across users and individual
# models get throttled). Override the leading model via env if you want
# something specific (paid is faster and more reliable).
_PRIMARY_MODEL = os.getenv(
    "OPENROUTER_MODEL", "openai/gpt-oss-120b:free"
)
# Walked through in order on rate-limit / model-unavailable errors.
# Sourced from the live OpenRouter `/models?:free` filter — refresh if
# 404s start dominating (free model availability rotates monthly).
_FALLBACK_MODELS = [
    "openai/gpt-oss-120b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "z-ai/glm-4.5-air:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "openai/gpt-oss-20b:free",
]
_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
_CACHE_TTL = 5 * 60  # seconds

# (key tuple → (timestamp, payload))
_cache: Dict[tuple, tuple[float, Dict[str, Any]]] = {}


class LlmReadRequest(BaseModel):
    """Subset of OptionAnalyzeResult fields the LLM needs. Sent by the
    client so we don't have to re-run the analyzer pipeline server-side."""

    symbol: str
    strike: float
    expiry: str
    right: str
    quantity: int
    is_long: bool
    dte: int
    spot: float
    breakeven: float
    distance_pct: float
    iv: float
    mid: Optional[float] = None
    entry_price: float

    rsi: Optional[float] = None
    macd_hist: Optional[float] = None
    trend_score: Optional[float] = None
    ema9: Optional[float] = None
    ema21: Optional[float] = None
    ema200: Optional[float] = None

    delta: Optional[float] = None
    gamma: Optional[float] = None
    theta: Optional[float] = None
    vega: Optional[float] = None

    rv30: Optional[float] = None
    iv_to_rv_ratio: Optional[float] = None
    spread_pct: Optional[float] = None
    liquidity_grade: Optional[str] = None

    pop: Optional[float] = None
    prob_itm: Optional[float] = None

    forecast_5d_return_pct: Optional[float] = None
    forecast_5d_band_pct: Optional[float] = None
    forecast_agreement: Optional[float] = None

    advice_label: Optional[str] = None
    advice_score: Optional[float] = None
    advice_notes: list[str] = Field(default_factory=list)


class LlmReadResponse(BaseModel):
    underlying: str
    option: str
    position: str
    risk: str
    model: str
    cached: bool = False


def _cache_key(req: LlmReadRequest) -> tuple:
    return (
        req.symbol, req.strike, req.expiry, req.right,
        req.quantity, req.is_long,
    )


def _build_prompt(req: LlmReadRequest) -> str:
    """Pack the structured analyze payload into one prompt. JSON blob is
    fine for the model — keeps it deterministic and field-aware."""
    payload = req.model_dump(exclude_none=True)
    return f"""You are a senior options trader giving a balanced read on this position to a teammate.

POSITION + MARKET DATA (live):
{json.dumps(payload, indent=2, default=str)}

Give four short paragraphs (1-3 sentences each) — concrete, opinionated,
specific with numbers from the data. Call it as the data shows it. If the
setup is constructive, say so plainly. If it's broken, say so plainly. Do
NOT default to caution because "options are risky" — that's already known
and priced into the trader's decision to be in the trade. Output strict JSON:

{{
  "underlying": "Read of the underlying — trend, momentum, where the forecast points. State the direction the tape is actually pointing; don't soften it.",
  "option": "Read of the contract itself — IV vs realized (rich/fair/cheap with the specific ratio), DTE phase (gamma/theta zone), liquidity, what the greeks say. Read THIS contract, don't lecture on options in general.",
  "position": "Direct recommendation, leading with one word: Add / Hold / Trim / Close / Hedge — then justification with the strongest fact FOR it and the strongest fact AGAINST it, weighted by the data. Include a concrete trigger (price/level/time) to revisit.",
  "risk": "The single most material headwind from here, with the specific number that defines it (e.g. 'theta -$48/day vs forecast +$210 expected — break-even at 5d'). If nothing material is against the trade right now, say so explicitly — don't invent a risk to fill the field."
}}

Use plain English. No filler. No 'as an AI'. No generic options-risk disclaimers.""".strip()


async def _call_openrouter(api_key: str, prompt: str, model: str) -> Dict[str, str]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        # OpenRouter polite headers — improves rate-limit treatment.
        "HTTP-Referer": "https://localhost:3000/monitor/analyzer",
        "X-Title": "Trading Dashboard Analyzer LLM Read",
    }
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You are a senior options trader. Respond ONLY with the exact JSON schema requested.",
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
        "response_format": {"type": "json_object"},
    }
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(_OPENROUTER_URL, headers=headers, json=body)
    if resp.status_code != 200:
        logger.error("OpenRouter %s: %s", resp.status_code, resp.text[:500])
        # Pass through the upstream status so the fallback chain in
        # llm_read() can tell rate-limit (retry next model) from
        # auth-failure (don't retry, bail).
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"OpenRouter error {resp.status_code}: {resp.text[:200]}",
        )
    raw = resp.json()
    try:
        content = raw["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise HTTPException(status_code=502, detail="OpenRouter returned unexpected shape")
    # Some free models return JSON wrapped in ```json ... ``` fences.
    content = content.strip()
    if content.startswith("```"):
        # strip ```json ... ```
        lines = content.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        content = "\n".join(lines)
    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        logger.error("LLM JSON parse failed: %s\n%s", e, content[:500])
        # Fall back to a single-string response so the UI doesn't crash.
        return {
            "underlying": "(model returned non-JSON)",
            "option": content[:500],
            "position": "(non-JSON response — try again)",
            "risk": "model output couldn't be parsed",
        }


@router.post("/llm-read", response_model=LlmReadResponse)
async def llm_read(req: LlmReadRequest) -> LlmReadResponse:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENROUTER_API_KEY not set on the API server",
        )

    # Cache hit?
    key = _cache_key(req)
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and (now - hit[0]) < _CACHE_TTL:
        return LlmReadResponse(**hit[1], cached=True)

    prompt = _build_prompt(req)
    # Try the primary first, then walk down the fallback list. Skip
    # duplicates if the primary is already in the fallback list.
    tried = []
    last_err: Optional[HTTPException] = None
    chain = [_PRIMARY_MODEL] + [m for m in _FALLBACK_MODELS if m != _PRIMARY_MODEL]
    parsed = None
    used_model = chain[0]
    for model in chain:
        tried.append(model)
        try:
            parsed = await _call_openrouter(api_key, prompt, model)
            used_model = model
            break
        except HTTPException as e:
            last_err = e
            # 429 (rate-limited), 402 (out of free credits), 503 (upstream
            # busy), 404/400 (model no longer hosted or invalid ID) → try
            # next in the fallback chain.
            if e.status_code in (429, 402, 503, 404, 400):
                logger.warning("model %s rate-limited (%s) — falling back", model, e.status_code)
                continue
            # Anything else (auth, bad request) — bail; not a rate-limit
            raise
    if parsed is None:
        raise last_err or HTTPException(status_code=503, detail=f"all models rate-limited: {tried}")

    payload = {
        "underlying": str(parsed.get("underlying", "")).strip() or "(empty)",
        "option": str(parsed.get("option", "")).strip() or "(empty)",
        "position": str(parsed.get("position", "")).strip() or "(empty)",
        "risk": str(parsed.get("risk", "")).strip() or "(empty)",
        "model": used_model,
    }
    _cache[key] = (now, payload)
    return LlmReadResponse(**payload, cached=False)
