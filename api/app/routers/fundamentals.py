"""Fundamentals endpoint stub.

IBKR Gateway is the only data source in this build. The IBKR API exposes
``reqFundamentalData`` for a subset of contracts but it returns vendor XML
that needs a paid Reuters/Wood Mackenzie subscription on most accounts.

This stub returns an empty payload (with the symbol echoed back) so the
screener and analyzer pages render without 5xx errors. When fundamentals
become important again, wire up a real provider here.
"""
from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, Query

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/fundamentals", tags=["fundamentals"])


def _empty(symbol: str) -> Dict[str, Any]:
    return {"symbol": symbol, "name": None, "sector": None, "industry": None}


@router.get("/{symbol}")
async def fundamentals(symbol: str):
    return _empty(symbol.upper())


@router.get("")
async def fundamentals_bulk(symbols: str = Query(..., description="comma-separated tickers")):
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    return [_empty(s) for s in syms]
