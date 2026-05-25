"use client";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { OptionAnalyzeResult } from "@/lib/api";
import { InfoIcon } from "@/components/ui/info-icon";

interface Props {
  result: OptionAnalyzeResult;
}

/**
 * "Inputs to verdict" — exposes every signal the algorithm consumed so the
 * user can audit the call. Each row is one signal: name + live value +
 * one-word interpretation + a dot indicating whether it's currently
 * scoring (●), neutral (○), or pushing against the position (◇).
 *
 * Read alongside the Rationale card: rationale = the *narrative*,
 * this panel = the *raw data* that produced it.
 */
export function SignalInputsPanel({ result }: Props) {
  const s = result.signal_inputs;
  // Older analyze responses (or partial reloads after a backend
  // restart) can omit signal_inputs entirely. Render a clean fallback
  // instead of crashing the whole audit column.
  if (!s || !s.chart_tf) {
    return (
      <div className="rounded-md border border-border bg-surface">
        <div className="flex items-baseline gap-2 px-3 h-7 border-b border-border/60">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            Signals
          </span>
        </div>
        <div className="p-3 text-[11px] text-text-muted">
          Signal inputs unavailable — try refreshing the analyzer.
        </div>
      </div>
    );
  }
  const isLong = result.is_long;
  const right = result.right;
  const bullishPos = (isLong && right === "C") || (!isLong && right === "P");
  const bearishPos = (isLong && right === "P") || (!isLong && right === "C");

  const tf = s.chart_tf.timeframe;
  const spot = result.spot;

  // Helpers for tagging signal disposition.
  const dot = (mood: "fires-for" | "fires-against" | "neutral" | "warn") =>
    mood === "fires-for" ? (
      <span className="text-up">●</span>
    ) : mood === "fires-against" ? (
      <span className="text-down">●</span>
    ) : mood === "warn" ? (
      <span className="text-warning">●</span>
    ) : (
      <span className="text-text-muted">○</span>
    );

  // Per-row interpretation logic mirrors the backend's scoring rules.
  const rsiDaily = s.daily.rsi;
  const rsiMood: "fires-for" | "fires-against" | "neutral" =
    rsiDaily >= 70
      ? bearishPos
        ? "fires-for"
        : "fires-against"
      : rsiDaily <= 30
        ? bullishPos
          ? "fires-for"
          : "fires-against"
        : "neutral";
  const rsiLabel =
    rsiDaily >= 70
      ? "overbought"
      : rsiDaily <= 30
        ? "oversold"
        : rsiDaily >= 60
          ? "strong"
          : rsiDaily <= 40
            ? "weak"
            : "neutral";

  const macdHist = s.chart_tf.macd_hist;
  const macdMood =
    macdHist == null
      ? "neutral"
      : macdHist > 0
        ? bullishPos
          ? "fires-for"
          : "fires-against"
        : bearishPos
          ? "fires-for"
          : "fires-against";
  const macdLabel =
    macdHist == null ? "—" : macdHist > 0 ? "positive" : "negative";

  const smi = s.chart_tf.smi;
  const smiSig = s.chart_tf.smi_signal;
  const smiMood =
    smi == null
      ? "neutral"
      : smi >= 40
        ? bearishPos
          ? "fires-for"
          : "warn"
        : smi <= -40
          ? bullishPos
            ? "fires-for"
            : "warn"
          : "neutral";
  const smiLabel =
    smi == null
      ? "—"
      : smi >= 40
        ? "overbought"
        : smi <= -40
          ? "oversold"
          : smiSig != null && smi > smiSig
            ? "above signal"
            : smiSig != null && smi < smiSig
              ? "below signal"
              : "neutral";

  const vwap = s.chart_tf.vwap;
  const isIntradayTF = !["1d", "1w", "1mo"].includes(tf);
  const vwapDiffPct = vwap && vwap > 0 ? ((spot - vwap) / vwap) * 100 : null;
  const vwapMood =
    !isIntradayTF || vwapDiffPct == null
      ? "neutral"
      : Math.abs(vwapDiffPct) < 0.3
        ? "neutral"
        : vwapDiffPct > 0
          ? bullishPos
            ? "fires-for"
            : "fires-against"
          : bearishPos
            ? "fires-for"
            : "fires-against";

  const trendScore = s.daily.trend_score;
  const emaAligned = trendScore >= 5;
  const emaInverse = trendScore <= -5;
  const emaMood = emaAligned
    ? bullishPos
      ? "fires-for"
      : "fires-against"
    : emaInverse
      ? bearishPos
        ? "fires-for"
        : "fires-against"
      : "neutral";

  const er = s.forecast_5d?.expected_return_pct ?? null;
  const band = s.forecast_5d?.band_pct ?? null;
  const fcMood =
    er == null
      ? "neutral"
      : (er >= 0.5 && bullishPos) || (er <= -0.5 && bearishPos)
        ? "fires-for"
        : (er >= 0.5 && bearishPos) || (er <= -0.5 && bullishPos)
          ? "fires-against"
          : "neutral";

  const ivRv = s.iv_rv_ratio;
  const ivMood =
    ivRv == null
      ? "neutral"
      : ivRv >= 1.3 && isLong
        ? "fires-against"
        : ivRv >= 1.3 && !isLong
          ? "fires-for"
          : ivRv <= 0.8 && isLong
            ? "fires-for"
            : ivRv <= 0.8 && !isLong
              ? "fires-against"
              : "neutral";

  const dte = s.dte;
  const absD = s.abs_delta;
  const dteMood =
    dte <= 7
      ? isLong
        ? "fires-against"
        : "warn"
      : dte <= 21 && isLong
        ? "warn"
        : "neutral";
  const deltaMood =
    absD == null
      ? "neutral"
      : absD >= 0.65 && isLong
        ? "fires-for"
        : absD < 0.2 && isLong
          ? "fires-against"
          : absD >= 0.4 && !isLong
            ? "fires-against"
            : "neutral";

  const rows: {
    name: string;
    source: string;
    value: string;
    label: string;
    mood: "fires-for" | "fires-against" | "neutral" | "warn";
  }[] = [
    {
      name: "Chronos forecast",
      source: "5d model",
      value:
        er == null
          ? "—"
          : `${er >= 0 ? "+" : ""}${er.toFixed(2)}% (±${band?.toFixed(1)}%)`,
      label:
        er == null
          ? "unavailable"
          : er >= 3
            ? "strong bullish"
            : er >= 0.5
              ? "mild bullish"
              : er <= -3
                ? "strong bearish"
                : er <= -0.5
                  ? "mild bearish"
                  : "flat",
      mood: fcMood,
    },
    {
      name: "RSI",
      source: "daily",
      value: rsiDaily.toFixed(1),
      label: rsiLabel,
      mood: rsiMood,
    },
    {
      name: "MACD hist",
      source: tf,
      value:
        macdHist == null
          ? "—"
          : `${macdHist >= 0 ? "+" : ""}${macdHist.toFixed(3)}`,
      label: macdLabel,
      mood: macdMood,
    },
    {
      name: "SMI",
      source: tf,
      value:
        smi == null
          ? "—"
          : `${smi.toFixed(1)}${smiSig != null ? ` / ${smiSig.toFixed(1)}` : ""}`,
      label: smiLabel,
      mood: smiMood,
    },
    {
      name: "VWAP",
      source: tf,
      value: !isIntradayTF
        ? "n/a daily"
        : vwap && vwap > 0
          ? `${vwap.toFixed(2)} (${vwapDiffPct! >= 0 ? "+" : ""}${vwapDiffPct!.toFixed(2)}%)`
          : "—",
      label: !isIntradayTF
        ? "intraday only"
        : vwapDiffPct == null
          ? "—"
          : Math.abs(vwapDiffPct) < 0.3
            ? "near vwap"
            : vwapDiffPct > 0
              ? "above vwap"
              : "below vwap",
      mood: vwapMood,
    },
    {
      name: "EMA stack",
      source: "daily",
      value: `9>${s.daily.ema9?.toFixed(2) ?? "—"} 21>${s.daily.ema21?.toFixed(2) ?? "—"} 200>${s.daily.ema200?.toFixed(2) ?? "—"}`,
      label: emaAligned ? "aligned up" : emaInverse ? "inverted" : "mixed",
      mood: emaMood,
    },
    {
      name: "IV vs RV30",
      source: "vol context",
      value: `${(s.iv * 100).toFixed(1)}% / ${ivRv != null ? `${ivRv.toFixed(2)}×` : "—"}`,
      label:
        ivRv == null
          ? "—"
          : ivRv >= 1.3
            ? "rich"
            : ivRv <= 0.8
              ? "cheap"
              : "fair",
      mood: ivMood,
    },
    {
      name: "DTE",
      source: "expiry",
      value: `${dte}d`,
      label:
        dte <= 7
          ? "expiring"
          : dte <= 21
            ? "mgmt zone"
            : dte >= 45
              ? "early"
              : "mid",
      mood: dteMood,
    },
    {
      name: "|Δ|",
      source: "greeks",
      value: absD == null ? "—" : absD.toFixed(3),
      label:
        absD == null
          ? "—"
          : absD >= 0.65
            ? "deep ITM"
            : absD >= 0.4
              ? "near money"
              : absD >= 0.25
                ? "OTM"
                : "far OTM",
      mood: deltaMood,
    },
  ];

  return (
    <Card>
      <div className="flex items-center gap-2 px-3 h-8 border-b border-border/60">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          Inputs to verdict
        </span>
        <InfoIcon
          side="left"
          hint={
            <div className="flex flex-col gap-1">
              <div className="font-medium mb-0.5">Signal disposition</div>
              <div>
                <span className="text-up">●</span> aligned — pushes score toward
                keep/hold
              </div>
              <div>
                <span className="text-down">●</span> against — pushes score
                toward close
              </div>
              <div>
                <span className="text-warning">●</span> caution — flags a risk
                but doesn't change direction
              </div>
              <div>
                <span className="text-text-muted">○</span> neutral — no scoring
                effect right now
              </div>
            </div>
          }
        />
      </div>
      <CardContent className="p-0">
        <table className="w-full border-collapse text-[11px] tabular">
          <thead>
            <tr className="text-text-muted text-[9px] uppercase tracking-wider">
              <th className="text-left px-3 py-1 font-medium w-4">·</th>
              <th className="text-left px-3 py-1 font-medium">Signal</th>
              <th className="text-left px-3 py-1 font-medium">Source</th>
              <th className="text-right px-3 py-1 font-medium">Value</th>
              <th className="text-left px-3 py-1 font-medium">Read</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.name}
                className={cn(
                  "border-t border-border/40",
                  i % 2 === 1 && "bg-surface-2/30",
                )}
              >
                <td className="px-3 py-1.5">{dot(r.mood)}</td>
                <td className="px-3 py-1.5 text-text-primary">{r.name}</td>
                <td className="px-3 py-1.5 text-text-muted text-[10px]">
                  {r.source}
                </td>
                <td className="px-3 py-1.5 text-right text-text-primary">
                  {r.value}
                </td>
                <td
                  className={cn(
                    "px-3 py-1.5 text-[10px]",
                    r.mood === "fires-for" && "text-up",
                    r.mood === "fires-against" && "text-down",
                    r.mood === "warn" && "text-warning",
                    r.mood === "neutral" && "text-text-muted",
                  )}
                >
                  {r.label}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
