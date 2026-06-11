"""Tests for the IBKR fill → trade_history mapping."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

_API_DIR = Path(__file__).resolve().parents[1] / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from app.services.ib_trade_log import _fill_to_trade  # noqa: E402

_TS = datetime(2026, 6, 10, 14, 32, 11, tzinfo=timezone.utc)
_IB_DBL_MAX = 1.7976931348623157e308


def _stock_fill(**overrides):
    exe = SimpleNamespace(
        execId="0001.abc.01", side="BOT", shares=10, price=458.12,
        exchange="NASDAQ", orderId=7, permId=99, acctNumber="DU123",
        orderRef="", time=_TS,
    )
    con = SimpleNamespace(symbol="AAPL", secType="STK")
    cr = SimpleNamespace(commission=1.05, realizedPNL=_IB_DBL_MAX)
    fill = SimpleNamespace(execution=exe, contract=con, commissionReport=cr)
    for k, v in overrides.items():
        setattr(fill, k, v)
    return fill


def test_stock_buy_maps_to_trade_row():
    row = _fill_to_trade(_stock_fill())
    assert row is not None
    assert row["symbol"] == "AAPL"
    assert row["side"] == "BUY"
    assert row["quantity"] == 10
    assert row["price"] == 458.12
    assert row["status"] == "FILLED"
    assert row["timestamp"] == _TS
    meta = row["metadata_"]
    assert meta["source"] == "ibkr"
    assert meta["exec_id"] == "0001.abc.01"
    assert meta["commission"] == 1.05
    # DBL_MAX sentinel must not leak into pnl
    assert row["pnl"] is None


def test_option_sell_with_realized_pnl():
    exe = SimpleNamespace(
        execId="0002.def.01", side="SLD", shares=2, price=5.30,
        exchange="CBOE", orderId=8, permId=100, acctNumber="DU123",
        orderRef="bull-put-spy", time=_TS,
    )
    con = SimpleNamespace(
        symbol="SPY", secType="OPT", strike=450.0,
        lastTradeDateOrContractMonth="20260717", right="C", multiplier="100",
    )
    cr = SimpleNamespace(commission=1.30, realizedPNL=212.40)
    row = _fill_to_trade(SimpleNamespace(execution=exe, contract=con, commissionReport=cr))
    assert row is not None
    assert row["side"] == "SELL"
    assert row["pnl"] == 212.40
    assert row["strategy"] == "bull-put-spy"
    meta = row["metadata_"]
    assert meta["sec_type"] == "OPT"
    assert meta["strike"] == 450.0
    assert meta["right"] == "C"
    assert meta["expiry"] == "20260717"
    assert meta["multiplier"] == 100.0


def test_malformed_fills_are_skipped():
    assert _fill_to_trade(SimpleNamespace(execution=None, contract=None)) is None
    no_exec_id = _stock_fill()
    no_exec_id.execution.execId = ""
    assert _fill_to_trade(no_exec_id) is None
    zero_qty = _stock_fill()
    zero_qty.execution.shares = 0
    assert _fill_to_trade(zero_qty) is None
