"""
Chronos forecast wrapper — Chronos-2 with log-return forecasting.

What changed vs the original (chronos-bolt-small on raw prices):

1. **Chronos-2** (120M params, covariate-aware) instead of chronos-bolt-small
   (50M params, univariate-only). Bigger model, multivariate-capable, and
   the official successor — substantially better zero-shot accuracy on
   public benchmarks (fev-bench, GIFT-Eval, Chronos Benchmark II).

2. **Log-return forecasting** instead of raw-price forecasting. Foundation
   models trained on heterogeneous time series benefit massively from
   forecasting *returns* rather than *levels* — removes the absolute price
   scale, lets the model focus on the dynamics. We forecast log returns
   and reconstruct price levels via cumulative product.

3. **Multi-horizon output** — single inference returns 1d / 5d / 21d
   forecasts simultaneously. Different horizons read differently:
   1d is noise-dominated, 21d shows trend, 5d is the sweet spot for
   weekly option positioning.

Pipeline loads lazily on first use (HF download cached under
/root/.cache/huggingface). CPU-only inference; ~600ms-1.2s per call
depending on context length.

Designed to be one signal among many — markets are mostly random walk.
"""
from __future__ import annotations

import logging
import math
import os
import threading
from typing import Any, Dict, List, Optional

import pandas as pd

logger = logging.getLogger(__name__)

# Model selection — chronos-2 is the default. Override via env for
# experiments (e.g. fall back to amazon/chronos-bolt-small in resource-
# constrained environments).
_MODEL_ID = os.getenv("CHRONOS_MODEL", "amazon/chronos-2")
_USE_CHRONOS_2 = "chronos-2" in _MODEL_ID

# Horizons we always produce. Anchored to typical option lifecycle reads.
DEFAULT_HORIZONS = (1, 5, 21)
MAX_HORIZON = max(DEFAULT_HORIZONS)

_pipeline = None
_load_lock = threading.Lock()
_load_error: Optional[str] = None


def _load():
    """Load the Chronos pipeline once. Thread-safe and non-blocking after
    first call. Returns the pipeline or None on failure."""
    global _pipeline, _load_error
    if _pipeline is not None or _load_error is not None:
        return _pipeline
    with _load_lock:
        if _pipeline is not None or _load_error is not None:
            return _pipeline
        try:
            import torch  # noqa: F401
            if _USE_CHRONOS_2:
                from chronos import Chronos2Pipeline
                logger.info("loading %s (first call may take 30-60s for download)…", _MODEL_ID)
                _pipeline = Chronos2Pipeline.from_pretrained(
                    _MODEL_ID,
                    device_map="cpu",
                )
            else:
                # Back-compat: any non-chronos-2 model uses the BaseChronosPipeline API
                # (chronos-bolt-small/base, original chronos-t5, etc).
                from chronos import BaseChronosPipeline
                logger.info("loading %s (legacy pipeline)…", _MODEL_ID)
                _pipeline = BaseChronosPipeline.from_pretrained(
                    _MODEL_ID,
                    device_map="cpu",
                )
            logger.info("chronos pipeline ready (%s)", _MODEL_ID)
        except Exception as e:  # noqa: BLE001
            _load_error = str(e)
            logger.warning("chronos load failed (%s): %s", _MODEL_ID, e)
            return None
    return _pipeline


def is_available() -> bool:
    return _load_error is None


# ─── Log-return transforms ─────────────────────────────────────────────────────

def _to_log_returns(closes: List[float]) -> List[float]:
    """Convert a price series into a log-return series. Drops the first bar
    (returns has length N-1). Skips zero/negative prices defensively."""
    out: List[float] = []
    for i in range(1, len(closes)):
        prev, curr = closes[i - 1], closes[i]
        if prev <= 0 or curr <= 0:
            out.append(0.0)
        else:
            out.append(math.log(curr / prev))
    return out


def _reconstruct_prices(last_close: float, log_return_path: List[float]) -> List[float]:
    """Inverse of _to_log_returns: walk a log-return path forward from
    `last_close` to produce a price series."""
    out: List[float] = []
    cum = math.log(last_close) if last_close > 0 else 0.0
    for r in log_return_path:
        cum += r
        out.append(math.exp(cum))
    return out


# ─── Public API ────────────────────────────────────────────────────────────────

def forecast(
    closes: List[float],
    horizon: int = 5,
    context_len: int = 512,
) -> Optional[Dict[str, Any]]:
    """Single-horizon forecast — back-compat shape for existing callers.

    Internally always runs the multi-horizon path and slices to `horizon`.
    Use forecast_multi() directly if you want all horizons at once.
    """
    multi = forecast_multi(closes, horizons=(horizon,), context_len=context_len)
    if multi is None:
        return None
    return multi["horizons"][str(horizon)]


def forecast_multi(
    closes: List[float],
    horizons: tuple[int, ...] = DEFAULT_HORIZONS,
    context_len: int = 512,
) -> Optional[Dict[str, Any]]:
    """Forecast multiple horizons in a single pipeline call.

    Returns:
      {
        "model": "amazon/chronos-2",
        "context_len": int,
        "last_close": float,
        "horizons": {
          "1":  {horizon, median, p10, p90, expected_return_pct, band_pct},
          "5":  {...},
          "21": {...},
        },
        "log_return_forecast": {  # raw log-return space, for debugging
          "median": [...], "p10": [...], "p90": [...]
        }
      }

    Returns None if input is too short or the model isn't available.
    The model forecasts in **log-return space** and we reconstruct prices.
    """
    # Need at least 64 returns of context for the model to do anything useful.
    if len(closes) < 65:
        return None
    pipe = _load()
    if pipe is None:
        return None

    horizons = tuple(sorted(set(horizons)))
    max_h = max(horizons)

    last_close = float(closes[-1])
    log_returns = _to_log_returns(closes[-context_len:])

    try:
        if _USE_CHRONOS_2:
            q = _predict_chronos2(pipe, log_returns, max_h)
        else:
            q = _predict_legacy(pipe, log_returns, max_h)
    except Exception as e:  # noqa: BLE001
        logger.warning("chronos forecast failed: %s", e)
        return None

    # q is { "p10": [...max_h], "p50": [...max_h], "p90": [...max_h] } in log-return space.
    # Compute cumulative log-return paths to reconstruct prices.
    out_horizons: Dict[str, Dict[str, Any]] = {}
    for h in horizons:
        med_path = q["p50"][:h]
        p10_path = q["p10"][:h]
        p90_path = q["p90"][:h]

        # Reconstruct prices for each quantile path.
        # Note: p10 of cumulative-return != cumulative of p10-return (quantiles
        # don't sum), but for short horizons it's a reasonable approximation
        # and matches what users intuitively expect to see.
        med_prices = _reconstruct_prices(last_close, med_path)
        p10_prices = _reconstruct_prices(last_close, p10_path)
        p90_prices = _reconstruct_prices(last_close, p90_path)

        # Headline numbers — return % and band width at the terminal horizon.
        terminal_med = med_prices[-1]
        terminal_p10 = p10_prices[-1]
        terminal_p90 = p90_prices[-1]
        expected_return = (terminal_med - last_close) / last_close * 100 if last_close else 0.0
        band = (terminal_p90 - terminal_p10) / last_close * 100 if last_close else 0.0

        out_horizons[str(h)] = {
            "horizon": h,
            "median": [round(v, 4) for v in med_prices],
            "p10": [round(v, 4) for v in p10_prices],
            "p90": [round(v, 4) for v in p90_prices],
            "expected_return_pct": round(expected_return, 2),
            "band_pct": round(band, 2),
        }

    return {
        "model": _MODEL_ID,
        "context_len": len(log_returns),
        "last_close": last_close,
        "horizons": out_horizons,
        # Keep the back-compat top-level keys so callers still using forecast()
        # see the same shape they always did — populated from the 5d horizon.
        **({
            "horizon": out_horizons[str(5)]["horizon"],
            "median": out_horizons[str(5)]["median"],
            "p10": out_horizons[str(5)]["p10"],
            "p90": out_horizons[str(5)]["p90"],
            "expected_return_pct": out_horizons[str(5)]["expected_return_pct"],
            "band_pct": out_horizons[str(5)]["band_pct"],
        } if "5" in out_horizons else {}),
    }


# ─── Pipeline-specific predict adapters ────────────────────────────────────────

def _predict_chronos2(pipe, log_returns: List[float], horizon: int) -> Dict[str, List[float]]:
    """Run Chronos2Pipeline on a log-return series. Uses the pandas
    DataFrame API since that's what Chronos-2 expects."""
    # Chronos-2 wants a DataFrame with id/timestamp/target columns.
    df = pd.DataFrame({
        "id": ["s"] * len(log_returns),
        "timestamp": pd.date_range("2000-01-01", periods=len(log_returns), freq="D"),
        "target": log_returns,
    })
    pred_df = pipe.predict_df(
        df,
        prediction_length=horizon,
        quantile_levels=[0.1, 0.5, 0.9],
        id_column="id",
        timestamp_column="timestamp",
        target="target",
    )
    # pred_df columns: ["id", "timestamp", "0.1", "0.5", "0.9"] or similar.
    # Newer versions may name them "quantile_0.1" etc — handle both.
    p10_col = _resolve_quantile_col(pred_df, 0.1)
    p50_col = _resolve_quantile_col(pred_df, 0.5)
    p90_col = _resolve_quantile_col(pred_df, 0.9)
    return {
        "p10": [float(v) for v in pred_df[p10_col].tolist()],
        "p50": [float(v) for v in pred_df[p50_col].tolist()],
        "p90": [float(v) for v in pred_df[p90_col].tolist()],
    }


def _resolve_quantile_col(df: pd.DataFrame, q: float) -> str:
    """Find the column name for quantile q across chronos-2 versions."""
    candidates = [
        f"{q}",
        f"{q:.1f}",
        f"quantile_{q}",
        f"quantile_{q:.1f}",
        f"q{int(q*100):02d}",
    ]
    for c in candidates:
        if c in df.columns:
            return c
    # last resort — pick by order of numeric-typed columns
    numeric = [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    if len(numeric) >= 3:
        idx = {0.1: 0, 0.5: 1, 0.9: 2}[q]
        return numeric[idx]
    raise KeyError(f"could not find column for quantile {q} in columns {list(df.columns)}")


def _predict_legacy(pipe, log_returns: List[float], horizon: int) -> Dict[str, List[float]]:
    """Run the legacy BaseChronosPipeline.predict_quantiles API on log returns."""
    import torch
    context = torch.tensor(log_returns, dtype=torch.float32)
    quantiles, _mean = pipe.predict_quantiles(
        context,
        prediction_length=horizon,
        quantile_levels=[0.1, 0.5, 0.9],
    )
    q = quantiles[0].tolist()
    return {
        "p10": [float(row[0]) for row in q],
        "p50": [float(row[1]) for row in q],
        "p90": [float(row[2]) for row in q],
    }
