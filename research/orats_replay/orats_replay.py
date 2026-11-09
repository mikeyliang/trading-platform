#!/usr/bin/env python3
"""Replay of the Rule One bull put package (RUT / Mars / Mars Max) on option chains.

One replay core, two chain sources:
  * OratsChains  - real near-close quotes from the ORATS strikes history (kept on the Mac, never in the repo)
  * SynthChains  - a model chain (the "realfit" skew fitted to live quotes on 2026-11-09) on real RUT closes and RVX

Rules replayed (the package):
  * strike: course rule on the reference spread ($25 wide, Mars Max $10) at MID: start at the distance floor, walk down
    while delta is above the cap, then keep walking while the reference spread still pays the target AROC and take the
    furthest strike that also passes the Kelly test
  * trade: short that strike, long put $55 lower (nearest listed strike at or below)
  * entry on the third Friday (+0 / +1 / +2 trading days), expiry the next third Friday (AM settled at the open)
  * exits at the snapshot ("close" mode): short delta above 30 / 36 / 42, or the Thursday rule (index within 3 / 2 / 2 %
    of the short strike on the last day before expiry)
  * costs: entry = share of the real half-spreads + commission, exit = full half-spreads (natural) + commission (+ slip)
  * account: one third of the account at max loss split over nine entries, x1.5 after a 15% 12-month RUT drawdown,
    idle cash in T-bills, daily marks at mid

Only aggregate statistics are printed. No quote ever leaves the machine through this script.
Needs python 3.9+, numpy; pandas + pyarrow only for the ORATS extract / loader.
"""
import bisect
import csv
import gzip
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from statistics import NormalDist

import numpy as np

_N = NormalDist().cdf
RISK_FREE = 0.03
COMM = 0.011          # $ per share per leg per side
STEP = 5.0
WING = 55.0
FIRST_ENTRY = date(2000, 3, 1)
NAN = float('nan')

SPECS = {
    'rut': dict(id='rut', delta_cap=0.10, min_distance=0.11, exit_delta=0.30, buffer=0.03,
                aroc=0.48, kelly_min=0.20, kelly_loss=0.30, ref_width=25.0),
    'mars': dict(id='mars', delta_cap=0.12, min_distance=0.09, exit_delta=0.36, buffer=0.02,
                 aroc=0.64, kelly_min=0.32, kelly_loss=0.25, ref_width=25.0),
    'marsmax': dict(id='marsmax', delta_cap=0.14, min_distance=0.09, exit_delta=0.42, buffer=0.02,
                    aroc=0.93, kelly_min=0.32, kelly_loss=0.33, ref_width=10.0),
    # Space is the S&P 500 sleeve: use it with Market(underlying='yahoo_GSPC', vol='spx') and SPX chains.
    'space': dict(id='space', delta_cap=0.12, min_distance=0.05, exit_delta=0.32, buffer=0.02,
                  aroc=0.74, kelly_min=0.44, kelly_loss=0.25, ref_width=25.0),
}
SIDS = ('rut', 'mars', 'marsmax')

TBILL_Q = {  # 3-month T-bill %, Q1..Q4
    2000: (5.5, 5.7, 6.0, 6.0), 2001: (4.8, 3.7, 3.2, 1.9), 2002: (1.7, 1.7, 1.6, 1.3), 2003: (1.2, 1.0, 0.9, 0.9),
    2004: (0.9, 1.1, 1.5, 2.0),
    2005: (2.54, 2.86, 3.36, 3.83), 2006: (4.40, 4.70, 4.93, 4.90), 2007: (4.98, 4.74, 4.30, 3.39),
    2008: (2.04, 1.63, 1.49, 0.30), 2009: (0.21, 0.18, 0.16, 0.06), 2010: (0.11, 0.15, 0.16, 0.14),
    2011: (0.13, 0.05, 0.02, 0.01), 2012: (0.07, 0.09, 0.10, 0.09), 2013: (0.09, 0.05, 0.03, 0.06),
    2014: (0.05, 0.03, 0.03, 0.02), 2015: (0.03, 0.02, 0.04, 0.12), 2016: (0.29, 0.26, 0.30, 0.44),
    2017: (0.60, 0.95, 1.03, 1.20), 2018: (1.59, 1.86, 2.03, 2.30), 2019: (2.40, 2.33, 1.95, 1.57),
    2020: (1.10, 0.13, 0.11, 0.09), 2021: (0.05, 0.02, 0.05, 0.05), 2022: (0.30, 1.10, 2.70, 4.00),
    2023: (4.65, 5.10, 5.30, 5.35), 2024: (5.25, 5.25, 5.05, 4.50), 2025: (4.30, 4.33, 4.15, 3.85),
    2026: (3.65, 3.65, 3.60, 3.60),
}


def tbill(d):
    return TBILL_Q[min(max(d.year, 2000), 2026)][(d.month - 1) // 3] / 100


def third_friday(y, m):
    first = date(y, m, 1)
    return first + timedelta(days=(4 - first.weekday()) % 7 + 14)


# ---------------------------------------------------------------- pricing helpers (same formulas as the engine)
def put_price(spot, strike, vol, years):
    if years <= 1e-6:
        return max(strike - spot, 0.0)
    sq = vol * math.sqrt(years)
    d1 = (math.log(spot / strike) + (RISK_FREE + vol * vol / 2) * years) / sq
    d2 = d1 - sq
    return strike * math.exp(-RISK_FREE * years) * _N(-d2) - spot * _N(-d1)


def bs_put_delta(spot, strike, vol, years):
    if years <= 1e-6:
        return 1.0 if spot < strike else 0.0
    sq = vol * math.sqrt(years)
    d1 = (math.log(spot / strike) + (RISK_FREE + vol * vol / 2) * years) / sq
    return 1.0 - _N(d1)


# ---------------------------------------------------------------- market data (index closes, opens, RVX)
class Market:
    """RUT daily bars and the RUT vol index (RVX, else 1.33 x VIX), forward filled, as the model engine loads them."""

    def __init__(self, data_dir, underlying='yahoo_RUT', vol='rut'):
        self.dir = data_dir
        rows = self._rows(underlying)
        self.dates, self.close, self.open, self.low = [], {}, {}, {}
        for r in rows:
            c = r.get('Close', '')
            if c in ('', '.'):
                continue
            d = date.fromisoformat(r['Date'])
            self.dates.append(d)
            self.close[d] = float(c)
            if r.get('Open', '') not in ('', '.'):
                self.open[d] = float(r['Open'])
            if r.get('Low', '') not in ('', '.'):
                self.low[d] = float(r['Low'])
        if vol == 'spx':                                   # the S&P 500: VIX as it is
            vol = self._closes('cboe_VIX')
        else:
            vol = {d: v * 1.33 for d, v in self._closes('cboe_VIX').items()}
            rvx = self._closes('fred_RVXCLS')
            rvx.update(self._closes('cboe_RVX'))
            vol.update(rvx)
        self.V, last = [], None
        for d in self.dates:
            last = vol.get(d, last)
            self.V.append(last)
        self.vol = dict(zip(self.dates, self.V))
        self.idx = {d: i for i, d in enumerate(self.dates)}
        self._me = {}
        for d in self.dates:
            self._me[(d.year, d.month)] = self.close[d]
        self._me_keys = sorted(self._me)

    def _rows(self, name):
        with open(os.path.join(self.dir, name + '.csv')) as f:
            return list(csv.DictReader(f))

    def _closes(self, name):
        out = {}
        p = os.path.join(self.dir, name + '.csv')
        if not os.path.exists(p):
            return out
        for r in self._rows(name):
            v = r.get('Close', '')
            if v not in ('', '.'):
                out[date.fromisoformat(r['Date'])] = float(v)
        return out

    def locate(self, d):
        i = bisect.bisect_right(self.dates, d) - 1
        return i if i >= 0 and (d - self.dates[i]).days <= 4 else None

    def mdd12(self, d):
        """RUT drawdown from the highest of the last 12 month-end closes (months strictly before d's month)."""
        j = bisect.bisect_left(self._me_keys, (d.year, d.month))
        keys = self._me_keys[max(0, j - 12):j]
        if len(keys) < 12:
            return None
        cl = [self._me[k] for k in keys]
        return cl[-1] / max(cl) - 1

    def cycles(self, off, start=None, end=None):
        """(third Friday, expiry, entry index, expiry index) exactly as the engine's replay_daily builds them."""
        dates = self.dates
        years = sorted({d.year for d in dates})
        fr = [third_friday(y, m) for y in years for m in range(1, 13)]
        for n in range(len(fr) - 1):
            entry, expiry = fr[n], fr[n + 1]
            if entry < max(FIRST_ENTRY, dates[0] + timedelta(days=60)) or (start and entry < start) or (end and entry >= end):
                continue
            ie = self.locate(entry)
            if ie is None:
                continue
            ie += off
            ix = self.locate(expiry)
            if ix is None or expiry > dates[-1] or ie >= ix or self.V[ie] is None:
                continue
            yield entry, expiry, ie, ix


# ---------------------------------------------------------------- chains
class Chain:
    """Puts of one expiry on one day. Arrays sorted by strike ascending. mid is nan where there is no usable quote."""
    __slots__ = ('K', 'bid', 'ask', 'mid', 'pd', 'iv', 'S', 'expir', 'dups')

    def __init__(self, K, bid, ask, pd, iv, S, expir=None, dups=0):
        self.K = np.asarray(K, float)
        self.bid = np.asarray(bid, float)
        self.ask = np.asarray(ask, float)
        self.pd = np.asarray(pd, float)
        self.iv = np.asarray(iv, float)
        ok = (self.ask > 0) & (self.ask >= self.bid)
        self.mid = np.where(ok, (self.bid + self.ask) / 2, np.nan)
        self.S = float(S)
        self.expir = expir
        self.dups = dups

    def at(self, k):
        j = int(np.searchsorted(self.K, k))
        return j if j < len(self.K) and abs(self.K[j] - k) < 1e-6 else -1

    def mid_at(self, k):
        """(mid, interpolated?) at strike k: the listed quote, else a straight line between the listed neighbours."""
        j = self.at(k)
        if j >= 0 and self.mid[j] == self.mid[j]:
            return float(self.mid[j]), False
        hi = int(np.searchsorted(self.K, k))
        lo = hi - 1
        while hi < len(self.K) and (self.mid[hi] != self.mid[hi] or abs(self.K[hi] - k) < 1e-6):
            hi += 1
        while lo >= 0 and (self.mid[lo] != self.mid[lo] or abs(self.K[lo] - k) < 1e-6):
            lo -= 1
        if lo < 0 or hi >= len(self.K) or self.K[hi] - self.K[lo] > 60:
            return NAN, True
        w = (k - self.K[lo]) / (self.K[hi] - self.K[lo])
        return float(self.mid[lo] + w * (self.mid[hi] - self.mid[lo])), True

    def iv_at(self, k):
        ok = self.iv == self.iv
        ok &= self.iv > 0
        if not ok.any():
            return NAN
        return float(np.interp(k, self.K[ok], self.iv[ok]))

    def half_near(self, k):
        ok = self.mid == self.mid
        if not ok.any():
            return 0.25
        j = int(np.argmin(np.where(ok, np.abs(self.K - k), np.inf)))
        return float((self.ask[j] - self.bid[j]) / 2)


class SynthChains:
    """Model chain: iv(K) = a x RVX + c0 / sqrt(max(DTE, dmin)) x (RVX/23)^gamma x ln(S/K); half-spread h0 + h1 x price."""

    def __init__(self, mkt, a=0.82, c0=5.45, dmin=10.0, gamma=0.0, h0=0.14, h1=0.0025, lo=0.15, hi=1.30, step=STEP):
        self.m, self.a, self.c0, self.dmin, self.gamma = mkt, a, c0, dmin, gamma
        self.h0, self.h1, self.lo, self.hi, self.step = h0, h1, lo, hi, step
        self._c = {}

    def iv(self, v, S, k, T):
        c = self.c0 / math.sqrt(max(T * 365, self.dmin)) * (v / 0.23) ** self.gamma
        return self.a * v + c * max(0.0, math.log(S / k))

    def expiries(self, d):
        """Every Friday in the next 100 days (the model can price any date)."""
        f = d + timedelta(days=(4 - d.weekday()) % 7 or 7)
        return [f + timedelta(days=7 * n) for n in range(14)]

    def spread_mid(self, S, v, T, k, width):
        return put_price(S, k, self.iv(v, S, k, T), T) - put_price(S, k - width, self.iv(v, S, k - width, T), T)

    def chain(self, d, expiry, v_fallback=None, exact=False):
        key = (d, expiry)
        if key in self._c:
            return self._c[key]
        S = self.m.close.get(d)
        v = self.m.vol.get(d)
        if v is None:
            v = v_fallback
        if S is None or v is None:
            return None
        v = v / 100
        T = max((expiry - d).days, 1) / 365
        st = self.step
        ks = [st * n for n in range(int(math.ceil(self.lo * S / st)), int(math.floor(self.hi * S / st)) + 1)]
        bid, ask, pd, ivs = [], [], [], []
        for k in ks:
            iv = self.iv(v, S, k, T)
            p = put_price(S, k, iv, T)
            h = self.h0 + self.h1 * p
            bid.append(p - h)
            ask.append(p + h)
            pd.append(bs_put_delta(S, k, iv, T))
            ivs.append(iv)
        ch = Chain(ks, bid, ask, pd, ivs, S, expiry)
        ch.mid = (ch.bid + ch.ask) / 2            # model quotes are always usable (bid may be below zero far out)
        if len(self._c) > 4000:
            self._c.clear()
        self._c[key] = ch
        return ch


ORATS_COLS = ['ticker', 'tradeDate', 'expirDate', 'dte', 'strike', 'stockPrice', 'spotPrice', 'putBidPrice', 'putValue',
              'putAskPrice', 'callBidPrice', 'callAskPrice', 'putMidIv', 'smvVol', 'delta', 'putOpenInterest',
              'putVolume', 'expiryTod']


def _extract_day(args):
    path, tickers = args
    try:
        with gzip.open(path, 'rt') as f:
            rows = json.load(f).get('data', [])
    except Exception as e:  # noqa: BLE001
        return path, None, str(e)
    keep = [[r.get(c) for c in ORATS_COLS] for r in rows if r.get('ticker') in tickers]
    return path, keep, None


def extract(strikes_dir, out_dir, tickers=('RUT',), years=None, procs=4):
    """strikes/<YYYY>/<YYYY-MM-DD>.json.gz -> <out_dir>/<TICKER>_<YYYY>.parquet (slim columns). Skips years already
    built unless the raw folder has newer files."""
    import pandas as pd
    from multiprocessing import Pool
    os.makedirs(out_dir, exist_ok=True)
    done = {}
    for ydir in sorted(os.listdir(strikes_dir)):
        if not ydir.isdigit() or (years and int(ydir) not in years):
            continue
        files = sorted(f for f in os.listdir(os.path.join(strikes_dir, ydir)) if f.endswith('.json.gz'))
        if not files:
            continue
        outs = {t: os.path.join(out_dir, '%s_%s.parquet' % (t, ydir)) for t in tickers}
        newest = max(os.path.getmtime(os.path.join(strikes_dir, ydir, f)) for f in files)
        if all(os.path.exists(p) and os.path.getmtime(p) >= newest for p in outs.values()):
            done[ydir] = (len(files), 'cached')
            continue
        jobs = [(os.path.join(strikes_dir, ydir, f), set(tickers)) for f in files]
        rows, bad = [], 0
        with Pool(procs) as pool:
            for _p, keep, err in pool.imap_unordered(_extract_day, jobs, chunksize=4):
                if err:
                    bad += 1
                else:
                    rows.extend(keep)
        df = pd.DataFrame(rows, columns=ORATS_COLS)
        for t, p in outs.items():
            df[df.ticker == t].to_parquet(p, compression='zstd', index=False)
        done[ydir] = (len(files), 'built, %d unreadable' % bad)
    return done


class OratsChains:
    """Real chains from the slim parquet files written by extract()."""

    def __init__(self, cache_dir, ticker='RUT'):
        self.dir, self.ticker = cache_dir, ticker
        self._years = {}
        self._cc = {}                  # (day, expiry, exact) -> Chain or None; survives the year cache
        self.stats = Counter()

    def _year(self, y):
        if y in self._years:
            return self._years[y]
        import pandas as pd
        p = os.path.join(self.dir, '%s_%d.parquet' % (self.ticker, y))
        out = {}
        if os.path.exists(p):
            df = pd.read_parquet(p)
            for c in ('strike', 'stockPrice', 'spotPrice', 'putBidPrice', 'putAskPrice', 'putMidIv', 'smvVol', 'delta',
                      'putOpenInterest'):
                df[c] = pd.to_numeric(df[c], errors='coerce')
            df['tradeDate'] = df['tradeDate'].astype(str).str[:10]
            df['expirDate'] = df['expirDate'].astype(str).str[:10]
            for (td, ex), g in df.groupby(['tradeDate', 'expirDate'], sort=False):
                out.setdefault(date.fromisoformat(td), {})[date.fromisoformat(ex)] = g
        if len(self._years) > 3:
            self._years.pop(next(iter(self._years)))
        self._years[y] = out
        return out

    def has_day(self, d):
        return d in self._year(d.year)

    def expiries(self, d):
        return sorted(self._year(d.year).get(d, {}))

    def chain(self, d, expiry, v_fallback=None, exact=False):
        key = (d, expiry, exact)
        if key not in self._cc:
            self._cc[key] = self._chain(d, expiry, exact)
        return self._cc[key]

    def _chain(self, d, expiry, exact):
        day = self._year(d.year).get(d)
        if not day:
            self.stats['no_day'] += 1
            return None
        g = None
        for cand in ((expiry,) if exact else (expiry, expiry + timedelta(days=1), expiry - timedelta(days=1))):
            if cand in day:
                g, ex = day[cand], cand
                break
        if g is None:
            self.stats['no_expiry'] += 1
            return None
        if not isinstance(g, Chain):
            dups = 0
            if g['strike'].duplicated().any():
                dups = int(g['strike'].duplicated().sum())
                tod = g['expiryTod'].astype(str).str.lower() if 'expiryTod' in g else None
                if tod is not None and tod.str.startswith('a').any() and not tod.str.startswith('a').all():
                    g = g[tod.str.startswith('a')]                 # third Friday: the AM settled monthly
                g = g.sort_values('putOpenInterest', ascending=False).drop_duplicates('strike')
            g = g.sort_values('strike')
            S = g['spotPrice'].iloc[0]
            if not (S == S and S > 0):
                S = g['stockPrice'].iloc[0]
            iv = g['putMidIv'].where(g['putMidIv'] > 0, g['smvVol'])
            if iv.median() > 3:                                    # percent, not a fraction
                iv = iv / 100
            g = Chain(g['strike'].values, g['putBidPrice'].fillna(0).values, g['putAskPrice'].fillna(0).values,
                      (1.0 - g['delta']).values, iv.values, S, ex, dups)
            day[ex] = g
        if g.dups:
            self.stats['dup_days'] += 1
        return g


# ---------------------------------------------------------------- the strike rule and one trade
def pick_strike(ch, spec, dte, info=None):
    """Course strike on listed strikes. Returns the index of the short strike in ch, or None when nothing qualifies."""
    S, K = ch.S, ch.K
    dte = max(dte, 1)
    w0, L = spec['ref_width'], spec['kelly_loss']
    k0 = math.floor(S * (1 - spec['min_distance'] * dte / 45) / STEP) * STEP
    j = int(np.searchsorted(K, k0 + 1e-9, side='right')) - 1
    while j >= 0 and not (ch.pd[j] <= spec['delta_cap']):
        j -= 1
        if j < 0 or K[j] < 0.4 * S:
            return None
    best = None
    while j >= 0:
        k = K[j]
        if k - w0 <= 0.3 * S:
            break
        ms = ch.mid[j]
        ml, interp = ch.mid_at(k - w0)
        if ms != ms or ml != ml:
            j -= 1
            continue
        credit = ms - ml
        if credit <= 0 or credit >= w0:
            break
        aroc = credit / (w0 - credit) * 365 / dte
        if credit < 0.05 or aroc < spec['aroc']:
            break
        d = float(ch.pd[j])
        R = credit / (L * (w0 - credit))
        if (1 - d) - d / R >= spec['kelly_min']:
            best = j
            if info is not None:
                info.update(ref_credit=credit, ref_interp=interp, aroc=aroc)
        j -= 1
    return best


FILL_ENGINE = dict(entry_share=0.33, entry_fixed=0.0, exit_share=1.0, exit_slip=0.0)


def _leg(ch, k, S, T, last_iv, last_half):
    """(mid, half-spread, put delta, iv, fallback?) of strike k on chain ch; Black-Scholes fallback when not quoted."""
    if ch is not None:
        j = ch.at(k)
        if j >= 0 and ch.mid[j] == ch.mid[j]:
            return (float(ch.mid[j]), float(ch.ask[j] - ch.bid[j]) / 2, float(ch.pd[j]),
                    float(ch.iv[j]) if ch.iv[j] == ch.iv[j] and ch.iv[j] > 0 else last_iv, False)
        iv = ch.iv_at(k)
        if iv != iv:
            iv = last_iv
        half = ch.half_near(k)
        if len(ch.K) and k > ch.K[-1] and S < k:        # above the kept strikes: deep in the money (delta filter)
            return max(put_price(S, k, iv, T), k - S), half, max(bs_put_delta(S, k, iv, T), 0.66), iv, True
        return put_price(S, k, iv, T), half, bs_put_delta(S, k, iv, T), iv, True
    return put_price(S, k, last_iv, T), last_half, bs_put_delta(S, k, last_iv, T), last_iv, True


def one_trade(mkt, chains, sid, entry_tf, expiry, i0, ix, wing=WING, fill=FILL_ENGINE, exit_delta=None, picker=None,
              exit_scale=1.0, settle='open', thursday=True):
    """One spread from entry to exit. exit_scale multiplies the delta trigger; settle='close' is for PM-settled
    expiries; thursday=False turns the day-before-expiry rule off."""
    spec = SPECS[sid]
    dates = mkt.dates
    d0 = dates[i0]
    v0 = mkt.V[i0]
    base = dict(strategy=sid, chain=entry_tf, entry=d0, expiry=expiry, vol=v0, close0=mkt.close[d0])
    skip = dict(base, exit=d0, kind='skip', short_strike=None, credit=0.0, risk=0.0, pnl=0.0, ror=0.0)
    dte = (expiry - d0).days
    ch = chains.chain(d0, expiry, v0)
    if ch is None or not len(ch.K):
        return dict(skip, why='nodata')
    info = {}
    j = (picker or pick_strike)(ch, spec, dte, info)
    if j is None:
        return dict(skip, why='rule', spot=ch.S)
    K = float(ch.K[j])
    jl = int(np.searchsorted(ch.K, K - wing + 1e-9, side='right')) - 1
    while jl >= 0 and ch.mid[jl] != ch.mid[jl]:
        jl -= 1
    if jl < 0:
        return dict(skip, why='nolong', spot=ch.S)
    Kl = float(ch.K[jl])
    width = K - Kl
    ms, ml = float(ch.mid[j]), float(ch.mid[jl])
    hs, hl = float(ch.ask[j] - ch.bid[j]) / 2, float(ch.ask[jl] - ch.bid[jl]) / 2
    credit = ms - ml
    if credit < 0.05:
        return dict(skip, why='credit', spot=ch.S)
    risk = width - credit
    c_in = fill['entry_share'] * (hs + hl) + fill['entry_fixed'] + 2 * COMM
    ivs = float(ch.iv[j]) if ch.iv[j] == ch.iv[j] else v0 / 100
    ivl = float(ch.iv[jl]) if ch.iv[jl] == ch.iv[jl] else ivs
    xd = (spec['exit_delta'] if exit_delta is None else exit_delta) * exit_scale
    base.update(short_strike=K, long_strike=Kl, width=width, credit=credit, risk=risk, entry_delta=float(ch.pd[j]),
                spot=ch.S, cost_in=c_in, half_in=hs + hl, ref_credit=info.get('ref_credit'),
                ref_interp=info.get('ref_interp'), aroc=info.get('aroc'), dte=dte, forced=bool(info.get('forced')))
    ex = ch.expir or expiry
    base['listed_expiry'] = ex
    marks = {d0: credit}
    flags = Counter()
    liab = credit
    for i in range(i0 + 1, ix + 1):
        d = dates[i]
        px = mkt.close[d]
        T = max((expiry - d).days, 1) / 365
        kind = None
        if i == ix:
            s_px = mkt.open.get(d, px) if settle == 'open' else px
            gross = credit - max(K - s_px, 0.0) + max(Kl - s_px, 0.0)
            pnl = gross - c_in
            S = s_px
            c_out = h_out = 0.0
            kind = 'expired_win' if pnl >= 0 else 'expired_loss'
        else:
            cd = chains.chain(d, ex, v0, exact=True)      # the same listed expiry as at entry
            S = cd.S if cd is not None else px
            last = i == ix - 1
            if cd is None:
                flags['noday'] += 1
                delta = None
                if last:
                    ms, hs, _d, ivs, _f = _leg(None, K, S, T, ivs, hs)
                    ml, hl, _d, ivl, _f = _leg(None, Kl, S, T, ivl, hl)
                    liab = ms - ml
            else:
                ms, hs, delta, ivs, f1 = _leg(cd, K, S, T, ivs, hs)
                ml, hl, _d, ivl, f2 = _leg(cd, Kl, S, T, ivl, hl)
                if f1 or f2:
                    flags['fallback'] += 1
                liab = min(max(ms - ml, 0.0), width) if (f1 or f2) else ms - ml
            gross = pnl = credit - liab
            if delta is not None and delta > xd:
                kind = 'delta_exit'
            elif last and thursday and px < K * (1 + spec['buffer']):
                kind = 'thursday'
            if kind:
                h_out = hs + hl
                c_out = fill['exit_share'] * h_out + fill['exit_slip'] + 2 * COMM
                pnl -= c_in + c_out
            else:
                marks[d] = liab
        if kind:
            pnl = max(pnl, -risk)
            return dict(base, exit=d, kind=kind, pnl=pnl, ror=pnl / risk, days_held=(d - d0).days, cost_out=c_out,
                        gross=gross, half_out=h_out, exit_spot=S, marks=marks, flags=dict(flags))
    raise RuntimeError('unreachable')


def refill(recs, fill):
    """The same trades under another fill assumption (costs only; strikes, exits and marks unchanged)."""
    out = []
    for r in recs:
        if r['kind'] == 'skip':
            out.append(r)
            continue
        c_in = fill['entry_share'] * r['half_in'] + fill['entry_fixed'] + 2 * COMM
        c_out = (fill['exit_share'] * r['half_out'] + fill['exit_slip'] + 2 * COMM) if r['kind'] in ('delta_exit', 'thursday') else 0.0
        pnl = max(r['gross'] - c_in - c_out, -r['risk'])
        out.append(dict(r, cost_in=c_in, cost_out=c_out, pnl=pnl, ror=pnl / r['risk']))
    return out


def pick_noskip(ch, spec, dte, info=None):
    """Course strike; when the course rule finds nothing, the first quoted strike at or below the distance floor with
    delta inside the cap (the trade the course would skip). Marks it forced."""
    j = pick_strike(ch, spec, dte, info)
    if j is not None:
        return j
    S, K = ch.S, ch.K
    k0 = math.floor(S * (1 - spec['min_distance'] * max(dte, 1) / 45) / STEP) * STEP
    j = int(np.searchsorted(K, k0 + 1e-9, side='right')) - 1
    while j >= 0 and not (ch.pd[j] <= spec['delta_cap'] and ch.mid[j] == ch.mid[j]):
        j -= 1
    if j < 0 or K[j] < 0.4 * S:
        return None
    if info is not None:
        info.update(forced=True)
    return j


def replay(mkt, chains, sid, off, start=None, end=None, **kw):
    out = []
    for entry_tf, expiry, ie, ix in mkt.cycles(off, start, end):
        out.append(one_trade(mkt, chains, sid, entry_tf, expiry, ie, ix, **kw))
    return out


def replay_all(mkt, chains, start=None, end=None, offs=(0, 1, 2), sids=SIDS, **kw):
    """Every sleeve and entry day, walked in calendar order so a real-chain loader reads each year once."""
    jobs = [(c[0], o, s, c) for o in offs for c in mkt.cycles(o, start, end) for s in sids]
    jobs.sort(key=lambda j: (j[0], j[1], j[2]))
    recs = {(s, o): [] for s in sids for o in offs}
    for _tf, o, s, (entry_tf, expiry, ie, ix) in jobs:
        recs[(s, o)].append(one_trade(mkt, chains, s, entry_tf, expiry, ie, ix, **kw))
    return recs


# ---------------------------------------------------------------- account
def account(mkt, trades, size=1 / 3, start=None, end=None, start_cash=100000.0, mdd_mult=1.5, weights=None,
            loan_spread=0.015):
    """Daily account: each entry risks NLV x size / 9 at max loss (x mult after a 15% 12-month RUT drawdown, capped at
    50% of the account in total), cash earns T-bills, open spreads marked at mid. Returns [(date, nlv)]."""
    start = start or mkt.dates[0]
    end = end or mkt.dates[-1]
    cal = [d for d in mkt.dates if start <= d <= end]
    flag_mult = min(mdd_mult, 0.5 / size) if mdd_mult else 1.0
    ent = defaultdict(list)
    for t in trades:
        if t['kind'] == 'skip' or t['entry'] < start or t['exit'] > end:
            continue
        ent[t['entry']].append(t)
    for d in ent:
        ent[d].sort(key=lambda t: t['strategy'])
    pos, cash, out = [], start_cash, []
    info = Counter()
    for k, d in enumerate(cal):
        if k:
            days = (d - cal[k - 1]).days
            rate = tbill(d) if cash >= 0 else tbill(d) + loan_spread
            cash += cash * rate * days / 365
        keep = []
        for t, n in pos:
            if t['exit'] == d:
                cash += -n * 100 * (t['credit'] - t['cost_in'] - t['pnl'])
            else:
                keep.append((t, n))
        pos = keep
        L = sum(n * 100 * t['marks'].get(d, t['_last']) for t, n in pos)
        nlv_pre = cash - L
        new = ent.get(d, ())
        if new:
            w_open = sum(n * 100 * t['width'] for t, n in pos)
            add = []
            for t in new:
                m = flag_mult if (mkt.mdd12(t['entry']) or 0) < -0.15 else 1.0
                if 'size_mult' in t:                       # optional per-trade tilt, same 50% ceiling
                    m = min(m * t['size_mult'], 0.5 / size)
                w = 1.0 if weights is None else weights[t['strategy']] * 3
                n = max(nlv_pre, 0.0) * size / 9 * m * w / (t['risk'] * 100)
                add.append((t, n))
            A = sum(n * 100 * (t['credit'] - t['cost_in']) for t, n in add)
            B = sum(n * 100 * t['width'] for t, n in add)
            if cash + A < w_open + B:
                info['regt_short'] += 1
            for t, n in add:
                cash += n * 100 * (t['credit'] - t['cost_in'])
                pos.append((t, n))
        L = 0.0
        for t, n in pos:
            t['_last'] = t['marks'].get(d, t.get('_last', t['credit']))
            L += n * 100 * t['_last']
        out.append((d, cash - L))
    return out, dict(info)


def acct_stats(out, start_cash=None):
    ds = [d for d, _ in out]
    eq = [e for _, e in out]
    e0 = start_cash or eq[0]
    yrs = (ds[-1] - ds[0]).days / 365.25
    cagr = (eq[-1] / e0) ** (1 / yrs) - 1
    peak, dd = e0, 0.0
    for e in eq:
        peak = max(peak, e)
        dd = max(dd, 1 - e / peak)
    me = []                                   # month-end series
    for i, d in enumerate(ds):
        if i + 1 == len(ds) or (ds[i + 1].year, ds[i + 1].month) != (d.year, d.month):
            me.append((d, eq[i]))
    mr, mex = [], []
    for (da, ea), (db, eb) in zip(me, me[1:]):
        r = eb / ea - 1
        mr.append(r)
        mex.append(r - ((1 + tbill(db)) ** ((db - da).days / 365.25) - 1))
    mean = sum(mex) / len(mex)
    sd = math.sqrt(sum((x - mean) ** 2 for x in mex) / len(mex))
    pos_m = sum(r for r in mr if r > 0)
    neg_m = -sum(r for r in mr if r < 0)
    yr = {}
    for d, e in out:
        yr.setdefault(d.year, [e, e])[1] = e
    ys = sorted(yr)
    yret = {y: yr[y][1] / (yr[ys[i - 1]][1] if i else e0) - 1 for i, y in enumerate(ys)}
    return dict(cagr=100 * cagr, dd=100 * dd, sharpe=mean / sd * math.sqrt(12) if sd else NAN,
                pf_month=pos_m / neg_m if neg_m else NAN, worst_month=100 * min(mr), worst_year=100 * min(yret.values()),
                pos_months=100 * sum(r > 0 for r in mr) / len(mr), end=eq[-1], years=yret)


def trade_stats(recs):
    tr = [r for r in recs if r['kind'] != 'skip']
    n = len(recs)
    if not tr:
        return dict(cycles=n, trades=0, skip_pct=100.0 if n else NAN)
    rr = [r['pnl'] / r['risk'] for r in tr]
    w = [x for x in rr if x > 0]
    l = [x for x in rr if x <= 0]
    return dict(cycles=n, trades=len(tr), skip_pct=100 * (n - len(tr)) / n, win_pct=100 * len(w) / len(tr),
                avg_win=100 * sum(w) / len(w) if w else NAN, avg_loss=100 * sum(l) / len(l) if l else NAN,
                pf=sum(w) / -sum(l) if l and sum(l) < 0 else NAN, exp=100 * sum(rr) / len(rr),
                credit_pct=100 * sum(r['credit'] / r['width'] for r in tr) / len(tr),
                dist_pct=100 * sum(1 - r['short_strike'] / r['spot'] for r in tr) / len(tr),
                kinds=dict(Counter(r['kind'] for r in tr)), why=dict(Counter(r.get('why') for r in recs if r['kind'] == 'skip')),
                fallback_trades=sum(1 for r in tr if r.get('flags', {}).get('fallback')),
                noday_trades=sum(1 for r in tr if r.get('flags', {}).get('noday')),
                ref_interp=sum(1 for r in tr if r.get('ref_interp')))


def run_package(mkt, chains, start, end, offs=(0, 1, 2), sizes=(1 / 3,), fill=FILL_ENGINE, weights=None, recs=None, **kw):
    """All three sleeves on the Fri/Mon/Tue split. Returns (records by (sid, off), per-sleeve stats, account stats by size)."""
    if recs is None:
        recs = replay_all(mkt, chains, start, end, offs, fill=fill, **kw)
    per = {s: trade_stats([r for o in offs for r in recs[(s, o)]]) for s in SIDS}
    pooled = sorted((r for v in recs.values() for r in v if r['kind'] != 'skip'), key=lambda r: (r['entry'], r['strategy']))
    acc = {}
    for sz in sizes:
        for r in pooled:
            r.pop('_last', None)
        out, info = account(mkt, pooled, sz, start, end, weights=weights)
        acc[round(sz, 3)] = dict(acct_stats(out, 100000.0), **info)
    return recs, per, acc


def fmt_stats(per, acc):
    lines = []
    for s in SIDS:
        p = per[s]
        if not p.get('trades'):
            lines.append('%-8s cycles %d, no trades' % (s, p['cycles']))
            continue
        lines.append('%-8s cycles %3d trades %3d skip %4.1f%% | win %4.1f%% avg win %+5.2f avg loss %+6.2f PF %4.2f exp %+5.2f '
                     '| credit %4.2f%% of width, %4.1f%% OTM | %s | skips %s | fallback %d noday %d refinterp %d'
                     % (s, p['cycles'], p['trades'], p['skip_pct'], p['win_pct'], p['avg_win'], p['avg_loss'], p['pf'],
                        p['exp'], p['credit_pct'], p['dist_pct'], p['kinds'], p['why'], p['fallback_trades'],
                        p['noday_trades'], p['ref_interp']))
    for sz, a in acc.items():
        lines.append('account size %.0f%%: CAGR %5.2f%%  maxDD %5.2f%%  Sharpe %4.2f  monthly PF %4.2f  worst month %5.1f%%  '
                     'worst year %5.1f%%  +months %4.1f%%  end $%.0f  regT-short entries %d'
                     % (100 * sz, a['cagr'], a['dd'], a['sharpe'], a['pf_month'], a['worst_month'], a['worst_year'],
                        a['pos_months'], a['end'], a.get('regt_short', 0)))
    return '\n'.join(lines)
