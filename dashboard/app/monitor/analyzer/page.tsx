"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, type OptionAnalyzeResult, type OptionsChain, type OptionAnalyzerTimeframe } from "@/lib/api";
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
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Stat, StatGroup } from "@/components/ui/stat";
import { Skeleton, Spinner } from "@/components/ui/skeleton";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { Logo } from "@/components/ui/logo";
import { cn, fmtCurrency } from "@/lib/utils";
import { RiArrowRightLine as ArrowRight, RiBrainLine as Brain, RiArrowLeftSLine as ChevronLeft, RiArrowRightSLine as ChevronRight, RiClipboardLine as Clipboard, RiFileListLine as ClipboardCheck, RiSearchLine as Search, RiBrainLine as Sparkles, RiArrowRightDownLine as TrendingDown } from "@remixicon/react";
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

function AnalyzerContent() {
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
    // A compact JSON payload + the human narrative, anything else an LLM
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
      greeks: result.greeks,
      probability: result.probability,
      sigma_ranges: result.sigma_ranges,
      vol_context: result.vol_context,
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


  const sideOptions: { label: string; value: "C" | "P" }[] = [
    { label: "Call", value: "C" },
    { label: "Put", value: "P" },
  ];

  return (
    <PageShell>
      <PageHeader
        title="Options position analyzer"
        description="Greeks, probability, P/L profile and model reads for one contract."
        actions={
          <>
            {loading && <Spinner size={16} />}
            {result && (
              <Button variant="secondary" onClick={copyAISnapshot} title="Copy an LLM-ready position snapshot">
                {copied ? <ClipboardCheck /> : <Clipboard />}
                {copied ? "Copied" : "Snapshot"}
              </Button>
            )}
            {chatAvailable && result && (
              <Button variant="secondary" onClick={askAI}><Sparkles />Ask AI</Button>
            )}
            {result?.tradingagents_enabled && (
              <Button variant="default" onClick={goAgents}><Brain />Debate<ChevronRight /></Button>
            )}
          </>
        }
      />

      {/* ── Contract picker ──────────────────────────────────────────────
          Symbol, expiry, strike, side, quantity, entry as labelled fields,
          with the live spot / IV readout at the far end. */}
      <Card className="shrink-0">
        <CardContent className="flex flex-wrap items-end gap-3">
          <Field label="Symbol">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (pendingSym.trim()) {
                  setSymbol(pendingSym.trim().toUpperCase());
                  setStrike(null);
                  setResult(null);
                }
              }}
            >
              <Logo symbol={symbol} size={20} />
              <Input
                value={pendingSym}
                onChange={(e) => setPendingSym(e.target.value.toUpperCase())}
                className="w-24 tabular text-body-2-medium"
                aria-label="Symbol"
              />
            </form>
          </Field>

          <Field label="Expiry">
            <Select value={expiry} onValueChange={setExpiry} disabled={!chain || chain.expirations.length === 0}>
              <SelectTrigger className="w-32 tabular" aria-label="Expiry"><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {(chain?.expirations || []).map((e) => (
                  <SelectItem key={e} value={e} className="tabular">{fmtExp(e)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Strike">
            <div className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="icon"
                aria-label="Lower strike"
                title="Lower strike"
                onClick={() => {
                  if (strike == null || strikes.length === 0) return;
                  const idx = strikes.findIndex((s) => s === strike);
                  if (idx > 0) setStrike(strikes[idx - 1]);
                }}
                disabled={strikes.length === 0 || strike == null || strikes.indexOf(strike) <= 0}
              >
                <ChevronLeft />
              </Button>
              <Select value={strike != null ? String(strike) : ""} onValueChange={(v: string) => setStrike(Number(v))} disabled={strikes.length === 0}>
                <SelectTrigger className="w-28 tabular" aria-label="Strike"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {strikes.map((s) => {
                    const atm = spot != null && Math.abs(s - spot) === Math.min(...strikes.map((k) => Math.abs(k - spot!)));
                    return (
                      <SelectItem key={s} value={String(s)} className="tabular">{s}{atm ? " (at the money)" : ""}</SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Higher strike"
                title="Higher strike"
                onClick={() => {
                  if (strike == null || strikes.length === 0) return;
                  const idx = strikes.findIndex((s) => s === strike);
                  if (idx >= 0 && idx < strikes.length - 1) setStrike(strikes[idx + 1]);
                }}
                disabled={strikes.length === 0 || strike == null || strikes.indexOf(strike) >= strikes.length - 1}
              >
                <ChevronRight />
              </Button>
            </div>
          </Field>

          <Field label="Side">
            <ToggleGroup options={sideOptions} value={right} onChange={setRight} ariaLabel="Side" className="h-8" />
          </Field>

          <Field label="Quantity" hint="Negative for short">
            <Input
              type="number"
              value={qty}
              onChange={(e) => setQty(Number(e.target.value || 0))}
              className="w-20 tabular"
              aria-label="Quantity"
              title="Positive is long, negative is short"
            />
          </Field>

          <Field label="Entry price">
            <Input
              type="number"
              step="0.01"
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder="Mid"
              className="w-24 tabular"
              aria-label="Entry price"
            />
          </Field>

          {(spot != null || result) && (
            <div className="ml-auto flex items-center gap-3 rounded-2lg bg-background-secondary-default px-3 h-12">
              {spot != null && <Stat label="Spot" value={`$${spot.toFixed(2)}`} />}
              {result && <Stat label="IV" value={`${(result.option.iv * 100).toFixed(1)}%`} />}
            </div>
          )}
        </CardContent>
      </Card>

      {!canAnalyze ? (
        <Card className="shrink-0">
          <EmptyState
            icon={Search}
            title="Pick an expiry and strike"
            description="Choose a contract above to see Greeks, EMA and the P/L profile."
          />
        </Card>
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

export default function OptionsAnalyzerPage() {
  return (
    <Suspense fallback={<AnalysisSkeleton />}>
      <AnalyzerContent />
    </Suspense>
  );
}

// A labelled control in the picker card.
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-caption-1-medium text-text-tertiary">
        {label}
        {hint && <span className="text-text-tertiary"> ({hint.toLowerCase()})</span>}
      </span>
      {children}
    </div>
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
  // Concrete action verdict (ADD/HOLD/SPEC/TRIM/EXIT), the single most
  // actionable element; colored independently of the raw score so EXIT/TRIM
  // read red/amber even when the score is only mildly negative.
  const action = advice.action ?? null;
  // Plain-English verdict: spell out the action (no cryptic "SPEC"), split the
  // label into the reasoning clause, and put the raw score into words so the
  // number actually means something on screen.
  const actionPhrase =
    action === "ADD" ? "Add or hold"
    : action === "HOLD" ? "Hold"
    : action === "SPEC" ? "Speculative hold"
    : action === "TRIM" ? "Reduce"
    : action === "EXIT" ? "Close"
    : (advice.label || "n/a");
  const labelExplanation = (() => {
    const l = advice.label || "";
    const dash = l.indexOf("n/a");
    const tail = dash >= 0 ? l.slice(dash + 1).trim() : l;
    return tail || l;
  })();
  const scoreWord =
    advice.score >= 40 ? "strong keep"
    : advice.score >= 15 ? "lean keep"
    : advice.score > -15 ? "leans neutral"
    : advice.score > -40 ? "lean close"
    : "strong close";
  const ivPctOfRv = result.vol_context.iv_to_rv_ratio;

  // POP and expected move pulled up into the state strip so probability is
  // visible without scrolling, used to live in the right-hand side rail.
  const pop = result.probability.pop;
  const popPct = pop != null ? `${(pop * 100).toFixed(0)}%` : "n/a";
  const popTone = pop == null ? undefined : pop >= 0.6 ? "up" : pop >= 0.4 ? "warning" : "down";
  const emPct = result.sigma_ranges.expected_move_pct;
  const emAbs = result.sigma_ranges.expected_move_abs;

  const toneText =
    tone === "up" ? "text-status-lime-text"
    : tone === "down" ? "text-status-rose-text"
    : tone === "warning" ? "text-status-yellow-text"
    : "text-text-secondary";
  const toneBg =
    tone === "up" ? "bg-status-lime-text"
    : tone === "down" ? "bg-status-rose-text"
    : tone === "warning" ? "bg-status-yellow-text"
    : "bg-foreground-icon-tertiary";

  return (
    <>
      {/* ── Verdict card ─────────────────────────────────────────────────
          Plain-words verdict, the reasoning, a signal meter and the
          narrative, then a row of headline metrics as inner tiles. */}
      <Card className="shrink-0">
        <CardHeader>
          <div className="flex items-center gap-2 min-w-0">
            <CardTitle>Verdict</CardTitle>
            {advice.conviction && (
              <Badge variant="muted" title="How much to trust this call, from signal strength and model agreement.">
                {advice.conviction} conviction
              </Badge>
            )}
          </div>
          <span className="text-caption-1-medium text-text-tertiary tabular">
            {result.quantity} {Math.abs(result.quantity) === 1 ? "contract" : "contracts"}, {result.is_long ? "long" : "short"} {result.right === "C" ? "call" : "put"}
          </span>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col md:flex-row md:items-start gap-4">
            <div className="shrink-0 flex flex-col gap-2 md:w-[260px]">
              <div className={cn("text-title-3-semibold", toneText)}>{actionPhrase}</div>
              <p className="text-body-2-regular text-text-secondary">{labelExplanation}</p>

              {/* Signal meter, the score made legible: where it sits between
                  "close it" and "keep it", with the number spelled out. */}
              <div
                className="relative w-full h-1 bg-background-tertiary-default rounded-full overflow-hidden mt-1"
                title="Verdict signal from -100 (close) to +100 (keep)"
              >
                <div className="absolute top-0 bottom-0 left-1/2 w-px bg-separator-border" />
                <div
                  className={cn("absolute top-0 bottom-0 w-1 rounded-full", toneBg)}
                  style={{ left: `${Math.max(0, Math.min(100, ((advice.score + 100) / 200) * 100))}%`, transform: "translateX(-50%)" }}
                />
              </div>
              <div className="flex justify-between items-baseline text-caption-1-medium text-text-tertiary">
                <span>Close</span>
                <span className="tabular">
                  Signal {advice.score > 0 ? "+" : ""}{advice.score}, {scoreWord}
                </span>
                <span>Keep</span>
              </div>
            </div>

            <p className="text-body-2-regular text-text-secondary flex-1 min-w-0">
              {result.narrative}
            </p>
          </div>

          {/* Headline metrics */}
          <StatGroup>
            <Stat label="Spot" value={`$${result.spot.toFixed(2)}`} hint="Underlying" />
            <Stat
              label="Mid"
              value={result.option.mid != null ? `$${result.option.mid.toFixed(2)}` : "n/a"}
              hint={result.option.bid != null && result.option.ask != null
                ? `Bid ${result.option.bid.toFixed(2)}, ask ${result.option.ask.toFixed(2)}`
                : "Bid/ask midpoint"}
            />
            <Stat
              label="IV"
              value={`${(result.option.iv * 100).toFixed(1)}%`}
              tone={ivPctOfRv != null && ivPctOfRv >= 1.3 ? "down" : ivPctOfRv != null && ivPctOfRv <= 0.8 ? "up" : "default"}
              hint={ivPctOfRv != null ? `${ivPctOfRv.toFixed(2)}x RV30, ${ivPctOfRv >= 1.3 ? "rich" : ivPctOfRv <= 0.8 ? "cheap" : "fair"}` : "Implied volatility"}
            />
            <Stat
              label="DTE"
              value={`${result.dte}d`}
              tone={result.dte <= 7 ? "down" : result.dte <= 21 ? "warning" : "default"}
              hint={result.dte <= 7 ? "Gamma and theta zone" : "Days to expiry"}
            />
            <Stat
              label="Distance to strike"
              value={`${result.distance_pct > 0 ? "+" : ""}${result.distance_pct.toFixed(2)}%`}
              tone={Math.abs(result.distance_pct) < 2 ? "warning" : "default"}
              hint={`Spot ${result.distance_pct >= 0 ? "above" : "below"} strike`}
            />
            <Stat
              label="Breakeven"
              value={`$${result.breakeven.toFixed(2)}`}
              hint={`${result.spot ? (((result.breakeven - result.spot) / result.spot) * 100).toFixed(1) : "n/a"}% from spot`}
            />
            <Stat
              label="POP"
              value={popPct}
              tone={popTone ?? "default"}
              hint={`P(ITM) ${result.probability.prob_itm != null ? (result.probability.prob_itm * 100).toFixed(0) + "%" : "n/a"}`}
            />
            <Stat
              label="Expected move"
              value={emPct != null ? `±${emPct.toFixed(1)}%` : "n/a"}
              hint={emAbs != null ? `±$${emAbs.toFixed(2)} by expiry` : "One sigma"}
            />
            <Stat
              label="Delta"
              value={result.greeks.delta != null ? result.greeks.delta.toFixed(3) : "n/a"}
              hint="Per $1 move"
            />
            <Stat
              label="Theta"
              value={result.greeks.theta != null ? result.greeks.theta.toFixed(3) : "n/a"}
              tone={result.greeks.theta != null && (result.is_long ? result.greeks.theta < 0 : result.greeks.theta > 0) ? "down" : "default"}
              hint="Daily decay"
            />
            <Stat
              label="Max profit"
              value={result.max_profit != null && isFinite(result.max_profit) ? `+${fmtCurrency(result.max_profit)}` : "Unlimited"}
              tone="up"
            />
            <Stat
              label="Max loss"
              value={result.max_loss != null && isFinite(result.max_loss) ? `-${fmtCurrency(Math.abs(result.max_loss))}` : "Unlimited"}
              tone="down"
            />
          </StatGroup>
        </CardContent>
      </Card>

      {/* ── Primary view: one tab strip, one panel rendered at a time ── */}
      <Card className="shrink-0">
        <Tabs defaultValue="pnl">
          <TabsList className="!flex w-full overflow-x-auto px-2">
            <TabsTrigger value="pnl">P/L profile</TabsTrigger>
            <TabsTrigger value="underlying">Underlying ({timeframe})</TabsTrigger>
            <TabsTrigger value="option">Option</TabsTrigger>
            <TabsTrigger value="greeks">Greeks</TabsTrigger>
            <TabsTrigger value="ai">AI read</TabsTrigger>
            <TabsTrigger value="forecast">Forecast</TabsTrigger>
            <TabsTrigger value="decay">P/L over time</TabsTrigger>
            <TabsTrigger value="momentum">Multi-timeframe</TabsTrigger>
            <TabsTrigger value="vol">Volatility</TabsTrigger>
            <TabsTrigger value="liquidity">Liquidity</TabsTrigger>
            <TabsTrigger value="scenarios">Scenarios</TabsTrigger>
          </TabsList>

          {/* P/L profile */}
          <TabsContent value="pnl" className="p-4">
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] gap-3">
              <div>
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
                <StatGroup cols={3} className="mt-3">
                  <Stat label="Max profit"
                    value={result.max_profit != null && isFinite(result.max_profit) ? `+${fmtCurrency(result.max_profit)}` : "Unlimited"}
                    tone="up" />
                  <Stat label="Max loss"
                    value={result.max_loss != null && isFinite(result.max_loss) ? `-${fmtCurrency(Math.abs(result.max_loss))}` : "Unlimited"}
                    tone="down" />
                  <Stat label="Reward to risk" value={rrRatio(result.max_profit, result.max_loss)} />
                </StatGroup>
              </div>

              {/* interpretation rail */}
              <div className="flex flex-col gap-3 min-w-0">
                <Tile>
                  <PnlInsights result={result} />
                </Tile>
                <SignalInputsPanel result={result} />
                <Tile className="flex-1">
                  <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-separator-border">
                    <span className="text-body-2-medium text-text-primary">Rationale</span>
                    <Badge variant="muted" className="tabular">
                      {advice.notes.length} {advice.notes.length === 1 ? "note" : "notes"}
                    </Badge>
                  </div>
                  <ul className="p-3 flex flex-col gap-1.5">
                    {advice.notes.map((n, i) => (
                      <li key={i} className="flex items-start gap-2 text-body-2-regular text-text-secondary">
                        <ArrowRight size={14} className={cn("shrink-0 mt-1", toneText)} aria-hidden="true" />
                        <span>{n}</span>
                      </li>
                    ))}
                    {advice.notes.length === 0 && (
                      <li className="text-body-2-regular text-text-tertiary">No specific concerns flagged.</li>
                    )}
                  </ul>
                </Tile>
              </div>
            </div>
          </TabsContent>

          {/* Underlying */}
          <TabsContent value="underlying" className="p-4">
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] gap-3">
              <UnderlyingAnalysisCard
                result={result}
                timeframe={timeframe}
                onTimeframeChange={onTimeframeChange}
                loading={loading}
              />
              <Tile>
                <UnderlyingInsights result={result} />
              </Tile>
            </div>
          </TabsContent>

          {/* Option contract */}
          <TabsContent value="option" className="p-4">
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] gap-3">
              <OptionAnalysisCard result={result} />
              <Tile>
                <OptionInsights result={result} />
              </Tile>
            </div>
          </TabsContent>

          {/* Greeks, full per-contract breakdown */}
          <TabsContent value="greeks" className="p-4">
            <GreeksPanel
              delta={result.greeks.delta}
              gamma={result.greeks.gamma}
              theta={result.greeks.theta}
              vega={result.greeks.vega}
              isLong={result.is_long}
              quantity={result.quantity}
            />
          </TabsContent>

          <TabsContent value="ai" className="p-4 min-h-[260px]">
            <AIRead result={result} />
          </TabsContent>

          <TabsContent value="forecast" className="p-4 min-h-[260px]">
            <ForecastBreakdownPanel result={result} />
          </TabsContent>

          <TabsContent value="decay" className="p-4 min-h-[260px]">
            {result.decay_profile && result.decay_profile.length > 0 ? (
              <PnlDecayChart data={result.decay_profile} height={260} />
            ) : (
              <EmptyState size="sm" icon={TrendingDown} title="No decay profile" description="The backend did not return a P/L over time series for this contract." />
            )}
          </TabsContent>

          <TabsContent value="momentum" className="p-4 min-h-[260px]">
            <MultiTfMomentumPanel result={result} />
          </TabsContent>

          <TabsContent value="vol" className="p-4 min-h-[260px]">
            <VolContextPanel result={result} />
          </TabsContent>

          <TabsContent value="liquidity" className="p-4 min-h-[260px]">
            <LiquidityPanel result={result} />
          </TabsContent>

          <TabsContent value="scenarios" className="p-4 min-h-[260px]">
            <ScenarioMatrixPanel result={result} />
          </TabsContent>
        </Tabs>
      </Card>
    </>
  );
}

// Inner tile for the interpretation rails: secondary surface, no border.
function Tile({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-2lg bg-background-secondary-default overflow-hidden", className)}>{children}</div>;
}

function rrRatio(maxP: number | null, maxL: number | null): string {
  if (maxP == null || maxL == null || !isFinite(maxP) || !isFinite(maxL) || maxL === 0) return "n/a";
  return `${(Math.abs(maxP) / Math.abs(maxL)).toFixed(2)} : 1`;
}

function AnalysisSkeleton() {
  // Shape-matches AnalysisBody so layout doesn't shift when the real data arrives.
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <Skeleton className="h-3 w-20" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start gap-4">
            <div className="flex flex-col gap-2 w-[260px] shrink-0">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-1 w-full" />
            </div>
            <div className="flex-1 flex flex-col gap-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-4/6" />
            </div>
          </div>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-2lg bg-background-secondary-default p-3 flex flex-col gap-2">
                <Skeleton className="h-2 w-12" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <div className="flex items-center gap-4 px-4 h-10 border-b border-separator-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-16" />
          ))}
        </div>
        <CardContent>
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] gap-3">
            <Skeleton className="h-[440px] w-full" />
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="rounded-2lg bg-background-secondary-default p-3 flex flex-col gap-2">
                  <Skeleton className="h-2 w-20" />
                  <Skeleton className="h-2 w-full" />
                  <Skeleton className="h-2 w-3/4" />
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
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
    `Entry: $${r.option.entry_price.toFixed(2)}/share, current mid $${r.option.mid?.toFixed(2) ?? "n/a"}`,
    `Spot: $${r.spot.toFixed(2)} (${r.distance_pct >= 0 ? "+" : ""}${r.distance_pct.toFixed(2)}% from strike)`,
    `Greeks: Δ=${r.greeks.delta?.toFixed(3) ?? "n/a"} Γ=${r.greeks.gamma?.toFixed(4) ?? "n/a"} Θ=${r.greeks.theta?.toFixed(3) ?? "n/a"} ν=${r.greeks.vega?.toFixed(3) ?? "n/a"}`,
    `IV: ${(r.option.iv * 100).toFixed(1)}%, breakeven $${r.breakeven.toFixed(2)}`,
    `Underlying: EMA9 ${r.underlying.ema9?.toFixed(2) ?? "n/a"}, EMA21 ${r.underlying.ema21?.toFixed(2) ?? "n/a"}, EMA200 ${r.underlying.ema200?.toFixed(2) ?? "n/a"}, RSI ${r.underlying.rsi.toFixed(0)}, trend score ${r.underlying.trend_score}`,
    r.forecast
      ? `Model (Chronos 5d): median ${r.forecast.expected_return_pct >= 0 ? "+" : ""}${r.forecast.expected_return_pct.toFixed(1)}% (p10/p90 band ±${r.forecast.band_pct.toFixed(1)}%)`
      : `Model: unavailable`,
    `Algorithm verdict: ${r.advice.label} (${r.advice.score})`,
    `Notes: ${r.advice.notes.join("; ") || "none"}`,
    "",
    "Give 3-4 bullets: keep or close, what to watch, one risk.",
  ].join("\n");
}
