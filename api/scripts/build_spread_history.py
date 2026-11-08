"""Rebuild the Rule One spread history that powers /api/regime.

Reads the IBKR bar archives in ``api/data/spread_history`` and replays every
monthly cycle since 2005 for each strategy, writing two CSVs into
``api/app/data``:

  spread_trades.csv       one row per modeled trade (entry, strike, regime, outcome)
  spread_checkpoints.csv  one row per weekly close while a trade was open
                          (delta, cushion, days left) joined to its final outcome

Replay rules (same as the course and the live exit monitor):
  * enter at the third-Friday close for the next monthly expiry
  * short strike: first 5-point strike at or below the distance floor whose
    modeled delta clears the strategy's cap; $10 wide
  * close when the modeled short delta reaches the exit threshold at a
    weekly close, or on the Thursday before expiry when spot is within the
    buffer of the strike; otherwise hold to settlement
  * return on risk = (credit - cost to close) / (width - credit)

Data: weekly SPX, RUT and VIX bars 2004-2026 (IBKR caps daily history at
five years, so weekly is what gives 21 years). RUT vol = VIX x 1.33.

Run ``python scripts/build_spread_history.py --validate`` to also replay the
last five years on daily bars with RVX and print how often the weekly and
daily replays agree per cycle, plus the 2012-2023 exit counts against the
course's own 12-year table (8 / 9 / 9 for RUT / Mars / Mars Max).
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
OUT_DIR = API_DIR / "app" / "data"

Bar = Tuple[date, float]  # (date, close)


def _load_bars(name: str, weekly: bool) -> List[Bar]:
    raw = json.loads((RAW_DIR / f"{name}.json").read_text())
    out: List[Bar] = []
    for t, c in zip(raw["time"], raw["close"]):
        d = date.fromisoformat(t[:10])
        if weekly:
            d = d + timedelta(days=4 - d.weekday())  # label the bar by its Friday
        out.append((d, float(c)))
    return out


def _vol_map(name: str, weekly: bool, scale: float = 1.0) -> Dict[date, float]:
    return {d: c * scale for d, c in _load_bars(name, weekly)}


def replay(spec: StrategySpec, bars: List[Bar], vols: Dict[date, float], weekly: bool,
           vix: Optional[Dict[date, float]] = None):
    """Replay every cycle. Returns (trades, checkpoints)."""
    dates = [b[0] for b in bars]
    pos = {d: i for i, d in enumerate(dates)}
    trend_window = 10 if weekly else 50

    def locate(d: date) -> Optional[int]:
        if weekly:
            for i in range(len(dates) - 1, -1, -1):
                if dates[i] <= d and (d - dates[i]).days < 7:
                    return i
            return None
        for back in range(4):
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
        if d_entry not in vols:
            continue
        spot0 = bars[ie][1]
        vol0 = vols[d_entry] / 100
        years_left = (expiry - entry).days / 365
        window = bars[max(0, ie - trend_window):ie + 1]
        avg = sum(b[1] for b in window) / len(window)
        trade_id = f"{spec.id}-{entry.isoformat()}"
        strike = pick_short_strike(spec, spot0, vol0, years_left)
        credit = spread_value(spot0, strike, SPREAD_WIDTH, vol0, years_left)
        delta0 = put_delta(spot0, strike, vol0, years_left)
        rec = {
            "trade_id": trade_id,
            "strategy": spec.id,
            "entry": entry.isoformat(),
            "expiry": expiry.isoformat(),
            "spot": round(spot0, 2),
            "short_strike": strike,
            "width": SPREAD_WIDTH,
            "credit": round(credit, 2),
            "entry_delta": round(delta0 * 100, 1),
            "distance_pct": round((1 - strike / spot0) * 100, 2),
            "index_vol": round(vol0 * 100, 2),
            "vix": round((vix[d_entry] if vix else vol0 * 100), 2),
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
        if ix is None or expiry > dates[-1] + timedelta(days=6 if weekly else 0):
            rec.update(outcome="open", exit_date="", cost=None, ror=None)
            trades.append(rec)
            checkpoints.extend(cps)
            continue
        result = None
        for i in range(ie + 1, ix + 1):
            d, px = bars[i]
            vol = vols.get(d, vol0 * 100) / 100
            years_now = max((expiry - d).days, 0) / 365
            last = i == ix
            if not last or weekly:
                if put_delta(px, strike, vol, max(years_now, 1 / 365)) > spec.exit_delta:
                    result = ("delta_exit", d, spread_value(px, strike, SPREAD_WIDTH, vol, max(years_now, 1 / 365)))
                    break
            if (weekly and last) or (not weekly and i == ix - 1):
                if px < strike * (1 + spec.last_day_buffer):
                    result = ("last_day_exit", d, spread_value(px, strike, SPREAD_WIDTH, vol, max(years_now, 1 / 365)))
                    break
            if last:
                cost = min(max(strike - px, 0.0), SPREAD_WIDTH)
                kind = "max_loss" if cost >= SPREAD_WIDTH else ("partial_loss" if cost > credit else "win")
                result = (kind, d, cost)
                break
            cps.append({
                "trade_id": trade_id, "strategy": spec.id, "date": d.isoformat(),
                "days_left": (expiry - d).days, "spot": round(px, 2),
                "delta": round(put_delta(px, strike, vol, max(years_now, 1 / 365)) * 100, 1),
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


def build() -> Tuple[list, list]:
    weekly = {"SPX": _load_bars("spx_w", True), "RUT": _load_bars("rut_w", True)}
    vix_w = _vol_map("vix_w", True)
    vols = {"SPX": vix_w, "RUT": _vol_map("vix_w", True, RUT_VOL_RATIO)}
    trades, cps = [], []
    for spec in STRATEGIES.values():
        t, c = replay(spec, weekly[spec.underlying], vols[spec.underlying], True, vix=vix_w)
        trades += t
        cps += c
    return trades, cps


def write_csv(path: Path, rows: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def validate(weekly_trades: list) -> None:
    daily = {"SPX": _load_bars("spx", False), "RUT": _load_bars("rut", False)}
    vols = {"SPX": _vol_map("vix", False), "RUT": _vol_map("rvx", False)}
    print("\nWeekly replay vs daily replay with RVX, 2021-2026 (same cycle, same win/no-win):")
    for spec in STRATEGIES.values():
        d_tr, _ = replay(spec, daily[spec.underlying], vols[spec.underlying], False)
        d_map = {t["entry"][:7]: t["outcome"] != "win" for t in d_tr if t["outcome"] != "open"}
        w_map = {t["entry"][:7]: t["outcome"] != "win" for t in weekly_trades
                 if t["strategy"] == spec.id and t["outcome"] != "open"}
        common = [m for m in d_map if m in w_map]
        agree = sum(d_map[m] == w_map[m] for m in common)
        print(f"  {spec.label:9s} {agree}/{len(common)} cycles agree "
              f"(daily non-wins {sum(d_map[m] for m in common)}, weekly {sum(w_map[m] for m in common)})")
    print("\n2012-2023 exits vs the course's 12-year table (RUT 8, Mars 9, Mars Max 9):")
    for sid in ("rut", "mars", "marsmax"):
        rows = [t for t in weekly_trades if t["strategy"] == sid and "2012-01" <= t["entry"] < "2024-01"
                and t["outcome"] != "open"]
        print(f"  {STRATEGIES[sid].label:9s} {sum(t['outcome'] != 'win' for t in rows)} non-wins in {len(rows)} trades")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()
    trades, cps = build()
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
