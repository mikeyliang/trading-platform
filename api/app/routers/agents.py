"""TradingAgents multi-agent debate runner.

Wraps the cloned ``tradingagents`` package as an HTTP endpoint. The graph
is heavy (multiple LLM calls per analyst + debate rounds), so this runs
in a thread pool and the API caches per (symbol, trade_date) for one
hour. Requires an LLM API key — OPENAI_API_KEY or equivalent — and
optionally FINNHUB_API_KEY for richer fundamentals/news.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException

from ..models.schemas import AgentAnalyzeRequest, AgentStatusResponse
from ..util.cache import TTLCache

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agents", tags=["agents"])

# One-hour cache: the agent debate is expensive (~30s + tokens) and the
# decision rarely changes minute-to-minute, so we serve repeated requests
# for the same (symbol, date) from cache.
_cache = TTLCache(ttl_seconds=3600)


def _run_graph_sync(symbol: str, trade_date: str) -> Dict[str, Any]:
    """Run the LangGraph pipeline. Imported lazily so the API boots even
    when tradingagents isn't installed."""
    from tradingagents.graph.trading_graph import TradingAgentsGraph
    from tradingagents.default_config import DEFAULT_CONFIG

    config = DEFAULT_CONFIG.copy()
    graph = TradingAgentsGraph(debug=False, config=config)
    state, decision = graph.propagate(symbol.upper(), trade_date)
    return {
        "symbol": symbol.upper(),
        "trade_date": trade_date,
        "decision": decision,
        "final_state": _summarize_state(state),
    }


def _summarize_state(state: Dict[str, Any]) -> Dict[str, Any]:
    """Pick the human-readable fields out of the heavy LangGraph state blob."""
    if not isinstance(state, dict):
        return {}
    keys = (
        "market_report", "sentiment_report", "news_report", "fundamentals_report",
        "investment_debate_state", "trader_investment_plan",
        "risk_debate_state", "final_trade_decision",
    )
    return {k: state.get(k) for k in keys if state.get(k) is not None}


@router.post(
    "/analyze",
    summary="Run the multi-agent debate",
    description=(
        "Heavy multi-agent LangGraph debate (~30s + tokens) for one ``(symbol, trade_date)``. "
        "Results are cached for one hour so re-clicks are free. The response shape is dynamic — "
        "it includes the model's final decision plus a summarized state blob from each analyst."
    ),
    responses={
        200: {
            "content": {
                "application/json": {
                    "example": {
                        "cached": False,
                        "symbol": "TSLA",
                        "trade_date": "2026-05-23",
                        "decision": "BUY",
                        "final_state": {"market_report": "...", "final_trade_decision": "BUY"},
                    }
                }
            }
        },
        503: {"description": "tradingagents package not installed in this image."},
        500: {"description": "agent run raised."},
    },
)
async def analyze(req: AgentAnalyzeRequest) -> Dict[str, Any]:
    trade_date = req.trade_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cache_key = (req.symbol.upper(), trade_date)
    cached = _cache.get(cache_key)
    if cached is not None:
        return {"cached": True, **cached}

    try:
        result = await asyncio.to_thread(_run_graph_sync, req.symbol, trade_date)
    except ImportError as e:
        raise HTTPException(status_code=503, detail=f"tradingagents not installed: {e}")
    except Exception as e:
        logger.exception("agent run failed for %s on %s", req.symbol, trade_date)
        raise HTTPException(status_code=500, detail=f"agent run failed: {e}")

    _cache.set(cache_key, result)
    return {"cached": False, **result}


@router.get(
    "/status",
    response_model=AgentStatusResponse,
    summary="Agents capability probe",
    description=(
        "Is the tradingagents package importable, and which LLM keys are set in the env? "
        "Used by the dashboard to gate the agents tab."
    ),
)
def status() -> AgentStatusResponse:
    import os

    try:
        import tradingagents  # noqa: F401
        installed = True
    except ImportError:
        installed = False

    return AgentStatusResponse(
        installed=installed,
        has_openai_key=bool(os.environ.get("OPENAI_API_KEY")),
        has_anthropic_key=bool(os.environ.get("ANTHROPIC_API_KEY")),
        has_google_key=bool(os.environ.get("GOOGLE_API_KEY")),
    )
