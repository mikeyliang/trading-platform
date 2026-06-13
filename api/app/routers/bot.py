"""
Trading bot API — paper bot gated on simulation results.

GET    /api/bot/status        full snapshot (positions, equity, decisions)
POST   /api/bot/start         start loop (refuses without a validating sim run unless force)
POST   /api/bot/stop          stop loop
POST   /api/bot/reset         reset paper account (must be stopped)
GET    /api/bot/gate          check which sim run (if any) validates a preset+timeframe
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..bot.runner import DEFAULT_CONFIG, bot_engine

router = APIRouter(prefix="/api/bot", tags=["bot"])


class BotStartRequest(BaseModel):
    symbols: List[str] = Field(default_factory=lambda: list(DEFAULT_CONFIG["symbols"]), min_length=1, max_length=12)
    timeframe: str = Field(DEFAULT_CONFIG["timeframe"])
    preset: str = Field(DEFAULT_CONFIG["preset"])
    params: Dict[str, Any] = Field(default_factory=dict)
    initial_capital: float = Field(DEFAULT_CONFIG["initial_capital"], gt=0, le=1e12)
    max_positions: int = Field(DEFAULT_CONFIG["max_positions"], ge=1, le=12)
    news_gate: bool = DEFAULT_CONFIG["news_gate"]
    news_block_below: float = Field(DEFAULT_CONFIG["news_block_below"], ge=-1, le=1)
    force: bool = False


@router.get("/status")
def status() -> Dict[str, Any]:
    return bot_engine.snapshot()


@router.post("/start")
async def start(req: BotStartRequest) -> Dict[str, Any]:
    try:
        cfg = req.model_dump(exclude={"force"})
        cfg["symbols"] = [s.strip().upper() for s in cfg["symbols"] if s.strip()]
        return await bot_engine.start(cfg, force=req.force)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/stop")
async def stop() -> Dict[str, Any]:
    return await bot_engine.stop()


@router.post("/reset")
def reset() -> Dict[str, Any]:
    try:
        return bot_engine.reset_paper()
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.get("/gate")
def gate(
    preset: str = Query("confluence-core"),
    timeframe: str = Query("1h"),
) -> Dict[str, Any]:
    run = bot_engine.find_validating_run(preset, timeframe)
    return {
        "validated": run is not None,
        "run": {k: run[k] for k in ("id", "label", "aggregate", "finished_at")} if run else None,
        "criteria": "completed sim run, same preset+timeframe, profit factor >= 1.0, avg return > 0",
    }
