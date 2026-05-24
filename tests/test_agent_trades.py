"""Tests for POST /api/agent/trades."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

_API_DIR = Path(__file__).resolve().parents[1] / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.nautilus import ib_orders  # noqa: E402
from app.routers.agent import require_agent_key, router as agent_router  # noqa: E402


@pytest.fixture
def app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(agent_router)
    test_app.dependency_overrides[require_agent_key] = lambda: None
    return test_app


@pytest.mark.asyncio
async def test_place_agent_trade_returns_order_id(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_place_stock_order(**kwargs):
        return {"order_id": "123", "status": "submitted"}

    monkeypatch.setattr(
        ib_orders.orders_client, "place_stock_order", fake_place_stock_order
    )

    payload = {
        "symbol": "AAPL",
        "quantity": 10,
        "side": "buy",
        "order_type": "market",
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/api/agent/trades", json=payload)

    assert resp.status_code == 201
    body = resp.json()
    assert body["order_id"] == "123"


@pytest.mark.asyncio
async def test_place_agent_trade_missing_symbol_returns_422(app: FastAPI) -> None:
    payload = {
        "quantity": 10,
        "side": "buy",
        "order_type": "market",
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/api/agent/trades", json=payload)

    assert resp.status_code == 422
