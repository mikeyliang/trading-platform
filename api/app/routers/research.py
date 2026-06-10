"""Equity research desk — multi-agent analysis runs, credits & pricing.

Endpoints:
  GET  /api/research/catalog            agent types, depths, cost model
  GET  /api/research/pricing            plans + credit packs
  GET  /api/research/credits            balance + recent ledger
  POST /api/research/credits/checkout   buy a credit pack (Stripe stubbed)
  POST /api/research/run                SSE multi-agent research run
  GET  /api/research/runs               run history
  GET  /api/research/runs/{run_id}      single run replay

Identity is a lightweight ``X-User-Id`` header (defaults to "default")
— the platform is single-tenant today; swap for real auth when user
accounts land. Credits are charged up-front when a run starts and
refunded in full if the pipeline dies before producing any output.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..services import credits, db
from ..services.equity_agents import (
    ANALYSTS,
    COST_DECISION,
    COST_PER_ANALYST,
    COST_PER_DEBATE_ROUND,
    COST_RISK_REVIEW,
    COST_TRADER,
    DEPTHS,
    ResearchEngine,
    run_cost,
)
from ..services.equity_data import MarketDataError, fetch_snapshot
from ..services.news import fetch_news

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/research", tags=["research"])

ASSET_CLASSES = ["stock", "etf", "crypto"]


# ── catalog + pricing ────────────────────────────────────────────────

@router.get("/catalog")
def catalog() -> Dict[str, Any]:
    """Everything the UI needs to build the run form and quote a cost."""
    return {
        "asset_classes": ASSET_CLASSES,
        "analysts": [
            {"id": key, "label": a["label"], "desc": a["desc"], "asset_classes": a["asset_classes"]}
            for key, a in ANALYSTS.items()
        ],
        "depths": [
            {
                "id": key,
                "label": d["label"],
                "desc": d["desc"],
                "debate_rounds": d["debate_rounds"],
                "risk_review": d["risk_review"],
            }
            for key, d in DEPTHS.items()
        ],
        "cost_model": {
            "per_analyst": COST_PER_ANALYST,
            "per_debate_round": COST_PER_DEBATE_ROUND,
            "trader": COST_TRADER,
            "risk_review": COST_RISK_REVIEW,
            "decision": COST_DECISION,
        },
    }


@router.get("/pricing")
def pricing() -> Dict[str, Any]:
    return {
        "plans": credits.PLANS,
        "packs": credits.CREDIT_PACKS,
        "signup_credits": settings.free_signup_credits,
        "example_costs": {
            depth: run_cost(["market", "news", "sentiment"], depth) for depth in DEPTHS
        },
    }


# ── credits ──────────────────────────────────────────────────────────

@router.get("/credits")
async def credit_balance(x_user_id: str = Header(default="default")) -> Dict[str, Any]:
    account = await credits.get_account(x_user_id)
    history = await credits.ledger(x_user_id, limit=25)
    return {**account, "ledger": history}


class CheckoutRequest(BaseModel):
    pack_id: str


@router.post("/credits/checkout")
async def checkout(req: CheckoutRequest, x_user_id: str = Header(default="default")) -> Dict[str, Any]:
    """Buy a credit pack. Without a Stripe key configured this grants
    instantly (dev mode); with one, this is where a Checkout Session
    would be created and the grant deferred to the payment webhook."""
    pack = credits.pack_by_id(req.pack_id)
    if pack is None:
        raise HTTPException(404, f"unknown pack '{req.pack_id}'")
    if settings.stripe_secret_key:
        raise HTTPException(501, "Stripe checkout not wired yet — unset STRIPE_SECRET_KEY for dev grants")
    balance = await credits.adjust(x_user_id, pack["credits"], f"pack_purchase:{pack['id']}")
    return {
        "granted": True,
        "dev_mode": True,
        "pack": pack,
        "balance": balance,
    }


class EstimateRequest(BaseModel):
    analysts: List[str] = Field(min_length=1)
    depth: str


@router.post("/estimate")
def estimate(req: EstimateRequest) -> Dict[str, int]:
    _validate_selection(req.analysts, req.depth, asset_class=None)
    return {"cost": run_cost(req.analysts, req.depth)}


# ── runs ─────────────────────────────────────────────────────────────

class RunRequest(BaseModel):
    symbol: str = Field(..., pattern=r"^[A-Za-z0-9\.\-]+$", max_length=12)
    asset_class: str = "stock"
    analysts: List[str] = Field(default_factory=lambda: ["market", "news", "sentiment"], min_length=1, max_length=5)
    depth: str = "standard"


def _validate_selection(analysts: List[str], depth: str, asset_class: Optional[str]) -> None:
    if depth not in DEPTHS:
        raise HTTPException(422, f"unknown depth '{depth}' (one of {list(DEPTHS)})")
    seen = set()
    for a in analysts:
        if a not in ANALYSTS:
            raise HTTPException(422, f"unknown analyst '{a}' (one of {list(ANALYSTS)})")
        if a in seen:
            raise HTTPException(422, f"duplicate analyst '{a}'")
        seen.add(a)
        if asset_class is not None and asset_class not in ANALYSTS[a]["asset_classes"]:
            raise HTTPException(422, f"analyst '{a}' does not cover asset class '{asset_class}'")


def _sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


async def _persist_run(
    user_id: str, req: RunRequest, engine: ResearchEngine,
    cost: int, duration_ms: int,
) -> Optional[int]:
    pool = db.pool()
    if pool is None:
        return None
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO equity_research_runs
                  (user_id, asset_class, symbol, depth, analysts, agents,
                   decision, credits_charged, duration_ms)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
                RETURNING id
                """,
                user_id, req.asset_class, req.symbol.upper(), req.depth,
                req.analysts, json.dumps(engine.agent_outputs),
                json.dumps(engine.decision) if engine.decision is not None else None,
                cost, duration_ms,
            )
            return int(row["id"])
    except Exception as e:  # noqa: BLE001 — persistence is best-effort
        logger.warning("equity_research_runs insert failed: %s", e)
        return None


@router.post("/run")
async def run_research(req: RunRequest, x_user_id: str = Header(default="default")) -> StreamingResponse:
    """SSE-stream a full multi-agent research run. Consumed by the
    dashboard via fetch + ReadableStream (EventSource can't POST)."""
    req.symbol = req.symbol.upper()
    if req.asset_class not in ASSET_CLASSES:
        raise HTTPException(422, f"unknown asset_class '{req.asset_class}' (one of {ASSET_CLASSES})")
    _validate_selection(req.analysts, req.depth, req.asset_class)
    if not settings.anthropic_api_key:
        raise HTTPException(503, "ANTHROPIC_API_KEY not configured")

    cost = run_cost(req.analysts, req.depth)
    account = await credits.get_account(x_user_id)
    if account["balance"] < cost:
        raise HTTPException(
            402,
            f"insufficient credits: run costs {cost}, balance is {account['balance']} — top up on the pricing page",
        )

    async def stream() -> AsyncIterator[str]:
        started = time.monotonic()
        # 1. Market data + news first — a dead data source must not
        #    burn credits.
        try:
            snapshot = await fetch_snapshot(req.symbol, req.asset_class)
        except MarketDataError as e:
            yield _sse({"event": "run.error", "error": str(e)})
            return
        try:
            news_symbol = f"{req.symbol}-USD" if req.asset_class == "crypto" else req.symbol
            news_items = await fetch_news(news_symbol)
        except Exception:  # noqa: BLE001 — news is optional context
            news_items = []

        # 2. Charge. Balance was pre-checked but may have raced.
        try:
            balance = await credits.adjust(x_user_id, -cost, f"run:{req.symbol}:{req.depth}")
        except credits.InsufficientCreditsError as e:
            yield _sse({"event": "run.error", "error": str(e)})
            return

        yield _sse({
            "event": "run.start",
            "symbol": req.symbol, "asset_class": req.asset_class,
            "depth": req.depth, "analysts": req.analysts,
            "cost": cost, "balance": balance,
        })
        yield _sse({"event": "data.ready", "snapshot": snapshot.summary()})

        # 3. Agents.
        engine = ResearchEngine(snapshot, news_items, req.analysts, req.depth)
        try:
            async for evt in engine.events():
                yield _sse(evt)
        except Exception as e:  # noqa: BLE001 — refund a run that produced nothing
            logger.exception("research pipeline crashed")
            if not engine.agent_outputs:
                balance = await credits.adjust(x_user_id, cost, f"refund:{req.symbol}")
            yield _sse({"event": "run.error", "error": str(e), "balance": balance})
            return

        duration_ms = int((time.monotonic() - started) * 1000)
        run_id = await _persist_run(x_user_id, req, engine, cost, duration_ms)
        yield _sse({
            "event": "run.complete",
            "run_id": run_id, "duration_ms": duration_ms,
            "credits_charged": cost, "balance": balance,
        })

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # nginx / Next.js proxy: don't buffer
        },
    )


# ── history ──────────────────────────────────────────────────────────

class RunRow(BaseModel):
    id: int
    ran_at: str
    symbol: str
    asset_class: str
    depth: str
    analysts: List[str]
    credits_charged: int
    duration_ms: Optional[int]
    decision: Optional[Dict[str, Any]]


@router.get("/runs", response_model=List[RunRow])
async def list_runs(
    limit: int = 20,
    symbol: Optional[str] = None,
    x_user_id: str = Header(default="default"),
) -> List[RunRow]:
    pool = db.pool()
    if pool is None:
        return []
    query = (
        "SELECT id, ran_at, symbol, asset_class, depth, analysts, "
        "credits_charged, duration_ms, decision FROM equity_research_runs "
        "WHERE user_id = $1"
    )
    args: List[Any] = [x_user_id]
    if symbol:
        query += " AND symbol = $2"
        args.append(symbol.upper())
    query += f" ORDER BY ran_at DESC LIMIT ${len(args) + 1}"
    args.append(min(limit, 100))
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *args)
    return [
        RunRow(
            id=int(r["id"]),
            ran_at=r["ran_at"].isoformat(),
            symbol=r["symbol"],
            asset_class=r["asset_class"],
            depth=r["depth"],
            analysts=list(r["analysts"]),
            credits_charged=int(r["credits_charged"]),
            duration_ms=r["duration_ms"],
            decision=_jsonb(r["decision"]),
        )
        for r in rows
    ]


@router.get("/runs/{run_id}")
async def get_run(run_id: int, x_user_id: str = Header(default="default")) -> Dict[str, Any]:
    pool = db.pool()
    if pool is None:
        raise HTTPException(404, "run history unavailable (no database)")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, ran_at, symbol, asset_class, depth, analysts, agents,
                   decision, credits_charged, duration_ms
            FROM equity_research_runs WHERE id = $1 AND user_id = $2
            """,
            run_id, x_user_id,
        )
    if row is None:
        raise HTTPException(404, f"run {run_id} not found")
    return {
        "id": int(row["id"]),
        "ran_at": row["ran_at"].isoformat(),
        "symbol": row["symbol"],
        "asset_class": row["asset_class"],
        "depth": row["depth"],
        "analysts": list(row["analysts"]),
        "agents": _jsonb(row["agents"]),
        "decision": _jsonb(row["decision"]),
        "credits_charged": int(row["credits_charged"]),
        "duration_ms": row["duration_ms"],
    }


def _jsonb(value: Any) -> Any:
    if isinstance(value, str):
        return json.loads(value)
    return value
