"""Rebuild the Rule One spread history that powers /api/regime.

Reads the daily index history in ``api/data/spread_history/daily`` and replays
every monthly cycle since March 2000 for each strategy, writing two CSVs into
``api/app/data``:

  spread_trades.csv       one row per modeled trade (entry, strike, regime, outcome)
  spread_checkpoints.csv  one row per trading day while a trade was open
                          (delta, cushion, days left) joined to its final outcome

Replay rules (same as the course and the live exit monitor):

  * enter at the third-Friday close for the next monthly expiry
  * short strike: first 5-point strike at or below the distance floor whose
    modeled delta clears the strategy's cap; $10 wide
  * close when the modeled short delta reaches the exit threshold at a daily
    close, or at the close of the last trading day before expiry when spot is
    within the buffer of the strike; otherwise hold to the AM settlement, which
    is approximated by the expiry-day open
  * cycles whose modeled credit is under $0.05 are not traded (Oct and Nov
    2008: the delta-10 strike sat 50% below spot at RVX 80 and paid nothing)
  * return on risk = (credit - cost to close) / (width - credit)

Data (see ``daily/README.md`` for the sources): Yahoo ^GSPC and ^RUT daily
OHLC 2000-2026, Cboe VIX closes, RVX closes from FRED from 2004-01-02 (the
Cboe file starts in 2009 and is identical where both exist). RUT vol is
RVX where it exists and VIX x 1.33 before 2004. The IBKR weekly archives
(``*_w.json``) are kept for reference; ``--weekly`` rebuilds from them the old
way (one check per week, which overstates crash losses).

Run ``python scripts/build_spread_history.py --validate`` to print the
2012-2023 exit counts against the course's own 12-year table (8 / 9 / 9 for
RUT / Mars / Mars Max) and the non-win count per year.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

from app.services.spread_model import (  # noqa: E402
    RUT_VOL_RATIO,
    SPREAD_WIDTH,
    STRATEGIES,
    StrategySpec,
    pick_short_strike,
    put_delta,
    spread_value,
    third_friday,
)

RAW_DIR = API_DIR / "data" / "spread_history"
DAILY_DIR = RAW_DIR / "daily"
OUT_DIR = API_DIR / "app" / "data"
MIN_CREDIT = 0.05  # dollars per spread; below this nobody places the trade

Bar = Tuple[date, float]  # (date, close)


# ---------------------------------------------------------------------------
# data
# ---------------------------------------------------------------------------

def _load_bars(name: str, weekly: bool) -> List[Bar]:
    """IBKR JSON archive -> [(date, close)]; weekly bars are labelled by their Friday."""
    raw = json.loads((RAW_DIR / f"{name}.json").read_text())
    out: List[Bar] = []
    for t, c in zip(raw["time"], raw["close"]):
        d = date.fromisoformat(t[:10])
        if weekly:
            d = d + timedelta(days=4 - d.weekday())
        out.append((d, float(c)))
    return out


def _vol_map(name: str, weekly: bool, scale: float = 1.0) -> Dict[date, float]:
    return {d: c * scale for d, c in _load_bars(name, weekly)}


def _load_daily(name: str, col: str = "Close") -> List[Bar]:
    """Daily CSV (Date, Open, High, Low, Close or Date, Close) -> [(date, value)]; blank rows skipped."""
    out: List[Bar] = []
    with (DAILY_DIR / f"{name}.csv").open(newline="") as f:
        for row in csv.DictReader(f):
            v = row.get(col, "")
            if v not in ("", "."):
                out.append((date.fromisoformat(row["Date"]), float(v)))
    return out


def _daily_map(*names: str, col: str = "Close") -> Dict[date, float]:
    """Merge several daily files; later names win where they overlap."""
    out: Dict[date, float] = {}
    for n in names:
        out.update(dict(_load_daily(n, col)))
    return out


def rut_vol_map_daily() -> Dict[date, float]:
    """RUT vol: RVX where it exists (FRED from 2004-01-02, Cboe from 2009-09-16), VIX x 1.33 before."""
    out = {d: v * RUT_VOL_RATIO for d, v in _daily_map("cboe_VIX").items()}
    out.update(_daily_map("fred_RVXCLS", "cboe_RVX"))
    return out


def rut_vol_map_weekly() -> Dict[date, float]:
    """Legacy weekly build: real weekly RVX where IBKR has it (Nov 2007 on), VIX x 1.33 before."""
    out = {d: v * RUT_VOL_RATIO for d, v in _vol_map("vix_w", True).items()}
    out.update(_vol_map("rvx_w", True))
    return out


# ---------------------------------------------------------------------------
# replay
# ---------------------------------------------------------------------------

def replay(spec: StrategySpec, bars: List[Bar], vols: Dict[date, float], weekly: bool,
           vix: Optional[Dict[date, float]] = None, opens: Optional[Dict[date, float]] = None,
           min_credit: float = MIN_CREDIT):
    """Replay every cycle. Returns (trades, checkpoints).

    Daily bars: exits are checked at every close, the Thursday rule at the close of
    the last trading day before expiry, and a spread still open on expiry day settles
    at that day's open (``opens``) or close. Weekly bars: one check per Friday close,
    the Thursday rule at the expiry-week close.
    """
    dates = [b[0] for b in bars]
    pos = {d: i for i, d in enumerate(dates)}
    vol_fill: List[Optional[float]] = []
    last_vol: Optional[float] = None
    for d in dates:
        last_vol = vols.get(d, last_vol)
        vol_fill.append(last_vol)
    trend_window = 10 if weekly else 50
    opens = opens or {}

    def locate(d: date) -> Optional[int]:
        if weekly:
            for i in range(len(dates) - 1, -1, -1):
                if dates[i] <= d and (d - dates[i]).days < 7:
                    return i
            return None
        for back in range(5):
            if d - timedelta(days=back) in pos:
                return pos[d - timedelta(days=back)]
        return None

    years = sorted({d.year for d in dates})
    fridays = [third_friday(y, m) for y in years for m in range(1, 13)]
    trades, checkpoints = [], []
    for entry, expiry in zip(fridays, fridays[1:]):
        ie = locate(entry)
        if ie is None or entry < dates[0] + timedelta(days=60):
            continue
        d_entry = dates[ie]
        if vol_fill[ie] is None:
            continue
        spot0 = bars[ie][1]
        vol0 = vol_fill[ie] / 100
        years_left = (expiry - d_entry).days / 365
        window = bars[max(0, ie - trend_window):ie + 1]
        avg = sum(b[1] for b in window) / len(window)
        trade_id = f"{spec.id}-{entry.isoformat()}"
        strike = pick_short_strike(spec, spot0, vol0, years_left)
        credit = spread_value(spot0, strike, SPREAD_WIDTH, vol0, years_left)
        if credit < min_credit:
            continue
        delta0 = put_delta(spot0, strike, vol0, years_left)
        rec = {
            "trade_id": trade_id,
            "strategy": spec.id,
            "entry": d_entry.isoformat(),
            "expiry": expiry.isoformat(),
            "spot": round(spot0, 2),
            "short_strike": strike,
            "width": SPREAD_WIDTH,
            "credit": round(credit, 2),
            "entry_delta": round(delta0 * 100, 1),
            "distance_pct": round((1 - strike / spot0) * 100, 2),
            "index_vol": round(vol0 * 100, 2),
            "vix": round((vix.get(d_entry, vol0 * 100) if vix else vol0 * 100), 2),
            "trend": "up" if spot0 >= avg else "down",
        }
        cps = [{
            "trade_id": trade_id, "strategy": spec.id, "date": d_entry.isoformat(),
            "days_left": (expiry - d_entry).days, "spot": round(spot0, 2),
            "delta": round(delta0 * 100, 1),
            "cushion_pct": round((spot0 / strike - 1) * 100, 2),
            "index_vol": round(vol0 * 100, 2),
        }]
        ix = locate(expiry)
        if ix is None or expiry > dates[-1] + timedelta(days=6 if weekly else 0) or ix <= ie:
            rec.update(outcome="open", exit_date="", cost=None, ror=None)
            trades.append(rec)
            checkpoints.extend(cps)
            continue
        result = None
        for i in range(ie + 1, ix + 1):
            d, px = bars[i]
            vol = (vol_fill[i] if vol_fill[i] is not None else vol0 * 100) / 100
            years_now = max((expiry - d).days, 1) / 365
            last = i == ix
            if not last or weekly:
                if put_delta(px, strike, vol, years_now) > spec.exit_delta:
                    result = ("delta_exit", d, spread_value(px, strike, SPREAD_WIDTH, vol, years_now))
                    break
            if (weekly and last) or (not weekly and i == ix - 1):
                if px < strike * (1 + spec.last_day_buffer):
                    result = ("last_day_exit", d, spread_value(px, strike, SPREAD_WIDTH, vol, years_now))
                    break
            if last:
                settle = px if weekly else opens.get(d, px)
                cost = min(max(strike - settle, 0.0), SPREAD_WIDTH)
                kind = "max_loss" if cost >= SPREAD_WIDTH else ("partial_loss" if cost > credit else "win")
                result = (kind, d, cost)
                break
            cps.append({
                "trade_id": trade_id, "strategy": spec.id, "date": d.isoformat(),
                "days_left": (expiry - d).days, "spot": round(px, 2),
                "delta": round(put_delta(px, strike, vol, years_now) * 100, 1),
                "cushion_pct": round((px / strike - 1) * 100, 2),
                "index_vol": round(vol * 100, 2),
            })
        if result is None:
            rec.update(outcome="open", exit_date="", cost=None, ror=None)
        else:
            kind, d, cost = result
            cost = min(cost, SPREAD_WIDTH)
            rec.update(outcome=kind, exit_date=d.isoformat(), cost=round(cost, 2),
                       ror=round((credit - cost) / (SPREAD_WIDTH - credit) * 100, 2))
        trades.append(rec)
        for cp in cps:
            cp["outcome"] = rec["outcome"]
            cp["ror"] = rec["ror"]
        checkpoints.extend(cps)
    return trades, checkpoints


def build(weekly: bool = False) -> Tuple[list, list]:
    if weekly:
        bars = {"SPX": _load_bars("spx_w", True), "RUT": _load_bars("rut_w", True)}
        vix = _vol_map("vix_w", True)
        vols = {"SPX": vix, "RUT": rut_vol_map_weekly()}
        opens: Dict[str, Dict[date, float]] = {"SPX": {}, "RUT": {}}
    else:
        bars = {"SPX": _load_daily("yahoo_GSPC"), "RUT": _load_daily("yahoo_RUT")}
        vix = _daily_map("cboe_VIX")
        vols = {"SPX": vix, "RUT": rut_vol_map_daily()}
        opens = {"SPX": dict(_load_daily("yahoo_GSPC", "Open")), "RUT": dict(_load_daily("yahoo_RUT", "Open"))}
    trades, cps = [], []
    for spec in STRATEGIES.values():
        t, c = replay(spec, bars[spec.underlying], vols[spec.underlying], weekly, vix=vix,
                      opens=opens[spec.underlying])
        trades += t
        cps += c
    return trades, cps


def write_csv(path: Path, rows: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def validate(trades: list) -> None:
    print("\n2012-2023 exits vs the course's 12-year table (RUT 8, Mars 9, Mars Max 9):")
    for sid in ("rut", "mars", "marsmax"):
        rows = [t for t in trades if t["strategy"] == sid and "2012-01" <= t["entry"] < "2024-01"
                and t["outcome"] != "open"]
        print(f"  {STRATEGIES[sid].label:9s} {sum(t['outcome'] != 'win' for t in rows)} non-wins in {len(rows)} trades")
    print("\nNon-wins per year:")
    years = sorted({t["entry"][:4] for t in trades})
    print("  " + " " * 9 + " ".join(y[2:] for y in years))
    for spec in STRATEGIES.values():
        row = []
        for y in years:
            rows = [t for t in trades if t["strategy"] == spec.id and t["entry"][:4] == y and t["outcome"] != "open"]
            row.append(f"{sum(t['outcome'] != 'win' for t in rows):2d}")
        print(f"  {spec.label:9s} " + " ".join(row))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--weekly", action="store_true", help="legacy build from the IBKR weekly archives")
    args = ap.parse_args()
    trades, cps = build(weekly=args.weekly)
    write_csv(OUT_DIR / "spread_trades.csv", trades)
    write_csv(OUT_DIR / "spread_checkpoints.csv", cps)
    for spec in STRATEGIES.values():
        rows = [t for t in trades if t["strategy"] == spec.id and t["outcome"] != "open"]
        bad = sum(t["outcome"] != "win" for t in rows)
        print(f"{spec.label:9s} {len(rows)} closed trades, {bad} non-wins ({bad / len(rows):.0%})")
    print(f"wrote {len(trades)} trades and {len(cps)} checkpoints to {OUT_DIR}")
    if args.validate:
        validate(trades)


if __name__ == "__main__":
    main()
