"""Postgres connection pool + schema init.

asyncpg with raw SQL — no ORM. Schema lives in ``SCHEMA_SQL`` below, applied
idempotently on startup. Use ``pool()`` to acquire a connection.
"""
from __future__ import annotations

import logging
from typing import Optional

import asyncpg

from ..config import settings

logger = logging.getLogger(__name__)

_pool: Optional[asyncpg.Pool] = None

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS scans (
  id              BIGSERIAL PRIMARY KEY,
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scope           TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  recommendation  TEXT,
  payload         JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS scans_ran_at_idx ON scans (ran_at DESC);
CREATE INDEX IF NOT EXISTS scans_symbol_idx ON scans (symbol, ran_at DESC);

-- OKW-style trade tracker. One row per placed bull-put spread (manual
-- entry or wired from a future Place flow). Captures the exact metrics
-- Jamal's Options Kelly Workbook uses + lifecycle status.
CREATE TABLE IF NOT EXISTS okw_trades (
  id              BIGSERIAL PRIMARY KEY,
  placed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,
  symbol          TEXT NOT NULL,
  trade_type      TEXT NOT NULL,                   -- rut | mars | marsmax | space
  side            TEXT NOT NULL DEFAULT 'put',     -- put | call
  expiry          TEXT NOT NULL,                   -- YYYYMMDD
  dte             INTEGER NOT NULL,
  short_strike    NUMERIC NOT NULL,
  long_strike     NUMERIC NOT NULL,
  width           NUMERIC NOT NULL,
  contracts       INTEGER NOT NULL DEFAULT 1,
  credit          NUMERIC NOT NULL,
  spot_at_open    NUMERIC,
  short_delta     NUMERIC,                         -- 0..1, e.g. 0.10
  aroc_pct        NUMERIC,
  kelly_pct       NUMERIC,
  adj_distance_pct NUMERIC,
  fib_floor1      NUMERIC,                         -- recorded even if not required
  fib_floor2      NUMERIC,
  status          TEXT NOT NULL DEFAULT 'open',    -- open | closed | expired
  exit_reason     TEXT,                            -- delta | 2pct | profit | manual
  realized_pnl    NUMERIC,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS okw_trades_placed_at_idx ON okw_trades (placed_at DESC);
CREATE INDEX IF NOT EXISTS okw_trades_status_idx ON okw_trades (status, placed_at DESC);
CREATE INDEX IF NOT EXISTS okw_trades_type_idx ON okw_trades (trade_type, placed_at DESC);

-- Forecast log: every prediction we make is recorded with the
-- last-known close and the predicted return. A nightly job (or
-- lazy backfill on read) scores forecasts whose horizon has elapsed
-- by writing the actual realized return — these residuals power
-- conformal calibration and per-model accuracy tracking.
CREATE TABLE IF NOT EXISTS forecast_log (
  id                BIGSERIAL PRIMARY KEY,
  made_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scored_at         TIMESTAMPTZ,
  symbol            TEXT NOT NULL,
  model             TEXT NOT NULL,         -- chronos | momentum | mean_reversion | martingale | ensemble
  horizon           INTEGER NOT NULL,      -- in trading days
  anchor_close      NUMERIC NOT NULL,      -- the close we forecasted FROM
  predicted_median  NUMERIC NOT NULL,      -- p50 terminal price
  predicted_p10     NUMERIC NOT NULL,
  predicted_p90     NUMERIC NOT NULL,
  predicted_return  NUMERIC NOT NULL,      -- (median - anchor) / anchor
  actual_return     NUMERIC,               -- filled in once horizon has elapsed
  abs_residual      NUMERIC                -- |predicted_return - actual_return|
);

CREATE INDEX IF NOT EXISTS forecast_log_made_at_idx ON forecast_log (made_at DESC);
CREATE INDEX IF NOT EXISTS forecast_log_sym_model_h_idx ON forecast_log (symbol, model, horizon, made_at DESC);
CREATE INDEX IF NOT EXISTS forecast_log_unscored_idx ON forecast_log (scored_at, made_at) WHERE scored_at IS NULL;

-- AI analyzer runs. Each row is one multi-agent run (news + underlying
-- + option + position synthesis) on a contract. agents JSONB holds the
-- per-agent prompt / output / model / latency so we can replay any run
-- and show historical reads on the same contract.
CREATE TABLE IF NOT EXISTS ai_runs (
  id              BIGSERIAL PRIMARY KEY,
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol          TEXT NOT NULL,
  strike          NUMERIC NOT NULL,
  expiry          TEXT NOT NULL,
  right_          TEXT NOT NULL,
  quantity        INTEGER NOT NULL,
  is_long         BOOLEAN NOT NULL,
  spot_at_run     NUMERIC,
  mid_at_run      NUMERIC,
  agents          JSONB NOT NULL,
  duration_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS ai_runs_contract_idx ON ai_runs (symbol, strike, expiry, right_, ran_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_ran_at_idx ON ai_runs (ran_at DESC);

CREATE TABLE IF NOT EXISTS trade_history (
  id               BIGSERIAL PRIMARY KEY,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol           TEXT,
  side             TEXT CHECK (side IN ('buy', 'sell')),
  quantity         NUMERIC,
  price            NUMERIC,
  order_type       TEXT,
  status           TEXT,
  pnl              NUMERIC,
  pnl_percentage   NUMERIC,
  strategy         TEXT,
  agent_id         TEXT,
  metadata_        JSONB,
  is_deleted       BOOLEAN NOT NULL DEFAULT FALSE
);

-- External identifier for trades sourced from IBKR Flex / activity exports.
-- Used to make re-pulls idempotent: source='ibkr_flex', external_id=ibExecID.
ALTER TABLE trade_history ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE trade_history ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS trade_history_external_id_uq
  ON trade_history (source, external_id)
  WHERE source IS NOT NULL AND external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS trade_history_symbol_idx ON trade_history (symbol);
CREATE INDEX IF NOT EXISTS trade_history_agent_id_idx ON trade_history (agent_id);
CREATE INDEX IF NOT EXISTS trade_history_strategy_idx ON trade_history (strategy);
CREATE INDEX IF NOT EXISTS trade_history_timestamp_idx ON trade_history (timestamp DESC);
"""


async def init() -> None:
    """Create the connection pool + apply schema. Idempotent."""
    global _pool
    if _pool is not None:
        return
    try:
        _pool = await asyncpg.create_pool(
            settings.database_url,
            min_size=1,
            max_size=4,
            timeout=10,
            command_timeout=30,
        )
        async with _pool.acquire() as conn:
            await conn.execute(SCHEMA_SQL)
        logger.info("postgres pool ready")
    except Exception as e:  # noqa: BLE001
        logger.warning("postgres init failed (%s) — scan history disabled", e)
        _pool = None


async def shutdown() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> Optional[asyncpg.Pool]:
    """Return the pool or None if init failed. Callers should treat None as
    "no persistence available" and continue without storing."""
    return _pool


def is_available() -> bool:
    return _pool is not None
