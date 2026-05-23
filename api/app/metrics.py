"""Prometheus metrics for the trading API.

Two layers:

* HTTP request count + latency histograms come from
  ``prometheus-fastapi-instrumentator``, which auto-instruments every route
  registered on the FastAPI app. It is wired up in :mod:`app.main`.

* Trading-specific counters live here so callers (the strategy engine,
  routers, the ib_async orders client) can increment them at the moment a
  real order or position is opened — not at the HTTP layer, which can't see
  the difference between a failed gateway call and a real fill.

Labels are kept low-cardinality on purpose. ``symbol`` is fine because the
universe is small (watchlists / scanned tickers); never label by user, order
id, or anything unbounded.
"""
from __future__ import annotations

from prometheus_client import Counter

ORDERS_PLACED = Counter(
    "trading_orders_placed_total",
    "Number of broker orders submitted (one per placeOrder call).",
    labelnames=("symbol", "side", "order_type"),
)

POSITIONS_OPENED = Counter(
    "trading_positions_opened_total",
    "Number of new positions opened (multi-leg spreads count as one position).",
    labelnames=("symbol", "strategy"),
)

POSITIONS_CLOSED = Counter(
    "trading_positions_closed_total",
    "Number of positions closed (including partial / early closes).",
    labelnames=("symbol", "strategy"),
)
