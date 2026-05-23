"""Black-Scholes Greeks + implied volatility solver.

Used as a fallback when IBKR doesn't supply Greeks for a given contract —
for example, near-the-money short-dated options where IB occasionally
returns nulls before market open.

All functions use the European-style Black-Scholes model. American-style
short-dated equity options (puts in particular) can deviate near
expiration, but for monthly Mars/MarsMax/Space credit spreads in the
20-40 DTE range the error is well under a delta point — fine for ranking.
"""
from __future__ import annotations

import math
from typing import Literal, Optional

from scipy.optimize import brentq
from scipy.stats import norm


def _d1_d2(spot: float, strike: float, dte_years: float, iv: float, rate: float = 0.045) -> tuple[float, float]:
    if dte_years <= 0 or iv <= 0:
        return float("nan"), float("nan")
    d1 = (math.log(spot / strike) + (rate + 0.5 * iv * iv) * dte_years) / (iv * math.sqrt(dte_years))
    d2 = d1 - iv * math.sqrt(dte_years)
    return d1, d2


def bs_price(spot: float, strike: float, dte_years: float, iv: float,
             right: Literal["call", "put"], rate: float = 0.045) -> float:
    """Theoretical Black-Scholes price."""
    if dte_years <= 0:
        intrinsic = max(spot - strike, 0) if right == "call" else max(strike - spot, 0)
        return intrinsic
    d1, d2 = _d1_d2(spot, strike, dte_years, iv, rate)
    if right == "call":
        return spot * norm.cdf(d1) - strike * math.exp(-rate * dte_years) * norm.cdf(d2)
    return strike * math.exp(-rate * dte_years) * norm.cdf(-d2) - spot * norm.cdf(-d1)


def implied_vol(market_price: float, spot: float, strike: float,
                dte_years: float, right: Literal["call", "put"],
                rate: float = 0.045) -> Optional[float]:
    """Solve for IV by bisecting Black-Scholes residual. Returns None when no
    real root exists (e.g. arbitrage violations or unusable quotes)."""
    if market_price <= 0 or spot <= 0 or strike <= 0 or dte_years <= 0:
        return None

    intrinsic = max(spot - strike, 0) if right == "call" else max(strike - spot, 0)
    if market_price < intrinsic - 0.01:
        # Below intrinsic — quote is stale or arb-violating; we cannot solve.
        return None

    def f(sigma: float) -> float:
        return bs_price(spot, strike, dte_years, sigma, right, rate) - market_price

    try:
        return brentq(f, 1e-4, 5.0, maxiter=100)
    except (ValueError, RuntimeError):
        return None


def greeks(spot: float, strike: float, dte_years: float, iv: float,
           right: Literal["call", "put"], rate: float = 0.045) -> dict:
    """Δ, Γ, Θ (per day), ν (vega per 1% IV move). Returns NaNs for degenerate inputs."""
    if dte_years <= 0 or iv <= 0:
        return {"delta": float("nan"), "gamma": float("nan"),
                "theta": float("nan"), "vega": float("nan")}
    d1, d2 = _d1_d2(spot, strike, dte_years, iv, rate)
    pdf_d1 = norm.pdf(d1)
    sqrt_t = math.sqrt(dte_years)

    if right == "call":
        delta = norm.cdf(d1)
        theta = (-spot * pdf_d1 * iv / (2 * sqrt_t)
                 - rate * strike * math.exp(-rate * dte_years) * norm.cdf(d2)) / 365.0
    else:
        delta = norm.cdf(d1) - 1
        theta = (-spot * pdf_d1 * iv / (2 * sqrt_t)
                 + rate * strike * math.exp(-rate * dte_years) * norm.cdf(-d2)) / 365.0

    gamma = pdf_d1 / (spot * iv * sqrt_t)
    vega = spot * pdf_d1 * sqrt_t / 100.0  # per 1% IV

    return {"delta": delta, "gamma": gamma, "theta": theta, "vega": vega}
