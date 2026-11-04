"""Smoke tests that run without a database or an IBKR gateway.

They pin the two fixes CI used to fall over on: the trade-history store's
exec-id lookup and the nautilus engine's config filtering.
"""
import asyncio
from dataclasses import fields

from app.services import trade_history_store
from app.strategies.bull_put_spread import BullPutSpreadConfig


def test_existing_exec_ids_empty_input_short_circuits():
    # No candidates means nothing to look up, with or without a pool.
    assert asyncio.run(trade_history_store.existing_exec_ids([])) == set()


def test_existing_exec_ids_without_pool_reports_unavailable(monkeypatch):
    monkeypatch.setattr(trade_history_store.db, "pool", lambda: None)
    assert asyncio.run(trade_history_store.existing_exec_ids(["abc"])) is None


def test_bull_put_spread_config_fields_are_enumerable():
    names = {f.name for f in fields(BullPutSpreadConfig)}
    assert "symbol" in names
