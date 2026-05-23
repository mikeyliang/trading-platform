"""Level 2 market-depth endpoints (REST snapshot + WebSocket stream)."""
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ..nautilus import ib_depth

router = APIRouter(prefix="/api/depth", tags=["depth"])


@router.get("/{symbol}")
async def depth_snapshot(
    symbol: str,
    rows: int = Query(ib_depth.DEFAULT_DEPTH_ROWS, ge=1, le=20),
):
    """One-shot DOM snapshot. Returns ``available: false`` when the IBKR
    account is not entitled for market depth on this exchange."""
    return await ib_depth.get_snapshot(symbol, rows=rows)


@router.websocket("/ws/{symbol}")
async def depth_ws(websocket: WebSocket, symbol: str, rows: int = ib_depth.DEFAULT_DEPTH_ROWS):
    """Live DOM stream. Pushes ``{type: 'depth', data: {...}}`` messages on
    every update (server-side throttled to ~4Hz to keep the ladder smooth
    without flooding the browser)."""
    await websocket.accept()
    ok = await ib_depth.add_subscriber(symbol, websocket, rows=rows)
    if not ok:
        # Tell the client we couldn't open a subscription so it can render the
        # "no depth entitlement" state instead of waiting forever.
        try:
            await websocket.send_json({
                "type": "unavailable",
                "data": {"symbol": symbol.upper(),
                         "reason": "no IBKR market-depth subscription or gateway offline"},
            })
        except Exception:  # noqa: BLE001
            pass
        await websocket.close()
        return
    try:
        while True:
            # We don't expect client→server messages on the depth socket, but
            # keep the receive loop running so disconnects are noticed.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        ib_depth.remove_subscriber(symbol, websocket)
