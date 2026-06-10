"""Tests for the equity research catalog / pricing / estimate endpoints."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

# Make the `app` package importable: api/ contains app/__init__.py.
_API_DIR = Path(__file__).resolve().parents[1] / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.routers.research import router as research_router  # noqa: E402
from app.services.equity_agents import ANALYSTS, DEPTHS, run_cost  # noqa: E402


@pytest.fixture
def app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(research_router)
    return test_app


def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_catalog_lists_analysts_and_depths(app: FastAPI) -> None:
    async with _client(app) as client:
        resp = await client.get("/api/research/catalog")
    assert resp.status_code == 200
    body = resp.json()
    ids = {a["id"] for a in body["analysts"]}
    assert ids == set(ANALYSTS)
    assert {d["id"] for d in body["depths"]} == set(DEPTHS)
    assert body["asset_classes"] == ["stock", "etf", "crypto"]
    # On-chain analyst is crypto-only.
    onchain = next(a for a in body["analysts"] if a["id"] == "onchain")
    assert onchain["asset_classes"] == ["crypto"]


@pytest.mark.asyncio
async def test_pricing_has_plans_and_packs(app: FastAPI) -> None:
    async with _client(app) as client:
        resp = await client.get("/api/research/pricing")
    assert resp.status_code == 200
    body = resp.json()
    assert {p["id"] for p in body["plans"]} == {"free", "pro", "desk"}
    assert all(p["credits"] > 0 and p["price_usd"] > 0 for p in body["packs"])
    assert body["example_costs"]["quick"] < body["example_costs"]["deep"]


def test_run_cost_math() -> None:
    # quick: analysts + decision only
    assert run_cost(["market"], "quick") == 2 + 2
    # standard adds one debate round + trader
    assert run_cost(["market", "news"], "standard") == 4 + 2 + 3 + 2
    # deep adds a second round + risk review
    assert run_cost(["market", "news"], "deep") == 4 + 2 + 6 + 2 + 3


@pytest.mark.asyncio
async def test_estimate_matches_run_cost(app: FastAPI) -> None:
    async with _client(app) as client:
        resp = await client.post(
            "/api/research/estimate",
            json={"analysts": ["market", "fundamentals", "news"], "depth": "deep"},
        )
    assert resp.status_code == 200
    assert resp.json()["cost"] == run_cost(["market", "fundamentals", "news"], "deep")


@pytest.mark.asyncio
async def test_estimate_rejects_unknown_analyst(app: FastAPI) -> None:
    async with _client(app) as client:
        resp = await client.post(
            "/api/research/estimate",
            json={"analysts": ["astrology"], "depth": "quick"},
        )
    assert resp.status_code == 422
