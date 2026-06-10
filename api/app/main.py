import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .config import settings
from .middleware import (
    QueryParamSanitizationMiddleware,
    RateLimitMiddleware,
    RequestLoggingMiddleware,
)
from .nautilus import ib_depth, ib_options, ib_ticks
from .nautilus.ib_node import ib_node
from .nautilus.ib_orders import orders_client
from .routers import agent, agent_tools, agents, analyze, backtest, chat, depth, fundamentals, logos, market, monitor as monitor_router, okw, option_analyzer, options, orders, scans, strategies, ticks, trade_history, watchlist
from .services import db, scheduler as job_scheduler
from .ws.manager import manager
from .ws.trades import trades_channel

logging.basicConfig(level=getattr(logging, settings.log_level, logging.INFO))
logger = logging.getLogger(__name__)


async def _status_broadcaster():
    """Push periodic IBKR account + positions + health snapshots over WS so
    the dashboard doesn't REST-poll. ~10s cadence is fast enough to feel live
    without saturating the gateway.

    Account payload mirrors the ``/api/account`` REST shape exactly (merging
    raw NT fields onto ``_EMPTY_ACCOUNT`` defaults) so the dashboard's
    AccountInfo type assumptions hold whether it sees a REST hydration or a
    WS push.

    Also refreshes each held position's mark price via ``ib_options.get_quote``
    so unrealized P&L doesn't stay pinned at 0 when the NT live-tick stream
    hasn't subscribed the symbol.
    """
    from .routers.orders import _EMPTY_ACCOUNT  # local import avoids cycles
    while True:
        # 5s cadence: positions / PnL feel responsive without saturating
        # the IBKR gateway with mark refreshes (each snapshot call is ~2s
        # for option contracts, but we parallel-fetch in asyncio.gather).
        await asyncio.sleep(5)
        if manager.connection_count == 0:
            continue
        try:
            account = None
            positions: list[dict] = []
            if ib_node.is_connected:
                # Prefer ib_async's accountSummaryAsync so EQ/BP reflect
                # IBKR's own NetLiquidation / BuyingPower tags. Nautilus's
                # balances_total/free only covers cash and undercounts
                # margin-aware BP on Reg-T / portfolio-margin accounts.
                raw_acct = await ib_options.get_account_summary()
                if raw_acct is None:
                    raw_acct = ib_node.latest_account()
                # Always use ib_async as the single source of truth for
                # positions. Nautilus's latest_positions() is unreliable
                # when InstrumentProvider rejects option contracts during
                # reconciliation, and its per-position event stream emits
                # transient quantity=0 events that cause the dashboard to
                # flicker between "showing" and "empty".
                positions = await ib_options.get_positions()
                positions = await _refresh_position_marks(positions)
                upnl = sum(float(p.get("unrealized_pnl", 0)) for p in positions)
                if raw_acct:
                    account = {
                        **_EMPTY_ACCOUNT,
                        **raw_acct,
                        "unrealized_pnl": round(upnl, 2),
                        "mode": raw_acct.get("mode") or settings.trading_mode,
                    }

            payload = {
                "health": {
                    "ib_connected": ib_node.is_connected,
                    "mode": settings.trading_mode,
                    "mock_mode": settings.mock_mode,
                },
                "account": account,
                "positions": positions,
            }
            await manager.broadcast({"type": "snapshot", "data": payload})
        except Exception as e:  # noqa: BLE001
            logger.debug("status broadcast error: %s", e)


async def _refresh_position_marks(positions: list[dict]) -> list[dict]:
    """Refresh ``current_price`` on each position with a fresh ib_async
    snapshot and recompute unrealized P&L. Option positions go through
    ``get_option_snapshot`` (by symbol/strike/expiry/right) — qualifying
    the contract from the full spec is more reliable than the conId-only
    path, which can miss when IBKR fails to resolve the bare conId.

    Multiplier-aware: option PnL = (mark - avg) * qty * multiplier, where
    avg is per-contract premium and the multiplier is typically 100. Stock
    PnL uses multiplier=1.
    """
    if not positions:
        return positions

    async def refresh_one(p: dict) -> dict:
        qty = float(p.get("quantity") or 0)
        avg = float(p.get("avg_price") or 0)
        if not qty or not avg:
            return p
        multiplier = float(p.get("_multiplier") or 1) or 1
        sec_type = p.get("_secType") or ""
        sym = p.get("symbol")

        new_price = None
        if sec_type == "OPT":
            strike = p.get("strike")
            expiry = p.get("expiry")
            right = p.get("right")
            if sym and strike and expiry and right:
                try:
                    snap = await ib_options.get_option_snapshot(sym, strike, expiry, right)
                except Exception:
                    snap = None
                if snap:
                    new_price = snap.get("mid") or snap.get("last") or snap.get("bid") or snap.get("ask")
        else:
            if sym:
                try:
                    snap = await ib_options.get_quote(sym)
                except Exception:
                    snap = None
                if snap:
                    new_price = snap.get("mid") or snap.get("last") or snap.get("bid") or snap.get("ask")

        if not new_price:
            return p

        new_price = float(new_price)
        upnl = (new_price - avg) * qty * multiplier
        pnl_pct = (new_price - avg) / avg * 100 if avg else 0.0
        return {
            **p,
            "current_price": round(new_price, 4),
            "unrealized_pnl": round(upnl, 2),
            "unrealized_pnl_pct": round(pnl_pct, 2),
        }

    return await asyncio.gather(*(refresh_one(p) for p in positions))


async def _mock_price_broadcaster():
    """Synthetic tick stream for development. Only fires in ``mock_mode`` AND
    when IB Gateway is unavailable — otherwise live IBKR ticks publish through
    the NT data client path."""
    from .nautilus.mock.data import simulate_tick
    from .routers.watchlist import _watchlist

    while True:
        await asyncio.sleep(2)
        if not settings.mock_mode:
            continue
        if manager.connection_count == 0 or ib_node.is_connected:
            continue
        for sym in list(_watchlist.keys()):
            try:
                await manager.broadcast_quote(sym, simulate_tick(sym))
            except Exception as e:
                logger.debug(f"mock tick error for {sym}: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle.

    IBKR Gateway is the only data + brokerage source — provides bars, option
    chains with Greeks, and live positions. When the gateway is unreachable
    and ``mock_mode`` is on, the synthetic broadcaster fills in development
    ticks for the watchlist.
    """
    logger.info("trading API starting (mock_mode=%s)", settings.mock_mode)
    await db.init()
    await ib_node.start()
    mock_task = asyncio.create_task(_mock_price_broadcaster())
    status_task = asyncio.create_task(_status_broadcaster())
    job_scheduler.start()
    try:
        yield
    finally:
        mock_task.cancel()
        status_task.cancel()
        await job_scheduler.shutdown()
        await ib_node.stop()
        await ib_options.shutdown()
        await ib_depth.shutdown()
        await ib_ticks.shutdown()
        await orders_client.disconnect()
        await db.shutdown()
        logger.info("trading API shutdown")


app = FastAPI(
    title="Trading API",
    description="IBKR-backed trading backend (NautilusTrader + ib_async).",
    version="1.0.0",
    lifespan=lifespan,
)

# Middleware ordering: Starlette wraps last-added on the OUTSIDE. We want
#   CORS (outer) -> Logging -> RateLimit -> Sanitize -> route
# so that rate-limit 429s and sanitization 400s still carry CORS headers
# (otherwise browsers drop the error and surface "CORS failure" instead).
app.add_middleware(
    QueryParamSanitizationMiddleware,
    max_string_length=settings.max_string_length,
)
app.add_middleware(
    RateLimitMiddleware,
    max_requests=settings.rate_limit_requests,
    window_seconds=settings.rate_limit_window_seconds,
    exempt_paths=[p.strip() for p in settings.rate_limit_exempt_paths.split(",") if p.strip()],
)
app.add_middleware(RequestLoggingMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins if settings.production_mode else ["*"],
    allow_credentials=settings.production_mode,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
    if settings.production_mode else ["*"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"]
    if settings.production_mode else ["*"],
    expose_headers=["X-Request-ID"],
    max_age=600,
)


class ErrorResponse(BaseModel):
    """Standard error response model for OpenAPI documentation."""
    error: str = Field(..., description="Error type or code")
    message: str = Field(..., description="Human-readable error description")
    details: Optional[Dict[str, Any]] = Field(None, description="Additional error details")


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Return standardized JSON error responses for HTTP exceptions."""
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(
            error=exc.__class__.__name__,
            message=exc.detail,
            details={"status_code": exc.status_code}
        ).dict()
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    """Catch-all error handler for unhandled exceptions."""
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content=ErrorResponse(
            error="InternalServerError",
            message="An unexpected error occurred",
            details={"type": exc.__class__.__name__}
        ).dict()
    )


app.include_router(market.router)
app.include_router(watchlist.router)
app.include_router(strategies.router)
app.include_router(backtest.router)
app.include_router(orders.router)
app.include_router(options.router)
app.include_router(option_analyzer.router)
app.include_router(chat.router)
app.include_router(analyze.router)
app.include_router(fundamentals.router)
app.include_router(agents.router)
app.include_router(monitor_router.router)
app.include_router(scans.router)
from .routers import ruleone  # noqa: E402  (router registration only)
app.include_router(ruleone.router)
from .routers import llm_read  # noqa: E402  (router registration only)
app.include_router(llm_read.router)
from .routers import ai_agents  # noqa: E402  (router registration only)
app.include_router(ai_agents.router)
from .routers import research  # noqa: E402  (router registration only)
app.include_router(research.router)
app.include_router(logos.router)
app.include_router(okw.router)
app.include_router(depth.router)
app.include_router(ticks.router)
app.include_router(agent_tools.router)
app.include_router(agent.router)
app.include_router(trade_history.router)


@app.get(
    "/health",
    response_model=Dict[str, Any],
    summary="Health check endpoint",
    response_description="Returns API health status including IBKR connection state",
    responses={
        200: {
            "description": "Successful health check",
            "content": {
                "application/json": {
                    "example": {
                        "status": "healthy",
                        "ib_connected": True,
                        "mode": "live",
                        "mock_mode": False,
                        "ws_connections": 3
                    }
                }
            }
        }
    }
)
def health_check():
    """Health probe. IBKR Gateway is the sole brokerage."""
    return {
        "status": "healthy",
        "ib_connected": ib_node.is_connected,
        "mode": settings.trading_mode,
        "mock_mode": settings.mock_mode,
        "ws_connections": manager.connection_count,
    }


@app.get(
    "/",
    summary="Root endpoint",
    response_description="Returns basic API information",
    responses={
        200: {
            "description": "Successful response",
            "content": {
                "application/json": {
                    "example": {
                        "message": "Trading API",
                        "version": "1.0.0",
                        "docs": "/docs",
                        "redoc": "/redoc"
                    }
                }
            }
        }
    }
)
def root():
    return {"message": "Trading API", "version": "1.0.0", "docs": "/docs", "redoc": "/redoc"}


@app.websocket("/api/ws/trades")
async def trades_websocket(websocket: WebSocket):
    """Real-time trade event stream: fill, cancel, error.

    Server-pushed only — incoming messages are drained and ignored so clients
    can send pings without crashing the receive loop.
    """
    await trades_channel.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        trades_channel.disconnect(websocket)
    except Exception as e:
        logger.debug("trades ws error: %s", e)
        trades_channel.disconnect(websocket)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    client_id = str(uuid.uuid4())[:8]
    await manager.connect(client_id, websocket)
    try:
        await manager.send(client_id, {
            "type": "connected",
            "client_id": client_id,
            "ib_connected": ib_node.is_connected,
        })
        while True:
            data = await websocket.receive_json()
            if data.get("action") == "subscribe":
                symbols = [s.upper() for s in data.get("symbols", [])]
                manager._subscriptions[client_id].update(symbols)
                for sym in symbols:
                    await ib_node.ensure_subscribed(sym)
                await manager.send(client_id, {"type": "subscribed", "symbols": symbols})
    except WebSocketDisconnect:
        manager.disconnect(client_id)
    except Exception as e:
        logger.debug(f"ws error for {client_id}: {e}")
        manager.disconnect(client_id)
