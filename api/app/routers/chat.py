"""
AI chat side panel powered by Claude.

Streams responses via SSE. Uses adaptive thinking (Opus 4.7) and prompt
caching: the system prompt + slowly-changing app context are cached, while
the user's question and any per-request snapshot ride after the cache
breakpoint.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    context: Optional[Dict[str, Any]] = None  # current page, last backtest, params, positions
    effort: Optional[str] = "high"  # low | medium | high | xhigh | max


SYSTEM_PROMPT = """\
You are the AI co-pilot embedded in a trading dashboard. The user is a quantitative trader iterating on strategies, backtests, and live IBKR positions.

# Voice
- Terse. Numbers over adjectives. No filler ("Great question!", "Certainly!").
- Bullets over paragraphs. Default to ≤4 bullets unless the user asks for depth.
- If ambiguous, ask one focused question. Don't bury it.

# When proposing parameter changes
If you want to suggest a concrete parameter tweak the user can apply, emit a fenced `params` block alongside your explanation. The UI parses this and renders an "Apply" preview card.

Exact format:
```params
{
  "strategy": "smi-short",
  "params": { "smi_period": 21, "smooth1": 30 },
  "rationale": "Raise lookback to reduce whipsaws on 4h timeframe."
}
```
- `strategy` must be a valid id (`smi-short`, `smi-mid`, `ema-cross`, `bull-put-spy`, `bull-put-rut`).
- `params` are only the fields you are changing (not the full config). Use field names from the strategy schema (e.g. `smi_period`, `smooth1`, `smooth2`, `signal`, `ema_fast`, `ema_slow`, `smi_overbought`, `smi_oversold`).
- `rationale` is one short sentence explaining the tradeoff.
- Suggest at most TWO param changes per turn — quality over coverage.
- Don't emit a params block if the user is just asking for explanation.

# Strategy domain knowledge
SMI = Stochastic Momentum Index. Crossover above signal line from < 0 is a buy; below from > 0 is a sell.
- Higher `smi_period` → smoother, fewer signals, less whipsaw, more lag.
- Higher `smooth1`/`smooth2` → less noise, more lag.
- Lower `signal` EMA → faster crossovers, more entries.
- Tighter `smi_overbought` / `smi_oversold` (closer to 0) → more frequent entries.
- `ema_fast > ema_slow` is the trend filter on buys. Widening the gap suppresses chop.

# Output style
- Plain text math (`Sharpe=1.4`, `drawdown=8%`), no LaTeX.
- Backticks for params (`smi_period=21`). No markdown tables unless asked.
- Do not place orders. Direct the user: Strategies → Edit params, BacktestPanel → Run backtest, /chart/SPY → BPS overlay.
"""


@router.get("/status")
def chat_status():
    """Lightweight health for the chat feature."""
    return {
        "available": bool(settings.anthropic_api_key),
        "model": settings.chat_model,
    }


@router.post("")
async def chat(req: ChatRequest):
    if not settings.anthropic_api_key:
        raise HTTPException(
            status_code=503,
            detail="ANTHROPIC_API_KEY not set — add it to .env and restart the api container.",
        )
    try:
        from anthropic import AsyncAnthropic
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"anthropic SDK not installed: {e}")

    client = AsyncAnthropic(api_key=settings.anthropic_api_key)

    # Build cached context block. Put stable bits before volatile ones so cache
    # reuses across turns. Render `context` deterministically with sorted keys.
    context = req.context or {}
    context_json = json.dumps(context, sort_keys=True, indent=2) if context else "(no context)"

    system_blocks = [
        {"type": "text", "text": SYSTEM_PROMPT},
        {
            "type": "text",
            "text": f"# Current app context\n```json\n{context_json}\n```",
            "cache_control": {"type": "ephemeral"},
        },
    ]

    api_messages = [{"role": m.role, "content": m.content} for m in req.messages]

    async def event_stream():
        try:
            async with client.messages.stream(
                model=settings.chat_model,
                max_tokens=8000,
                system=system_blocks,
                messages=api_messages,
                thinking={"type": "adaptive"},
                output_config={"effort": req.effort or "high"},
            ) as stream:
                async for text in stream.text_stream:
                    yield f"data: {json.dumps({'type': 'delta', 'text': text})}\n\n"

                final = await stream.get_final_message()
                usage = {
                    "input_tokens": final.usage.input_tokens,
                    "output_tokens": final.usage.output_tokens,
                    "cache_read_input_tokens": getattr(final.usage, "cache_read_input_tokens", 0),
                    "cache_creation_input_tokens": getattr(
                        final.usage, "cache_creation_input_tokens", 0
                    ),
                }
                yield f"data: {json.dumps({'type': 'done', 'usage': usage})}\n\n"
        except Exception as e:  # noqa: BLE001
            logger.exception("chat stream error")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
