"""Tests for the credits system + run-endpoint gating (in-memory store)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

_API_DIR = Path(__file__).resolve().parents[1] / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.config import settings  # noqa: E402
from app.routers.research import router as research_router  # noqa: E402
from app.services import credits, db  # noqa: E402


@pytest.fixture(autouse=True)
def memory_store(monkeypatch: pytest.MonkeyPatch):
    """Force the in-memory fallback and wipe it between tests."""
    monkeypatch.setattr(db, "pool", lambda: None)
    credits.reset_memory_store()
    yield
    credits.reset_memory_store()


@pytest.fixture
def app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(research_router)
    return test_app


def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_new_account_gets_signup_credits(app: FastAPI) -> None:
    async with _client(app) as client:
        resp = await client.get("/api/research/credits", headers={"X-User-Id": "alice"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["balance"] == settings.free_signup_credits
    assert body["plan"] == "free"
    assert body["ledger"][0]["reason"] == "signup_grant"


@pytest.mark.asyncio
async def test_checkout_grants_pack_in_dev_mode(app: FastAPI) -> None:
    async with _client(app) as client:
        resp = await client.post(
            "/api/research/credits/checkout",
            json={"pack_id": "starter"},
            headers={"X-User-Id": "bob"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["granted"] is True
    pack = credits.pack_by_id("starter")
    assert body["balance"] == settings.free_signup_credits + pack["credits"]


@pytest.mark.asyncio
async def test_checkout_unknown_pack_404(app: FastAPI) -> None:
    async with _client(app) as client:
        resp = await client.post(
            "/api/research/credits/checkout", json={"pack_id": "nope"}
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_adjust_rejects_overdraft() -> None:
    await credits.get_account("carol")
    with pytest.raises(credits.InsufficientCreditsError):
        await credits.adjust("carol", -(settings.free_signup_credits + 1), "test")
    # Balance unchanged after the failed debit.
    acct = await credits.get_account("carol")
    assert acct["balance"] == settings.free_signup_credits


@pytest.mark.asyncio
async def test_run_requires_api_key(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    async with _client(app) as client:
        resp = await client.post(
            "/api/research/run",
            json={"symbol": "AAPL", "asset_class": "stock"},
        )
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_run_rejects_insufficient_credits(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    # Drain the account below the cost of a standard 3-analyst run (13).
    await credits.get_account("dave")
    await credits.adjust("dave", -(settings.free_signup_credits - 5), "drain")
    async with _client(app) as client:
        resp = await client.post(
            "/api/research/run",
            json={"symbol": "AAPL", "asset_class": "stock", "depth": "standard"},
            headers={"X-User-Id": "dave"},
        )
    assert resp.status_code == 402
    assert "insufficient credits" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_run_rejects_bad_selection(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    async with _client(app) as client:
        # onchain analyst is crypto-only — invalid on a stock run.
        resp = await client.post(
            "/api/research/run",
            json={"symbol": "AAPL", "asset_class": "stock", "analysts": ["onchain"]},
        )
    assert resp.status_code == 422
