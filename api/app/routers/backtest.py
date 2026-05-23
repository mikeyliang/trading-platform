from fastapi import APIRouter, HTTPException, BackgroundTasks
from typing import List
from ..models.schemas import BacktestRequest, BacktestResult
from ..nautilus.engine import engine

router = APIRouter(prefix="/api/backtest", tags=["backtest"])


@router.post("/run", response_model=BacktestResult)
def run_backtest(req: BacktestRequest):
    """
    runs a backtest synchronously and returns the result.
    uses NautilusTrader BacktestEngine when available, else built-in engine.
    """
    try:
        result = engine.run_backtest(req)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/results", response_model=List[BacktestResult])
def list_results():
    return engine.list_backtest_results()


@router.get("/results/{result_id}", response_model=BacktestResult)
def get_result(result_id: str):
    result = engine.get_backtest_result(result_id)
    if not result:
        raise HTTPException(status_code=404, detail="backtest result not found")
    return result
