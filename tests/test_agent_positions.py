"""Tests for GET /api/agent/positions."""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager
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
    {"id": 11, "symbol": "AAPL", "quantity": 100, "price": 182.5, "pnl": 42.10},
    {"id": 12, "symbol": "MSFT", "quantity": 50, "price": 410.0, "pnl": -15.0},
    {"id": 13, "symbol": "TSLA", "quantity": 25, "price": 220.75, "pnl": None},
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
async def test_agent_positions_returns_open_rows(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(db, "pool", lambda: _FakePool(_SAMPLE_ROWS))

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/agent/positions")

    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) == 3

    first = body[0]
    assert set(first.keys()) == {"id", "symbol", "size", "entry_price", "current_pnl"}
    assert first["id"] == 11
    assert first["symbol"] == "AAPL"
    assert first["size"] == 100.0
    assert first["entry_price"] == 182.5
    assert first["current_pnl"] == pytest.approx(42.10)

    # Null pnl should serialize as null, not be omitted.
    assert body[2]["current_pnl"] is None


@pytest.mark.asyncio
async def test_agent_positions_db_unavailable(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(db, "pool", lambda: None)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/agent/positions")

    assert resp.status_code == 503
