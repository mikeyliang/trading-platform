from typing import List

from fastapi import APIRouter, HTTPException

from ..models.schemas import BacktestRequest, BacktestResult
from ..nautilus.engine import engine

router = APIRouter(prefix="/api/backtest", tags=["backtest"])


@router.post(
    "/run",
    response_model=BacktestResult,
    summary="Run a backtest",
    description=(
        "Runs a backtest synchronously and returns the result. Uses NautilusTrader's "
        "``BacktestEngine`` when available, otherwise the built-in vectorized engine."
    ),
    responses={
        500: {"description": "Backtest engine raised; inspect ``detail`` for the cause."},
    },
)
def run_backtest(req: BacktestRequest) -> BacktestResult:
    try:
        return engine.run_backtest(req)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/results",
    response_model=List[BacktestResult],
    summary="List past backtest results",
)
def list_results():
    return engine.list_backtest_results()


@router.get(
    "/results/{result_id}",
    response_model=BacktestResult,
    summary="Get a single backtest result",
    responses={404: {"description": "Result id not found."}},
)
def get_result(result_id: str):
    result = engine.get_backtest_result(result_id)
    if not result:
        raise HTTPException(status_code=404, detail="backtest result not found")
    return result
