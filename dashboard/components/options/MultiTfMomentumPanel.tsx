"use client";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { HintLabel } from "@/components/ui/info-icon";
import type {
  OptionAnalyzeResult,
  OptionAnalyzerTimeframe,
  MultiTfSnapshot,
} from "@/lib/api";

interface Props {
  result: OptionAnalyzeResult;
}

/**
 * Multi-timeframe momentum matrix. Each column is a chart timeframe, each
 * row is an indicator. Cell color encodes "is this signal aligned with
 * the user's position direction?" — green = aligned, red = against,
 * muted = neutral. The bottom row is a per-TF consensus trend label.
 *
 * The TFs shown match the option's expiration relevance — a 0DTE option
 * gets emphasis on intraday TFs; a 240DTE option emphasizes 4h/1d. The
 * recommended primary TF is highlighted in the column header.
 */
export function MultiTfMomentumPanel({ result }: Props) {
  const mt = result.multi_tf;
  if (!mt) return null;

  const tfs = Object.keys(mt) as OptionAnalyzerTimeframe[];
  // Order shortest-first for natural left→right reading.
  const order: OptionAnalyzerTimeframe[] = ["5m", "15m", "1h", "4h", "1d"];
  const sortedTfs = order.filter((t) => tfs.includes(t));
  const recommended = result.recommended_chart_tf;

  const isLong = result.is_long;
  const right = result.right;
  const bullishPos = (isLong && right === "C") || (!isLong && right === "P");
  const bearishPos = (isLong && right === "P") || (!isLong && right === "C");

  // Per-cell coloring: encode whether the signal value pushes the position's verdict
  // toward keep/hold (green) or close (red) — same logic family as SignalInputsPanel
  // so the colors mean the same thing across the page.
  const toneFor = (
    name: "rsi" | "macd" | "smi" | "vwap" | "ema" | "trend",
    s: MultiTfSnapshot,
  ): "fires-for" | "fires-against" | "warn" | "neutral" => {
    if (!s.available) return "neutral";
    if (name === "rsi") {
      const v = s.rsi ?? 50;
      if (v >= 70) return bearishPos ? "fires-for" : "warn";
      if (v <= 30) return bullishPos ? "fires-for" : "warn";
      if (v >= 55)
        return bullishPos
          ? "fires-for"
          : bearishPos
            ? "fires-against"
            : "neutral";
      if (v <= 45)
        return bearishPos
          ? "fires-for"
          : bullishPos
            ? "fires-against"
            : "neutral";
      return "neutral";
    }
    if (name === "macd") {
      const v = s.macd_hist ?? 0;
      if (v > 0) return bullishPos ? "fires-for" : "fires-against";
      if (v < 0) return bearishPos ? "fires-for" : "fires-against";
      return "neutral";
    }
    if (name === "smi") {
      const v = s.smi ?? 0;
      if (v >= 40) return bearishPos ? "fires-for" : "warn";
      if (v <= -40) return bullishPos ? "fires-for" : "warn";
      if (v > 0)
        return bullishPos
          ? "fires-for"
          : bearishPos
            ? "fires-against"
            : "neutral";
      if (v < 0)
        return bearishPos
          ? "fires-for"
          : bullishPos
            ? "fires-against"
            : "neutral";
      return "neutral";
    }
    if (name === "vwap") {
      const d = s.vwap_diff_pct;
      if (d == null) return "neutral";
      if (Math.abs(d) < 0.3) return "neutral";
      if (d > 0) return bullishPos ? "fires-for" : "fires-against";
      return bearishPos ? "fires-for" : "fires-against";
    }
    if (name === "ema") {
      if (s.ema9 == null || s.ema21 == null) return "neutral";
      if (s.ema9 > s.ema21) return bullishPos ? "fires-for" : "fires-against";
      if (s.ema9 < s.ema21) return bearishPos ? "fires-for" : "fires-against";
      return "neutral";
    }
    if (name === "trend") {
      if (s.trend === "bull") return bullishPos ? "fires-for" : "fires-against";
      if (s.trend === "bear") return bearishPos ? "fires-for" : "fires-against";
      return "neutral";
    }
    return "neutral";
  };

  const toneClass = (
    tone: "fires-for" | "fires-against" | "warn" | "neutral",
  ) =>
    tone === "fires-for"
      ? "text-up bg-up/8"
      : tone === "fires-against"
        ? "text-down bg-down/8"
        : tone === "warn"
          ? "text-warning bg-warning/6"
          : "text-text-secondary";

  const cellVal = (
    name: "rsi" | "macd" | "smi" | "vwap" | "ema",
    s: MultiTfSnapshot,
  ): string => {
    if (!s.available) return "—";
    if (name === "rsi") return s.rsi != null ? s.rsi.toFixed(0) : "—";
    if (name === "macd") {
      const v = s.macd_hist;
      if (v == null) return "—";
      return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
    }
    if (name === "smi") return s.smi != null ? s.smi.toFixed(0) : "—";
    if (name === "vwap") {
      const d = s.vwap_diff_pct;
      if (d == null) return "n/a";
      return `${d >= 0 ? "+" : ""}${d.toFixed(2)}%`;
    }
    if (name === "ema") {
      if (s.ema9 == null || s.ema21 == null) return "—";
      return s.ema9 > s.ema21 ? "9>21" : s.ema9 < s.ema21 ? "9<21" : "9=21";
    }
    return "—";
  };

  const rows: {
    key: "rsi" | "macd" | "smi" | "vwap" | "ema";
    label: string;
    hint: string;
  }[] = [
    {
      key: "rsi",
      label: "RSI",
      hint: "Wilder's RSI(14). >70 overbought, <30 oversold.",
    },
    {
      key: "macd",
      label: "MACD-h",
      hint: "MACD histogram: positive = bullish momentum, negative = bearish.",
    },
    {
      key: "smi",
      label: "SMI",
      hint: "Stochastic Momentum Index. >40 overbought, <-40 oversold.",
    },
    {
      key: "vwap",
      label: "VWAP%",
      hint: "% of spot from VWAP. Intraday only (daily-reset).",
    },
    {
      key: "ema",
      label: "EMA",
      hint: "EMA9 vs EMA21 cross. 9>21 = short-term uptrend.",
    },
  ];

  // Bottom-row consensus reading: count bull/bear/neutral across TFs.
  const consensus = (() => {
    let bull = 0,
      bear = 0,
      total = 0;
    for (const tf of sortedTfs) {
      const t = mt[tf]?.trend;
      if (!t) continue;
      total++;
      if (t === "bull") bull++;
      else if (t === "bear") bear++;
    }
    if (total === 0) return { label: "—", tone: "neutral" as const };
    if (bull >= total * 0.6)
      return { label: `${bull}/${total} bull`, tone: "fires-for" as const };
    if (bear >= total * 0.6)
      return { label: `${bear}/${total} bear`, tone: "fires-against" as const };
    return {
      label: `${bull}↑ ${bear}↓ ${total - bull - bear}→`,
      tone: "warn" as const,
    };
  })();

  return (
    <Card>
      <div className="flex items-center gap-2 px-3 h-7 border-b border-border/60">
        <HintLabel
          className="text-[10px] uppercase tracking-wider text-text-muted"
          hint={
            <div className="flex flex-col gap-1">
              <div className="font-medium">Cross-timeframe momentum</div>
              <div>
                Each column is a chart timeframe. Cells color-coded against this
                position&apos;s direction:{" "}
                <span className="text-up">green</span> = aligned,{" "}
                <span className="text-down">red</span> = against,{" "}
                <span className="text-warning">yellow</span> = caution.
              </div>
              <div>
                Recommended primary TF is highlighted in the header — picked
                from your option&apos;s DTE so a 0DTE shows 5m emphasis, a
                240DTE shows 1d.
              </div>
            </div>
          }
        >
          Multi-TF momentum
        </HintLabel>
        <span className="ml-auto text-[10px] tabular text-text-muted">
          DTE {result.dte}d · rec.{" "}
          <span className="text-accent font-medium">{recommended}</span>
        </span>
      </div>
      <CardContent className="p-0">
        <table className="w-full border-collapse text-[11px] tabular">
          <thead>
            <tr className="text-text-muted text-[9px] uppercase tracking-wider border-b border-border/40">
              <th className="text-left px-3 py-1.5 font-medium w-[78px]"></th>
              {sortedTfs.map((tf) => (
                <th
                  key={tf}
                  className={cn(
                    "text-right px-3 py-1.5 font-medium",
                    tf === recommended && "text-accent",
                  )}
                  title={
                    tf === recommended
                      ? "Recommended primary timeframe for this DTE"
                      : undefined
                  }
                >
                  {tf}
                  {tf === recommended && (
                    <span className="ml-1 inline-block w-1 h-1 rounded-full bg-accent align-middle" />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr
                key={row.key}
                className={cn(
                  "border-t border-border/40",
                  idx % 2 === 1 && "bg-surface-2/20",
                )}
              >
                <td className="px-3 py-1.5 text-text-secondary">
                  <HintLabel hint={row.hint} className="text-text-secondary">
                    {row.label}
                  </HintLabel>
                </td>
                {sortedTfs.map((tf) => {
                  const s = mt[tf];
                  const tone = toneFor(row.key, s);
                  return (
                    <td
                      key={`${row.key}-${tf}`}
                      className={cn("text-right px-3 py-1.5", toneClass(tone))}
                    >
                      {cellVal(row.key, s)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border/60 bg-surface-2/20">
              <td className="px-3 py-1.5 text-text-muted text-[9px] uppercase tracking-wider">
                Trend
              </td>
              {sortedTfs.map((tf) => {
                const s = mt[tf];
                const tone = toneFor("trend", s);
                const tr = s?.trend ?? "—";
                return (
                  <td
                    key={`trend-${tf}`}
                    className={cn(
                      "text-right px-3 py-1.5 font-medium uppercase text-[10px] tracking-wider",
                      toneClass(tone),
                    )}
                  >
                    {tr}
                  </td>
                );
              })}
            </tr>
            <tr className="border-t border-border/40">
              <td className="px-3 py-1.5 text-text-muted text-[9px] uppercase tracking-wider">
                Consensus
              </td>
              <td
                colSpan={sortedTfs.length}
                className={cn(
                  "px-3 py-1.5 text-right font-medium text-[10px]",
                  toneClass(consensus.tone),
                )}
              >
                {consensus.label}
              </td>
            </tr>
          </tfoot>
        </table>
      </CardContent>
    </Card>
  );
}
