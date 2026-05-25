from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Query

from ..models.schemas import OptionChain, SpreadScanResponse, SpreadSpec
from ..nautilus import ib_options
from ..services import scan_store, spread_finder

router = APIRouter(prefix="/api/options", tags=["options"])


@router.get(
    "/chain/{symbol}",
    response_model=OptionChain,
    summary="Option chain for one underlying",
    description=(
        "Returns the option chain for ``symbol`` from IBKR. "
        "Omit ``expiration`` for a lightweight expirations + strikes payload (no Greeks). "
        "When ``expiration`` is given, calls + puts are populated with Greeks for that expiry."
    ),
    responses={
        200: {
            "description": "Chain payload. Calls/puts empty when expiration is omitted.",
        }
    },
)
async def chain(
    symbol: str,
    expiration: Optional[str] = Query(
        None,
        pattern=r"^\d{8}$",
        description="YYYYMMDD; omit for expirations+strikes only.",
    ),
) -> OptionChain:
    raw = await ib_options.get_chain(symbol, expiration)
    return OptionChain(**raw)


@router.get(
    "/spreads/scan",
    response_model=SpreadScanResponse,
    response_model_exclude_none=False,
    summary="Scan credit-spread candidates",
    description=(
        "Scan IBKR chains for Mars / Mars Max / Space / RUT credit-spread candidates. "
        "Every scan is persisted to Postgres via ``scan_store.save_scan`` so the "
        "/trade/history view and the picker's instant-hydrate path have a source. "
        "Per-trade-type buckets in ``trade_types`` / ``top_picks`` carry trade-specific "
        "fields (fib floors, scale notes), so the response model allows extras."
    ),
)
async def scan_spreads(
    symbol: str = Query("RUT", description="Underlying (RUT, SPX, SPY, ...)"),
    side: Literal["put", "call", "both"] = Query("put"),
    trade_types: Optional[List[str]] = Query(
        None,
        description="Filter to specific trade types; omit for all (rut, mars, marsmax, space)",
    ),
    max_per_type: int = Query(5, ge=1, le=20),
) -> Dict[str, Any]:
    result = await spread_finder.scan(
        symbol=symbol, side=side,
        trade_types=trade_types, max_per_type=max_per_type,
    )
    await scan_store.save_scan(scope="manual", symbol=symbol.upper(), payload=result)
    return result


@router.get(
    "/spreads/specs",
    response_model=Dict[str, SpreadSpec],
    summary="Trade-type criteria",
    description=(
        "Static pass/fail thresholds for each trade type — the UI uses these to "
        "render badges (e.g. ``Δ 0.12 ≤ 0.15 ✓``)."
    ),
)
def spread_specs() -> Dict[str, SpreadSpec]:
    return {
        name: SpreadSpec(
            name=spec.name,
            underlying=spec.underlying,
            max_delta=spec.max_delta,
            min_adj_distance_pct=spec.min_adj_distance_pct,
            target_aroc_pct=spec.target_aroc_pct,
            min_kelly_pct=spec.min_kelly_pct,
            delta_exit=spec.delta_exit,
            floor_required=spec.floor_required,
            description=spec.description,
        )
        for name, spec in spread_finder.TRADE_SPECS.items()
    }
