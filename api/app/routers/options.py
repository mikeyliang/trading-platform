from fastapi import APIRouter, Query
from typing import List, Literal, Optional

from ..nautilus import ib_options
from ..services import scan_store, spread_finder

router = APIRouter(prefix="/api/options", tags=["options"])


@router.get("/chain/{symbol}")
async def chain(
    symbol: str,
    expiration: Optional[str] = Query(None, description="YYYYMMDD; omit for expirations+strikes only"),
):
    """Option chain for ``symbol`` from IBKR. Omit ``expiration`` for a
    lightweight expirations + strikes payload (no Greeks).
    """
    return await ib_options.get_chain(symbol, expiration)


@router.get("/spreads/scan")
async def scan_spreads(
    symbol: str = Query("RUT", description="Underlying (RUT, SPX, SPY, ...)"),
    side: Literal["put", "call", "both"] = Query("put"),
    trade_types: Optional[List[str]] = Query(
        None,
        description="Filter to specific trade types; omit for all (rut, mars, marsmax, space)",
    ),
    max_per_type: int = Query(5, ge=1, le=20),
):
    """Scan IBKR chains for Mars / Mars Max / Space / RUT credit-spread candidates.

    Every scan is persisted to Postgres via ``scan_store.save_scan`` so the
    /trade/history view and the picker's instant-hydrate path have a source.
    """
    result = await spread_finder.scan(
        symbol=symbol, side=side,
        trade_types=trade_types, max_per_type=max_per_type,
    )
    await scan_store.save_scan(scope="manual", symbol=symbol.upper(), payload=result)
    return result


@router.get("/spreads/specs")
def spread_specs():
    """Static trade-type criteria so the UI can show pass/fail badges."""
    return {
        name: {
            "name": spec.name,
            "underlying": spec.underlying,
            "max_delta": spec.max_delta,
            "min_adj_distance_pct": spec.min_adj_distance_pct,
            "target_aroc_pct": spec.target_aroc_pct,
            "min_kelly_pct": spec.min_kelly_pct,
            "delta_exit": spec.delta_exit,
            "floor_required": spec.floor_required,
            "description": spec.description,
        }
        for name, spec in spread_finder.TRADE_SPECS.items()
    }
