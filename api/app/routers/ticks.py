"""Time & Sales (tick-by-tick) endpoints (REST snapshot + WebSocket stream)."""
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ..nautilus import ib_ticks

router = APIRouter(prefix="/api/ticks", tags=["ticks"])


@router.get("/{symbol}")
async def recent_prints(
    symbol: str,
    n: int = Query(ib_ticks.DEFAULT_RECENT_N, ge=1, le=ib_ticks.ROLLING_TAPE_LEN),
):
    """Most recent ``n`` prints for ``symbol``. Each print includes
    timestamp, price, size, aggressor side (buy/sell/mid based on the
    contemporaneous bid/ask), and any IBKR condition flags."""
    return await ib_ticks.get_recent(symbol, n=n)


@router.websocket("/ws/{symbol}")
async def ticks_ws(websocket: WebSocket, symbol: str):
    """Live tape stream. On connect: hydrates with the current rolling
    buffer (``{type: 'tape', data: {prints: [...]}}``). On each new print:
    pushes ``{type: 'print', data: {...}}``."""
    await websocket.accept()
    ok = await ib_ticks.add_subscriber(symbol, websocket)
    if not ok:
        try:
            await websocket.send_json({
                "type": "unavailable",
                "data": {"symbol": symbol.upper(),
                         "reason": "no IBKR tick-by-tick subscription or gateway offline"},
            })
        except Exception:  # noqa: BLE001
            pass
        await websocket.close()
        return
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        ib_ticks.remove_subscriber(symbol, websocket)
