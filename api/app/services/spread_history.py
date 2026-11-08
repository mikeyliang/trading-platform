"""Historical context for Rule One spreads: what happened to trades like this one.

Backed by the two CSVs that ``scripts/build_spread_history.py`` writes from
21 years of IBKR bars (see that script for the replay rules and validation).
Three questions are answered here:

  odds()          a trade sits at short delta D with N days left; of the past
                  trades that were in the same spot, how many later hit an exit?
  regime_stats()  entering with VIX at V in an up/down trend; how did that
                  strategy do in that regime versus overall?
  summary()       the full evidence tables for the History page.

Everything is counted from the model's weekly checkpoints, so "exit" means
"the replay would have closed the trade under the course's rules", not a
real fill. Counts are small for narrow slices; every answer carries ``n``
so the UI can say so.
"""
from __future__ import annotations

import csv
import logging
import math
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from .spread_model import STRATEGIES, normalize_strategy

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
TRADES_CSV = DATA_DIR / "spread_trades.csv"
CHECKPOINTS_CSV = DATA_DIR / "spread_checkpoints.csv"

EXIT_OUTCOMES = {"delta_exit", "last_day_exit"}
LOSS_OUTCOMES = {"partial_loss", "max_loss"}

VIX_BUCKETS = [("<15", 0, 15), ("15-20", 15, 20), ("20-25", 20, 25), ("25-30", 25, 30), ("30+", 30, 1e9)]
DELTA_BINS = [(0, 5), (5, 10), (10, 15), (15, 20), (20, 25), (25, 30), (30, 40)]
DAYS_BANDS = [("3 weeks out", 18, 24), ("2 weeks out", 11, 17), ("1 week out", 4, 10)]

DELTA_BAND = 5.0       # +/- delta points for "same spot"
DELTA_BAND_WIDE = 8.0  # fallback when the narrow band has too few trades
DAYS_BAND = 4          # +/- days; checkpoints are weekly so this catches one column
MIN_SAMPLE = 8


def _num(v: Any) -> Optional[float]:
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _read(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        logger.warning("spread history missing: %s (run scripts/build_spread_history.py)", path)
        return []
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        for k, v in list(r.items()):
            if k in ("trade_id", "strategy", "entry", "expiry", "exit_date", "date", "trend", "outcome"):
                continue
            r[k] = _num(v)
    return rows


@lru_cache(maxsize=1)
def trades() -> List[Dict[str, Any]]:
    return _read(TRADES_CSV)


@lru_cache(maxsize=1)
def checkpoints() -> List[Dict[str, Any]]:
    return _read(CHECKPOINTS_CSV)


def closed_trades(strategy: str) -> List[Dict[str, Any]]:
    return [t for t in trades() if t["strategy"] == strategy and t["outcome"] != "open"]


def coverage() -> Dict[str, Any]:
    rows = [t for t in trades() if t["outcome"] != "open"]
    if not rows:
        return {"trades": 0, "first_entry": None, "last_entry": None}
    return {
        "trades": len(rows),
        "first_entry": min(t["entry"] for t in rows),
        "last_entry": max(t["entry"] for t in rows),
    }


def _tally(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    n = len(rows)
    exited = sum(1 for r in rows if r["outcome"] in EXIT_OUTCOMES)
    lost = sum(1 for r in rows if r["outcome"] in LOSS_OUTCOMES)
    rors = [r["ror"] for r in rows if r.get("ror") is not None]
    return {
        "n": n,
        "exited": exited,
        "held_to_loss": lost,
        "wins": n - exited - lost,
        "non_win_pct": round(100 * (exited + lost) / n, 1) if n else None,
        "exit_pct": round(100 * exited / n, 1) if n else None,
        "avg_ror_pct": round(sum(rors) / len(rors), 2) if rors else None,
    }


def fisher_one_sided(bad_a: int, good_a: int, bad_b: int, good_b: int) -> float:
    """P(group A's non-win count this high or higher | same underlying rate)."""
    n = bad_a + good_a + bad_b + good_b
    row_a = bad_a + good_a
    col_bad = bad_a + bad_b
    if n == 0 or row_a == 0 or col_bad == 0:
        return 1.0
    total = math.comb(n, col_bad)

    def p(x: int) -> float:
        return math.comb(row_a, x) * math.comb(n - row_a, col_bad - x) / total

    return min(1.0, sum(p(x) for x in range(bad_a, min(row_a, col_bad) + 1)))


# ---------------------------------------------------------------------------
# odds: trades that were in the same spot
# ---------------------------------------------------------------------------

def odds(strategy: str, delta: float, days_left: int) -> Dict[str, Any]:
    sid = normalize_strategy(strategy)
    if sid is None:
        return {"strategy": None, "n": 0, "note": "unknown strategy"}
    rows = [c for c in checkpoints() if c["strategy"] == sid and c["outcome"] != "open"]
    near_days = [c for c in rows if abs(c["days_left"] - days_left) <= DAYS_BAND]
    band = DELTA_BAND
    match = [c for c in near_days if abs(c["delta"] - delta) <= band]
    widened = False
    if len(match) < MIN_SAMPLE:
        band = DELTA_BAND_WIDE
        match = [c for c in near_days if abs(c["delta"] - delta) <= band]
        widened = True
    # One checkpoint per trade: the one closest in days to the query.
    best: Dict[str, Dict[str, Any]] = {}
    for c in match:
        cur = best.get(c["trade_id"])
        if cur is None or abs(c["days_left"] - days_left) < abs(cur["days_left"] - days_left):
            best[c["trade_id"]] = c
    picked = list(best.values())
    tally = _tally(picked)
    trade_by_id = {t["trade_id"]: t for t in trades()}
    examples = sorted(
        (
            {
                "entry": trade_by_id[c["trade_id"]]["entry"],
                "date": c["date"],
                "delta": c["delta"],
                "cushion_pct": c["cushion_pct"],
                "outcome": c["outcome"],
                "ror": c.get("ror"),
            }
            for c in picked if c["trade_id"] in trade_by_id
        ),
        key=lambda e: e["date"],
        reverse=True,
    )
    return {
        "strategy": sid,
        "query": {"delta": delta, "days_left": days_left},
        "band": {"delta": band, "days": DAYS_BAND, "widened": widened},
        **tally,
        "examples": examples[:12],
        "thin": tally["n"] < MIN_SAMPLE,
    }


def odds_grid(strategy: str) -> List[Dict[str, Any]]:
    """Exit probability by (days-left band x delta bin) for the History page."""
    rows = [c for c in checkpoints() if c["strategy"] == strategy and c["outcome"] != "open"]
    out = []
    for label, lo_d, hi_d in DAYS_BANDS:
        in_band = [c for c in rows if lo_d <= c["days_left"] <= hi_d]
        for lo, hi in DELTA_BINS:
            cell = {}
            for c in in_band:
                if lo <= c["delta"] < hi:
                    cell.setdefault(c["trade_id"], c)
            t = _tally(list(cell.values()))
            out.append({"days_band": label, "delta_lo": lo, "delta_hi": hi, **t})
    return out


# ---------------------------------------------------------------------------
# regime: VIX level and trend at entry
# ---------------------------------------------------------------------------

def vix_bucket(vix: Optional[float]) -> Optional[str]:
    if vix is None:
        return None
    for label, lo, hi in VIX_BUCKETS:
        if lo <= vix < hi:
            return label
    return None


def regime_stats(strategy: str, vix: Optional[float], trend: Optional[str]) -> Dict[str, Any]:
    sid = normalize_strategy(strategy)
    if sid is None:
        return {"strategy": None}
    rows = closed_trades(sid)
    overall = _tally(rows)
    bucket = vix_bucket(vix)
    by_vix = _tally([t for t in rows if vix_bucket(t["vix"]) == bucket]) if bucket else None
    by_trend = _tally([t for t in rows if t["trend"] == trend]) if trend in ("up", "down") else None
    same = (
        _tally([t for t in rows if vix_bucket(t["vix"]) == bucket and t["trend"] == trend])
        if bucket and trend in ("up", "down") else None
    )
    down = [t for t in rows if t["trend"] == "down"]
    up = [t for t in rows if t["trend"] == "up"]
    bad = lambda rs: sum(1 for t in rs if t["outcome"] != "win")  # noqa: E731
    p_down = fisher_one_sided(bad(down), len(down) - bad(down), bad(up), len(up) - bad(up))
    return {
        "strategy": sid,
        "label": STRATEGIES[sid].label,
        "vix_bucket": bucket,
        "trend": trend,
        "overall": overall,
        "same_vix": by_vix,
        "same_trend": by_trend,
        "same_regime": same,
        "downtrend_p": round(p_down, 3),
        "finding": finding(sid),
    }


def finding(strategy: str) -> str:
    """One honest sentence per strategy, computed from the data, not typed in."""
    rows = closed_trades(strategy)
    if not rows:
        return "No history loaded."
    label = STRATEGIES[strategy].label
    buckets = []
    for b, _, _ in VIX_BUCKETS:
        rs = [t for t in rows if vix_bucket(t["vix"]) == b]
        if len(rs) >= 15:
            buckets.append((b, _tally(rs)["non_win_pct"]))
    worst_bucket, worst_rate = max(buckets, key=lambda x: x[1]) if buckets else ("", 0.0)
    high = [t for t in rows if t["vix"] >= 25]
    low = [t for t in rows if t["vix"] < 25]
    high_rate = _tally(high)["non_win_pct"] if high else None
    low_rate = _tally(low)["non_win_pct"] if low else None
    down = [t for t in rows if t["trend"] == "down"]
    up = [t for t in rows if t["trend"] == "up"]
    bad = lambda rs: sum(1 for t in rs if t["outcome"] != "win")  # noqa: E731
    p_down = fisher_one_sided(bad(down), len(down) - bad(down), bad(up), len(up) - bad(up))
    parts = []
    if high_rate is not None and low_rate is not None:
        if high_rate <= low_rate:
            parts.append(
                f"High VIX has not hurt {label}: entries with VIX 25 or higher went wrong "
                f"{high_rate:.0f}% of the time versus {low_rate:.0f}% below 25."
            )
        else:
            parts.append(
                f"{label} entries with VIX 25 or higher went wrong {high_rate:.0f}% of the time "
                f"versus {low_rate:.0f}% below 25."
            )
    if worst_bucket and worst_rate > (_tally(rows)["non_win_pct"] or 0) * 1.3:
        parts.append(f"The weak spot is VIX {worst_bucket} ({worst_rate:.0f}% went wrong).")
    d_rate = _tally(down)["non_win_pct"] if down else None
    u_rate = _tally(up)["non_win_pct"] if up else None
    if d_rate is not None and u_rate is not None:
        if p_down < 0.10:
            parts.append(
                f"Entering below the 10-week average went wrong {d_rate:.0f}% of the time versus "
                f"{u_rate:.0f}% above it (p={p_down:.2f}, suggestive but not conclusive)."
            )
        else:
            parts.append(
                f"Trend at entry made no reliable difference ({d_rate:.0f}% below the 10-week average "
                f"versus {u_rate:.0f}% above, p={p_down:.2f})."
            )
    return " ".join(parts)


# ---------------------------------------------------------------------------
# summary for the History page
# ---------------------------------------------------------------------------

def summary() -> Dict[str, Any]:
    out: Dict[str, Any] = {"coverage": coverage(), "strategies": []}
    for sid, spec in STRATEGIES.items():
        rows = closed_trades(sid)
        if not rows:
            continue
        by_vix = []
        for label, lo, hi in VIX_BUCKETS:
            rs = [t for t in rows if lo <= t["vix"] < hi]
            by_vix.append({"bucket": label, **_tally(rs)})
        by_trend = [{"trend": tr, **_tally([t for t in rows if t["trend"] == tr])} for tr in ("up", "down")]
        down = [t for t in rows if t["trend"] == "down"]
        up = [t for t in rows if t["trend"] == "up"]
        bad = lambda rs: sum(1 for t in rs if t["outcome"] != "win")  # noqa: E731
        non_wins = [
            {
                "entry": t["entry"], "expiry": t["expiry"], "outcome": t["outcome"],
                "vix": t["vix"], "trend": t["trend"], "ror": t["ror"],
                "entry_delta": t["entry_delta"], "distance_pct": t["distance_pct"],
            }
            for t in rows if t["outcome"] != "win"
        ]
        out["strategies"].append({
            "id": sid,
            "label": spec.label,
            "underlying": spec.underlying,
            "exit_delta": round(spec.exit_delta * 100),
            "overall": _tally(rows),
            "by_vix": by_vix,
            "by_trend": by_trend,
            "downtrend_p": round(fisher_one_sided(bad(down), len(down) - bad(down), bad(up), len(up) - bad(up)), 3),
            "odds_grid": odds_grid(sid),
            "non_wins": non_wins,
            "finding": finding(sid),
        })
    return out
