"""Tool-use definitions for AI agents.

Returns the analyzer + related market endpoints described as
function/tool specs in both the Anthropic Messages API shape
(``input_schema``) and the OpenAI Chat Completions shape (``parameters``).
Drop the relevant list into your LLM call's ``tools`` argument and the
model can invoke our analytics natively.
"""
from typing import Any, Dict, List

from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/agents", tags=["agents"])


# Canonical tool definitions — JSON Schema bodies. The same schemas are
# reshaped per provider below; if you add a tool, add it once here.
_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "analyze_option",
        "description": (
            "Run the full single-option position analyzer. Returns Greeks, "
            "P/L profile (today/halfway/expiry curves), probability metrics "
            "(POP, P(ITM), P(touch)), expected move, IV vs realised vol, "
            "liquidity grade, decay-over-time profile, and a deterministic "
            "advice score with notes. Use this whenever the user wants a "
            "quantitative read on a specific contract they hold or are "
            "considering."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "symbol":      {"type": "string", "description": "Underlying ticker (e.g. SPY, RUT, USO)."},
                "strike":      {"type": "number", "description": "Strike price."},
                "expiry":      {"type": "string", "description": "Expiry as YYYYMMDD."},
                "right":       {"type": "string", "enum": ["C", "P"]},
                "quantity":    {"type": "integer", "description": "Signed contracts: positive = long, negative = short.", "default": 1},
                "entry_price": {"type": "number", "description": "Per-share cost basis. If omitted, current mid is used."},
            },
            "required": ["symbol", "strike", "expiry", "right"],
        },
        "endpoint": "GET /api/options/analyze/{symbol}?strike=…&expiry=…&right=…&quantity=…&entry_price=…",
    },
    {
        "name": "get_option_chain",
        "description": (
            "Fetch an option chain for a symbol. Without `expiration`, returns "
            "expirations + strikes only (cheap). With `expiration`, returns "
            "call/put rows with bid/ask/IV/Greeks/OI/volume for strikes around "
            "spot. Use first when the user asks 'what's available' before "
            "committing to a specific strike."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "symbol":     {"type": "string"},
                "expiration": {"type": "string", "description": "YYYYMMDD; omit for lightweight metadata only."},
            },
            "required": ["symbol"],
        },
        "endpoint": "GET /api/options/chain/{symbol}?expiration=YYYYMMDD",
    },
    {
        "name": "get_bars",
        "description": (
            "Historical OHLCV bars for an underlying. Use to derive trend, "
            "realized vol, or context for an options decision. Daily bars go "
            "back years; intraday timeframes are capped at ~60 days by IBKR."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "symbol":    {"type": "string"},
                "timeframe": {"type": "string", "enum": ["1m", "5m", "15m", "30m", "1h", "4h", "1d"], "default": "15m"},
                "days":      {"type": "integer", "minimum": 1, "maximum": 3650, "default": 30},
            },
            "required": ["symbol"],
        },
        "endpoint": "GET /api/market/bars/{symbol}?timeframe=…&days=…",
    },
    {
        "name": "get_volume_profile",
        "description": (
            "Volume-by-price histogram with POC + value area. Use to find "
            "support/resistance zones derived from where volume actually "
            "transacted, not chart-drawn lines."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "symbol":    {"type": "string"},
                "timeframe": {"type": "string", "default": "15m"},
                "days":      {"type": "integer", "minimum": 1, "maximum": 365, "default": 20},
                "bins":      {"type": "integer", "minimum": 10, "maximum": 120, "default": 40},
            },
            "required": ["symbol"],
        },
        "endpoint": "GET /api/market/volume-profile/{symbol}?timeframe=…&days=…&bins=…",
    },
    {
        "name": "get_depth_snapshot",
        "description": (
            "Level 2 market-depth snapshot — top-of-book bids/asks with "
            "displayed sizes. Returns `available: false` when the IBKR "
            "account lacks a depth subscription for this venue."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"},
                "rows":   {"type": "integer", "minimum": 1, "maximum": 20, "default": 10},
            },
            "required": ["symbol"],
        },
        "endpoint": "GET /api/depth/{symbol}?rows=…",
    },
    {
        "name": "get_recent_prints",
        "description": (
            "Time & sales — most recent prints with aggressor side (buy/sell/"
            "mid based on the contemporaneous bid/ask). Useful for confirming "
            "whether actual orders are hitting at the bid or lifting the ask."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"},
                "n":      {"type": "integer", "minimum": 1, "maximum": 500, "default": 100},
            },
            "required": ["symbol"],
        },
        "endpoint": "GET /api/ticks/{symbol}?n=…",
    },
]


def _to_anthropic(t: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "name": t["name"],
        "description": t["description"],
        "input_schema": t["schema"],
    }


def _to_openai(t: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": t["name"],
            "description": t["description"],
            "parameters": t["schema"],
        },
    }


@router.get("/tools")
def list_tools(
    provider: str = Query("anthropic", description="anthropic | openai | raw"),
):
    """Tool/function definitions for the analyzer + related market endpoints.

    Use ``provider=anthropic`` for Claude (Messages API ``tools`` arg),
    ``provider=openai`` for GPT (Chat Completions ``tools`` arg), or
    ``provider=raw`` for the canonical JSON Schemas + REST endpoints so
    you can adapt to any other framework.
    """
    if provider == "openai":
        return {"tools": [_to_openai(t) for t in _TOOLS]}
    if provider == "raw":
        return {"tools": _TOOLS}
    return {"tools": [_to_anthropic(t) for t in _TOOLS]}
