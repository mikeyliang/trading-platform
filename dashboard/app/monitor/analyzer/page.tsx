"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, type OptionAnalyzeResult, type OptionsChain, type OptionAnalyzerTimeframe } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Logo } from "@/components/ui/logo";
import { cn, fmtCurrency } from "@/lib/utils";
import {
  ArrowRight,
  Brain,
  ChevronRight,
  Clipboard,
  ClipboardCheck,
  Loader2,
  Search,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { PnlProfileChart } from "@/components/options/PnlProfileChart";
import { PnlDecayChart } from "@/components/options/PnlDecayChart";
import { GreeksPanel } from "@/components/options/GreeksPanel";
import { UnderlyingAnalysisCard } from "@/components/options/UnderlyingAnalysisCard";
import { SignalInputsPanel } from "@/components/options/SignalInputsPanel";
import { ForecastBreakdownPanel } from "@/components/options/ForecastBreakdownPanel";
import { OptionAnalysisCard } from "@/components/options/OptionAnalysisCard";
import { MultiTfMomentumPanel } from "@/components/options/MultiTfMomentumPanel";
import {
  VolContextPanel,
  LiquidityPanel,
  ScenarioMatrixPanel,
} from "@/components/options/AnalyticsPanels";
import { useChatAvailable } from "@/lib/chat-availability";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PnlInsights, UnderlyingInsights, OptionInsights } from "@/components/options/ChartInsights";
import { AIRead } from "@/components/options/AIRead";

export default function OptionsAnalyzerPage() {
  const router = useRouter();
  const params = useSearchParams();

  const [symbol, setSymbol] = useState((params?.get("symbol") || "SPY").toUpperCase());
  const [pendingSym, setPendingSym] = useState(symbol);
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [expiry, setExpiry] = useState<string>(params?.get("expiry") || "");
  const [strike, setStrike] = useState<number | null>(
    params?.get("strike") ? Number(params.get("strike")) : null
  );
  const [right, setRight] = useState<"C" | "P">(
    (params?.get("right") || "C").toUpperCase() === "P" ? "P" : "C"
  );
  const [qty, setQty] = useState<number>(Number(params?.get("qty") || 1));
  const [entry, setEntry] = useState<string>(params?.get("entry") || "");
  const [timeframe, setTimeframe] = useState<OptionAnalyzerTimeframe>(
    (params?.get("tf") as OptionAnalyzerTimeframe) || "1d"
  );
  // True until the user manually picks a TF. While auto, we honor the
  // backend's DTE-recommended TF every time it changes (e.g., switching from
  // a 240d contract to a 0DTE one). User selection locks it.
  const [tfIsAuto, setTfIsAuto] = useState<boolean>(!params?.get("tf"));
  const setTimeframeManual = (tf: OptionAnalyzerTimeframe) => {
    setTfIsAuto(false);
    setTimeframe(tf);
  };
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OptionAnalyzeResult | null>(null);
  const chatAvailable = useChatAvailable();

  // Load expirations
  useEffect(() => {
    setChain(null);
    api
      .optionsChain(symbol)
      .then((c) => {
        setChain(c);
        if (c.expirations.length > 0 && !c.expirations.includes(expiry)) {
          setExpiry(c.expirations[0]);
        }
      })
      .catch(() => setChain(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  // Load chain for selected expiry
  useEffect(() => {
    if (!expiry || !symbol) return;
    api
      .optionsChain(symbol, expiry)
      .then((c) => {
        setChain(c);
        if (!strike && c.underlying_price) {
          // default to nearest strike to spot
          const all = c.strikes
            .slice()
            .sort(
              (a, b) =>
                Math.abs(a - c.underlying_price!) - Math.abs(b - c.underlying_price!)
            );
          if (all[0] != null) setStrike(all[0]);
        }
      })
      .catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, expiry]);

  const strikes = chain?.strikes ?? [];
  const spot = chain?.underlying_price;

  // Auto-run analysis when key inputs are present
  const canAnalyze = !!symbol && !!expiry && strike != null;
  useEffect(() => {
    if (!canAnalyze) return;
    setLoading(true);
    const entryNum = entry.trim() ? Number(entry) : undefined;
    api
      .analyzeOption({
        symbol,
        strike: strike!,
        expiry,
        right,
        quantity: qty,
        entry_price: entryNum != null && !isNaN(entryNum) ? entryNum : undefined,
        timeframe,
      })
      .then((res) => {
        setResult(res);
        // Auto-sync chart TF to DTE-recommended value while in auto mode.
        // The backend picks 5m for 0DTE, 1d for 240DTE, etc. User can still
        // override by picking from the TF pills (which calls setTimeframeManual).
        if (tfIsAuto && res.recommended_chart_tf && res.recommended_chart_tf !== timeframe) {
          setTimeframe(res.recommended_chart_tf);
        }
      })
      .catch(() => setResult(null))
      .finally(() => setLoading(false));
  }, [symbol, strike, expiry, right, qty, entry, timeframe, canAnalyze, tfIsAuto]);

  const askAI = () => {
    if (!result) return;
    const event = new KeyboardEvent("keydown", {
      key: "j",
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
    });
    document.dispatchEvent(event);
    window.dispatchEvent(
      new CustomEvent("copilot:prefill", {
        detail: { prompt: buildAIPrompt(result) },
      })
    );
  };

  const goAgents = () => {
    if (!result) return;
    router.push(`/agents?symbol=${result.symbol}`);
  };

  const [copied, setCopied] = useState(false);
  const copyAISnapshot = async () => {
    if (!result) return;
    // A compact JSON payload + the human narrative — anything else an LLM
    // agent needs is reachable from the analyze endpoint by symbol/strike/expiry.
    const snapshot = {
      position: {
        symbol: result.symbol, strike: result.strike, expiry: result.expiry,
        right: result.right, quantity: result.quantity, is_long: result.is_long,
        entry_price: result.option.entry_price,
      },
      market: {
        spot: result.spot, distance_pct: result.distance_pct, dte: result.dte,
        mid: result.option.mid, bid: result.option.bid, ask: result.option.ask,
        iv: result.option.iv,
      },
      position_pnl: result.position_pnl,
      greeks: result.greeks,
      probability: result.probability,
      sigma_ranges: result.sigma_ranges,
      // vol_context minus the daily history arrays — they'd dwarf the snapshot.
      vol_context: {
        realized_vol_30d: result.vol_context.realized_vol_30d,
        realized_vol_90d: result.vol_context.realized_vol_90d,
        iv_to_rv_ratio: result.vol_context.iv_to_rv_ratio,
        iv_rank: result.vol_context.iv_rank,
        iv_percentile: result.vol_context.iv_percentile,
        iv_52w_high: result.vol_context.iv_52w_high,
        iv_52w_low: result.vol_context.iv_52w_low,
        underlying_iv_now: result.vol_context.underlying_iv_now,
      },
      liquidity: result.liquidity,
      underlying_trend: {
        rsi: result.underlying.rsi,
        trend_score: result.underlying.trend_score,
        ema9: result.underlying.ema9, ema21: result.underlying.ema21,
        ema50: result.underlying.ema50, ema200: result.underlying.ema200,
      },
      chart_timeframe: result.chart.timeframe,
      forecast_5d: result.forecast
        ? {
            expected_return_pct: result.forecast.expected_return_pct,
            band_pct: result.forecast.band_pct,
            median: result.forecast.median,
            p10: result.forecast.p10,
            p90: result.forecast.p90,
          }
        : null,
      advice: result.advice,
      narrative: result.narrative,
    };
    const text =
      `${result.narrative}\n\n` +
      "```json\n" + JSON.stringify(snapshot, null, 2) + "\n```";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // some browsers block clipboard in non-https; fall back to a textarea trick
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <PageShell>
      <PageHeader title="Options Position Analyzer" />

      {/* contract selector */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <Logo symbol={symbol} size={28} />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (pendingSym.trim()) {
                  setSymbol(pendingSym.trim().toUpperCase());
                  setStrike(null);
                  setResult(null);
                }
              }}
            >
              <Input
                value={pendingSym}
                onChange={(e) => setPendingSym(e.target.value.toUpperCase())}
                className="h-8 w-24 font-semibold tabular text-sm"
              />
            </form>
            {spot != null && (
              <span className="text-[10px] text-text-muted">
                spot <span className="text-text-primary tabular font-medium">${spot.toFixed(2)}</span>
              </span>
            )}
          </div>

          <Field label="Expiry">
            <Select value={expiry} onValueChange={setExpiry} disabled={!chain || chain.expirations.length === 0}>
              <SelectTrigger className="h-8 w-32 tabular text-xs">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {(chain?.expirations || []).map((e) => (
                  <SelectItem key={e} value={e} className="tabular text-xs">
                    {fmtExp(e)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Strike">
            <div className="flex h-8">
              <button
                onClick={() => {
                  if (strike == null || strikes.length === 0) return;
                  const idx = strikes.findIndex((s) => s === strike);
                  if (idx > 0) setStrike(strikes[idx - 1]);
                }}
                disabled={strikes.length === 0 || strike == null || strikes.indexOf(strike) <= 0}
                className="px-2 border border-border rounded-l-md text-text-muted hover:bg-surface-2 disabled:opacity-30 disabled:cursor-not-allowed text-xs tabular"
                title="Lower strike"
              >
                ◀
              </button>
              <Select
                value={strike != null ? String(strike) : ""}
                onValueChange={(v: string) => setStrike(Number(v))}
                disabled={strikes.length === 0}
              >
                <SelectTrigger className="h-8 w-24 tabular text-xs border-l-0 border-r-0 rounded-none">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {strikes.map((s) => {
                    const atm = spot != null && Math.abs(s - spot) === Math.min(...strikes.map((k) => Math.abs(k - spot!)));
                    return (
                      <SelectItem key={s} value={String(s)} className="tabular text-xs">
                        {s}{atm ? " · ATM" : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <button
                onClick={() => {
                  if (strike == null || strikes.length === 0) return;
                  const idx = strikes.findIndex((s) => s === strike);
                  if (idx >= 0 && idx < strikes.length - 1) setStrike(strikes[idx + 1]);
                }}
                disabled={strikes.length === 0 || strike == null || strikes.indexOf(strike) >= strikes.length - 1}
                className="px-2 border border-border rounded-r-md text-text-muted hover:bg-surface-2 disabled:opacity-30 disabled:cursor-not-allowed text-xs tabular"
                title="Higher strike"
              >
                ▶
              </button>
            </div>
          </Field>

          <Field label="Right">
            <div className="flex h-8 rounded-md border border-border overflow-hidden">
              <button
                onClick={() => setRight("C")}
                className={cn(
                  "px-3 text-xs font-medium transition-colors",
                  right === "C" ? "bg-up/15 text-up" : "text-text-muted hover:bg-surface-2"
                )}
              >
                CALL
              </button>
              <button
                onClick={() => setRight("P")}
                className={cn(
                  "px-3 text-xs font-medium border-l border-border transition-colors",
                  right === "P" ? "bg-down/15 text-down" : "text-text-muted hover:bg-surface-2"
                )}
              >
                PUT
              </button>
            </div>
          </Field>

          <Field label="Qty (± = long/short)">
            <Input
              type="number"
              value={qty}
              onChange={(e) => setQty(Number(e.target.value || 0))}
              className="h-8 w-20 tabular text-xs"
            />
          </Field>

          <Field label="Entry $ / share">
            <Input
              type="number"
              step="0.01"
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder="mid"
              className="h-8 w-24 tabular text-xs"
            />
          </Field>

          <div className="ml-auto flex items-center gap-2">
            {loading && <Loader2 size={14} className="animate-spin text-text-muted" />}
            {result && (
              <Button variant="outline" size="sm" onClick={copyAISnapshot} title="Copy LLM-ready position snapshot">
                {copied ? <ClipboardCheck /> : <Clipboard />}
                {copied ? "Copied" : "AI Snapshot"}
              </Button>
            )}
            {chatAvailable && result && (
              <Button variant="outline" size="sm" onClick={askAI}>
                <Sparkles />
                Ask AI
              </Button>
            )}
            {result?.tradingagents_enabled && (
              <Button variant="default" size="sm" onClick={goAgents}>
                <Brain />
                Multi-Agent Debate
                <ChevronRight />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {!canAnalyze ? (
        <EmptyState
          icon={Search}
          title="Pick an expiry and strike"
          description="Choose a contract above to see Greeks, EMA, and P/L profile."
        />
      ) : !result ? (
        <AnalysisSkeleton />
      ) : (
        <AnalysisBody
          result={result}
          timeframe={timeframe}
          onTimeframeChange={setTimeframeManual}
          loading={loading}
        />
      )}
    </PageShell>
  );
}

function AnalysisBody({
  result,
  timeframe,
  onTimeframeChange,
  loading,
}: {
  result: OptionAnalyzeResult;
  timeframe: OptionAnalyzerTimeframe;
  onTimeframeChange: (tf: OptionAnalyzerTimeframe) => void;
  loading: boolean;
}) {
  const advice = result.advice;
  const tone =
    advice.score >= 40 ? "up" : advice.score <= -40 ? "down" : Math.abs(advice.score) >= 15 ? "warning" : "muted";
  const TrendIcon = advice.score >= 0 ? TrendingUp : TrendingDown;
  const ivPctOfRv = result.vol_context.iv_to_rv_ratio;

  // POP and expected move pulled up into the state strip so probability is
  // visible without scrolling — used to live in the right-hand side rail.
  const pop = result.probability.pop;
  const popPct = pop != null ? `${(pop * 100).toFixed(0)}%` : "—";
  const popTone = pop == null ? undefined : pop >= 0.6 ? "up" : pop >= 0.4 ? "warning" : "down";
  const emPct = result.sigma_ranges.expected_move_pct;
  const emAbs = result.sigma_ranges.expected_move_abs;

  // Unrealized P&L — the first thing a trader reviewing their own position
  // wants to see, so it leads the metric grid.
  const upnl = result.position_pnl?.unrealized_pnl;
  const upnlPct = result.position_pnl?.unrealized_pnl_pct;
  const ivRank = result.vol_context.iv_rank;

  return (
    <>
      {/* ── HERO ─────────────────────────────────────────────────────────
          Verdict + headline metrics in one band. Layout:
            row 1 — big prominent SCORE, label pill, narrative, position tag
            row 2 — fixed 4/8-column metric grid (stable across widths)
          The score is the dominant element on the page; reading "+42" or
          "-46" should answer "should I keep this trade?" at a glance.
          `shrink-0` keeps the band from collapsing under flex pressure
          when the page is tall — that was the root cause of "the section
          above P/L profile has small height". */}
      <div className="relative rounded-md border border-border bg-surface px-5 py-4 overflow-hidden shrink-0">
        {/* Side rule — tone color, full-height. */}
        <div className={cn(
          "absolute left-0 top-0 bottom-0 w-1",
          tone === "up" && "bg-up",
          tone === "down" && "bg-down",
          tone === "warning" && "bg-warning",
          tone === "muted" && "bg-border",
        )} />

        <div className="flex items-center gap-4">
          {/* Prominent score block — big tabular number with explicit
              scale + tooltip so the user knows what -46 vs +42 actually
              means. The pill underneath is the human-readable label. */}
          <div
            className="shrink-0 flex flex-col items-center gap-1 min-w-[78px]"
            title={
              "Verdict score on a -100 → +100 scale.\n" +
              "  ≤ -40 : strong close\n" +
              "  -40 to -15 : lean close\n" +
              "  -15 to +15 : neutral / review\n" +
              "  +15 to +40 : lean keep\n" +
              "  ≥ +40 : strong keep"
            }
          >
            <span className="text-[9px] uppercase tracking-wider text-text-muted leading-none">
              score
            </span>
            <div className="flex items-baseline gap-0.5">
              <span className={cn(
                "text-[26px] leading-none font-bold tabular tracking-tight",
                tone === "up" && "text-up",
                tone === "down" && "text-down",
                tone === "warning" && "text-warning",
                tone === "muted" && "text-text-secondary",
              )}>
                {advice.score > 0 ? "+" : ""}{advice.score}
              </span>
              <span className="text-[10px] tabular text-text-muted leading-none">
                /100
              </span>
            </div>
            <span className={cn(
              "px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold inline-flex items-center gap-1",
              tone === "up" && "bg-up/15 text-up",
              tone === "down" && "bg-down/15 text-down",
              tone === "warning" && "bg-warning/15 text-warning",
              tone === "muted" && "bg-surface-2 text-text-secondary",
            )}>
              <TrendIcon size={10} />
              {advice.label}
            </span>
            {/* Mini scale bar — visual position of the score on -100..+100. */}
            <div className="relative w-[68px] h-1 mt-0.5 bg-surface-2 rounded-full overflow-hidden">
              <div className="absolute top-0 bottom-0 left-1/2 w-px bg-text-muted/40" />
              <div
                className={cn(
                  "absolute top-0 bottom-0 w-1 rounded-full",
                  tone === "up" && "bg-up",
                  tone === "down" && "bg-down",
                  tone === "warning" && "bg-warning",
                  tone === "muted" && "bg-text-secondary",
                )}
                style={{
                  left: `${Math.max(0, Math.min(100, ((advice.score + 100) / 200) * 100))}%`,
                  transform: "translateX(-50%)",
                }}
              />
            </div>
            <div className="flex w-[68px] justify-between text-[8px] tabular text-text-muted/60 leading-none">
              <span>close</span>
              <span>keep</span>
            </div>
          </div>

          <p className="text-[12px] leading-relaxed text-text-secondary flex-1 min-w-0">
            {result.narrative}
          </p>
          <span className="text-[10px] uppercase tracking-wider text-text-muted shrink-0 hidden md:inline self-start mt-0.5">
            {result.is_long ? "long" : "short"} {Math.abs(result.quantity)}×
          </span>
        </div>

        {/* Stable grid for headline metrics — 5 cols mobile / 10 cols md+.
            Avoids the flex-wrap chaos where inline label-value pairs
            wrapped differently each width. P&L leads: it's the question
            the user deep-linked from their position to answer. */}
        <div className="mt-3 pt-3 border-t border-border/40 grid grid-cols-5 md:grid-cols-10 gap-x-4 gap-y-2">
          <HeroMetric label="P&L"
            value={upnl != null ? fmtCurrency(upnl) : "—"}
            tone={upnl == null ? undefined : upnl >= 0 ? "up" : "down"}
            hint={upnlPct != null
              ? `${upnlPct >= 0 ? "+" : ""}${upnlPct.toFixed(1)}% vs entry $${result.option.entry_price.toFixed(2)} (mark ${result.position_pnl?.mark_source ?? "—"})`
              : "Unrealized P&L vs entry"} />
          <HeroMetric label="Spot" value={`$${result.spot.toFixed(2)}`}
            hint="Live underlying price." />
          <HeroMetric label="Mid"
            value={result.option.mid != null ? `$${result.option.mid.toFixed(2)}` : "—"}
            hint={result.option.bid != null && result.option.ask != null
              ? `bid ${result.option.bid.toFixed(2)} / ask ${result.option.ask.toFixed(2)}`
              : "Midpoint of bid/ask"} />
          <HeroMetric label="IV"
            value={`${(result.option.iv * 100).toFixed(1)}%`}
            tone={ivPctOfRv != null && ivPctOfRv >= 1.3 ? "down" : ivPctOfRv != null && ivPctOfRv <= 0.8 ? "up" : undefined}
            hint={ivPctOfRv != null ? `${ivPctOfRv.toFixed(2)}× RV30 — ${ivPctOfRv >= 1.3 ? "rich" : ivPctOfRv <= 0.8 ? "cheap" : "fair"}` : "Implied volatility"} />
          <HeroMetric label="IV Rank"
            value={ivRank != null ? ivRank.toFixed(0) : "—"}
            tone={ivRank == null ? undefined : ivRank >= 70 ? (result.is_long ? "down" : "up") : ivRank <= 20 ? (result.is_long ? "up" : "down") : undefined}
            hint={ivRank != null
              ? `52w IV range ${result.vol_context.iv_52w_low != null ? (result.vol_context.iv_52w_low * 100).toFixed(0) : "—"}–${result.vol_context.iv_52w_high != null ? (result.vol_context.iv_52w_high * 100).toFixed(0) : "—"}% · percentile ${result.vol_context.iv_percentile?.toFixed(0) ?? "—"} (IBKR IV index)`
              : "IV rank unavailable — needs IBKR vol history"} />
          <HeroMetric label="DTE" value={`${result.dte}d`}
            tone={result.dte <= 7 ? "down" : result.dte <= 21 ? "warning" : undefined}
            hint="Days to expiration. ≤7d = gamma+theta zone." />
          <HeroMetric label="Δ-K"
            value={`${result.distance_pct > 0 ? "+" : ""}${result.distance_pct.toFixed(2)}%`}
            tone={Math.abs(result.distance_pct) < 2 ? "warning" : undefined}
            hint={`${result.distance_pct >= 0 ? "above" : "below"} strike`} />
          <HeroMetric label="BE" value={`$${result.breakeven.toFixed(2)}`}
            hint={`${result.spot ? (((result.breakeven - result.spot) / result.spot) * 100).toFixed(1) : "—"}% from spot`} />
          <HeroMetric label="POP" value={popPct} tone={popTone}
            hint={`P(ITM) ${result.probability.prob_itm != null ? (result.probability.prob_itm * 100).toFixed(0) + "%" : "—"}`} />
          <HeroMetric label="±1σ"
            value={emPct != null ? `±${emPct.toFixed(1)}%` : "—"}
            hint={emAbs != null ? `±$${emAbs.toFixed(2)} by expiry` : "Expected 1σ move"} />
        </div>
      </div>

      {/* ── P/L PROFILE (the visual) + WHY (audit column) ──────────────
          Section announced by typography header, not by an outer Card. */}
      <SectionHeader title="P/L Profile" hint={`${result.is_long ? "long" : "short"} ${Math.abs(result.quantity)}×`} />
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] gap-3 shrink-0">
        <div className="rounded-md border border-border bg-surface overflow-hidden">
          <div className="p-3">
            <PnlProfileChart
              spot={result.spot}
              breakeven={result.breakeven}
              strike={result.strike}
              sigma1Low={result.sigma_ranges.sigma1_low}
              sigma1High={result.sigma_ranges.sigma1_high}
              sigma2Low={result.sigma_ranges.sigma2_low}
              sigma2High={result.sigma_ranges.sigma2_high}
              maxProfit={result.max_profit}
              maxLoss={result.max_loss}
              iv={result.option.iv}
              dteYears={result.dte / 365.25}
              right={result.right}
              entryPrice={result.option.entry_price}
              quantity={result.quantity}
              isLong={result.is_long}
              pop={result.probability.pop}
              probItm={result.probability.prob_itm}
              height={440}
            />
            <div className="grid grid-cols-3 mt-3 pt-2 border-t border-border/40 text-[10px] tabular">
              <RiskCell label="Max profit"
                value={result.max_profit != null && isFinite(result.max_profit) ? fmtCurrency(result.max_profit) : "∞"}
                tone="up" />
              <RiskCell label="Max loss"
                value={result.max_loss != null && isFinite(result.max_loss) ? fmtCurrency(result.max_loss) : "−∞"}
                tone="down" />
              <RiskCell label="R / R"
                value={rrRatio(result.max_profit, result.max_loss)} />
            </div>
          </div>
        </div>

        {/* WHY rail — position read + signals + rationale stacked. Reads
            beside the chart so the verdict has its receipts (per-rule
            interpretation, signal inputs, free-text notes) visible
            without scrolling. */}
        <div className="flex flex-col gap-3 min-w-0">
          <div className="rounded-md border border-border bg-surface overflow-hidden">
            <PnlInsights result={result} />
          </div>
          <SignalInputsPanel result={result} />
          <div className="rounded-md border border-border bg-surface flex-1">
            <div className="flex items-baseline gap-2 px-3 h-7 border-b border-border/60">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Rationale</span>
              <span className="ml-auto text-[10px] tabular text-text-muted">
                {advice.notes.length} {advice.notes.length === 1 ? "note" : "notes"}
              </span>
            </div>
            <div className="p-3">
              <ul className="space-y-1.5">
                {advice.notes.map((n, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] text-text-secondary leading-snug">
                    <ArrowRight size={11} className={cn(
                      "shrink-0 mt-0.5",
                      tone === "up" && "text-up",
                      tone === "down" && "text-down",
                      tone === "warning" && "text-warning",
                      tone === "muted" && "text-text-muted",
                    )} />
                    <span>{n}</span>
                  </li>
                ))}
                {advice.notes.length === 0 && (
                  <li className="text-[11px] text-text-muted">No specific concerns flagged.</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* ── UNDERLYING ──────────────────────────────────────────────────
          Chart on the left, insights rail on the right. Side-by-side
          means the trader reads the chart's interpretation while still
          looking at the candles — no scroll-back-to-context tax. */}
      <SectionHeader title="Underlying" hint={`${result.symbol} · ${timeframe}`} />
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] gap-3 shrink-0">
        <UnderlyingAnalysisCard
          result={result}
          timeframe={timeframe}
          onTimeframeChange={onTimeframeChange}
          loading={loading}
        />
        <div className="rounded-md border border-border bg-surface overflow-hidden">
          <UnderlyingInsights result={result} />
        </div>
      </div>

      {/* ── OPTION CONTRACT ─────────────────────────────────────────── */}
      <SectionHeader title="Option contract" hint={`${result.strike}${result.right} · BS-replay`} />
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] gap-3 shrink-0">
        <OptionAnalysisCard result={result} />
        <div className="rounded-md border border-border bg-surface overflow-hidden">
          <OptionInsights result={result} />
        </div>
      </div>

      {/* ── GREEKS ─────────────────────────────────────────────────────
          Always visible — it's the analytic users check most often
          (delta-vs-quantity, theta/day, vega exposure). Hiding it
          behind a tab made it feel like content went missing. */}
      <SectionHeader title="Greeks" hint="per-contract · exposure beneath" />
      <div className="rounded-md border border-border bg-surface p-3 shrink-0">
        <GreeksPanel
          delta={result.greeks.delta}
          gamma={result.greeks.gamma}
          theta={result.greeks.theta}
          vega={result.greeks.vega}
          isLong={result.is_long}
          quantity={result.quantity}
        />
      </div>

      {/* ── ANALYTICS (tabbed) ─────────────────────────────────────────
          Lower-priority detail panels live behind tabs so the page
          doesn't scroll forever AND new analytics can be added later
          without further bloat. One tab is open at a time. */}
      <SectionHeader title="Analytics" hint="click a tab" />
      <AnalyticsTabs result={result} />
    </>
  );
}

// ─── HeroMetric — single grid cell in the hero band. Label stacks above
//     the value vertically so wide and narrow values both align. Tone
//     color applies to the value only; label stays muted. The hint lives
//     in the title attribute so the cell stays a single number on screen.
function HeroMetric({
  label, value, tone, hint,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "up" | "down" | "warning";
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0" title={hint}>
      <span className="text-[10px] uppercase tracking-wider text-text-muted leading-none">
        {label}
      </span>
      <span className={cn(
        "text-[14px] font-semibold tabular leading-tight truncate",
        tone === "up" && "text-up",
        tone === "down" && "text-down",
        tone === "warning" && "text-warning",
        !tone && "text-text-primary",
      )}>
        {value}
      </span>
    </div>
  );
}

// ─── SectionHeader — typography divider between major sections. Reads
//     as a clear visual anchor: bigger uppercase title, tone-tinted left
//     accent rule, optional metadata on the right. Mid-density: bigger
//     than the previous 10px hairline (which got lost in the page flow)
//     but still typography-only — no card chrome.
function SectionHeader({ title, hint }: { title: string; hint?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pl-2.5 border-l-2 border-accent">
      <span className="text-[12px] uppercase tracking-wider text-text-primary font-semibold leading-none">
        {title}
      </span>
      {hint && (
        <span className="text-[10px] uppercase tracking-wider text-text-muted leading-none">
          {hint}
        </span>
      )}
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

// ─── AnalyticsTabs — bottom-of-page secondary detail. Greeks / decay /
//     multi-TF / vol / liquidity / scenarios / forecast breakdown live
//     here behind a single tab strip so the page top-fold stays focused
//     on the verdict + chart. Scales: adding a new analytic = adding a
//     trigger + content, not another section pushing the fold down.
function AnalyticsTabs({ result }: { result: OptionAnalyzeResult }) {
  // Force `flex` (TabsList ships as `inline-flex` which fights `w-full`).
  // `overflow-x-auto` lets the strip scroll on narrow viewports without
  // hiding triggers behind the right edge. `shrink-0` so the card doesn't
  // collapse when PageShell's flex column is under height pressure.
  return (
    <div className="rounded-md border border-border bg-surface overflow-hidden shrink-0">
      <Tabs defaultValue="ai">
        <TabsList className="!flex w-full overflow-x-auto rounded-none">
          <TabsTrigger value="ai">AI Read</TabsTrigger>
          <TabsTrigger value="decay">P/L · time</TabsTrigger>
          <TabsTrigger value="momentum">Multi-TF</TabsTrigger>
          <TabsTrigger value="vol">Vol</TabsTrigger>
          <TabsTrigger value="liquidity">Liquidity</TabsTrigger>
          <TabsTrigger value="scenarios">Scenarios</TabsTrigger>
          <TabsTrigger value="forecast">Forecast</TabsTrigger>
        </TabsList>

        <TabsContent value="ai" className="p-4 min-h-[260px]">
          <AIRead result={result} />
        </TabsContent>

        <TabsContent value="decay" className="p-3 min-h-[260px]">
          {result.decay_profile && result.decay_profile.length > 0 ? (
            <PnlDecayChart data={result.decay_profile} height={260} />
          ) : (
            <div className="h-[210px] flex items-center justify-center text-[11px] text-text-muted">
              No decay profile
            </div>
          )}
        </TabsContent>

        <TabsContent value="momentum" className="p-3 min-h-[260px]">
          <MultiTfMomentumPanel result={result} />
        </TabsContent>

        <TabsContent value="vol" className="p-3 min-h-[260px]">
          <VolContextPanel result={result} />
        </TabsContent>

        <TabsContent value="liquidity" className="p-3 min-h-[260px]">
          <LiquidityPanel result={result} />
        </TabsContent>

        <TabsContent value="scenarios" className="p-3 min-h-[260px]">
          <ScenarioMatrixPanel result={result} />
        </TabsContent>

        <TabsContent value="forecast" className="p-3 min-h-[260px]">
          <ForecastBreakdownPanel result={result} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RiskCell({ label, value, tone }: {
  label: string; value: React.ReactNode;
  tone?: "up" | "down";
}) {
  return (
    <div className="flex items-baseline justify-center gap-2 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      <span className={cn(
        "text-[12px] font-semibold tabular",
        tone === "up" && "text-up",
        tone === "down" && "text-down",
        !tone && "text-text-primary"
      )}>{value}</span>
    </div>
  );
}

function rrRatio(maxP: number | null, maxL: number | null): string {
  if (maxP == null || maxL == null || !isFinite(maxP) || !isFinite(maxL) || maxL === 0) return "—";
  return `${(Math.abs(maxP) / Math.abs(maxL)).toFixed(2)} : 1`;
}


function AnalysisSkeleton() {
  // Shape-matches AnalysisBody so layout doesn't shift when the real data arrives.
  // Uses the `.skeleton` class (defined in globals.css) — a subtle horizontal
  // shimmer sweep, not an opacity pulse, so it reads as "data incoming" without
  // the screen breathing in your face.
  return (
    <div className="flex flex-col gap-3">
      {/* Hero verdict + narrative */}
      <div className="rounded-md border border-border bg-surface px-4 py-3 flex items-start gap-3">
        <div className="skeleton h-5 w-32 shrink-0" />
        <div className="flex-1 flex flex-col gap-1.5">
          <div className="skeleton h-3 w-full" />
          <div className="skeleton h-3 w-11/12" />
          <div className="skeleton h-3 w-4/6" />
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 md:grid-cols-6 rounded-md border border-border bg-surface divide-x divide-border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="px-3 py-2 flex flex-col gap-1">
            <div className="skeleton h-2 w-12" />
            <div className="skeleton h-4 w-16" />
            <div className="skeleton h-2 w-10" />
          </div>
        ))}
      </div>

      {/* Chart hero + side rail */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_240px] gap-3">
        <div className="rounded-md border border-border bg-surface overflow-hidden">
          <div className="flex items-center gap-2 px-3 h-8 border-b border-border/60">
            <div className="skeleton h-2 w-20" />
          </div>
          <div className="p-3"><div className="skeleton h-[440px] w-full" /></div>
        </div>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-md border border-border bg-surface">
              <div className="px-3 py-1.5 border-b border-border/60">
                <div className="skeleton h-2 w-20" />
              </div>
              <div className="px-3 py-2 flex flex-col gap-2">
                {Array.from({ length: 3 }).map((_, j) => (
                  <div key={j} className="flex items-baseline justify-between">
                    <div className="skeleton h-2 w-16" />
                    <div className="skeleton h-2 w-12" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Greeks strip */}
      <div className="rounded-md border border-border bg-surface">
        <div className="flex items-center gap-2 px-3 h-8 border-b border-border/60">
          <div className="skeleton h-2 w-12" />
        </div>
        <div className="p-3 grid grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded border border-border p-3 flex flex-col gap-2">
              <div className="skeleton h-5 w-8" />
              <div className="skeleton h-3 w-16" />
              <div className="skeleton h-2 w-20" />
            </div>
          ))}
        </div>
      </div>

      {/* Analytics row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-md border border-border bg-surface">
            <div className="px-3 h-7 border-b border-border/60 flex items-center">
              <div className="skeleton h-2 w-24" />
            </div>
            <div className="p-3 grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="flex flex-col gap-1">
                  <div className="skeleton h-2 w-14" />
                  <div className="skeleton h-3 w-20" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </div>
  );
}

function fmtExp(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(2, 4)}`;
}

function buildAIPrompt(r: OptionAnalyzeResult): string {
  const side = r.right === "C" ? "call" : "put";
  const direction = r.is_long ? "long" : "short";
  return [
    `Should I keep / close my ${direction} ${side} on ${r.symbol}?`,
    "",
    `Position: ${r.quantity} × ${r.strike} ${r.right} exp ${fmtExp(r.expiry)} (${r.dte}d)`,
    `Entry: $${r.option.entry_price.toFixed(2)}/share, current mid $${r.option.mid?.toFixed(2) ?? "—"}`,
    r.position_pnl?.unrealized_pnl != null
      ? `Unrealized P&L: ${r.position_pnl.unrealized_pnl >= 0 ? "+" : ""}$${r.position_pnl.unrealized_pnl.toFixed(0)} (${r.position_pnl.unrealized_pnl_pct! >= 0 ? "+" : ""}${r.position_pnl.unrealized_pnl_pct!.toFixed(1)}%)`
      : `Unrealized P&L: unavailable`,
    `Spot: $${r.spot.toFixed(2)} (${r.distance_pct >= 0 ? "+" : ""}${r.distance_pct.toFixed(2)}% from strike)`,
    `Greeks: Δ=${r.greeks.delta?.toFixed(3) ?? "—"} Γ=${r.greeks.gamma?.toFixed(4) ?? "—"} Θ=${r.greeks.theta?.toFixed(3) ?? "—"} ν=${r.greeks.vega?.toFixed(3) ?? "—"}`,
    `IV: ${(r.option.iv * 100).toFixed(1)}%${r.vol_context.iv_rank != null ? ` (IV rank ${r.vol_context.iv_rank.toFixed(0)}, percentile ${r.vol_context.iv_percentile?.toFixed(0) ?? "—"})` : ""}, breakeven $${r.breakeven.toFixed(2)}`,
    `Underlying: EMA9 ${r.underlying.ema9?.toFixed(2) ?? "—"}, EMA21 ${r.underlying.ema21?.toFixed(2) ?? "—"}, EMA200 ${r.underlying.ema200?.toFixed(2) ?? "—"}, RSI ${r.underlying.rsi.toFixed(0)}, trend score ${r.underlying.trend_score}`,
    r.forecast
      ? `Model (Chronos 5d): median ${r.forecast.expected_return_pct >= 0 ? "+" : ""}${r.forecast.expected_return_pct.toFixed(1)}% (p10/p90 band ±${r.forecast.band_pct.toFixed(1)}%)`
      : `Model: unavailable`,
    `Algorithm verdict: ${r.advice.label} (${r.advice.score})`,
    `Notes: ${r.advice.notes.join("; ") || "none"}`,
    "",
    "Give 3-4 bullets: keep or close, what to watch, one risk.",
  ].join("\n");
}
