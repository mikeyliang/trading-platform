from typing import List

from fastapi import APIRouter, HTTPException

from ..models.schemas import StrategyInfo, StrategyStartRequest
from ..nautilus.engine import engine
from ..strategies.schemas import get_schema, STRATEGY_SCHEMAS

router = APIRouter(prefix="/api/strategies", tags=["strategies"])


@router.get(
    "",
    response_model=List[StrategyInfo],
    summary="List all registered strategies",
)
def list_strategies():
    return engine.list_strategies()


@router.get(
    "/{strategy_id}",
    response_model=StrategyInfo,
    summary="Get one strategy by id",
    responses={404: {"description": "Strategy not found."}},
)
def get_strategy(strategy_id: str):
    s = engine.get_strategy(strategy_id)
    if not s:
        raise HTTPException(status_code=404, detail="strategy not found")
    return s


@router.get("/{strategy_id}/snapshot")
def strategy_snapshot(strategy_id: str):
    """Live runner state: open spreads, scan stats, last error. Empty when not running."""
    snap = engine.runner_snapshot(strategy_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="strategy not running")
    return snap


@router.get("/{strategy_id}/schema")
def strategy_schema(strategy_id: str):
    """JSON schema for the strategy's tunable parameters (renders as a form)."""
    schema = get_schema(strategy_id)
    if schema is None:
        # graceful: return empty schema rather than 404, lets the UI degrade
        return {"type": "object", "properties": {}, "defaults": {}}
    return schema


@router.get("/schemas/all")
def all_schemas():
    """List every strategy id that has a tunable schema (for the UI registry)."""
    return {sid: get_schema(sid) for sid in STRATEGY_SCHEMAS.keys()}


@router.post(
    "/{strategy_id}/start",
    response_model=StrategyInfo,
    summary="Start a strategy",
    description=(
        "Subscribes the strategy to the given symbols/timeframe and starts the runner."
    ),
    responses={404: {"description": "Strategy not found."}},
)
async def start_strategy(strategy_id: str, req: StrategyStartRequest) -> StrategyInfo:
    s = await engine.start_strategy(strategy_id, req.symbols, req.timeframe.value, req.params)
    if not s:
        raise HTTPException(status_code=404, detail="strategy not found")
    return s


@router.post(
    "/{strategy_id}/stop",
    response_model=StrategyInfo,
    summary="Stop a running strategy",
    responses={404: {"description": "Strategy not found."}},
)
async def stop_strategy(strategy_id: str) -> StrategyInfo:
    s = await engine.stop_strategy(strategy_id)
    if not s:
        raise HTTPException(status_code=404, detail="strategy not found")
    return s
