"""Multi-agent analyzer endpoint with SSE-streaming progress.

Inspired by the heavier tradingagents LangGraph pattern but lighter and
purpose-built for the options-analyzer page: four agents that each get a
focused prompt and a slice of the analyze payload, run concurrently, and
stream their results to the UI as they finish. Each run is persisted to
postgres so the user can replay any past analysis on the same contract.

Agents:
  - news       : pulls free RSS, summarizes the recent narrative
  - underlying : reads chart + indicators + forecast cone
  - option     : reads contract + IV/RV + greeks + liquidity
  - synthesis  : final coordinator — combines all three into a verdict

SSE event shape (one JSON object per `data:` line):
  {"event": "agent.start",    "agent": "news"}
  {"event": "agent.complete", "agent": "news",    "output": "...", "model": "..."}
  {"event": "agent.error",    "agent": "news",    "error": "..."}
  {"event": "run.complete",   "run_id": 123,      "duration_ms": 4172}
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..services import db
from ..services.news import fetch_news

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/options", tags=["analyzer"])

# Same fallback chain as llm_read. Free models on OpenRouter rotate
# monthly — refresh by querying /models with `:free` filter when 404s.
_PRIMARY_MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-oss-120b:free")
_FALLBACK_MODELS = [
    "openai/gpt-oss-120b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "z-ai/glm-4.5-air:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "openai/gpt-oss-20b:free",
]
_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


# ── Request schema (matches the existing llm_read payload + history) ──

class AgentRunRequest(BaseModel):
    """Comprehensive context payload — every analyzable signal we have on
    a position. Agents pull from this; fields are optional so partial
    payloads (older clients, IBKR gaps) still produce useful reads."""

    # ── identity ─────────────────────────────────────────────────────
    symbol: str
    strike: float
    expiry: str
    right: str
    quantity: int
    is_long: bool
    dte: int
    side: Optional[str] = None  # "long_call" | "short_put" | etc.

    # ── price + breakeven context ────────────────────────────────────
    spot: float
    breakeven: float
    distance_pct: float
    entry_price: float
    mid: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None
    last: Optional[float] = None

    # ── option fundamentals ──────────────────────────────────────────
    iv: float
    delta: Optional[float] = None
    gamma: Optional[float] = None
    theta: Optional[float] = None
    vega: Optional[float] = None

    # ── underlying daily indicators ──────────────────────────────────
    rsi: Optional[float] = None
    macd_hist: Optional[float] = None
    trend_score: Optional[float] = None
    ema9: Optional[float] = None
    ema21: Optional[float] = None
    ema50: Optional[float] = None
    ema200: Optional[float] = None

    # ── chart-TF indicators (what's on screen in the analyzer) ───────
    chart_tf: Optional[str] = None
    chart_tf_rsi: Optional[float] = None
    chart_tf_macd_hist: Optional[float] = None
    chart_tf_macd_hist_prev: Optional[float] = None
    chart_tf_smi: Optional[float] = None
    chart_tf_smi_signal: Optional[float] = None
    chart_tf_vwap: Optional[float] = None

    # ── vol context ──────────────────────────────────────────────────
    rv30: Optional[float] = None
    rv90: Optional[float] = None
    iv_to_rv_ratio: Optional[float] = None

    # ── liquidity ────────────────────────────────────────────────────
    spread: Optional[float] = None
    spread_pct: Optional[float] = None
    liquidity_grade: Optional[str] = None
    volume: Optional[int] = None
    open_interest: Optional[int] = None

    # ── probability + sigma ranges ───────────────────────────────────
    pop: Optional[float] = None
    prob_itm: Optional[float] = None
    expected_move_pct: Optional[float] = None
    expected_move_abs: Optional[float] = None
    sigma1_low: Optional[float] = None
    sigma1_high: Optional[float] = None
    sigma2_low: Optional[float] = None
    sigma2_high: Optional[float] = None

    # ── forecast ensemble ────────────────────────────────────────────
    forecast_5d_return_pct: Optional[float] = None
    forecast_5d_band_pct: Optional[float] = None
    forecast_agreement: Optional[float] = None
    forecast_members: Optional[Dict[str, Any]] = None  # per-model breakdown
    forecast_calibration_coverage: Optional[float] = None
    forecast_calibration_samples: Optional[int] = None
    forecast_horizons_other: Optional[Dict[str, Any]] = None  # 1d, 21d if present

    # ── multi-TF momentum snapshot ───────────────────────────────────
    multi_tf: Optional[Dict[str, Any]] = None
    recommended_chart_tf: Optional[str] = None

    # ── recent bars on the chart TF (last ~20 OHLCV) ─────────────────
    recent_bars: Optional[List[Dict[str, float]]] = None

    # ── P/L over time + risk bounds ──────────────────────────────────
    decay_profile: Optional[List[Dict[str, float]]] = None
    max_profit: Optional[float] = None
    max_loss: Optional[float] = None

    # ── advice + narrative the rule-based scorer already produced ────
    advice_label: Optional[str] = None
    advice_score: Optional[float] = None
    advice_notes: List[str] = Field(default_factory=list)
    narrative: Optional[str] = None


# ── OpenRouter call (shared with llm_read; copy kept here so this
#    router has no cross-module coupling and can ship standalone) ──

# Per-call HTTP timeout. Tight so a single dead model doesn't burn a
# minute of pipeline wall-clock while the user stares at a spinner.
_PER_CALL_TIMEOUT_S = 35
# Hard ceiling per agent (across all fallback attempts). If we can't
# get an answer in 75s, bail and surface "agent timed out" — the
# pipeline progresses with the remaining agents.
_PER_AGENT_TIMEOUT_S = 75


async def _call_openrouter(prompt: str, system: str) -> tuple[str, str]:
    """Returns (output_text, model_used). Walks the free-model fallback
    chain on rate-limit / 404 / 400 / 402 / 503. Capped at 3 attempts
    so one slow OpenRouter region can't lock up the whole pipeline."""
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(503, "OPENROUTER_API_KEY not set")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://localhost:3000/monitor/analyzer",
        "X-Title": "Trading Dashboard Multi-Agent Analyzer",
    }
    chain = ([_PRIMARY_MODEL] + [m for m in _FALLBACK_MODELS if m != _PRIMARY_MODEL])[:3]
    last_err: Optional[str] = None
    for model in chain:
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.4,
        }
        try:
            async with httpx.AsyncClient(timeout=_PER_CALL_TIMEOUT_S) as client:
                resp = await client.post(_OPENROUTER_URL, headers=headers, json=body)
            if resp.status_code == 200:
                content = resp.json()["choices"][0]["message"]["content"]
                return content.strip(), model
            if resp.status_code in (429, 402, 503, 404, 400):
                last_err = f"{model}: {resp.status_code}"
                logger.warning("openrouter %s on %s, trying next", resp.status_code, model)
                continue
            raise HTTPException(resp.status_code, resp.text[:200])
        except (httpx.TimeoutException, httpx.HTTPError) as e:
            last_err = f"{model}: {type(e).__name__}"
            logger.warning("openrouter %s on %s — %s, trying next", type(e).__name__, model, e)
            continue
    raise HTTPException(503, f"all free models exhausted: {last_err}")


# ── Per-agent prompts ─────────────────────────────────────────────────

_SYSTEM_BASE = (
    "You are a senior options trader giving a balanced read to a teammate. "
    "Tight, opinionated, specific numbers. Call it as the data sees it — "
    "if the setup is working, say so plainly; if it's broken, say so plainly. "
    "Do NOT default to caution or hedge every statement with a risk caveat. "
    "Options are risky by nature; that's already priced into the trader's "
    "decision to hold the position. Your job is to read THIS contract, THIS "
    "tape — not lecture on options in general. No filler, no 'as an AI', no "
    "boilerplate disclaimers."
)


def _fmt(v, fmt: str = ".2f", default: str = "—") -> str:
    if v is None or not isinstance(v, (int, float)) or v != v:  # NaN check
        return default
    return f"{v:{fmt}}"


def _payload_summary(r: AgentRunRequest) -> str:
    """Full structured briefing for every agent. Each agent picks what
    it cares about; including more context in every prompt gives the
    model freedom to make cross-section observations (e.g. underlying
    analyst flagging an EMA50 inversion that's relevant beyond just
    trend). Format is human-readable + line-oriented so models hold
    fields steady. ~600-1000 tokens depending on filled fields."""
    pos = "long" if r.is_long else "short"
    side = r.side or f"{'long' if r.is_long else 'short'}_{('call' if r.right == 'C' else 'put')}"

    lines: List[str] = []
    lines.append(
        f"POSITION: {pos} {r.quantity}× {r.symbol} {r.strike}{r.right} exp {r.expiry} "
        f"({r.dte}d to expiry, side={side})"
    )
    lines.append(
        f"  entry ${_fmt(r.entry_price)}  mid ${_fmt(r.mid)}  "
        f"bid/ask ${_fmt(r.bid)} / ${_fmt(r.ask)}  last ${_fmt(r.last)}"
    )
    lines.append(
        f"SPOT: ${_fmt(r.spot)}  Δ-from-K {_fmt(r.distance_pct, '+.2f')}%  BE ${_fmt(r.breakeven)}"
    )
    lines.append(
        f"IV: {(r.iv or 0)*100:.1f}%  RV30: {(r.rv30 or 0)*100:.1f}%  RV90: {(r.rv90 or 0)*100:.1f}%  "
        f"IV/RV30: {_fmt(r.iv_to_rv_ratio)}×"
    )
    lines.append(
        f"GREEKS (per contract): Δ {_fmt(r.delta, '+.3f')}  Γ {_fmt(r.gamma, '+.4f')}  "
        f"Θ {_fmt(r.theta, '+.3f')}/day  ν {_fmt(r.vega, '+.3f')}"
    )
    if any(v is not None for v in (r.delta, r.gamma, r.theta, r.vega)):
        # Position-level exposures derived from per-contract greeks.
        q_signed = r.quantity * (1 if r.is_long else -1)
        d_dollar = (r.delta or 0) * q_signed * 100
        t_dollar = (r.theta or 0) * q_signed * 100
        v_dollar = (r.vega or 0) * q_signed * 100
        lines.append(
            f"POSITION EXPOSURE: Δ-$ {d_dollar:+.0f}/pt  Θ-$ {t_dollar:+.0f}/day  "
            f"ν-$ {v_dollar:+.0f}/IV-pt"
        )

    lines.append(
        f"DAILY INDICATORS: RSI {_fmt(r.rsi, '.0f')}  MACD-hist {_fmt(r.macd_hist, '+.3f')}  "
        f"trend {_fmt(r.trend_score, '+.0f')}"
    )
    lines.append(
        f"  EMAs 9/21/50/200: {_fmt(r.ema9)} / {_fmt(r.ema21)} / {_fmt(r.ema50)} / {_fmt(r.ema200)}"
    )
    if r.chart_tf is not None:
        lines.append(
            f"CHART-TF ({r.chart_tf}): RSI {_fmt(r.chart_tf_rsi, '.0f')}  "
            f"MACD-hist {_fmt(r.chart_tf_macd_hist, '+.3f')} (prev {_fmt(r.chart_tf_macd_hist_prev, '+.3f')})  "
            f"SMI {_fmt(r.chart_tf_smi, '.0f')}/{_fmt(r.chart_tf_smi_signal, '.0f')}  "
            f"VWAP {_fmt(r.chart_tf_vwap)}"
        )

    if r.multi_tf:
        # Compact per-TF trend table — surfaces multi-TF alignment at
        # a glance, which is the single highest-signal cross-TF read.
        tf_strs = []
        for tf, snap in r.multi_tf.items():
            if not snap or not snap.get("available"):
                continue
            trend = snap.get("trend") or "?"
            rsi_v = snap.get("rsi")
            tf_strs.append(f"{tf}={trend}/RSI{_fmt(rsi_v, '.0f')}")
        if tf_strs:
            lines.append(f"MULTI-TF: {'  '.join(tf_strs)}")
        if r.recommended_chart_tf:
            lines.append(f"  recommended chart TF for this DTE: {r.recommended_chart_tf}")

    lines.append(
        f"PROBABILITY: POP {_fmt((r.pop or 0)*100, '.0f')}%  P(ITM) {_fmt((r.prob_itm or 0)*100, '.0f')}%  "
        f"±1σ {_fmt(r.expected_move_pct, '+.1f')}% (≈±${_fmt(r.expected_move_abs)})"
    )
    if r.sigma1_low is not None and r.sigma1_high is not None:
        lines.append(
            f"  ±1σ range: ${_fmt(r.sigma1_low)} – ${_fmt(r.sigma1_high)}; "
            f"±2σ: ${_fmt(r.sigma2_low)} – ${_fmt(r.sigma2_high)}"
        )

    lines.append(
        f"FORECAST 5d: median {_fmt(r.forecast_5d_return_pct, '+.1f')}%  "
        f"band ±{_fmt(r.forecast_5d_band_pct)}%  "
        f"agreement {(r.forecast_agreement or 0)*100:.0f}%"
    )
    if r.forecast_calibration_coverage is not None:
        lines.append(
            f"  calibration: {r.forecast_calibration_coverage*100:.0f}% past-coverage "
            f"({r.forecast_calibration_samples or 0} samples — 80% target)"
        )
    if r.forecast_members:
        # Per-model bullets — gives the agent the disagreement texture
        # behind the headline agreement number.
        member_lines: List[str] = []
        for name, member in (r.forecast_members or {}).items():
            h = (member.get("horizons", {}) or {}).get("5") if isinstance(member, dict) else None
            if not h:
                continue
            er = h.get("expected_return_pct")
            band = h.get("band_pct")
            member_lines.append(f"{name}={_fmt(er, '+.1f')}% ±{_fmt(band)}%")
        if member_lines:
            lines.append("  members: " + "  ".join(member_lines))

    lines.append(
        f"LIQUIDITY: {r.liquidity_grade or '?'}  spread ${_fmt(r.spread)} ({(r.spread_pct or 0)*100:.1f}%)  "
        f"volume {r.volume or 0}  OI {r.open_interest or 0}"
    )

    if r.recent_bars:
        lines.append(f"RECENT PRICE ACTION ({len(r.recent_bars)} bars on chart TF):")
        # Sample first/middle/last to keep prompt size in check.
        sample_idx = sorted(set([
            0, len(r.recent_bars) // 4, len(r.recent_bars) // 2,
            3 * len(r.recent_bars) // 4, len(r.recent_bars) - 1,
        ]))
        for i in sample_idx:
            b = r.recent_bars[i]
            lines.append(
                f"  bar -{len(r.recent_bars)-1-i}: O {_fmt(b.get('o'))} H {_fmt(b.get('h'))} "
                f"L {_fmt(b.get('l'))} C {_fmt(b.get('c'))} V {_fmt(b.get('v'), '.0f')}"
            )

    lines.append(
        f"ADVICE (rule-based): {r.advice_label or '?'} ({_fmt(r.advice_score, '+.0f')})"
    )
    if r.advice_notes:
        for note in r.advice_notes:
            lines.append(f"  - {note}")
    if r.narrative:
        lines.append(f"NARRATIVE (rule-based): {r.narrative}")

    return "\n".join(lines)


def _news_prompt(news_items: list, r: AgentRunRequest) -> str:
    if not news_items:
        return (
            f"Symbol: {r.symbol}\n\n"
            "No live news feed available for this ticker right now (Yahoo + Google News RSS both returned empty). "
            "In one sentence say so — don't fabricate headlines. Then in one more sentence flag whether the absence "
            "of news is itself noteworthy (e.g. expected earnings/event window vs quiet period)."
        )
    bullet_news = "\n".join(
        f"  • {item['title']} — {item['source']} ({item['published']})"
        for item in news_items
    )
    return (
        f"Symbol: {r.symbol}\n\n"
        f"Recent headlines:\n{bullet_news}\n\n"
        "Summarize in 2-3 sentences: what's the current narrative around this ticker, and is it "
        "consistent with the position thesis (a long put benefits from down-narrative, a long call from up-narrative)?"
    )


def _underlying_prompt(r: AgentRunRequest) -> str:
    return (
        _payload_summary(r) +
        "\nRead the UNDERLYING in 2-3 sentences. Lead with the direction the tape "
        "is actually pointing — bullish, bearish, or chopping — using RSI, the "
        "EMA stack, and the 5d forecast. If the read is constructive for this "
        "position, say so without softening it. If it's against the position, "
        "say so without piling on caveats. Mention forecast agreement only if "
        "it's <60% (low conviction is worth flagging)."
    )


def _option_prompt(r: AgentRunRequest) -> str:
    return (
        _payload_summary(r) +
        "\nRead the OPTION CONTRACT in 2-3 sentences. Three things, in order: "
        "(1) is IV rich, fair, or cheap vs RV30 — give the ratio; (2) is the "
        "DTE in a comfortable phase or a danger phase (gamma/theta accelerates "
        "in the last ~21d, theta is a tailwind for shorts, drag for longs); "
        "(3) can the trader exit cleanly given the spread and liquidity grade. "
        "Don't lecture on what 'options can do' in general — read THIS contract."
    )


def _decay_prompt(r: AgentRunRequest) -> str:
    """Decay analyst — reads the P/L-over-time profile + theta path
    and projects what time alone does to the position. Different from
    the option analyst (which is about NOW); this one is about the
    *trajectory* assuming nothing else changes."""
    if not r.decay_profile:
        return (
            _payload_summary(r) +
            "\nNo decay profile data available. In one sentence, given the theta "
            f"({r.theta or 0:+.4f}/contract/day) and DTE ({r.dte}), what's the rough P/L drag "
            "if spot stays exactly here?"
        )
    # Compact the decay table — sample 4-5 dates so the prompt isn't huge.
    points = r.decay_profile
    sample_indices = [0]
    if len(points) >= 4:
        sample_indices.extend([len(points) // 4, len(points) // 2, 3 * len(points) // 4])
    sample_indices.append(len(points) - 1)
    sample_indices = sorted(set(sample_indices))
    table_rows = []
    for i in sample_indices:
        p = points[i]
        days = int(p.get("days_remaining", 0))
        elapsed = r.dte - days if r.dte > days else 0
        table_rows.append(
            f"  +{elapsed:>3}d ({days:>3}d to expiry):  "
            f"flat ${p.get('pnl_flat', 0):>+8.0f}  "
            f"+1σ ${p.get('pnl_up_1s', 0):>+8.0f}  "
            f"−1σ ${p.get('pnl_dn_1s', 0):>+8.0f}"
        )
    table = "P/L PROJECTION OVER TIME (flat spot / spot +1σ / spot −1σ):\n" + "\n".join(table_rows)
    return (
        _payload_summary(r) +
        "\n" + table +
        "\n\nRead the DECAY in 2-3 sentences. State plainly: if spot stays here, "
        "where does the position sit in N days (use a specific row from the "
        "table above)? Then — for a LONG position, does the +1σ track give it "
        "a real shot at profit before theta eats it, or is the math against "
        "the trade? For a SHORT position, is theta steadily building credit, "
        "or does the −1σ track threaten the max-loss boundary? Don't assume "
        "the position is in trouble — let the numbers say."
    )


def _synthesis_prompt(
    r: AgentRunRequest,
    news_text: str,
    underlying_text: str,
    option_text: str,
    decay_text: str,
) -> str:
    return (
        _payload_summary(r) +
        "\n\nNEWS READ:\n" + news_text +
        "\n\nUNDERLYING READ:\n" + underlying_text +
        "\n\nOPTION READ:\n" + option_text +
        "\n\nDECAY READ:\n" + decay_text +
        "\n\nBased on all FOUR reads above, give the FINAL POSITION CALL. "
        "Lead with the verdict, then justify it with the strongest one-or-two "
        "things working FOR the trade and the strongest one-or-two things "
        "working AGAINST it — weighted by what the data actually shows. If "
        "the data is constructive, the verdict is constructive; if it's "
        "broken, say close. Don't default to caution because 'options are "
        "risky' — that's already a known.\n\n"
        "Format (Markdown, in this exact order):\n"
        "**Verdict:** one of `Add` / `Hold` / `Trim` / `Close` / `Hedge` — "
        "then one sentence saying why in plain English.\n"
        "**Working for it:** 1–2 bullets, each citing a specific number "
        "(e.g. 'POP 64%', 'forecast +2.3% 5d at 78% agreement', 'IV 22% vs "
        "RV30 31% — paying cheaply for the move').\n"
        "**Working against it:** 1–2 bullets, same standard — specific "
        "numbers, no boilerplate. If nothing material is against the trade, "
        "say so explicitly rather than inventing a risk.\n"
        "**Trigger:** one concrete price/level/time to revisit "
        "(e.g. 'close at $0.80 mid', 'cut if spot < $X', 'reassess in 5 trading days').\n"
        "Use specific numbers from the payload. No filler, no generic options-risk disclaimers."
    )


# ── Agent runner ─────────────────────────────────────────────────────

def _sse(event: str, **payload) -> str:
    return f"data: {json.dumps({'event': event, **payload})}\n\n"


async def _run_pipeline(r: AgentRunRequest) -> AsyncIterator[str]:
    """Async generator yielding SSE events. Runs news/underlying/option
    in parallel (they're independent), then synthesis sequentially after
    all three finish (it depends on their outputs)."""
    started_at = time.monotonic()

    # ── news + underlying + option + decay in parallel ────────────────
    yield _sse("agent.start", agent="news")
    yield _sse("agent.start", agent="underlying")
    yield _sse("agent.start", agent="option")
    yield _sse("agent.start", agent="decay")

    async def news_task() -> tuple[str, str, list]:
        # News RSS fetch is bounded by its own httpx timeout (12s); the
        # outer wait_for guards against everything afterward.
        items = await fetch_news(r.symbol)
        prompt = _news_prompt(items, r)
        text, model = await _call_openrouter(prompt, _SYSTEM_BASE)
        return text, model, items

    async def underlying_task() -> tuple[str, str]:
        return await _call_openrouter(_underlying_prompt(r), _SYSTEM_BASE)

    async def option_task() -> tuple[str, str]:
        return await _call_openrouter(_option_prompt(r), _SYSTEM_BASE)

    async def decay_task() -> tuple[str, str]:
        return await _call_openrouter(_decay_prompt(r), _SYSTEM_BASE)

    results: Dict[str, Dict[str, Any]] = {}

    # Wrap each task in wait_for so one dead model can't block the
    # whole pipeline indefinitely. Agents that time out emit
    # agent.error and the rest carry on.
    async def with_timeout(name: str, coro):
        try:
            return name, await asyncio.wait_for(coro, timeout=_PER_AGENT_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise HTTPException(504, f"{name} agent exceeded {_PER_AGENT_TIMEOUT_S}s")

    coros = {
        "news": news_task(),
        "underlying": underlying_task(),
        "option": option_task(),
        "decay": decay_task(),
    }
    tasks = {asyncio.create_task(with_timeout(n, c)): n for n, c in coros.items()}
    pending = set(tasks.keys())

    parallel_started_at = time.monotonic()
    while pending:
        # Short wait so we can interleave heartbeat ticks. Each tick is
        # an SSE event the proxy and client both see — keeps the
        # connection alive and lets the UI show "still running, Xs in".
        done, pending = await asyncio.wait(
            pending, timeout=4.0, return_when=asyncio.FIRST_COMPLETED,
        )
        if not done:
            # Heartbeat for every still-running agent.
            elapsed = int(time.monotonic() - parallel_started_at)
            running_names = [tasks[t] for t in pending]
            yield _sse(
                "heartbeat",
                phase="parallel",
                elapsed_s=elapsed,
                running=running_names,
            )
            continue
        for t in done:
            name = tasks[t]
            try:
                _name, res = t.result()
                if name == "news":
                    text, model, news_items = res  # type: ignore[misc]
                    results["news"] = {
                        "output": text, "model": model,
                        "headlines": news_items,
                    }
                else:
                    text, model = res  # type: ignore[misc]
                    results[name] = {"output": text, "model": model}
                yield _sse("agent.complete", agent=name, **results[name])
            except Exception as e:  # noqa: BLE001
                logger.exception("agent %s failed", name)
                results[name] = {"error": str(e)}
                yield _sse("agent.error", agent=name, error=str(e))

    # ── synthesis: depends on all four above ─────────────────────────
    yield _sse("agent.start", agent="synthesis")
    try:
        synthesis_text, syn_model = await asyncio.wait_for(
            _call_openrouter(
                _synthesis_prompt(
                    r,
                    results.get("news", {}).get("output", "(news agent failed)"),
                    results.get("underlying", {}).get("output", "(underlying agent failed)"),
                    results.get("option", {}).get("output", "(option agent failed)"),
                    results.get("decay", {}).get("output", "(decay agent failed)"),
                ),
                _SYSTEM_BASE,
            ),
            timeout=_PER_AGENT_TIMEOUT_S,
        )
        results["synthesis"] = {"output": synthesis_text, "model": syn_model}
        yield _sse("agent.complete", agent="synthesis", output=synthesis_text, model=syn_model)
    except Exception as e:  # noqa: BLE001
        logger.exception("synthesis agent failed")
        results["synthesis"] = {"error": str(e)}
        yield _sse("agent.error", agent="synthesis", error=str(e))

    duration_ms = int((time.monotonic() - started_at) * 1000)

    # ── persist to postgres (best-effort; never fail the request) ─────
    run_id = await _persist_run(r, results, duration_ms)

    yield _sse("run.complete", run_id=run_id, duration_ms=duration_ms)


async def _persist_run(
    r: "AgentRunRequest", results: Dict[str, Any], duration_ms: int
) -> Optional[int]:
    """Insert one multi-agent run into ``ai_runs``. Best-effort — never
    raises, so a DB hiccup can't fail the analysis. Shared by the SSE
    pipeline and the headless (scheduled) runner."""
    pool = db.pool()
    if pool is None:
        return None
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO ai_runs
                  (symbol, strike, expiry, right_, quantity, is_long,
                   spot_at_run, mid_at_run, agents, duration_ms)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
                RETURNING id
                """,
                r.symbol, r.strike, r.expiry, r.right, r.quantity, r.is_long,
                r.spot, r.mid, json.dumps(results), duration_ms,
            )
            return int(row["id"])
    except Exception as e:  # noqa: BLE001
        logger.warning("ai_runs insert failed: %s", e)
        return None


async def run_and_store(r: "AgentRunRequest") -> Optional[int]:
    """Run the four analyst agents + synthesis headlessly (no SSE) and
    persist the result. Used by the scheduled position-analysis job so the
    Insights timeline fills itself without anyone clicking. Returns run_id.

    Mirrors ``_run_pipeline`` but collects results instead of streaming
    them. Each agent is independently guarded so one dead model can't sink
    the whole run; the synthesis still proceeds with placeholders."""
    started_at = time.monotonic()
    results: Dict[str, Dict[str, Any]] = {}

    async def guarded(name: str, coro):
        try:
            return name, await asyncio.wait_for(coro, timeout=_PER_AGENT_TIMEOUT_S)
        except Exception as e:  # noqa: BLE001
            logger.warning("headless agent %s failed: %s", name, e)
            return name, e

    async def news_coro():
        items = await fetch_news(r.symbol)
        text, model = await _call_openrouter(_news_prompt(items, r), _SYSTEM_BASE)
        return text, model, items

    pairs = await asyncio.gather(
        guarded("news", news_coro()),
        guarded("underlying", _call_openrouter(_underlying_prompt(r), _SYSTEM_BASE)),
        guarded("option", _call_openrouter(_option_prompt(r), _SYSTEM_BASE)),
        guarded("decay", _call_openrouter(_decay_prompt(r), _SYSTEM_BASE)),
    )
    for name, res in pairs:
        if isinstance(res, Exception):
            results[name] = {"error": str(res)}
        elif name == "news":
            text, model, items = res
            results["news"] = {"output": text, "model": model, "headlines": items}
        else:
            text, model = res
            results[name] = {"output": text, "model": model}

    try:
        synthesis_text, syn_model = await asyncio.wait_for(
            _call_openrouter(
                _synthesis_prompt(
                    r,
                    results.get("news", {}).get("output", "(news agent failed)"),
                    results.get("underlying", {}).get("output", "(underlying agent failed)"),
                    results.get("option", {}).get("output", "(option agent failed)"),
                    results.get("decay", {}).get("output", "(decay agent failed)"),
                ),
                _SYSTEM_BASE,
            ),
            timeout=_PER_AGENT_TIMEOUT_S,
        )
        results["synthesis"] = {"output": synthesis_text, "model": syn_model}
    except Exception as e:  # noqa: BLE001
        results["synthesis"] = {"error": str(e)}

    duration_ms = int((time.monotonic() - started_at) * 1000)
    return await _persist_run(r, results, duration_ms)


@router.post("/agent-run")
async def agent_run(req: AgentRunRequest) -> StreamingResponse:
    """SSE-stream the four-agent pipeline. The frontend consumes via
    fetch + ReadableStream (EventSource doesn't support POST)."""
    return StreamingResponse(
        _run_pipeline(req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # nginx / Next.js proxy: don't buffer
        },
    )


# ── History: list recent runs on a contract ──────────────────────────

class AgentRunRow(BaseModel):
    id: int
    ran_at: str
    symbol: str
    strike: float
    expiry: str
    right: str
    quantity: int
    is_long: bool
    duration_ms: Optional[int]
    agents: Dict[str, Any]


@router.get("/agent-runs", response_model=List[AgentRunRow])
async def list_runs(
    symbol: str,
    strike: float,
    expiry: str,
    right: str,
    limit: int = 10,
) -> List[AgentRunRow]:
    """Past AI runs on this specific contract, newest first. The UI
    surfaces them so the user can read "what did I think 3 days ago?"
    without re-spending tokens."""
    pool = db.pool()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, ran_at, symbol, strike, expiry, right_ AS right,
                   quantity, is_long, duration_ms, agents
            FROM ai_runs
            WHERE symbol = $1
              AND strike = $2
              AND expiry = $3
              AND right_ = $4
            ORDER BY ran_at DESC
            LIMIT $5
            """,
            symbol.upper(), strike, expiry, right.upper(), limit,
        )
    out: List[AgentRunRow] = []
    for row in rows:
        out.append(AgentRunRow(
            id=int(row["id"]),
            ran_at=row["ran_at"].isoformat(),
            symbol=row["symbol"],
            strike=float(row["strike"]),
            expiry=row["expiry"],
            right=row["right"],
            quantity=int(row["quantity"]),
            is_long=bool(row["is_long"]),
            duration_ms=row["duration_ms"],
            agents=json.loads(row["agents"]) if isinstance(row["agents"], str) else row["agents"],
        ))
    return out


def _extract_verdict(agents: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """Pull a compact verdict + one-line rationale out of the synthesis
    agent's markdown so the cross-contract timeline can render a glanceable
    card without re-reading the whole run."""
    syn = agents.get("synthesis") or {}
    text = syn.get("output") or ""
    verdict: Optional[str] = None
    rationale: Optional[str] = None
    if text:
        import re

        m = re.search(r"\*\*Verdict:\*\*\s*(.+?)(?:\n|$)", text)
        if m:
            line = m.group(1).strip()
            # First sentence becomes the verdict label; the rest the rationale.
            parts = re.split(r"(?<=[.!?])\s+", line, maxsplit=1)
            verdict = parts[0].strip(" .—-")
            rationale = parts[1].strip() if len(parts) > 1 else None
        elif text.strip():
            verdict = text.strip().split("\n", 1)[0][:80]
    failed = sum(1 for v in agents.values() if isinstance(v, dict) and v.get("error"))
    return {"verdict": verdict, "rationale": rationale, "failed_agents": failed}


class RecentRunRow(BaseModel):
    id: int
    ran_at: str
    symbol: str
    strike: float
    expiry: str
    right: str
    quantity: int
    is_long: bool
    spot_at_run: Optional[float] = None
    mid_at_run: Optional[float] = None
    duration_ms: Optional[int] = None
    verdict: Optional[str] = None
    rationale: Optional[str] = None
    failed_agents: int = 0


@router.get("/agent-runs/recent", response_model=List[RecentRunRow])
async def recent_runs(
    symbol: Optional[str] = None,
    limit: int = 40,
) -> List[RecentRunRow]:
    """Recent AI analyzer runs across ALL contracts, newest first. Powers the
    Insights timeline — a portfolio-wide log of "what the agents concluded,
    and when", instead of the per-contract history. Optionally filter by
    symbol."""
    pool = db.pool()
    if pool is None:
        return []
    limit = max(1, min(limit, 200))
    where = ""
    args: List[Any] = []
    if symbol:
        where = "WHERE symbol = $1"
        args.append(symbol.upper())
    args.append(limit)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, ran_at, symbol, strike, expiry, right_ AS right,
                   quantity, is_long, spot_at_run, mid_at_run, duration_ms, agents
            FROM ai_runs
            {where}
            ORDER BY ran_at DESC
            LIMIT ${len(args)}
            """,
            *args,
        )
    out: List[RecentRunRow] = []
    for row in rows:
        agents = json.loads(row["agents"]) if isinstance(row["agents"], str) else (row["agents"] or {})
        v = _extract_verdict(agents)
        out.append(RecentRunRow(
            id=int(row["id"]),
            ran_at=row["ran_at"].isoformat(),
            symbol=row["symbol"],
            strike=float(row["strike"]),
            expiry=row["expiry"],
            right=row["right"],
            quantity=int(row["quantity"]),
            is_long=bool(row["is_long"]),
            spot_at_run=float(row["spot_at_run"]) if row["spot_at_run"] is not None else None,
            mid_at_run=float(row["mid_at_run"]) if row["mid_at_run"] is not None else None,
            duration_ms=row["duration_ms"],
            verdict=v["verdict"],
            rationale=v["rationale"],
            failed_agents=v["failed_agents"] or 0,
        ))
    return out
