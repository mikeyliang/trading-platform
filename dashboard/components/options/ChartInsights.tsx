"use client";

import type { OptionAnalyzeResult } from "@/lib/api";
import { cn, fmt, fmtCurrency } from "@/lib/utils";

/**
 * Plain-English chart interpretation panels. Three flavors:
 *   - underlying : reads candles + EMA stack + RSI + MACD + forecast cone
 *   - option     : reads synthetic-price trajectory + RV30 vs IV + RSI
 *   - pnl        : reads P/L profile + theta drag + BE distance + R/R
 *
 * Each bullet has a tone (up / down / warning / neutral) that color-codes
 * the dot beside it, so a glance at the panel reads as "what's helping
 * me" vs "what's hurting me" before the user reads the words.
 *
 * Rule-based. No LLM. Cheap, deterministic, no per-render API cost.
 */

interface Insight {
  tone: "up" | "down" | "warning" | "neutral";
  // The short headline (1–6 words) — keeps the panel scannable.
  label: string;
  // One-line plain-English elaboration. Optional.
  detail?: string;
}

function ToneDot({ tone }: { tone: Insight["tone"] }) {
  return (
    <span
      className={cn(
        "inline-block w-1.5 h-1.5 rounded-full shrink-0 translate-y-[5px]",
        tone === "up" && "bg-up",
        tone === "down" && "bg-down",
        tone === "warning" && "bg-warning",
        tone === "neutral" && "bg-text-muted",
      )}
    />
  );
}

function InsightList({ items }: { items: Insight[] }) {
  if (items.length === 0) {
    return (
      <div className="text-[11px] text-text-muted">
        No specific signals to flag.
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex items-start gap-2">
          <ToneDot tone={it.tone} />
          <div className="min-w-0">
            <span
              className={cn(
                "text-[11px] tabular font-medium",
                it.tone === "up" && "text-up",
                it.tone === "down" && "text-down",
                it.tone === "warning" && "text-warning",
                it.tone === "neutral" && "text-text-primary",
              )}
            >
              {it.label}
            </span>
            {it.detail && (
              <span className="text-[11px] text-text-secondary">
                {" "}
                — {it.detail}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── Underlying interpretation ─────────────────────────────────────────
function buildUnderlyingInsights(result: OptionAnalyzeResult): Insight[] {
  const out: Insight[] = [];
  const u = result.underlying;
  const fe = result.forecast_ensemble;
  const fc = fe?.ensemble.horizons["5"] ?? null;
  const rsi = u.rsi;
  const mh = u.macd_hist;
  const emaBull =
    u.ema9 != null &&
    u.ema21 != null &&
    u.ema200 != null &&
    u.ema9 > u.ema21 &&
    u.ema21 > u.ema200;
  const emaBear =
    u.ema9 != null &&
    u.ema21 != null &&
    u.ema200 != null &&
    u.ema9 < u.ema21 &&
    u.ema21 < u.ema200;

  // Multi-timeframe momentum alignment — if every TF agrees, that's a
  // huge signal. If the chart TF disagrees with the daily, that's a
  // pullback/bounce setup the trader should know about.
  const mtfTrends = Object.values(result.multi_tf ?? {})
    .filter((t) => t?.available && t.trend)
    .map((t) => t.trend);
  const bullCount = mtfTrends.filter((t) => t === "bull").length;
  const bearCount = mtfTrends.filter((t) => t === "bear").length;
  const totalTfs = mtfTrends.length;

  // ─ Trend (composite read of EMA stack + MACD + RSI) ─
  if (emaBull && mh > 0 && rsi >= 55) {
    out.push({
      tone: "up",
      label: "Trend: confirmed up",
      detail:
        "EMAs stacked 9 > 21 > 200, MACD expanding, RSI bullish — three independent reads in alignment",
    });
  } else if (emaBear && mh < 0 && rsi <= 45) {
    out.push({
      tone: "down",
      label: "Trend: confirmed down",
      detail:
        "EMAs stacked bearish, MACD expanding red, RSI weak — three independent reads in alignment",
    });
  } else if (emaBull && (mh < 0 || rsi < 50)) {
    out.push({
      tone: "warning",
      label: "Trend: up, momentum cooling",
      detail:
        "EMA stack still bullish but MACD/RSI rolling over — watch for pullback or reversal",
    });
  } else if (emaBear && (mh > 0 || rsi > 50)) {
    out.push({
      tone: "warning",
      label: "Trend: down, bottoming?",
      detail:
        "EMA stack still bearish but momentum turning up — potential reversal forming",
    });
  } else {
    out.push({
      tone: "neutral",
      label: "Trend: no clean read",
      detail: "EMAs / momentum / RSI disagree — likely chop or transition",
    });
  }

  // ─ RSI extreme call-out ─
  if (Number.isFinite(rsi)) {
    if (rsi >= 75)
      out.push({
        tone: "warning",
        label: `RSI ${rsi.toFixed(0)} extreme`,
        detail: "overbought — entry here pays at-the-extreme prices",
      });
    else if (rsi <= 25)
      out.push({
        tone: "warning",
        label: `RSI ${rsi.toFixed(0)} extreme`,
        detail: "oversold — counter-trade risk if you're chasing the move",
      });
  }

  // ─ Forecast consensus + disagreement risk ─
  if (fc) {
    const er = fc.expected_return_pct;
    const agree = fe?.agreement["5"] ?? 1;
    const tone: Insight["tone"] =
      er > 0.5 ? "up" : er < -0.5 ? "down" : "neutral";
    out.push({
      tone,
      label: `5d ensemble ${er >= 0 ? "+" : ""}${er.toFixed(1)}%`,
      detail: `±${fc.band_pct.toFixed(1)}% band · ${(agree * 100).toFixed(0)}% model agreement`,
    });
    if (agree < 0.5) {
      out.push({
        tone: "warning",
        label: "Forecast: low confidence",
        detail:
          "models split — at least one expects the opposite move; treat the headline as one opinion, not consensus",
      });
    }
  }

  // ─ Forecast vs trend conflict ─
  if (fc && (emaBull || emaBear)) {
    const fcUp = fc.expected_return_pct > 0.5;
    const fcDown = fc.expected_return_pct < -0.5;
    if (emaBull && fcDown) {
      out.push({
        tone: "warning",
        label: "Forecast vs trend conflict",
        detail:
          "uptrend on the chart but models lean down — likely a calls-overpriced setup",
      });
    } else if (emaBear && fcUp) {
      out.push({
        tone: "warning",
        label: "Forecast vs trend conflict",
        detail:
          "downtrend on the chart but models lean up — possible mean-reversion setup",
      });
    }
  }

  // ─ Multi-TF momentum alignment ─
  if (totalTfs >= 3) {
    if (bullCount === totalTfs) {
      out.push({
        tone: "up",
        label: `${totalTfs}/${totalTfs} timeframes bullish`,
        detail:
          "every timeframe checked agrees — high-conviction up-trend across micro and macro",
      });
    } else if (bearCount === totalTfs) {
      out.push({
        tone: "down",
        label: `${totalTfs}/${totalTfs} timeframes bearish`,
        detail:
          "every timeframe checked agrees — high-conviction down-trend across micro and macro",
      });
    } else if (bullCount >= totalTfs - 1 || bearCount >= totalTfs - 1) {
      const dom = bullCount > bearCount ? "bull" : "bear";
      out.push({
        tone: dom === "bull" ? "up" : "down",
        label: `${Math.max(bullCount, bearCount)}/${totalTfs} timeframes ${dom}ish`,
        detail: "nearly all timeframes align — minor dissent on one TF only",
      });
    } else {
      out.push({
        tone: "warning",
        label: "Timeframes split",
        detail: `${bullCount} bullish, ${bearCount} bearish of ${totalTfs} TFs — chop or transition`,
      });
    }
  }

  // ─ Calibration coverage (how well-calibrated are recent forecasts?) ─
  const cov = fe?.ensemble.calibration?.coverage_observed_per_h?.["5"];
  if (cov != null && Number.isFinite(cov)) {
    if (cov >= 0.7 && cov <= 0.9) {
      out.push({
        tone: "up",
        label: `Forecast calibrated (${(cov * 100).toFixed(0)}% cov)`,
        detail:
          "p10-p90 band historically captured ~80% of realized outcomes — bands are honest",
      });
    } else if (cov < 0.5) {
      out.push({
        tone: "warning",
        label: `Forecast under-covers (${(cov * 100).toFixed(0)}%)`,
        detail:
          "past bands have missed ≥50% of moves — true uncertainty likely larger than shown",
      });
    }
  }

  return out;
}

// ─── Option-contract interpretation ───────────────────────────────────
function buildOptionInsights(result: OptionAnalyzeResult): Insight[] {
  const out: Insight[] = [];
  const oc = result.option_chart;
  if (!oc || oc.synthetic_prices.length < 2) return out;

  const N = oc.synthetic_prices.length;
  const first = oc.synthetic_prices[Math.max(0, N - 90)];
  const last = oc.synthetic_prices[N - 1];
  const periodPct = first > 0 ? ((last - first) / first) * 100 : 0;

  // Synthetic price trend
  if (Math.abs(periodPct) > 3) {
    out.push({
      tone: periodPct > 0 ? "up" : "down",
      label: `Replay ${periodPct > 0 ? "+" : ""}${periodPct.toFixed(0)}% over last ~90 bars`,
      detail: `If you'd held this contract through the visible window (at today's IV), you'd be ${periodPct > 0 ? "ahead" : "behind"} by that much`,
    });
  }

  // RV30 as IV proxy
  const rv30 = oc.rv30[oc.rv30.length - 1];
  const ivPct = result.option.iv * 100;
  const rv30Pct = (rv30 ?? 0) * 100;
  if (rv30Pct > 0 && Number.isFinite(ivPct)) {
    const ratio = ivPct / rv30Pct;
    if (ratio >= 1.3) {
      out.push({
        tone: result.is_long ? "down" : "up",
        label: `IV (${ivPct.toFixed(0)}%) rich vs realized (${rv30Pct.toFixed(0)}%)`,
        detail: `${ratio.toFixed(2)}× ratio — options expensive; ${result.is_long ? "long premium is paying up" : "short premium has a tailwind"}`,
      });
    } else if (ratio <= 0.8) {
      out.push({
        tone: result.is_long ? "up" : "down",
        label: `IV (${ivPct.toFixed(0)}%) cheap vs realized (${rv30Pct.toFixed(0)}%)`,
        detail: `${ratio.toFixed(2)}× ratio — options underpriced; ${result.is_long ? "good time to buy premium" : "short premium has headwind"}`,
      });
    }
  }

  // Option-side RSI
  const orsi = oc.rsi[oc.rsi.length - 1];
  if (Number.isFinite(orsi)) {
    if (orsi >= 75) {
      out.push({
        tone: "warning",
        label: `Option RSI ${orsi.toFixed(0)} · extended`,
        detail:
          "the contract itself has run far — quick reversal of fortune possible",
      });
    } else if (orsi <= 25) {
      out.push({
        tone: "warning",
        label: `Option RSI ${orsi.toFixed(0)} · oversold`,
        detail: "contract beaten down — bounce risk if you're short",
      });
    }
  }

  return out;
}

// ─── P/L profile interpretation ───────────────────────────────────────
function buildPnlInsights(result: OptionAnalyzeResult): Insight[] {
  const out: Insight[] = [];
  const isLong = result.is_long;
  const entry = result.option.entry_price;
  const mid = result.option.mid ?? entry;
  const qty = Math.abs(result.quantity);
  const liveUnrealized = (mid - entry) * qty * 100 * (isLong ? 1 : -1);

  // Current P/L
  if (Number.isFinite(liveUnrealized)) {
    out.push({
      tone: liveUnrealized >= 0 ? "up" : "down",
      label: `${liveUnrealized >= 0 ? "Up" : "Down"} ${fmtCurrency(Math.abs(liveUnrealized))} on the position right now`,
      detail: `mid ${fmt(mid)} vs entry ${fmt(entry)} × ${qty}× × ${isLong ? "long" : "short"}`,
    });
  }

  // Theta — pulled from the greeks block
  const theta = result.greeks.theta;
  if (theta != null && Number.isFinite(theta) && theta !== 0) {
    const dailyDollar = theta * qty * 100 * (isLong ? 1 : -1);
    out.push({
      tone: dailyDollar >= 0 ? "up" : "down",
      label: `Theta ${dailyDollar >= 0 ? "+" : ""}${fmtCurrency(dailyDollar)} / day`,
      detail:
        dailyDollar >= 0
          ? "time decay works in your favor — every passing day adds value"
          : "every day that passes costs this much in time decay, all else equal",
    });
  }

  // Break-even distance
  const be = result.breakeven;
  const spot = result.spot;
  if (Number.isFinite(be) && spot > 0) {
    const moveNeededPct = ((be - spot) / spot) * 100;
    const dir =
      (isLong && (result.right === "C" ? be > spot : be < spot)) ||
      (!isLong && (result.right === "C" ? be < spot : be > spot));
    out.push({
      tone:
        Math.abs(moveNeededPct) < 2
          ? "up"
          : Math.abs(moveNeededPct) < 8
            ? "neutral"
            : "warning",
      label: `BE @ ${fmt(be)} · ${moveNeededPct >= 0 ? "+" : ""}${moveNeededPct.toFixed(1)}% from spot`,
      detail: `spot needs to ${dir ? "stay on its current side of" : "cross"} this line at expiry to avoid a loss`,
    });
  }

  // R/R
  const mp = result.max_profit;
  const ml = result.max_loss;
  if (mp != null && ml != null && isFinite(mp) && isFinite(ml) && ml !== 0) {
    const rr = Math.abs(mp) / Math.abs(ml);
    out.push({
      tone: rr >= 2 ? "up" : rr >= 1 ? "neutral" : "down",
      label: `R/R ${rr.toFixed(2)} : 1`,
      detail:
        rr >= 2
          ? "asymmetric — risking $1 to make $2+"
          : rr >= 1
            ? "symmetric — even payoff"
            : "you're risking more than you can make at max",
    });
  }

  // POP
  const pop = result.probability.pop;
  if (pop != null) {
    out.push({
      tone: pop >= 0.6 ? "up" : pop >= 0.4 ? "warning" : "down",
      label: `POP ${(pop * 100).toFixed(0)}%`,
      detail:
        pop >= 0.6
          ? "lopsided in your favor at expiry under current IV"
          : pop >= 0.4
            ? "coin-flip territory — IV is doing more than direction"
            : "low base-rate — needs a thesis stronger than IV",
    });
  }

  return out;
}

// ─── Public components ────────────────────────────────────────────────
interface Props {
  result: OptionAnalyzeResult;
}

export function UnderlyingInsights({ result }: Props) {
  const items = buildUnderlyingInsights(result);
  return (
    <div className="px-3 py-3 border-t border-border/40 bg-surface-2/30">
      <div className="text-[10px] uppercase tracking-wider text-text-muted font-medium mb-2">
        Read the chart
      </div>
      <InsightList items={items} />
    </div>
  );
}

export function OptionInsights({ result }: Props) {
  const items = buildOptionInsights(result);
  return (
    <div className="px-3 py-3 border-t border-border/40 bg-surface-2/30">
      <div className="text-[10px] uppercase tracking-wider text-text-muted font-medium mb-2">
        Read the chart
      </div>
      <InsightList items={items} />
    </div>
  );
}

export function PnlInsights({ result }: Props) {
  const items = buildPnlInsights(result);
  return (
    <div className="px-3 py-3 border-t border-border/40 bg-surface-2/30">
      <div className="text-[10px] uppercase tracking-wider text-text-muted font-medium mb-2">
        Position read
      </div>
      <InsightList items={items} />
    </div>
  );
}
