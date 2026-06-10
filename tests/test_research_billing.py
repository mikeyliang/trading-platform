"""Tests for Stripe webhook verification + plan subscription (dev mode)."""
from __future__ import annotations

import hashlib
import hmac
import json
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

_API_DIR = Path(__file__).resolve().parents[1] / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.config import settings  # noqa: E402
from app.routers.research import router as research_router  # noqa: E402
from app.services import billing, credits, db  # noqa: E402


@pytest.fixture(autouse=True)
def memory_store(monkeypatch: pytest.MonkeyPatch):
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


def _signed(payload: bytes, secret: str, ts: int | None = None) -> str:
    t = ts if ts is not None else int(time.time())
    mac = hmac.new(secret.encode(), f"{t}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={t},v1={mac}"


def _event(user_id: str, session_id: str = "cs_test_123", credits_amount: int = 100) -> bytes:
    return json.dumps({
        "type": "checkout.session.completed",
        "data": {"object": {
            "id": session_id,
            "metadata": {"user_id": user_id, "pack_id": "starter", "credits": str(credits_amount)},
        }},
    }).encode()


def test_signature_roundtrip(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "stripe_webhook_secret", "whsec_test")
    payload = _event("alice")
    assert billing.verify_webhook_signature(payload, _signed(payload, "whsec_test"))
    # Wrong secret fails.
    assert not billing.verify_webhook_signature(payload, _signed(payload, "whsec_other"))
    # Stale timestamp fails (replay protection).
    stale = _signed(payload, "whsec_test", ts=int(time.time()) - 3600)
    assert not billing.verify_webhook_signature(payload, stale)


@pytest.mark.asyncio
async def test_webhook_grants_once(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "stripe_webhook_secret", "whsec_test")
    payload = _event("erin", credits_amount=100)
    headers = {"stripe-signature": _signed(payload, "whsec_test")}
    async with _client(app) as client:
        first = await client.post("/api/research/stripe/webhook", content=payload, headers=headers)
        second = await client.post("/api/research/stripe/webhook", content=payload, headers=headers)
    assert first.status_code == 200 and first.json()["acted"] is True
    assert second.status_code == 200 and second.json().get("duplicate") is True
    acct = await credits.get_account("erin")
    # Signup grant + exactly one 100-credit grant despite the replay.
    assert acct["balance"] == settings.free_signup_credits + 100


@pytest.mark.asyncio
async def test_webhook_rejects_bad_signature(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "stripe_webhook_secret", "whsec_test")
    payload = _event("frank")
    async with _client(app) as client:
        resp = await client.post(
            "/api/research/stripe/webhook",
            content=payload,
            headers={"stripe-signature": "t=0,v1=deadbeef"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_plan_subscribe_dev_mode(app: FastAPI) -> None:
    async with _client(app) as client:
        resp = await client.post(
            "/api/research/plan/subscribe",
            json={"plan_id": "pro"},
            headers={"X-User-Id": "gina"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["plan"] == "pro"
    pro = credits.plan_by_id("pro")
    assert body["balance"] == settings.free_signup_credits + pro["credits_month"]
