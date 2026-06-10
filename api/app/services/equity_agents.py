"""Multi-agent equity research engine (TradingAgents-style).

A run flows through four phases, mirroring the Tauric Research
TradingAgents architecture but built directly on the Anthropic SDK:

  1. Analyst team   — selectable specialists (market / fundamentals /
                      news / sentiment / on-chain) run **concurrently**
                      and stream their reads.
  2. Researcher team — bull vs bear debate over the analyst reports,
                      N rounds depending on depth.
  3. Trader + risk  — a trader proposes the trade; on deep runs a risk
                      manager stress-tests it.
  4. Portfolio manager — final structured decision (strict JSON via
                      output_config) the UI renders as a decision card.

Cost levers:
  * every call in a run shares the same system prefix (persona + market
    briefing) with cache_control breakpoints, so calls after the first
    read the prompt cache;
  * all calls stream (SDK timeout protection) and use adaptive thinking.

The engine yields plain dict events; the router serializes them to SSE.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator, Dict, List, Optional

import anthropic

from ..config import settings
from .equity_data import MarketSnapshot, build_briefing

logger = logging.getLogger(__name__)

_AGENT_TIMEOUT_S = 180

# ── catalog ──────────────────────────────────────────────────────────

ANALYSTS: Dict[str, Dict[str, Any]] = {
    "market": {
        "label": "Market Analyst",
        "desc": "Price structure, trend, momentum — RSI, MACD, moving-average stack.",
        "asset_classes": ["stock", "etf", "crypto"],
        "instruction": (
            "You are the MARKET ANALYST. Read the technicals in the briefing: trend "
            "direction from the SMA stack, momentum from RSI/MACD, where price sits in "
            "its 52-week range, and what the recent close structure says. 3-5 sentences, "
            "specific numbers, end with a one-line technical stance: bullish / bearish / neutral."
        ),
    },
    "fundamentals": {
        "label": "Fundamentals Analyst",
        "desc": "Business quality, valuation context, macro positioning for the asset.",
        "asset_classes": ["stock", "etf"],
        "instruction": (
            "You are the FUNDAMENTALS ANALYST. Using your knowledge of this company/fund "
            "(business model, competitive position, earnings trajectory, valuation regime) "
            "plus the price/volatility context in the briefing, assess whether the asset's "
            "fundamental story supports owning it here. Flag anything from the headlines "
            "that changes the thesis. Be explicit about what you know vs. what is dated "
            "given your knowledge cutoff. 3-5 sentences, end with a fundamental stance."
        ),
    },
    "news": {
        "label": "News Analyst",
        "desc": "Recent headlines, catalysts, and the prevailing narrative.",
        "asset_classes": ["stock", "etf", "crypto"],
        "instruction": (
            "You are the NEWS ANALYST. Read the headlines in the briefing. What is the "
            "current narrative, what catalysts are live, and does news flow support upside "
            "or downside from here? If there are no headlines, say so plainly and note "
            "whether silence is itself informative. Never invent headlines. 3-4 sentences, "
            "end with a narrative stance."
        ),
    },
    "sentiment": {
        "label": "Sentiment Analyst",
        "desc": "Crowd positioning: momentum chasing, capitulation, euphoria.",
        "asset_classes": ["stock", "etf", "crypto"],
        "instruction": (
            "You are the SENTIMENT ANALYST. Infer crowd positioning from the tape: the "
            "shape of recent returns (1w/1m/3m), distance from 52-week extremes, realized "
            "volatility, and headline tone. Is this crowded momentum, quiet accumulation, "
            "capitulation, or euphoria? Contrarian signals welcome when the data supports "
            "them. 3-4 sentences, end with a sentiment stance."
        ),
    },
    "onchain": {
        "label": "On-Chain Analyst",
        "desc": "Crypto-native lens: cycle position, volume regime, structural flows.",
        "asset_classes": ["crypto"],
        "instruction": (
            "You are the ON-CHAIN / CRYPTO-STRUCTURE ANALYST. Read this token through a "
            "crypto-native lens: where are we in the cycle given the drawdown/run-up "
            "profile, what does the volume regime suggest about participation, and what "
            "structural factors (halving cycles, staking, regulatory overhang, dominance "
            "rotation) matter for this specific asset right now? Be explicit about what "
            "is inference vs. data. 3-5 sentences, end with a structural stance."
        ),
    },
}

DEPTHS: Dict[str, Dict[str, Any]] = {
    "quick": {
        "label": "Quick read",
        "desc": "Analysts + portfolio manager. No debate.",
        "debate_rounds": 0,
        "risk_review": False,
    },
    "standard": {
        "label": "Standard",
        "desc": "Analysts, one bull/bear debate round, trader plan, decision.",
        "debate_rounds": 1,
        "risk_review": False,
    },
    "deep": {
        "label": "Deep dive",
        "desc": "Two debate rounds plus a risk-committee review before the decision.",
        "debate_rounds": 2,
        "risk_review": True,
    },
}

# Credit pricing per pipeline stage. A run's cost is fully determined by
# its analyst selection + depth, so the UI can quote it before launch.
COST_PER_ANALYST = 2
COST_PER_DEBATE_ROUND = 3   # one bull + one bear reply
COST_TRADER = 2
COST_RISK_REVIEW = 3
COST_DECISION = 2


def run_cost(analysts: List[str], depth: str) -> int:
    d = DEPTHS[depth]
    cost = COST_PER_ANALYST * len(analysts) + COST_DECISION
    if d["debate_rounds"] > 0:
        cost += COST_PER_DEBATE_ROUND * d["debate_rounds"] + COST_TRADER
    if d["risk_review"]:
        cost += COST_RISK_REVIEW
    return cost


# ── prompts ──────────────────────────────────────────────────────────

_BASE_SYSTEM = (
    "You are one specialist on a multi-agent equity research desk covering stocks, "
    "ETFs and crypto. You receive a market briefing and play exactly one role per "
    "request. House rules: tight, opinionated, specific numbers from the briefing; "
    "call it as the data sees it — no hedging every line, no generic risk "
    "disclaimers, no 'as an AI'. When you rely on background knowledge rather than "
    "the briefing, say so. This is research, not financial advice, and the reader "
    "knows that — do not repeat it."
)

DECISION_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["BUY", "SELL", "HOLD"]},
        "conviction": {"type": "integer", "enum": list(range(0, 101, 5))},
        "position_size_pct": {"type": "number"},
        "time_horizon": {"type": "string"},
        "entry_zone": {"type": "string"},
        "stop_loss": {"type": "string"},
        "take_profit": {"type": "string"},
        "bull_case": {"type": "string"},
        "bear_case": {"type": "string"},
        "key_risks": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": [
        "action", "conviction", "position_size_pct", "time_horizon", "entry_zone",
        "stop_loss", "take_profit", "bull_case", "bear_case", "key_risks", "summary",
    ],
    "additionalProperties": False,
}


def _system_blocks(briefing: str) -> List[Dict[str, Any]]:
    """Stable prefix shared by every call in the run. Both blocks carry
    cache breakpoints: the persona is shared across *all* runs, the
    briefing across all calls in *this* run."""
    return [
        {"type": "text", "text": _BASE_SYSTEM, "cache_control": {"type": "ephemeral"}},
        {
            "type": "text",
            "text": "MARKET BRIEFING\n===============\n" + briefing,
            "cache_control": {"type": "ephemeral"},
        },
    ]


def _reports_block(reports: Dict[str, str]) -> str:
    parts = []
    for key, text in reports.items():
        label = ANALYSTS.get(key, {}).get("label", key)
        parts.append(f"--- {label} ---\n{text}")
    return "\n\n".join(parts) if parts else "(no analyst reports available)"


def _debate_block(transcript: List[Dict[str, str]]) -> str:
    if not transcript:
        return "(no debate yet)"
    return "\n\n".join(f"[{t['speaker'].upper()}]\n{t['text']}" for t in transcript)


# ── engine ───────────────────────────────────────────────────────────

class ResearchEngine:
    """One instance per run. ``events()`` is the async generator the
    router streams; results are collected on the instance for
    persistence after the stream ends."""

    def __init__(
        self,
        snapshot: MarketSnapshot,
        news_items: List[dict],
        analysts: List[str],
        depth: str,
    ):
        self.snapshot = snapshot
        self.analysts = analysts
        self.depth = depth
        self.briefing = build_briefing(snapshot, news_items)
        self.system = _system_blocks(self.briefing)
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        self.reports: Dict[str, str] = {}
        self.transcript: List[Dict[str, str]] = []
        self.trader_plan: Optional[str] = None
        self.risk_review: Optional[str] = None
        self.decision: Optional[Dict[str, Any]] = None
        self.agent_outputs: Dict[str, Dict[str, Any]] = {}

    # ── single streamed agent call ───────────────────────────────────
    async def _call(self, agent_key: str, prompt: str, model: str, emit) -> str:
        started = time.monotonic()
        await emit({"event": "agent.start", "agent": agent_key})
        try:
            async def _go() -> str:
                async with self.client.messages.stream(
                    model=model,
                    max_tokens=8000,
                    thinking={"type": "adaptive"},
                    system=self.system,
                    messages=[{"role": "user", "content": prompt}],
                ) as stream:
                    async for text in stream.text_stream:
                        await emit({"event": "agent.delta", "agent": agent_key, "text": text})
                    final = await stream.get_final_message()
                return "".join(b.text for b in final.content if b.type == "text").strip()

            output = await asyncio.wait_for(_go(), timeout=_AGENT_TIMEOUT_S)
            duration_ms = int((time.monotonic() - started) * 1000)
            self.agent_outputs[agent_key] = {
                "output": output, "model": model, "duration_ms": duration_ms,
            }
            await emit({
                "event": "agent.complete", "agent": agent_key,
                "output": output, "model": model, "duration_ms": duration_ms,
            })
            return output
        except Exception as e:  # noqa: BLE001 — surfaced as an SSE event
            logger.exception("agent %s failed", agent_key)
            self.agent_outputs[agent_key] = {"error": str(e)}
            await emit({"event": "agent.error", "agent": agent_key, "error": str(e)})
            return f"({agent_key} unavailable: {e})"

    # ── phases ───────────────────────────────────────────────────────
    async def _run_analysts(self, emit) -> None:
        async def one(key: str) -> None:
            prompt = ANALYSTS[key]["instruction"]
            self.reports[key] = await self._call(key, prompt, settings.equity_quick_model, emit)

        await asyncio.gather(*(one(k) for k in self.analysts))

    async def _run_debate(self, rounds: int, emit) -> None:
        for rnd in range(1, rounds + 1):
            await emit({"event": "debate.round", "round": rnd, "total": rounds})
            for speaker, brief in (
                ("bull", (
                    "You are the BULL RESEARCHER. Build the strongest honest case FOR "
                    "taking/holding a long position, grounded in the analyst reports. "
                    "Directly rebut the bear's best points if any exist in the debate so "
                    "far. 4-6 sentences, cite specific numbers."
                )),
                ("bear", (
                    "You are the BEAR RESEARCHER. Build the strongest honest case AGAINST "
                    "a long position (or for a short/avoid), grounded in the analyst "
                    "reports. Directly rebut the bull's best points from the debate so "
                    "far. 4-6 sentences, cite specific numbers."
                )),
            ):
                prompt = (
                    f"{brief}\n\nANALYST REPORTS\n{_reports_block(self.reports)}\n\n"
                    f"DEBATE SO FAR (round {rnd} of {rounds})\n{_debate_block(self.transcript)}"
                )
                key = f"{speaker}_r{rnd}"
                text = await self._call(key, prompt, settings.equity_deep_model, emit)
                self.transcript.append({"speaker": speaker, "round": rnd, "text": text})

    async def _run_trader(self, emit) -> None:
        prompt = (
            "You are the TRADER. Given the analyst reports and the researcher debate, "
            "propose a concrete trade plan: direction, sizing logic, entry zone, stop, "
            "target, and time horizon — with the single strongest reason it works and "
            "the single most likely way it fails. 5-7 sentences.\n\n"
            f"ANALYST REPORTS\n{_reports_block(self.reports)}\n\n"
            f"DEBATE\n{_debate_block(self.transcript)}"
        )
        self.trader_plan = await self._call("trader", prompt, settings.equity_deep_model, emit)

    async def _run_risk(self, emit) -> None:
        prompt = (
            "You are the RISK MANAGER. Stress-test the trader's plan: position sizing vs "
            "the asset's realized vol and max drawdown, stop placement vs normal noise, "
            "correlation/liquidity concerns, and what invalidates the thesis fastest. "
            "End with: APPROVE / APPROVE WITH CHANGES (state them) / REJECT.\n\n"
            f"TRADER PLAN\n{self.trader_plan or '(none)'}\n\n"
            f"ANALYST REPORTS\n{_reports_block(self.reports)}\n\n"
            f"DEBATE\n{_debate_block(self.transcript)}"
        )
        self.risk_review = await self._call("risk", prompt, settings.equity_deep_model, emit)

    async def _run_decision(self, emit) -> None:
        await emit({"event": "agent.start", "agent": "portfolio_manager"})
        started = time.monotonic()
        sections = [
            "You are the PORTFOLIO MANAGER making the final call. Weigh everything "
            "below and decide. Conviction reflects evidence quality, not bravado; "
            "position_size_pct is % of a diversified portfolio (0-10 typical). "
            "entry_zone/stop_loss/take_profit are concrete price strings derived from "
            "the briefing's levels.",
            f"ANALYST REPORTS\n{_reports_block(self.reports)}",
        ]
        if self.transcript:
            sections.append(f"BULL/BEAR DEBATE\n{_debate_block(self.transcript)}")
        if self.trader_plan:
            sections.append(f"TRADER PLAN\n{self.trader_plan}")
        if self.risk_review:
            sections.append(f"RISK REVIEW\n{self.risk_review}")
        prompt = "\n\n".join(sections)
        try:
            async def _go() -> Dict[str, Any]:
                resp = await self.client.messages.create(
                    model=settings.equity_deep_model,
                    max_tokens=16000,
                    thinking={"type": "adaptive"},
                    system=self.system,
                    messages=[{"role": "user", "content": prompt}],
                    output_config={"format": {"type": "json_schema", "schema": DECISION_SCHEMA}},
                )
                text = next(b.text for b in resp.content if b.type == "text")
                return json.loads(text)

            self.decision = await asyncio.wait_for(_go(), timeout=_AGENT_TIMEOUT_S)
            duration_ms = int((time.monotonic() - started) * 1000)
            self.agent_outputs["portfolio_manager"] = {
                "output": self.decision, "model": settings.equity_deep_model,
                "duration_ms": duration_ms,
            }
            await emit({
                "event": "agent.complete", "agent": "portfolio_manager",
                "model": settings.equity_deep_model, "duration_ms": duration_ms,
            })
            await emit({"event": "decision", "decision": self.decision})
        except Exception as e:  # noqa: BLE001 — surfaced as an SSE event
            logger.exception("portfolio manager failed")
            self.agent_outputs["portfolio_manager"] = {"error": str(e)}
            await emit({"event": "agent.error", "agent": "portfolio_manager", "error": str(e)})

    # ── orchestration ────────────────────────────────────────────────
    async def events(self) -> AsyncIterator[Dict[str, Any]]:
        """Run the pipeline, yielding UI events as they happen. Phases
        run in a background task that pushes onto a queue so concurrent
        analysts can interleave their streamed deltas."""
        queue: asyncio.Queue = asyncio.Queue()

        async def emit(evt: Dict[str, Any]) -> None:
            await queue.put(evt)

        async def pipeline() -> None:
            cfg = DEPTHS[self.depth]
            await self._run_analysts(emit)
            if cfg["debate_rounds"] > 0:
                await self._run_debate(cfg["debate_rounds"], emit)
                await self._run_trader(emit)
            if cfg["risk_review"]:
                await self._run_risk(emit)
            await self._run_decision(emit)

        task = asyncio.create_task(pipeline())
        try:
            while True:
                if task.done() and queue.empty():
                    break
                try:
                    evt = await asyncio.wait_for(queue.get(), timeout=5.0)
                    yield evt
                except asyncio.TimeoutError:
                    yield {"event": "heartbeat"}
            # Re-raise pipeline errors that didn't surface per-agent.
            exc = task.exception()
            if exc is not None:
                raise exc
        finally:
            if not task.done():
                task.cancel()
