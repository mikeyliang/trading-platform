"""Tests for GET /api/agent/health."""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

# Make the `app` package importable: api/ contains app/__init__.py.
_API_DIR = Path(__file__).resolve().parents[1] / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.nautilus.ib_node import ib_node  # noqa: E402
from app.routers.agent import require_agent_key, router as agent_router  # noqa: E402
from app.services import db  # noqa: E402


class _FakeConn:
    async def fetchval(self, query, *args):
        return 1


class _FakePool:
    def acquire(self):
        @asynccontextmanager
        async def _cm():
            yield _FakeConn()

        return _cm()


@pytest.fixture
def app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(agent_router)
    # Bypass the X-Agent-Key check — the dependency is exercised elsewhere.
    test_app.dependency_overrides[require_agent_key] = lambda: None
    return test_app


@pytest.mark.asyncio
async def test_agent_health_ok(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    # is_connected is a @property on the IBNode class; patch on the type.
    monkeypatch.setattr(
        type(ib_node), "is_connected", property(lambda self: True)
    )
    monkeypatch.setattr(db, "pool", lambda: _FakePool())

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/agent/health")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["ibkr_connected"] is True
    assert body["db_connected"] is True
    assert isinstance(body["timestamp"], str) and body["timestamp"]
