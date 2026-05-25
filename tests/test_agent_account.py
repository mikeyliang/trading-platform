"""Tests for GET /api/agent/account."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

_API_DIR = Path(__file__).resolve().parents[1] / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.nautilus import ib_options  # noqa: E402
from app.nautilus.ib_node import ib_node  # noqa: E402
from app.routers.agent import require_agent_key, router as agent_router  # noqa: E402


@pytest.fixture
def app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(agent_router)
    test_app.dependency_overrides[require_agent_key] = lambda: None
    return test_app


@pytest.mark.asyncio
async def test_agent_account_returns_summary(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        type(ib_node), "is_connected", property(lambda self: True)
    )

    async def fake_get_account_summary():
        return {"balance": 100000, "buying_power": 50000, "equity": 100000}

    async def fake_get_positions():
        return []

    monkeypatch.setattr(ib_options, "get_account_summary", fake_get_account_summary)
    monkeypatch.setattr(ib_options, "get_positions", fake_get_positions)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/agent/account")

    assert resp.status_code == 200
    body = resp.json()
    assert body["balance"] == 100000
    assert body["buying_power"] == 50000
    assert body["equity"] == 100000
    assert body["daily_pnl"] == 0
