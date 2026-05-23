"use client";

import { useEffect, useMemo, useState } from "react";
import {
  STRATEGIES,
  calcMetrics,
  checkStrategy,
  type StrategySpec,
  type Underlying,
  type TradeInput,
} from "@/lib/ruleone";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PayoffChart } from "./PayoffChart";
import { cn, fmt, fmtCurrency } from "@/lib/utils";
import { Check, X, Rocket, Info } from "lucide-react";

export interface PrefillInputs {
  spot?: number;
  dte?: number;
  shortStrike?: number;
  longStrike?: number;
  credit?: number;
  shortDelta?: number;
}

interface Props {
  underlying: Underlying;
  prefill?: PrefillInputs;
  defaultBankroll?: number;
}

const DEFAULT_BANKROLL = 100_000;

export function RuleOneScreener({ underlying, prefill, defaultBankroll }: Props) {
  const [spot, setSpot] = useState<number>(prefill?.spot ?? 0);
  const [dte, setDte] = useState<number>(prefill?.dte ?? 25);
  const [shortStrike, setShortStrike] = useState<number>(prefill?.shortStrike ?? 0);
  const [longStrike, setLongStrike] = useState<number>(prefill?.longStrike ?? 0);
  const [credit, setCredit] = useState<number>(prefill?.credit ?? 0);
  const [shortDelta, setShortDelta] = useState<number>(prefill?.shortDelta ?? 0.1);
  const [bankroll, setBankroll] = useState<number>(defaultBankroll ?? DEFAULT_BANKROLL);

  // When prefill changes (e.g. user clicks a strike in the chain), update.
  useEffect(() => {
    if (prefill?.spot != null) setSpot(prefill.spot);
    if (prefill?.dte != null) setDte(prefill.dte);
    if (prefill?.shortStrike != null) setShortStrike(prefill.shortStrike);
    if (prefill?.longStrike != null) setLongStrike(prefill.longStrike);
    if (prefill?.credit != null) setCredit(prefill.credit);
    if (prefill?.shortDelta != null) setShortDelta(prefill.shortDelta);
  }, [prefill]);

  const input: TradeInput = {
    underlying,
    spot,
    dte,
    shortStrike,
    longStrike,
    credit,
    shortDelta,
    bankroll,
  };

  const m = useMemo(() => calcMetrics(input), [spot, dte, shortStrike, longStrike, credit, shortDelta, bankroll]);
  const results = useMemo(
    () => STRATEGIES.map((s) => checkStrategy(input, m, s)),
    [input, m],
  );

  const applicable = results.filter((r) => r.applicable);
  const passing = applicable.filter((r) => r.passes);

  const valid = spot > 0 && shortStrike > 0 && longStrike > 0 && credit > 0 && shortStrike > longStrike;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Rocket size={14} className="text-accent" />
          <span className="text-xs font-medium text-text-primary">Rule One Screener</span>
          <Badge variant="accent" className="normal-case tracking-normal">{underlying}</Badge>
        </div>
        <Badge variant={passing.length > 0 ? "up" : "muted"}>
          {passing.length}/{applicable.length} pass
        </Badge>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-2 p-3">
          <NumField label="Spot" value={spot} onChange={setSpot} step={0.5} />
          <NumField label="DTE" value={dte} onChange={setDte} step={1} integer />
          <NumField label="Short strike" value={shortStrike} onChange={setShortStrike} step={5} />
          <NumField label="Long strike" value={longStrike} onChange={setLongStrike} step={5} />
          <NumField label="Credit ($)" value={credit} onChange={setCredit} step={0.05} />
          <NumField label="Short Δ" value={shortDelta} onChange={setShortDelta} step={0.01} hint="absolute, e.g. 0.10" />
          <NumField label="Bankroll" value={bankroll} onChange={setBankroll} step={1000} className="col-span-2" />
        </CardContent>
      </Card>

      {valid ? (
        <>
          {/* metrics row */}
          <Card>
            <CardContent className="grid grid-cols-4 gap-2 p-3">
              <Metric label="Width" value={fmt(m.width, 0)} />
              <Metric label="Distance" value={fmt(m.distancePct, 2) + "%"} />
              <Metric label="Adj %OTM" value={fmt(m.adjOTMPct, 2) + "%"} />
              <Metric label="AROC" value={fmt(m.arocPct, 1) + "%"} />
              <Metric label="Prob OTM" value={fmt(m.probOTM * 100, 1) + "%"} />
              <Metric label="Kelly" value={fmt(m.kellyPct, 1) + "%"} />
              <Metric label="Max profit" value={fmtCurrency(m.maxProfitPerContract)} tone="up" />
              <Metric label="Max loss" value={fmtCurrency(-m.maxLossPerContract)} tone="down" />
            </CardContent>
          </Card>

          {/* qualification per strategy */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {results.map((r) => (
              <StrategyResultCard key={r.spec.id} spec={r.spec} result={r} />
            ))}
          </div>

          {/* position sizing */}
          <Card>
            <CardContent className="p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-text-muted">
                  Position sizing
                </span>
                <Badge variant="muted">{fmtCurrency(bankroll)} bankroll</Badge>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Metric label="Kelly cap" value={`${m.maxContractsKelly} ct`} />
                <Metric label="33% cap" value={`${m.maxContractsThird} ct`} />
                <Metric
                  label="Recommended"
                  value={`${m.recommendedContracts} ct`}
                  tone={m.recommendedContracts > 0 ? "up" : undefined}
                />
              </div>
              <p className="text-[10px] text-text-muted leading-relaxed">
                Sizing is the lesser of Kelly% × bankroll and Rule One's 33% bankroll cap, divided
                by max loss per contract. Break-even at expiration:{" "}
                <span className="text-text-secondary tabular">{fmt(m.breakeven, 2)}</span>.
              </p>
            </CardContent>
          </Card>

          {/* payoff diagram */}
          <Card>
            <CardContent className="p-3 flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">
                Payoff at expiration · {m.recommendedContracts || 1} ct
              </span>
              <PayoffChart
                spot={spot}
                shortStrike={shortStrike}
                longStrike={longStrike}
                credit={credit}
                contracts={m.recommendedContracts || 1}
              />
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="p-3 text-[11px] text-text-muted flex items-center gap-2">
            <Info size={12} />
            Enter spot, both strikes (short &gt; long), credit, and short delta to evaluate.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StrategyResultCard({
  spec,
  result,
}: {
  spec: StrategySpec;
  result: ReturnType<typeof checkStrategy>;
}) {
  return (
    <Card
      className={cn(
        "transition-colors",
        !result.applicable
          ? "opacity-50 border-border"
          : result.passes
            ? "border-up/40 bg-up/5"
            : "border-down/30 bg-down/5",
      )}
    >
      <CardContent className="p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">{spec.name}</span>
          <Badge variant={!result.applicable ? "muted" : result.passes ? "up" : "down"}>
            {!result.applicable ? "n/a" : result.passes ? "pass" : "fail"}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
          <CheckRow label={result.checks.delta.label} ok={result.checks.delta.pass} value={result.checks.delta.value} suffix="" applicable={result.applicable} />
          <CheckRow label={result.checks.adjOTM.label} ok={result.checks.adjOTM.pass} value={result.checks.adjOTM.value} suffix="%" applicable={result.applicable} />
          <CheckRow label={result.checks.aroc.label} ok={result.checks.aroc.pass} value={result.checks.aroc.value} suffix="%" applicable={result.applicable} />
          <CheckRow label={result.checks.kelly.label} ok={result.checks.kelly.pass} value={result.checks.kelly.value} suffix="" applicable={result.applicable} />
        </div>
        <p className="text-[10px] text-text-muted leading-snug border-t border-border/60 pt-1.5">
          Exit at Δ {spec.exitDelta}. {spec.notes}
        </p>
      </CardContent>
    </Card>
  );
}

function CheckRow({
  label,
  ok,
  value,
  suffix,
  applicable,
}: {
  label: string;
  ok: boolean;
  value: number;
  suffix: string;
  applicable: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-muted">{label}</span>
      <span className="flex items-center gap-1">
        <span className={cn("tabular", applicable ? (ok ? "text-up" : "text-down") : "text-text-muted")}>
          {fmt(value, value > 99 ? 0 : 1)}{suffix}
        </span>
        {applicable && (ok ? <Check size={10} className="text-up" /> : <X size={10} className="text-down" />)}
      </span>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  step,
  integer,
  hint,
  className,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  integer?: boolean;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label className="text-[10px] text-text-muted uppercase tracking-wider flex items-center gap-1">
        {label}
        {hint && <span className="lowercase tracking-normal text-text-muted/70 normal-case">· {hint}</span>}
      </label>
      <Input
        type="number"
        step={step ?? "any"}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const n = integer ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className="h-7 tabular"
      />
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-text-muted uppercase tracking-wider">{label}</span>
      <span
        className={cn(
          "tabular text-sm font-semibold",
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text-primary",
        )}
      >
        {value}
      </span>
    </div>
  );
}
