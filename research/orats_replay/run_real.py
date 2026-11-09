"""Real-quote replay of the Rule One bull put package, next to the same replay on the price model.

    python run_real.py --strikes <orats>/strikes --cache <orats>/parquet/slim --daily <repo>/api/data/spread_history/daily \
                       --out <orats>/replay

Reads the raw daily strike files (never changes them), writes slim per-year parquet into --cache and results into --out.
Everything it writes stays on this computer: result.json and summary.txt hold aggregates only, trades.pkl holds trades.
"""
import argparse
import json
import math
import os
import pickle
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import date

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orats_replay as R  # noqa: E402

BUCKETS = (('<18', 0, 18), ('18-22', 18, 22), ('22-30', 22, 30), ('>30', 30, 1e9))
ERAS = (('2007-12', 2007, 2012), ('2013-19', 2013, 2019), ('2020-26', 2020, 2099))
DELTAS = (0.06, 0.08, 0.10, 0.12, 0.14, 0.16)
WIDTHS = (10.0, 25.0, 55.0)


def bucket(v):
    for name, lo, hi in BUCKETS:
        if lo <= v < hi:
            return name
    return '?'


def era(d):
    for name, lo, hi in ERAS:
        if lo <= d.year <= hi:
            return name
    return '?'


def agg(xs, nd=3):
    xs = [x for x in xs if x is not None and x == x and abs(x) != float('inf')]
    if not xs:
        return dict(n=0)
    xs.sort()
    q = lambda p: xs[min(len(xs) - 1, int(p * len(xs)))]  # noqa: E731
    return dict(n=len(xs), med=round(statistics.median(xs), nd), mean=round(sum(xs) / len(xs), nd), p25=round(q(0.25), nd),
                p75=round(q(0.75), nd))


def coverage(strikes_dir, mkt, min_cov=0.9):
    """Newest unbroken run of months with at least min_cov of the market days on disk."""
    have = set()
    for y in sorted(os.listdir(strikes_dir)):
        yd = os.path.join(strikes_dir, y)
        if y.isdigit() and os.path.isdir(yd):
            for f in os.listdir(yd):
                if f.endswith('.json.gz'):
                    try:
                        have.add(date.fromisoformat(f[:10]))
                    except ValueError:
                        pass
    if not have:
        return dict(files=0, start=None, last=None, months={})
    last = max(have)
    months = defaultdict(lambda: [0, 0])
    for d in mkt.dates:
        if date(2007, 1, 1) <= d <= last:
            m = months[(d.year, d.month)]
            m[1] += 1
            m[0] += d in have
    good = []
    for k in sorted(months, reverse=True):
        h, n = months[k]
        if h / n < min_cov:
            break
        good.append(k)
    by_year = defaultdict(lambda: [0, 0])
    for (y, _m), (h, n) in months.items():
        by_year[y][0] += h
        by_year[y][1] += n
    return dict(files=len(have), last=last, start=date(good[-1][0], good[-1][1], 1) if good else None, good_months=len(good),
                by_year={y: '%d/%d' % tuple(v) for y, v in sorted(by_year.items())})


# ------------------------------------------------------------------ entry diagnostics
def first_eligible(ch, spec, dte):
    """The nearest strike the course rule may sell: at or below the distance floor, inside the delta cap, quoted."""
    S, K = ch.S, ch.K
    k0 = math.floor(S * (1 - spec['min_distance'] * max(dte, 1) / 45) / R.STEP) * R.STEP
    j = int(np.searchsorted(K, k0 + 1e-9, side='right')) - 1
    while j >= 0 and not (ch.pd[j] <= spec['delta_cap'] and ch.mid[j] == ch.mid[j]):
        j -= 1
    return None if j < 0 or K[j] < 0.4 * S else j


def spread_credit(ch, j, w):
    ml, _i = ch.mid_at(float(ch.K[j]) - w)
    return float(ch.mid[j]) - ml


def rule_view(ch, spec, dte):
    """What the course rule sees on this chain: best yield on offer and whether a strike qualifies."""
    if ch is None or not len(ch.K):
        return dict(why='nodata')
    j = first_eligible(ch, spec, dte)
    if j is None:
        return dict(why='nostrike')
    w0 = spec['ref_width']
    c = spread_credit(ch, j, w0)
    out = dict(K=float(ch.K[j]), dist=1 - float(ch.K[j]) / ch.S, delta=float(ch.pd[j]), credit=c)
    if not (c == c) or c <= 0 or c >= w0:
        return dict(out, why='nocredit')
    out['aroc'] = c / (w0 - c) * 365 / max(dte, 1)
    info = {}
    jp = R.pick_strike(ch, spec, dte, info)
    if jp is not None:
        return dict(out, why=None, pickK=float(ch.K[jp]), pick_dist=1 - float(ch.K[jp]) / ch.S, pick_delta=float(ch.pd[jp]),
                    pick_aroc=info.get('aroc'))
    return dict(out, why='aroc' if out['aroc'] < spec['aroc'] or c < 0.05 else 'kelly')


def entry_diag(mkt, real, syn, start, end, offs):
    """Per entry day: the rule's view on real and model chains, and real vs model premium at fixed real put deltas."""
    rule, fixed = [], []
    for off in offs:
        for tf, expiry, ie, _ix in mkt.cycles(off, start, end):
            d0 = mkt.dates[ie]
            v = mkt.V[ie]
            dte = (expiry - d0).days
            T = max(dte, 1) / 365
            cr = real.chain(d0, expiry, v)
            cs = syn.chain(d0, expiry, v)
            b = bucket(v)
            for sid in R.SIDS:
                spec = R.SPECS[sid]
                rv, sv = rule_view(cr, spec, dte), rule_view(cs, spec, dte)
                row = dict(sid=sid, off=off, tf=tf, d=d0, v=v, b=b, real=rv, syn=sv)
                if 'credit' in rv and rv['credit'] == rv['credit']:
                    m = syn.spread_mid(cr.S, v / 100, T, rv['K'], spec['ref_width'])
                    row['ratio_same_strike'] = rv['credit'] / m if m > 0.01 else None
                rule.append(row)
            if cr is None or not len(cr.K):
                continue
            ok = cr.mid == cr.mid
            for tgt in DELTAS:
                dist = np.where(ok, np.abs(cr.pd - tgt), np.inf)
                j = int(np.argmin(dist))
                if not dist[j] <= 0.02:
                    continue
                K = float(cr.K[j])
                S = cr.S
                iv_m = syn.iv(v / 100, S, K, T)
                p_m = R.put_price(S, K, iv_m, T)
                row = dict(tgt=tgt, off=off, d=d0, v=v, b=b, dist=1 - K / S, put_ratio=float(cr.mid[j]) / p_m if p_m > 0.01 else None,
                           iv_real=float(cr.iv[j]) if cr.iv[j] == cr.iv[j] else None, iv_model=iv_m,
                           delta_model=R.bs_put_delta(S, K, iv_m, T), half_real=float(cr.ask[j] - cr.bid[j]) / 2,
                           half_model=syn.h0 + syn.h1 * p_m, spot_gap=S / mkt.close[d0] - 1)
                for w in WIDTHS:
                    c = spread_credit(cr, j, w)
                    m = syn.spread_mid(S, v / 100, T, K, w)
                    row['c%d' % w] = c if c == c else None
                    row['m%d' % w] = m
                    row['r%d' % w] = c / m if c == c and m > 0.01 else None
                fixed.append(row)
    return rule, fixed


def summarize_rule(rule):
    out = {}
    for sid in R.SIDS:
        rows = [r for r in rule if r['sid'] == sid]
        thr = R.SPECS[sid]['aroc']
        for key, pred in [('all', lambda r: True)] + [(b[0], (lambda n: lambda r: r['b'] == n)(b[0])) for b in BUCKETS]:
            g = [r for r in rows if pred(r)]
            if not g:
                continue
            two = Counter(('T' if r['real']['why'] is None else 'S') + ('T' if r['syn']['why'] is None else 'S') for r in g)
            out['%s|%s' % (sid, key)] = dict(
                n=len(g), real_trade_pct=round(100 * sum(r['real']['why'] is None for r in g) / len(g), 1),
                model_trade_pct=round(100 * sum(r['syn']['why'] is None for r in g) / len(g), 1),
                real_model=dict(TT=two['TT'], TS=two['TS'], ST=two['ST'], SS=two['SS']),
                real_why=dict(Counter(str(r['real']['why']) for r in g)), model_why=dict(Counter(str(r['syn']['why']) for r in g)),
                best_aroc_real=agg([r['real'].get('aroc') for r in g]), best_aroc_model=agg([r['syn'].get('aroc') for r in g]),
                threshold=thr,
                real_over_threshold_pct=round(100 * sum((r['real'].get('aroc') or 0) >= thr for r in g) / len(g), 1),
                model_over_threshold_pct=round(100 * sum((r['syn'].get('aroc') or 0) >= thr for r in g) / len(g), 1),
                first_dist_real=agg([r['real'].get('dist') for r in g], 4), first_dist_model=agg([r['syn'].get('dist') for r in g], 4),
                first_delta_real=agg([r['real'].get('delta') for r in g], 4), first_delta_model=agg([r['syn'].get('delta') for r in g], 4),
                credit_ratio_same_strike=agg([r.get('ratio_same_strike') for r in g]),
                pick_dist_real=agg([r['real'].get('pick_dist') for r in g], 4), pick_dist_model=agg([r['syn'].get('pick_dist') for r in g], 4))
    return out


def summarize_fixed(fixed):
    out = {}
    groups = [('all', lambda r: True)] + [('rvx ' + b[0], (lambda n: lambda r: r['b'] == n)(b[0])) for b in BUCKETS] + \
             [('era ' + e[0], (lambda n: lambda r: era(r['d']) == n)(e[0])) for e in ERAS]
    for tgt in DELTAS:
        rows = [r for r in fixed if r['tgt'] == tgt]
        for key, pred in groups:
            g = [r for r in rows if pred(r)]
            if not g:
                continue
            o = dict(n=len(g), dist=agg([r['dist'] for r in g], 4), put_ratio=agg([r['put_ratio'] for r in g]),
                     iv_real=agg([r['iv_real'] for r in g], 4), iv_model=agg([r['iv_model'] for r in g], 4),
                     delta_model=agg([r['delta_model'] for r in g], 4), half_real=agg([r['half_real'] for r in g]),
                     half_model=agg([r['half_model'] for r in g]))
            for w in WIDTHS:
                o['ratio_%d' % w] = agg([r['r%d' % w] for r in g])
                o['credit_%d' % w] = agg([r['c%d' % w] for r in g])
                o['model_%d' % w] = agg([r['m%d' % w] for r in g])
            out['%.2f|%s' % (tgt, key)] = o
    out['spot_gap_1546_vs_close'] = agg([abs(r['spot_gap']) for r in fixed if r['tgt'] == 0.10], 5)
    return out


# ------------------------------------------------------------------ exits and matched trades
def exit_diag(mkt, syn, recs):
    rows = []
    for (sid, _off), rs in recs.items():
        for r in rs:
            if r['kind'] not in ('delta_exit', 'thursday'):
                continue
            d = r['exit']
            v = mkt.vol.get(d) or r['vol']
            T = max((r['expiry'] - d).days, 1) / 365
            S = r.get('exit_spot') or mkt.close[d]
            liab = r['credit'] - r['gross']
            m = syn.spread_mid(S, v / 100, T, r['short_strike'], r['width'])
            ps = R.put_price(S, r['short_strike'], syn.iv(v / 100, S, r['short_strike'], T), T)
            pl = R.put_price(S, r['long_strike'], syn.iv(v / 100, S, r['long_strike'], T), T)
            rows.append(dict(sid=sid, kind=r['kind'], b=bucket(v), liab=liab, model=m, diff=liab - m,
                             ratio=liab / m if m > 0.05 else None, half=r['half_out'],
                             half_model=2 * syn.h0 + syn.h1 * (ps + pl), ror=r['pnl'] / r['risk'], width=r['width'],
                             fallback=bool(r.get('flags', {}).get('fallback'))))
    out = {}
    for key, pred in [('all', lambda x: True), ('delta_exit', lambda x: x['kind'] == 'delta_exit'),
                      ('thursday', lambda x: x['kind'] == 'thursday')] + \
                     [('sid ' + s, (lambda n: lambda x: x['sid'] == n)(s)) for s in R.SIDS] + \
                     [('rvx ' + b[0], (lambda n: lambda x: x['b'] == n)(b[0])) for b in BUCKETS]:
        g = [x for x in rows if pred(x)]
        if g:
            out[key] = dict(n=len(g), liab_real=agg([x['liab'] for x in g]), liab_model=agg([x['model'] for x in g]),
                            diff=agg([x['diff'] for x in g]), ratio=agg([x['ratio'] for x in g]),
                            half_out_real=agg([x['half'] for x in g]), half_out_model=agg([x['half_model'] for x in g]),
                            ror=agg([100 * x['ror'] for x in g], 2), fallback=sum(x['fallback'] for x in g))
    return out


def matched(real, syn):
    out = {}
    for sid in R.SIDS:
        rows = []
        for (s, off), rs in real.items():
            if s != sid:
                continue
            by = {r['chain']: r for r in syn[(s, off)]}
            for r in rs:
                m = by.get(r['chain'])
                if m is not None and r['kind'] != 'skip' and m['kind'] != 'skip':
                    rows.append((r, m))
        if rows:
            out[sid] = dict(
                n=len(rows),
                strike_gap_pct=agg([100 * (r['short_strike'] / r['spot'] - m['short_strike'] / m['spot']) for r, m in rows], 2),
                credit_pct_width_real=agg([100 * r['credit'] / r['width'] for r, _m in rows], 2),
                credit_pct_width_model=agg([100 * m['credit'] / m['width'] for _r, m in rows], 2),
                cost_in_real=agg([r['cost_in'] for r, _m in rows]), cost_in_model=agg([m['cost_in'] for _r, m in rows]),
                ror_real=agg([100 * r['pnl'] / r['risk'] for r, _m in rows], 2),
                ror_model=agg([100 * m['pnl'] / m['risk'] for _r, m in rows], 2),
                same_exit_kind_pct=round(100 * sum(r['kind'] == m['kind'] for r, m in rows) / len(rows), 1),
                real_exits=dict(Counter(r['kind'] for r, _m in rows)), model_exits=dict(Counter(m['kind'] for _r, m in rows)))
    return out


def slim_acc(a):
    return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in a.items() if k != 'years'}


def acc_line(tag, a):
    return '%-34s CAGR %6.2f  maxDD %5.2f  Sharpe %5.2f  PF %5.2f  worst mo %6.1f  worst yr %6.1f  +mo %4.1f%%' % (
        tag, a['cagr'], a['dd'], a['sharpe'], a['pf_month'], a['worst_month'], a['worst_year'], a['pos_months'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--strikes')
    ap.add_argument('--cache', required=True)
    ap.add_argument('--daily', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--start')
    ap.add_argument('--end')
    ap.add_argument('--tickers', default='RUT')
    ap.add_argument('--procs', type=int, default=4)
    ap.add_argument('--min-cov', type=float, default=0.9)
    ap.add_argument('--fake-real', help='test only: a,c0 of a model chain used in place of real quotes')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()
    L = []

    def say(*x):
        s = ' '.join(str(i) for i in x)
        print(s, flush=True)
        L.append(s)

    mkt = R.Market(a.daily)
    res = dict(run_at=time.strftime('%Y-%m-%d %H:%M'))
    start = date.fromisoformat(a.start) if a.start else None
    end = date.fromisoformat(a.end) if a.end else None
    if a.fake_real:
        fa, fc = (float(x) for x in a.fake_real.split(','))
        real = R.SynthChains(mkt, a=fa, c0=fc)
        start = start or date(2019, 1, 1)
    else:
        if a.strikes:
            built = R.extract(a.strikes, a.cache, tuple(a.tickers.split(',')), procs=a.procs)
            say('extract:', ', '.join('%s %d files %s' % (y, n, st) for y, (n, st) in sorted(built.items())))
            cov = coverage(a.strikes, mkt, a.min_cov)
            res['coverage'] = {k: (str(v) if isinstance(v, date) else v) for k, v in cov.items()}
            say('coverage: files %s, last %s, unbroken from %s (%s months)' % (cov['files'], cov['last'], cov['start'],
                                                                             cov.get('good_months')))
            say('files/market days by year:', cov.get('by_year'))
            start = start or cov['start']
            end = end or cov['last']
        real = R.OratsChains(a.cache, 'RUT')
    if start is None:
        say('no month has enough days yet: nothing to replay')
        json.dump(res, open(os.path.join(a.out, 'result.json'), 'w'), indent=1, default=str)
        return
    if end:
        n = sum(d <= end for d in mkt.dates)
        mkt.dates, mkt.V = mkt.dates[:n], mkt.V[:n]
    end = mkt.dates[-1]
    syn = R.SynthChains(mkt)
    offs, sizes = (0, 1, 2), (1 / 3, 0.5)
    say('window %s to %s' % (start, end))
    res['window'] = [str(start), str(end)]

    r_recs, r_per, r_acc = R.run_package(mkt, real, start, end, offs, sizes)
    say('\n== REAL quotes (close-mode exits, engine fill: 33% of the half-spread in, 100% out)')
    say(R.fmt_stats(r_per, r_acc))
    s_recs, s_per, s_acc = R.run_package(mkt, syn, start, end, offs, sizes)
    say('\n== MODEL (realfit) on the same window')
    say(R.fmt_stats(s_per, s_acc))
    res['real'] = dict(per=r_per, acc={k: slim_acc(v) for k, v in r_acc.items()})
    res['model'] = dict(per=s_per, acc={k: slim_acc(v) for k, v in s_acc.items()})
    res['years'] = {str(y): [round(100 * r_acc[0.333]['years'].get(y, float('nan')), 2),
                             round(100 * s_acc[0.333]['years'].get(y, float('nan')), 2)] for y in sorted(s_acc[0.333]['years'])}
    say('\nyear: real / model return at 33%')
    say('  '.join('%s %+.1f/%+.1f' % (y, v[0], v[1]) for y, v in res['years'].items()))
    if hasattr(real, 'stats'):
        res['data_quality'] = dict(real.stats)
        say('data quality counters:', dict(real.stats))

    say('\n== fills on the real trades (same strikes and exits, costs only), 33% size')
    res['fills'] = {}
    for tag, f in (('entry 33% of half-spread (engine)', R.FILL_ENGINE),
                   ('entry 50%', dict(R.FILL_ENGINE, entry_share=0.5)),
                   ('entry 100% (natural)', dict(R.FILL_ENGINE, entry_share=1.0)),
                   ('entry at mid, exit at mid', dict(R.FILL_ENGINE, entry_share=0.0, exit_share=0.0)),
                   ('engine + $0.25 exit slip', dict(R.FILL_ENGINE, exit_slip=0.25))):
        rr = {k: R.refill(v, f) for k, v in r_recs.items()}
        _r, per, acc = R.run_package(mkt, real, start, end, offs, (1 / 3,), recs=rr)
        res['fills'][tag] = dict(acc=slim_acc(acc[0.333]), exp={s: round(per[s].get('exp', float('nan')), 3) for s in R.SIDS})
        say(acc_line(tag, acc[0.333]))

    say('\n== wing width on real quotes, 33% size (real | model)')
    res['wings'] = {}
    for w in (25.0, 35.0, 55.0, 75.0, 100.0):
        _r, per, acc = R.run_package(mkt, real, start, end, offs, (1 / 3,), wing=w)
        _s, pers, accs = R.run_package(mkt, syn, start, end, offs, (1 / 3,), wing=w)
        res['wings'][str(int(w))] = dict(real=slim_acc(acc[0.333]), model=slim_acc(accs[0.333]),
                                         exp_real={s: round(per[s].get('exp', float('nan')), 3) for s in R.SIDS},
                                         exp_model={s: round(pers[s].get('exp', float('nan')), 3) for s in R.SIDS})
        say(acc_line('wing $%d real' % w, acc[0.333]))
        say(acc_line('wing $%d model' % w, accs[0.333]))

    say('\n== weights on real quotes, 33% size')
    res['weights'] = {}
    for tag, wt in (('40/40/20', dict(rut=0.4, mars=0.4, marsmax=0.2)), ('50/50/0', dict(rut=0.5, mars=0.5, marsmax=0.0)),
                    ('20/40/40', dict(rut=0.2, mars=0.4, marsmax=0.4))):
        _r, _p, acc = R.run_package(mkt, real, start, end, offs, (1 / 3,), recs=r_recs, weights=wt)
        res['weights'][tag] = slim_acc(acc[0.333])
        say(acc_line(tag, acc[0.333]))

    say('\n== trades the course rule skips, forced on (nearest allowed strike), real quotes')
    f_recs, _fp, f_acc = R.run_package(mkt, real, start, end, offs, (1 / 3,), picker=R.pick_noskip)
    res['forced'] = dict(acc=slim_acc(f_acc[0.333]))
    for s in R.SIDS:
        fs = R.trade_stats([r for o in offs for r in f_recs[(s, o)] if r.get('forced')])
        res['forced'][s] = fs
        if fs.get('trades'):
            say('%-8s forced trades %3d  win %5.1f%%  avg win %+5.2f  avg loss %+6.2f  exp %+5.2f  credit %4.2f%% of width' % (
                s, fs['trades'], fs['win_pct'], fs['avg_win'], fs['avg_loss'], fs['exp'], fs['credit_pct']))
    say(acc_line('account with forced trades', f_acc[0.333]))

    rule, fixed = entry_diag(mkt, real, syn, start, end, offs)
    res['rule'] = summarize_rule(rule)
    res['fixed_delta'] = summarize_fixed(fixed)
    say('\n== what the course rule sees at entry (best yield on the reference spread at the nearest allowed strike)')
    say('sleeve|RVX      n  real trade%  model trade%   TT  TS  ST  SS   best AROC real med / model med (need)   real/model credit, same strike')
    for k, v in res['rule'].items():
        say('%-15s %4d   %5.1f       %5.1f       %3d %3d %3d %3d    %5.2f / %5.2f (%.2f)    med %s mean %s n %s   real skips %s' % (
            k, v['n'], v['real_trade_pct'], v['model_trade_pct'], v['real_model']['TT'], v['real_model']['TS'],
            v['real_model']['ST'], v['real_model']['SS'], v['best_aroc_real'].get('med', float('nan')),
            v['best_aroc_model'].get('med', float('nan')), v['threshold'], v['credit_ratio_same_strike'].get('med'),
            v['credit_ratio_same_strike'].get('mean'), v['credit_ratio_same_strike'].get('n'), v['real_why']))
    say('\n== real / model mid credit at fixed real put deltas (same strike, same spot)')
    say('delta|group          n   OTM%   put    $10    $25    $55   iv real/model   model delta   half real/model')
    for k, v in res['fixed_delta'].items():
        if '|' not in k:
            continue
        say('%-18s %4d  %5.2f  %5.2f  %5.2f  %5.2f  %5.2f   %.3f/%.3f     %.3f       %.2f/%.2f' % (
            k, v['n'], 100 * v['dist'].get('med', float('nan')), v['put_ratio'].get('med', float('nan')),
            v['ratio_10'].get('med', float('nan')), v['ratio_25'].get('med', float('nan')), v['ratio_55'].get('med', float('nan')),
            v['iv_real'].get('med', float('nan')), v['iv_model'].get('med', float('nan')), v['delta_model'].get('med', float('nan')),
            v['half_real'].get('med', float('nan')), v['half_model'].get('med', float('nan'))))
    say('abs gap between the 15:46 spot and the close:', res['fixed_delta'].get('spot_gap_1546_vs_close'))

    res['exits'] = exit_diag(mkt, syn, r_recs)
    say('\n== buyback value on exit days: real vs model at the same spot and RVX ($ per share)')
    for k, v in res['exits'].items():
        say('%-12s n %3d  real med %s  model med %s  diff med %s mean %s  ratio med %s  half-spread out real %s model %s  ror med %s  fallback %d' % (
            k, v['n'], v['liab_real'].get('med'), v['liab_model'].get('med'), v['diff'].get('med'), v['diff'].get('mean'),
            v['ratio'].get('med'), v['half_out_real'].get('med'), v['half_out_model'].get('med'), v['ror'].get('med'), v['fallback']))

    res['matched'] = matched(r_recs, s_recs)
    say('\n== cycles traded on both real and model chains')
    for s, v in res['matched'].items():
        say('%-8s n %3d  strike gap %s%% of spot  credit %% of width real %s model %s  cost in real %s model %s  ror mean real %s model %s  same exit %s%%' % (
            s, v['n'], v['strike_gap_pct'].get('med'), v['credit_pct_width_real'].get('med'), v['credit_pct_width_model'].get('med'),
            v['cost_in_real'].get('med'), v['cost_in_model'].get('med'), v['ror_real'].get('mean'), v['ror_model'].get('mean'),
            v['same_exit_kind_pct']))
        say('         real exits %s | model exits %s' % (v['real_exits'], v['model_exits']))

    say('\nrun time %.0fs' % (time.time() - t0))
    json.dump(res, open(os.path.join(a.out, 'result.json'), 'w'), indent=1, default=str)
    open(os.path.join(a.out, 'summary.txt'), 'w').write('\n'.join(L) + '\n')
    for rs in (r_recs, s_recs, f_recs):
        for v in rs.values():
            for r in v:
                r.pop('_last', None)
    pickle.dump(dict(real=r_recs, model=s_recs, forced=f_recs, rule=rule, fixed=fixed, window=(start, end)),
                open(os.path.join(a.out, 'trades.pkl'), 'wb'))


if __name__ == '__main__':
    main()
