"""
Simulation API — real NautilusTrader backtests over select stocks.

POST   /api/sim/run                start a background multi-symbol run
GET    /api/sim/runs               list run summaries (newest first)
GET    /api/sim/runs/{id}          run detail: per-symbol stats/trades/equity
GET    /api/sim/runs/{id}/chart    chart payload for one symbol of the run
DELETE /api/sim/runs/{id}          remove a run
GET    /api/sim/presets            strategy presets for the UI
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from ..backtest import store
from ..backtest.signals import DEFAULT_PARAMS
from ..models.schemas import Timeframe

router = APIRouter(prefix="/api/sim", tags=["simulation"])


class SimRunRequest(BaseModel):
    symbols: List[str] = Field(..., min_length=1, max_length=12)
    timeframe: Timeframe = Timeframe.H1
    start_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    initial_capital: float = Field(100_000.0, gt=0, le=1e12)
    preset: str = Field("confluence-core")
    params: Dict[str, Any] = Field(default_factory=dict)
    label: str = Field("", max_length=120)

    @field_validator("symbols")
    @classmethod
    def _norm_symbols(cls, v: List[str]) -> List[str]:
        out = []
        for s in v:
            s = s.strip().upper()
            if s and s not in out:
                out.append(s)
        if not out:
            raise ValueError("at least one symbol required")
        return out

    @field_validator("preset")
    @classmethod
    def _check_preset(cls, v: str) -> str:
        if v not in {p["id"] for p in store.PRESETS}:
            raise ValueError(f"unknown preset: {v}")
        return v


@router.post("/run", summary="Start a NautilusTrader simulation run")
def start_run(req: SimRunRequest) -> Dict[str, Any]:
    if req.start_date >= req.end_date:
        raise HTTPException(status_code=422, detail="start_date must be before end_date")
    return store.start_run(
        symbols=req.symbols,
        timeframe=req.timeframe.value,
        start_date=req.start_date,
        end_date=req.end_date,
        initial_capital=req.initial_capital,
        params=req.params,
        preset=req.preset,
        label=req.label,
    )


@router.get("/runs", summary="List simulation runs")
def list_runs() -> List[Dict[str, Any]]:
    return store.list_runs()


@router.get("/runs/{run_id}", summary="Run detail (stats, trades, equity per symbol)")
def get_run(run_id: str) -> Dict[str, Any]:
    doc = store.get_run(run_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="run not found")
    return doc


@router.get("/runs/{run_id}/chart", summary="Chart payload for one symbol")
def get_chart(run_id: str, symbol: str = Query(..., min_length=1, max_length=12)) -> Dict[str, Any]:
    payload = store.get_chart(run_id, symbol)
    if payload is None:
        raise HTTPException(status_code=404, detail="chart not found (run or symbol missing, or still running)")
    return payload


@router.delete("/runs/{run_id}", summary="Delete a run")
def delete_run(run_id: str) -> Dict[str, str]:
    if not store.delete_run(run_id):
        raise HTTPException(status_code=404, detail="run not found")
    return {"status": "deleted"}


@router.get("/presets", summary="Strategy presets")
def presets() -> Dict[str, Any]:
    return {"presets": store.PRESETS, "default_params": DEFAULT_PARAMS}
