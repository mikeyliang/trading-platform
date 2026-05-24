"""Tests for GET /api/agent/trades."""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

_API_DIR = Path(__file__).resolve().parents[1] / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.routers.agent import require_agent_key, router as agent_router  # noqa: E402
from app.services import db  # noqa: E402


_SAMPLE_ROWS = [
    {
        "symbol": "AAPL",
        "side": "buy",
        "quantity": 100,
        "price": 182.5,
        "status": "FILLED",
        "timestamp": datetime(2026, 5, 24, 14, 30, 0, tzinfo=timezone.utc),
    },
    {
        "symbol": "MSFT",
        "side": "sell",
        "quantity": 50,
        "price": 410.0,
        "status": "FILLED",
        "timestamp": datetime(2026, 5, 24, 13, 15, 0, tzinfo=timezone.utc),
    },
]


class _FakeConn:
    def __init__(self, rows):
        self._rows = rows

    async def fetch(self, query, *args):
        return list(self._rows)


class _FakePool:
    def __init__(self, rows):
        self._rows = rows

    def acquire(self):
        @asynccontextmanager
        async def _cm():
            yield _FakeConn(self._rows)

        return _cm()


@pytest.fixture
def app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(agent_router)
    test_app.dependency_overrides[require_agent_key] = lambda: None
    return test_app


@pytest.mark.asyncio
async def test_list_agent_trades_returns_filled_rows(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(db, "pool", lambda: _FakePool(_SAMPLE_ROWS))

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/agent/trades")

    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) == 2

    first = body[0]
    assert set(first.keys()) == {
        "symbol",
        "side",
        "quantity",
        "price",
        "status",
        "timestamp",
    }
    assert first["symbol"] == "AAPL"
    assert first["side"] == "buy"
    assert first["quantity"] == 100.0
    assert first["price"] == 182.5
    assert first["status"] == "FILLED"
    assert first["timestamp"].startswith("2026-05-24T14:30:00")

    second = body[1]
    assert second["symbol"] == "MSFT"
    assert second["side"] == "sell"
    assert second["quantity"] == 50.0
    assert second["price"] == 410.0
    assert second["status"] == "FILLED"
