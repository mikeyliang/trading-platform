"""
Conformal calibration for probabilistic forecasts.

Forecast models (Chronos included) tend to be overconfident — their p10/p90
bands cover the realized outcome less often than the nominal 80%. Conformal
calibration fixes this empirically: take the last N forecast residuals,
compute the empirical quantile that *would have* contained 80% of them, and
widen the model's bands to that quantile.

Implementation:
  * Each forecast we make is logged to `forecast_log` in Postgres.
  * On scoring (horizon elapsed), we record the actual realized return.
  * On every new forecast, we look up the recent residual distribution
    for that (symbol, model, horizon) and widen p10/p90 by the
    appropriate scale factor.
  * If no calibration data exists yet, we pass through the model's
    native bands unchanged.

This is the "split conformal" variant — simple, well-understood, no
distributional assumptions. Reference: Vovk, Gammerman, Shafer (2005);
"Conformal Prediction" (Angelopoulos, Bates, 2021).
"""
from __future__ import annotations

import logging
import math
from datetime import timedelta
from typing import Any, Dict, List, Optional

from ..services import db

logger = logging.getLogger(__name__)

# How many recent residuals to use for calibration. ~3 months of daily
# forecasts. Smaller window → more responsive to regime changes; larger
# window → more stable estimate.
_RESIDUAL_WINDOW = 60

# Minimum residuals required before we trust the empirical quantile.
# Below this, fall back to the model's native bands.
_MIN_RESIDUALS = 12


async def log_forecast(
    symbol: str,
    model: str,
    horizon: int,
    anchor_close: float,
    predicted_median: float,
    predicted_p10: float,
    predicted_p90: float,
) -> Optional[int]:
    """Record a forecast so we can score it later. Returns the row id
    or None if persistence is unavailable.

    Idempotent across (symbol, model, horizon, made_at-on-the-same-day):
    callers can fire-and-forget; duplicate entries in a 24h window are
    suppressed at the SQL level via a uniqueness check on the date.
    """
    p = db.pool()
    if p is None:
        return None
    predicted_return = (predicted_median - anchor_close) / anchor_close if anchor_close else 0.0
    try:
        async with p.acquire() as conn:
            # Dedupe: don't insert another (symbol, model, horizon) row
            # within the same UTC day — we only need one anchor per day.
            existing = await conn.fetchval(
                "SELECT id FROM forecast_log "
                "WHERE symbol = $1 AND model = $2 AND horizon = $3 "
                "  AND made_at >= date_trunc('day', NOW())",
                symbol, model, horizon,
            )
            if existing is not None:
                return existing
            row_id = await conn.fetchval(
                """
                INSERT INTO forecast_log
                  (symbol, model, horizon, anchor_close,
                   predicted_median, predicted_p10, predicted_p90, predicted_return)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id
                """,
                symbol, model, horizon,
                float(anchor_close),
                float(predicted_median),
                float(predicted_p10),
                float(predicted_p90),
                float(predicted_return),
            )
            return row_id
    except Exception as e:  # noqa: BLE001
        logger.debug("log_forecast failed: %s", e)
        return None


async def score_outstanding(
    fetch_close: Any,
    max_rows: int = 500,
) -> int:
    """Score forecasts whose horizon has elapsed.

    `fetch_close(symbol, target_date)` is an async callable returning the
    closing price on `target_date` (a `date`) or None if unavailable. We pass
    this in to keep the calibration module decoupled from market data fetching.

    Returns the number of rows scored.
    """
    p = db.pool()
    if p is None:
        return 0
    scored = 0
    try:
        async with p.acquire() as conn:
            # Pull unscored rows whose horizon has elapsed (made_at + horizon trading days < now).
            # Approximation: use calendar days × 1.4 to crudely convert to trading days.
            rows = await conn.fetch(
                """
                SELECT id, symbol, horizon, anchor_close, predicted_return, made_at
                FROM forecast_log
                WHERE scored_at IS NULL
                  AND made_at < NOW() - (horizon * INTERVAL '1.4 days')
                ORDER BY made_at ASC
                LIMIT $1
                """,
                max_rows,
            )
            for r in rows:
                target_date = (r["made_at"] + timedelta(days=int(r["horizon"] * 1.4))).date()
                close = await fetch_close(r["symbol"], target_date)
                if close is None or close <= 0:
                    continue
                actual_return = (close - r["anchor_close"]) / r["anchor_close"] if r["anchor_close"] else 0.0
                abs_resid = abs(actual_return - float(r["predicted_return"]))
                await conn.execute(
                    """
                    UPDATE forecast_log
                    SET actual_return = $2, abs_residual = $3, scored_at = NOW()
                    WHERE id = $1
                    """,
                    r["id"], float(actual_return), float(abs_resid),
                )
                scored += 1
    except Exception as e:  # noqa: BLE001
        logger.warning("score_outstanding failed: %s", e)
    return scored


async def apply_calibration(
    forecast: Dict[str, Any],
    symbol: str,
    model: str,
) -> Dict[str, Any]:
    """Widen p10/p90 bands of a forecast using recent residuals.

    Mutates and returns the input forecast dict. Each horizon's bands
    are adjusted independently based on residuals for that horizon.
    Adds a `calibration` block to the result:
      {
        "samples": int,            # how many residuals were used
        "scale_factor_per_h": {    # multiplier applied to band width
          "1": 1.23, "5": 1.05, ...
        },
        "coverage_observed_per_h": {  # empirical hit rate of native bands
          "1": 0.71, ...           # 0..1, ideally ≈ 0.8
        }
      }
    """
    p = db.pool()
    if p is None or not forecast or "horizons" not in forecast:
        return forecast

    samples_total = 0
    scale_per_h: Dict[str, float] = {}
    coverage_per_h: Dict[str, float] = {}

    try:
        async with p.acquire() as conn:
            for hk, hf in forecast["horizons"].items():
                horizon = int(hk)
                rows = await conn.fetch(
                    """
                    SELECT abs_residual, predicted_return, actual_return,
                           predicted_p10, predicted_p90, anchor_close
                    FROM forecast_log
                    WHERE symbol = $1 AND model = $2 AND horizon = $3
                      AND scored_at IS NOT NULL
                    ORDER BY made_at DESC
                    LIMIT $4
                    """,
                    symbol, model, horizon, _RESIDUAL_WINDOW,
                )
                if len(rows) < _MIN_RESIDUALS:
                    continue
                samples_total = max(samples_total, len(rows))

                # Empirical 80% quantile of absolute residual = the band radius
                # that *would have* contained 80% of past actual returns.
                abs_resids = sorted(float(r["abs_residual"]) for r in rows)
                idx_80 = int(0.80 * len(abs_resids))
                empirical_radius = abs_resids[min(idx_80, len(abs_resids) - 1)]

                # Model's native band radius (average from logged forecasts).
                native_radii = []
                for r in rows:
                    p10_ret = (float(r["predicted_p10"]) - float(r["anchor_close"])) / float(r["anchor_close"])
                    p90_ret = (float(r["predicted_p90"]) - float(r["anchor_close"])) / float(r["anchor_close"])
                    native_radii.append((p90_ret - p10_ret) / 2)
                native_radius = sum(native_radii) / len(native_radii) if native_radii else 0
                if native_radius <= 0:
                    continue

                scale = empirical_radius / native_radius
                # Clamp: don't trust extreme scales from sparse data.
                scale = max(0.5, min(3.0, scale))
                scale_per_h[hk] = round(scale, 3)

                # Coverage observed: what % of native p10/p90 bands actually contained the realized return?
                hits = 0
                for r in rows:
                    if r["actual_return"] is None or r["predicted_p10"] is None:
                        continue
                    p10_ret = (float(r["predicted_p10"]) - float(r["anchor_close"])) / float(r["anchor_close"])
                    p90_ret = (float(r["predicted_p90"]) - float(r["anchor_close"])) / float(r["anchor_close"])
                    if p10_ret <= float(r["actual_return"]) <= p90_ret:
                        hits += 1
                coverage_per_h[hk] = round(hits / len(rows), 3)

                # Apply scale: stretch p10/p90 around the median.
                med_path = hf.get("median", [])
                p10_path = hf.get("p10", [])
                p90_path = hf.get("p90", [])
                anchor = forecast.get("last_close", 0)
                for i in range(len(med_path)):
                    if anchor <= 0:
                        continue
                    med_ret = (med_path[i] - anchor) / anchor
                    # Scale the symmetric band width around the median's log price.
                    new_p10_ret = med_ret - (med_ret - (p10_path[i] - anchor) / anchor) * scale
                    new_p90_ret = med_ret + ((p90_path[i] - anchor) / anchor - med_ret) * scale
                    p10_path[i] = round(anchor * (1 + new_p10_ret), 4)
                    p90_path[i] = round(anchor * (1 + new_p90_ret), 4)
                # Recompute terminal band_pct.
                if anchor > 0 and p10_path and p90_path:
                    hf["band_pct"] = round((p90_path[-1] - p10_path[-1]) / anchor * 100, 2)
    except Exception as e:  # noqa: BLE001
        logger.debug("apply_calibration failed: %s", e)

    if samples_total > 0:
        forecast["calibration"] = {
            "samples": samples_total,
            "scale_factor_per_h": scale_per_h,
            "coverage_observed_per_h": coverage_per_h,
        }
    return forecast


async def model_accuracy(
    symbol: Optional[str] = None,
    horizon: Optional[int] = None,
    limit: int = 500,
) -> Dict[str, Any]:
    """Aggregate per-model accuracy across recent scored forecasts.

    Used by the calibration panel in the UI to show "is the model actually
    any good?". Returns per-model MAE, RMSE, hit-rate (sign match), and
    sample count.
    """
    p = db.pool()
    if p is None:
        return {"models": {}, "available": False}
    where = []
    args: List[Any] = []
    if symbol:
        where.append(f"symbol = ${len(args) + 1}")
        args.append(symbol)
    if horizon:
        where.append(f"horizon = ${len(args) + 1}")
        args.append(int(horizon))
    where.append("scored_at IS NOT NULL")
    where_sql = " AND ".join(where) if where else "TRUE"
    args.append(limit)
    try:
        async with p.acquire() as conn:
            rows = await conn.fetch(
                f"""
                SELECT model, predicted_return, actual_return, abs_residual
                FROM forecast_log
                WHERE {where_sql}
                ORDER BY made_at DESC
                LIMIT ${len(args)}
                """,
                *args,
            )
        agg: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            m = r["model"]
            if m not in agg:
                agg[m] = {"n": 0, "sum_abs": 0.0, "sum_sq": 0.0, "sign_hits": 0}
            agg[m]["n"] += 1
            agg[m]["sum_abs"] += float(r["abs_residual"])
            agg[m]["sum_sq"] += float(r["abs_residual"]) ** 2
            if (float(r["predicted_return"]) >= 0) == (float(r["actual_return"]) >= 0):
                agg[m]["sign_hits"] += 1
        out: Dict[str, Any] = {}
        for m, d in agg.items():
            n = d["n"]
            out[m] = {
                "n": n,
                "mae_pct": round(d["sum_abs"] / n * 100, 3) if n else None,
                "rmse_pct": round(math.sqrt(d["sum_sq"] / n) * 100, 3) if n else None,
                "sign_hit_rate": round(d["sign_hits"] / n, 3) if n else None,
            }
        return {"models": out, "available": True}
    except Exception as e:  # noqa: BLE001
        logger.warning("model_accuracy failed: %s", e)
        return {"models": {}, "available": False}
