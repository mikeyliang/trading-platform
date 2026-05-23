"use client";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { OptionAnalyzeResult } from "@/lib/api";
import { HintLabel } from "@/components/ui/info-icon";

interface Props {
  result: OptionAnalyzeResult;
}

/**
 * Forecast transparency panel. Shows each ensemble member's prediction
 * side-by-side per horizon, plus the consensus and how much the members
 * agree. Lets the user judge whether the headline forecast number is
 * "all four models say up" or "one says +5%, another says -5% and we
 * averaged them" — very different levels of confidence.
 *
 * Per-model accuracy badges read from the persistent calibration store
 * (populated as forecasts get scored over time).
 */
export function ForecastBreakdownPanel({ result }: Props) {
  const fe = result.forecast_ensemble;
  if (!fe || Object.keys(fe.ensemble.horizons).length === 0) {
    return null;
  }

  const horizons = Object.keys(fe.ensemble.horizons)
    .map((h) => Number(h))
    .sort((a, b) => a - b);

  const memberOrder = ["chronos", "momentum", "mean_reversion", "martingale", "ensemble"];
  const memberNames: Record<string, string> = {
    chronos: "Chronos-2",
    momentum: "Momentum",
    mean_reversion: "Mean rev",
    martingale: "No-info",
    ensemble: "Ensemble",
  };
  // Hints become tooltips on the model name so each row stays one-line tall.
  const memberHints: Record<string, string> = {
    chronos: "Chronos-2 foundation model. 120M params, trained on heterogeneous time series. Operates in log-return space.",
    momentum: "Extrapolates the mean log return over the last 20 days. Captures 'trend persists'. Strongest in clean directional regimes.",
    mean_reversion: "Pulls price back toward the 50-day EMA with ~10-day half-life. Captures 'overextended price reverts'.",
    martingale: "No-information baseline: median = last close, bands widen with sqrt(time). The floor everyone else has to beat.",
    ensemble: "Equal-weight combination of all member models. Bands widened to widest member for honesty.",
  };

  const cal = fe.ensemble.calibration;

  return (
    <Card>
      <div className="flex items-center gap-2 px-3 h-7 border-b border-border/60">
        <HintLabel
          className="text-[10px] uppercase tracking-wider text-text-muted"
          hint="Each row is a model's forecast for the underlying over each horizon. 'ret' is the expected % change; '±band' is the p10/p90 80% confidence width. Lower agreement = members disagree more."
        >
          Forecast breakdown
        </HintLabel>
        {cal && (
          <span className="ml-auto text-[9px] tabular text-text-muted">
            <HintLabel
              hint={`Conformal-calibrated against ${cal.samples} past residuals. Band widths are scaled to match the empirical 80% quantile of recent forecast errors so coverage is honest, not theoretical.`}
            >
              calibrated · {cal.samples} samples
            </HintLabel>
          </span>
        )}
      </div>
      <CardContent className="p-0">
        <table className="w-full border-collapse text-[11px] tabular">
          <thead>
            <tr className="text-text-muted text-[9px] uppercase tracking-wider border-b border-border/40">
              <th className="text-left px-3 py-1.5 font-medium">Model</th>
              {horizons.map((h) => (
                <th key={h} className="text-right px-3 py-1.5 font-medium" colSpan={2}>
                  {h}d
                </th>
              ))}
            </tr>
            <tr className="text-text-muted text-[9px] border-b border-border/40">
              <th></th>
              {horizons.flatMap((h) => [
                <th key={`${h}-er`} className="text-right px-3 py-0.5 font-normal">ret</th>,
                <th key={`${h}-band`} className="text-right px-3 py-0.5 font-normal text-text-muted/70">±band</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {memberOrder.map((m) => {
              const isEnsemble = m === "ensemble";
              const src = isEnsemble ? fe.ensemble : fe.members[m];
              if (!src) return null;
              return (
                <tr
                  key={m}
                  className={cn(
                    "border-t border-border/40",
                    isEnsemble && "bg-accent/5 font-medium"
                  )}
                >
                  <td className="px-3 py-1.5">
                    <HintLabel
                      hint={memberHints[m] ?? ""}
                      className={cn(
                        "decoration-text-muted/30",
                        isEnsemble ? "text-accent" : "text-text-primary"
                      )}
                    >
                      {memberNames[m] ?? m}
                    </HintLabel>
                  </td>
                  {horizons.map((h) => {
                    const hf = src.horizons[String(h)];
                    if (!hf) {
                      return [
                        <td key={`${m}-${h}-er`} className="text-right px-3 py-1.5 text-text-muted">—</td>,
                        <td key={`${m}-${h}-band`} className="text-right px-3 py-1.5 text-text-muted">—</td>,
                      ];
                    }
                    const er = hf.expected_return_pct;
                    const band = hf.band_pct;
                    const erTone = er > 0.5 ? "text-up" : er < -0.5 ? "text-down" : "text-text-muted";
                    return [
                      <td key={`${m}-${h}-er`} className={cn("text-right px-3 py-1.5 font-medium", erTone)}>
                        {er >= 0 ? "+" : ""}{er.toFixed(2)}%
                      </td>,
                      <td key={`${m}-${h}-band`} className="text-right px-3 py-1.5 text-text-muted text-[10px]">
                        ±{band.toFixed(1)}%
                      </td>,
                    ];
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border/60 text-text-muted text-[9px]">
              <td className="px-3 py-1.5 uppercase tracking-wider">
                <HintLabel
                  className="text-text-muted uppercase tracking-wider"
                  hint="Per-horizon ensemble agreement (0..100%) — how closely members agree on direction/magnitude. Below 50% means soft signal. If calibration data exists, 'cov' shows what fraction of past native bands actually contained the realized outcome (ideally ≈80%)."
                >
                  Agreement
                </HintLabel>
              </td>
              {horizons.map((h) => {
                const agree = fe.agreement[String(h)] ?? 1;
                const agreeTone = agree >= 0.7 ? "text-up" : agree >= 0.4 ? "text-warning" : "text-down";
                const cov = cal?.coverage_observed_per_h?.[String(h)];
                return (
                  <td key={`agree-${h}`} colSpan={2} className="px-3 py-1.5 text-right">
                    <span className={cn("font-medium tabular", agreeTone)}>
                      {(agree * 100).toFixed(0)}%
                    </span>
                    {cov != null && (
                      <HintLabel
                        className="text-text-muted/70 ml-2 text-[9px] tabular"
                        hint="Observed coverage: fraction of past native p10/p90 bands that actually contained the realized return. Target ≈ 80%."
                      >
                        cov {(cov * 100).toFixed(0)}%
                      </HintLabel>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </CardContent>
    </Card>
  );
}
