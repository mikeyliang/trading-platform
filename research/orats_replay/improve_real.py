"""Improvement tests for the Rule One bull put package on real quotes.

    python improve_real.py --strikes <orats>/strikes --cache <orats>/parquet/slim \
                           --daily <repo>/api/data/spread_history/daily --out <orats>/replay/improveN

Each block changes one thing against the same base (course strike, $55 wing, Fri/Mon/Tue, 33% at max loss) and reports
return, drawdown, Sharpe and profit factor:

  A  what the chain looked like at entry (richness vs the price model, skew, term slope, implied minus realised, ...)
     and how trades did by third of each reading
  B  sizing on those readings, ranked only against earlier trades, with a month-shuffle placebo
  C  where on the chain to sell: nearest / middle / furthest strike that passes the course rule, or a fixed real delta
  D  earlier or later delta exits, and the Thursday rule off
  E  other days to expiry from the same entry days
  F  Space on real S&P 500 quotes (needs the SPX slim files; skipped when they are missing)

Reads the slim parquet built by run_real.py (builds it when --strikes is given). Everything it writes stays in --out:
summary.txt and result.json hold aggregates only.
"""
import argparse
import json
import math
import os
import pickle
import random
import sys
import time
from collections import Counter, defaultdict
from datetime import date, timedelta

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orats_replay as R  # noqa: E402
import run_real as RR  # noqa: E402

OFFS = (0, 1, 2)
FEATS = ('rich', 'skew', 'term', 'iv_rv', 'atm_rvx', 'sig_otm', 'width_rel', 'rvx_rank', 'dd60')
FEAT_HELP = dict(
    rich='real credit / model credit, same strike',
    skew='IV at the 10-delta put / at-the-money IV - 1',
    term='next monthly ATM IV / this expiry ATM IV - 1',
    iv_rv='at-the-money IV minus 20-day realised vol (points)',
    atm_rvx='at-the-money IV / RVX index',
    sig_otm='distance to the short strike in implied standard deviations',
    width_rel='bid/ask half-width of the spread / credit',
    rvx_rank='RVX rank over the last 252 days',
    dd60='RUT vs its 60-day high')


# ------------------------------------------------------------------ small helpers
def pooled(recs, offs=OFFS, sids=R.SIDS):
    return [r for s in sids for o in offs for r in recs.get((s, o), ())]


def acct(mkt, trades, start, end, size=1 / 3, weights=None):
    tr = sorted((dict(r) for r in trades if r['kind'] != 'skip'), key=lambda r: (r['entry'], r['strategy']))
    for r in tr:
        r.pop('_last', None)
    if not tr:
        return None
    out, info = R.account(mkt, tr, size, start, end, weights=weights)
    return dict(R.acct_stats(out, 100000.0), **info)


def tline(tag, st):
    if not st.get('trades'):
        return '%-30s cycles %d, no trades' % (tag, st.get('cycles', 0))
    return ('%-30s trades %4d skip %4.1f%% | win %5.1f%% avg win %+5.2f avg loss %+7.2f PF %5.2f exp %+5.2f | '
            'credit %4.2f%% of width, %4.1f%% OTM | %s' % (
                tag, st['trades'], st['skip_pct'], st['win_pct'], st['avg_win'], st['avg_loss'], st['pf'], st['exp'],
                st['credit_pct'], st['dist_pct'], st['kinds']))


def aline(tag, a):
    return RR.acc_line(tag, a) if a else '%-34s no trades' % tag


def slim_t(st):
    return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in st.items()}


# ------------------------------------------------------------------ A: the chain at entry
def iv_at_delta(ch, dl):
    ok = (ch.iv == ch.iv) & (ch.iv > 0) & (ch.pd == ch.pd) & (ch.pd > 0.005) & (ch.pd < 0.6)
    if ok.sum() < 3:
        return R.NAN
    pd, iv = ch.pd[ok], ch.iv[ok]
    o = np.argsort(pd)
    if dl < pd[o][0] or dl > pd[o][-1]:
        return R.NAN
    return float(np.interp(dl, pd[o], iv[o]))


def next_monthly(chains, d0, expiry):
    for ex in chains.expiries(d0):
        gap = (ex - expiry).days
        if 21 <= gap <= 43:
            tf = R.third_friday(ex.year, ex.month)
            if ex in (tf, tf + timedelta(days=1), tf - timedelta(days=1)):
                return ex
    return None


def add_features(mkt, real, syn, r):
    """Readings taken from the entry-day chain only (nothing from later days)."""
    d0, expiry = r['entry'], r['expiry']
    f = {}
    i = mkt.idx[d0]
    v = mkt.vol.get(d0)
    ch = real.chain(d0, expiry, v)
    if ch is None or not len(ch.K):
        r['feat'] = f
        return
    T = max((expiry - d0).days, 1) / 365
    atm = ch.iv_at(ch.S)
    if atm == atm and atm > 0:
        if v:
            f['atm_rvx'] = atm * 100 / v
        if i >= 20:
            cl = [mkt.close[mkt.dates[k]] for k in range(i - 20, i + 1)]
            lr = [math.log(b / a) for a, b in zip(cl, cl[1:])]
            f['iv_rv'] = atm * 100 - 100 * math.sqrt(sum(x * x for x in lr) / len(lr) * 252)
        p10 = iv_at_delta(ch, 0.10)
        if p10 == p10:
            f['skew'] = p10 / atm - 1
        nx = next_monthly(real, d0, ch.expir or expiry)
        if nx is not None:
            c2 = real.chain(d0, nx, v, exact=True)
            a2 = c2.iv_at(c2.S) if c2 is not None and len(c2.K) else R.NAN
            if a2 == a2 and a2 > 0:
                f['term'] = a2 / atm - 1
    if i >= 252 and v:
        hist = [x for x in mkt.V[i - 252:i] if x is not None]
        if hist:
            f['rvx_rank'] = sum(x < v for x in hist) / len(hist)
    if i >= 60:
        f['dd60'] = mkt.close[d0] / max(mkt.close[mkt.dates[k]] for k in range(i - 60, i + 1)) - 1
    if r['kind'] != 'skip':
        K, w0 = r['short_strike'], R.SPECS[r['strategy']]['ref_width']
        if r.get('ref_credit') and v:
            m = syn.spread_mid(ch.S, v / 100, T, K, w0)
            if m > 0.01:
                f['rich'] = r['ref_credit'] / m
        if atm == atm and atm > 0:
            f['sig_otm'] = math.log(ch.S / K) / (atm * math.sqrt(T))
        if r['credit'] > 0:
            f['width_rel'] = r['half_in'] / r['credit']
    r['feat'] = f


def thirds_table(trades, name):
    """In-sample thirds of one reading, ranked inside each sleeve."""
    rows = defaultdict(list)
    for sid in R.SIDS:
        xs = sorted((r['feat'][name], id(r), r) for r in trades if r['strategy'] == sid and name in r['feat'])
        n = len(xs)
        for k, (_x, _i, r) in enumerate(xs):
            rows[min(2, 3 * k // n) if n >= 3 else 1].append(r)
    out = {}
    for t in (0, 1, 2):
        rs = rows.get(t, [])
        if not rs:
            continue
        rr = [100 * r['pnl'] / r['risk'] for r in rs]
        loss = [x for x in rr if x <= 0]
        out[('low', 'mid', 'high')[t]] = dict(
            n=len(rs), value_med=round(float(np.median([r['feat'][name] for r in rs])), 4),
            exp=round(sum(rr) / len(rr), 2), loss_pct=round(100 * len(loss) / len(rr), 1),
            avg_loss=round(sum(loss) / len(loss), 2) if loss else None, worst=round(min(rr), 1))
    return out


# ------------------------------------------------------------------ B: sizing on a reading
def forward_rank(trades, name, min_hist=18):
    """Rank of each trade's reading against earlier trades of the same sleeve (None until there is enough history)."""
    out = {}
    for sid in R.SIDS:
        rs = sorted((r for r in trades if r['strategy'] == sid), key=lambda r: r['entry'])
        hist = []
        for r in rs:
            x = r['feat'].get(name)
            prev = [h for d, h in hist if d < r['entry']]
            if x is not None and len(prev) >= min_hist:
                out[id(r)] = sum(h < x for h in prev) / len(prev)
            if x is not None:
                hist.append((r['entry'], x))
    return out


def tilt_set(trades, rank, mode):
    """Trades with a size multiplier (or dropped) by forward rank. mode: hi / lo (size up that third, down the other),
    skip_lo / skip_hi (leave that third out)."""
    out = []
    for r in trades:
        p = rank.get(id(r))
        m = 1.0
        if p is not None:
            top, bot = p >= 2 / 3, p < 1 / 3
            if mode == 'hi':
                m = 1.5 if top else 0.5 if bot else 1.0
            elif mode == 'lo':
                m = 0.5 if top else 1.5 if bot else 1.0
            elif mode == 'skip_lo' and bot:
                m = 0.0
            elif mode == 'skip_hi' and top:
                m = 0.0
        if m > 0:
            out.append(dict(r, size_mult=m))
        else:
            out.append(dict(r, size_mult=0.0, _drop=True))
    return out


def weighted_exp(ts):
    w = sum(t['size_mult'] for t in ts)
    return sum(t['size_mult'] * t['pnl'] / t['risk'] for t in ts) / w if w else R.NAN


def placebo(ts, draws, seed=7):
    """Share of month shuffles (multipliers moved between months as a block) whose size-weighted result per unit of
    risk is at least as good as the real ordering."""
    months = sorted({t['chain'] for t in ts})
    if len(months) < 6:
        return None
    key = lambda t: (t['strategy'], (t['entry'] - t['chain']).days)  # noqa: E731
    mult = {(t['chain'], key(t)): t['size_mult'] for t in ts}
    real = weighted_exp(ts)
    rng, ge = random.Random(seed), 0
    for _ in range(draws):
        sh = months[:]
        rng.shuffle(sh)
        mp = dict(zip(months, sh))
        w = s = 0.0
        for t in ts:
            m = mult.get((mp[t['chain']], key(t)), 1.0)
            w += m
            s += m * t['pnl'] / t['risk']
        if w and s / w >= real - 1e-12:
            ge += 1
    return ge / draws


# ------------------------------------------------------------------ C: where on the chain to sell
def passing(ch, spec, dte):
    """Every strike that passes the course rule, nearest first (the course sells the last one)."""
    S, K = ch.S, ch.K
    dte = max(dte, 1)
    w0, L = spec['ref_width'], spec['kelly_loss']
    k0 = math.floor(S * (1 - spec['min_distance'] * dte / 45) / R.STEP) * R.STEP
    j = int(np.searchsorted(K, k0 + 1e-9, side='right')) - 1
    while j >= 0 and not (ch.pd[j] <= spec['delta_cap']):
        j -= 1
        if j < 0 or K[j] < 0.4 * S:
            return []
    out = []
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
        Rr = credit / (L * (w0 - credit))
        if (1 - d) - d / Rr >= spec['kelly_min']:
            out.append((j, credit, interp, aroc))
        j -= 1
    return out


def picker_at(where):
    def pick(ch, spec, dte, info=None):
        ok = passing(ch, spec, dte)
        if not ok:
            return None
        j, credit, interp, aroc = ok[0] if where == 'near' else ok[len(ok) // 2] if where == 'mid' else ok[-1]
        if info is not None:
            info.update(ref_credit=credit, ref_interp=interp, aroc=aroc)
        return j
    return pick


def picker_delta(target):
    """The strike whose real put delta is at or just under the target, whatever the course rule says."""
    def pick(ch, spec, dte, info=None):
        ok = (ch.pd <= target) & (ch.mid == ch.mid) & (ch.K < ch.S) & (ch.K > 0.4 * ch.S)
        if not ok.any():
            return None
        j = int(np.max(np.nonzero(ok)[0]))
        ml, interp = ch.mid_at(float(ch.K[j]) - spec['ref_width'])
        if ml != ml:
            return None
        credit = float(ch.mid[j]) - ml
        if info is not None:
            info.update(ref_credit=credit, ref_interp=interp,
                        aroc=credit / max(spec['ref_width'] - credit, 1e-9) * 365 / max(dte, 1))
        return j
    return pick


# ------------------------------------------------------------------ E: other days to expiry
def dte_cycles(mkt, chains, off, start, end, target):
    """The base entry days, with the listed Friday expiry closest to target days away (within 9 days)."""
    for entry_tf, _exp, ie, _ix in mkt.cycles(off, start, end):
        d0 = mkt.dates[ie]
        best = None
        for ex in chains.expiries(d0):
            dte = (ex - d0).days
            if abs(dte - target) > 9 or ex > mkt.dates[-1]:
                continue
            jx = mkt.locate(ex)
            if jx is None or jx <= ie + 1:
                continue
            last = mkt.dates[jx]
            if (ex - last).days > 1:
                continue
            if last.weekday() != 4 and not (last.weekday() == 3 and (jx + 1 >= len(mkt.dates)
                                                                      or (mkt.dates[jx + 1] - last).days > 1)):
                continue
            if best is None or abs(dte - target) < best[0]:
                best = (abs(dte - target), ex, jx)
        if best is None:
            continue
        _g, ex, jx = best
        tf = R.third_friday(ex.year, ex.month)
        yield entry_tf, ex, ie, jx, ('open' if ex in (tf, tf + timedelta(days=1), tf - timedelta(days=1)) else 'close')


def replay_dte(mkt, chains, start, end, target, sids=R.SIDS, offs=OFFS):
    jobs = [(c[0], o, s, c) for o in offs for c in dte_cycles(mkt, chains, o, start, end, target) for s in sids]
    jobs.sort(key=lambda j: (j[0], j[1], j[2]))
    recs = {(s, o): [] for s in sids for o in offs}
    for _tf, o, s, (entry_tf, ex, ie, jx, settle) in jobs:
        recs[(s, o)].append(R.one_trade(mkt, chains, s, entry_tf, ex, ie, jx, settle=settle))
    return recs


def per30(trades):
    tr = [r for r in trades if r['kind'] != 'skip']
    days = sum(max(r['days_held'], 1) for r in tr)
    return 100 * sum(r['pnl'] / r['risk'] for r in tr) / days * 30 if days else R.NAN


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--strikes')
    ap.add_argument('--cache', required=True)
    ap.add_argument('--daily', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--start')
    ap.add_argument('--end')
    ap.add_argument('--procs', type=int, default=4)
    ap.add_argument('--min-cov', type=float, default=0.9)
    ap.add_argument('--draws', type=int, default=1000)
    ap.add_argument('--no-space', action='store_true')
    ap.add_argument('--fake-real', help='test only: a,c0 of a model chain used in place of real quotes')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()
    L = []

    def say(*x):
        s = ' '.join(str(i) for i in x)
        print(s, flush=True)
        L.append(s)

    def save():
        with open(os.path.join(a.out, 'summary.txt'), 'w') as f:
            f.write('\n'.join(L) + '\n')
        json.dump(res, open(os.path.join(a.out, 'result.json'), 'w'), indent=1, default=str)

    mkt = R.Market(a.daily)
    res = dict(run_at=time.strftime('%Y-%m-%d %H:%M'))
    start = date.fromisoformat(a.start) if a.start else None
    end = date.fromisoformat(a.end) if a.end else None
    fake = None
    if a.fake_real:
        fake = tuple(float(x) for x in a.fake_real.split(','))
        real = R.SynthChains(mkt, a=fake[0], c0=fake[1])
        start = start or date(2019, 1, 1)
    else:
        if a.strikes:
            tick = ('RUT',) if a.no_space else ('RUT', 'SPX')
            built = R.extract(a.strikes, a.cache, tick, procs=a.procs)
            say('extract:', ', '.join('%s %d files %s' % (y, n, st) for y, (n, st) in sorted(built.items())))
            cov = RR.coverage(a.strikes, mkt, a.min_cov)
            say('coverage: files %s, last %s, unbroken from %s (%s months)' % (cov['files'], cov['last'], cov['start'],
                                                                             cov.get('good_months')))
            start = start or cov['start']
            end = end or cov['last']
        real = R.OratsChains(a.cache, 'RUT')
    if start is None:
        say('no month has enough days yet: nothing to test')
        save()
        return
    if end:
        n = sum(d <= end for d in mkt.dates)
        mkt.dates, mkt.V = mkt.dates[:n], mkt.V[:n]
    end = mkt.dates[-1]
    syn = R.SynthChains(mkt)
    say('window %s to %s' % (start, end))
    res['window'] = [str(start), str(end)]

    # ---- base
    recs = R.replay_all(mkt, real, start, end, OFFS)
    base_tr = pooled(recs)
    traded = [r for r in base_tr if r['kind'] != 'skip']
    base_acc = acct(mkt, base_tr, start, end)
    months = len({r['chain'] for r in base_tr})
    losers = sum(r['pnl'] <= 0 for r in traded)
    say('\n== BASE (course strike, $55 wing, Fri/Mon/Tue, 33%%): %d months, %d trades, %d losing trades' % (
        months, len(traded), losers))
    for s in R.SIDS:
        say(tline(s, R.trade_stats([r for r in base_tr if r['strategy'] == s])))
    say(aline('base account', base_acc))
    if losers < 6:
        say('NOTE: fewer than 6 losing trades in this window. Nothing below can judge loss control yet; read it as '
            'premium and cost only.')
    res['base'] = dict(months=months, trades=len(traded), losing_trades=losers, account=RR.slim_acc(base_acc) if base_acc else None,
                       sleeves={s: slim_t(R.trade_stats([r for r in base_tr if r['strategy'] == s])) for s in R.SIDS})
    save()

    # ---- A: the chain at entry
    for r in base_tr:
        add_features(mkt, real, syn, r)
    say('\n== A. THE CHAIN AT ENTRY: trades by third of each reading (ranked inside each sleeve, whole window)')
    say('   exp = average result per trade, % of max loss; loss% = share of losing trades')
    res['A'] = {}
    for name in FEATS:
        tb = thirds_table(traded, name)
        res['A'][name] = tb
        if not tb:
            say('%-10s no readings' % name)
            continue
        say('%-10s %s' % (name, FEAT_HELP[name]))
        for t in ('low', 'mid', 'high'):
            if t in tb:
                x = tb[t]
                say('   %-5s n %4d  median %8.4f  exp %+6.2f  loss%% %5.1f  avg loss %s  worst %+7.1f' % (
                    t, x['n'], x['value_med'], x['exp'], x['loss_pct'],
                    ('%+7.2f' % x['avg_loss']) if x['avg_loss'] is not None else '   none', x['worst']))
    skips = [r for r in base_tr if r['kind'] == 'skip']
    if skips:
        say('skipped cycles: %d. Readings on those days (median): %s' % (len(skips), {
            n: round(float(np.median([r['feat'][n] for r in skips if n in r['feat']])), 3)
            for n in ('skew', 'term', 'iv_rv', 'atm_rvx', 'rvx_rank') if any(n in r['feat'] for r in skips)}))
        say('traded cycles, same readings (median): %s' % {
            n: round(float(np.median([r['feat'][n] for r in traded if n in r['feat']])), 3)
            for n in ('skew', 'term', 'iv_rv', 'atm_rvx', 'rvx_rank') if any(n in r['feat'] for r in traded)})
    save()

    # ---- B: sizing on a reading
    say('\n== B. SIZING ON A READING (rank against earlier trades only; x1.5 one third, x0.5 the other, or skip a third)')
    say('   placebo p = share of month shuffles doing at least as well; under 0.05 is worth a second look')
    say(aline('base', base_acc))
    res['B'] = {}
    for name in FEATS:
        rank = forward_rank(traded, name)
        if len(rank) < 30:
            say('%-10s not enough ranked trades yet (%d)' % (name, len(rank)))
            continue
        res['B'][name] = {}
        for mode in ('hi', 'lo', 'skip_lo', 'skip_hi'):
            ts = tilt_set(traded, rank, mode)
            live = [t for t in ts if not t.get('_drop')]
            ac = acct(mkt, live, start, end)
            p = placebo(ts, a.draws)
            say(aline('%s %s' % (name, mode), ac) + '  trades %d  placebo p %s' % (
                len(live), '%.3f' % p if p is not None else 'n/a'))
            res['B'][name][mode] = dict(account=RR.slim_acc(ac) if ac else None, trades=len(live), placebo_p=p)
    save()

    # ---- C: where on the chain to sell
    say('\n== C. WHERE TO SELL (same exits and wing; course = furthest strike that passes)')
    res['C'] = {}
    variants = [('course (furthest)', None), ('middle passing strike', picker_at('mid')), ('nearest passing strike', picker_at('near'))]
    variants += [('real delta %.2f, no rule' % d, picker_delta(d)) for d in (0.06, 0.08, 0.10, 0.12)]
    for tag, pk in variants:
        rc = recs if pk is None else R.replay_all(mkt, real, start, end, OFFS, picker=pk)
        tr = pooled(rc)
        st = R.trade_stats(tr)
        ac = acct(mkt, tr, start, end)
        say(tline(tag, st))
        say(aline('   account', ac))
        res['C'][tag] = dict(trades=slim_t(st), account=RR.slim_acc(ac) if ac else None)
    save()

    # ---- D: exits
    say('\n== D. EXITS (delta trigger scaled; base is 30 / 36 / 42)')
    res['D'] = {}
    for tag, kw in (('exit delta x0.67 (20/24/28)', dict(exit_scale=2 / 3)), ('exit delta x0.83 (25/30/35)', dict(exit_scale=5 / 6)),
                    ('base', None), ('exit delta x1.25 (37/45/52)', dict(exit_scale=1.25)),
                    ('Thursday rule off', dict(thursday=False)), ('no delta exit, Thursday rule only', dict(exit_scale=9.0))):
        rc = recs if kw is None else R.replay_all(mkt, real, start, end, OFFS, **kw)
        tr = pooled(rc)
        st = R.trade_stats(tr)
        ac = acct(mkt, tr, start, end)
        say(tline(tag, st))
        say(aline('   account', ac))
        res['D'][tag] = dict(trades=slim_t(st), account=RR.slim_acc(ac) if ac else None)
    save()

    # ---- E: days to expiry
    say('\n== E. DAYS TO EXPIRY (same entry days; per 30 = result per 30 days held, % of max loss; account uses the same')
    say('   size per entry, so longer trades overlap and carry more open risk)')
    res['E'] = {}
    for target in (14, 21, 30, 45, 60):
        try:
            rc = replay_dte(mkt, real, start, end, target)
        except Exception as e:  # noqa: BLE001
            say('target %d days: failed (%s)' % (target, e))
            continue
        tr = pooled(rc)
        st = R.trade_stats(tr)
        if not st.get('trades'):
            say('target %d days: no trades (%d cycles found)' % (target, st.get('cycles', 0)))
            continue
        got = [r for r in tr if r['kind'] != 'skip']
        ac = acct(mkt, tr, start, end)
        say(tline('target %d days (avg %.0f)' % (target, sum(r['dte'] for r in got) / len(got)), st)
            + ' | per 30 %+5.2f' % per30(tr))
        say(aline('   account', ac))
        res['E'][target] = dict(trades=slim_t(st), per30=round(per30(tr), 3), account=RR.slim_acc(ac) if ac else None)
    save()

    # ---- F: Space on the S&P 500
    if not a.no_space:
        say('\n== F. SPACE ON REAL S&P 500 QUOTES (entry days: third Friday +0/+1/+2 and +5; per-trade results)')
        res['F'] = {}
        try:
            ms = R.Market(a.daily, 'yahoo_GSPC', vol='spx')
            n = sum(d <= end for d in ms.dates)
            ms.dates, ms.V = ms.dates[:n], ms.V[:n]
            sreal = R.SynthChains(ms, a=fake[0], c0=fake[1], h0=0.186, h1=0.0129) if fake else R.OratsChains(a.cache, 'SPX')
            ssyn = R.SynthChains(ms, h0=0.186, h1=0.0129)
            soffs = (0, 1, 2, 5)
            for wing in (25.0, 50.0, 100.0):
                for tag, chn in (('real', sreal), ('model', ssyn)):
                    rc = R.replay_all(ms, chn, start, end, soffs, sids=('space',), wing=wing)
                    tr = pooled(rc, soffs, ('space',))
                    st = R.trade_stats(tr)
                    say(tline('space $%d wide, %s' % (wing, tag), st) + ' | skips %s' % st.get('why'))
                    res['F']['%d_%s' % (wing, tag)] = slim_t(st)
                    if tag == 'real' and wing == 25.0:
                        for o in soffs:
                            say(tline('   entry day +%d' % o, R.trade_stats(rc[('space', o)])))
            if not fake:
                say('S&P data-quality counters:', dict(sreal.stats))
        except Exception as e:  # noqa: BLE001
            say('Space block failed: %r' % (e,))
        save()

    if not fake:
        say('\nRussell data-quality counters:', dict(real.stats))
    say('run time %.0fs' % (time.time() - t0))
    save()
    with open(os.path.join(a.out, 'trades.pkl'), 'wb') as f:
        pickle.dump([{k: v for k, v in r.items() if k not in ('marks', '_last')} for r in base_tr], f)


if __name__ == '__main__':
    main()
