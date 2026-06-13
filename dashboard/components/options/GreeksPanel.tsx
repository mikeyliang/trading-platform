"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { CHART } from "@/lib/chartTheme";
import { bsGreeks, bsPnl, type PnlInputs } from "@/lib/bs";

interface Props {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  isLong: boolean;
  quantity: number;
  /** Optional scenario context — when supplied, a "What-if" panel opens
   *  below the Greeks grid with sliders for spot Δ%, IV Δ%, and days
   *  forward. All three drive analytic BS Greeks + position P&L. */
  scenario?: {
    spot: number;
    strike: number;
    iv: number;
    dteYears: number;
    right: "C" | "P";
    entryPrice: number;
  };
}

/**
 * Visual Greeks display. Each Greek has a magnitude meter and a short
 * tooltip-style hint about what it implies for the position.
 *
 * **Convention:** raw values shown are *per contract* (per-share Greeks
 * scaled by the 100-share equity-option multiplier), matching what TOS,
 * tastytrade, IBKR TWS, etc. display by default. So a long put with
 * delta −0.80 per contract means "this contract loses $0.80 when the
 * underlying gains $1." The smaller per-share number IB returns is
 * almost never what a trader reasons in.
 *
 * The sub-line beneath each value is the *per-position* exposure
 * (per-contract × quantity), e.g. "−16 shares Δ" for 20 of those puts.
 *
 * When `scenario` is supplied the panel reveals a "What-if" section: 3
 * sliders (Spot Δ%, IV Δ%, Days fwd) drive a recomputation of Greeks
 * via the analytic BS formulas, and each Greek card shows the delta
 * from the baseline. Useful for "what does theta look like in 5 days if
 * IV drops 10%?" without leaving the position card.
 */
export function GreeksPanel({
  delta, gamma, theta, vega, isLong, quantity, scenario,
}: Props) {
  const qty = Math.abs(quantity) || 1;
  const sign = isLong ? 1 : -1;
  const MULT = 100; // equity-option contract multiplier

  // ── scenario sliders (only render when scenario is provided) ──────────
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [spotPct, setSpotPct] = useState(0);
  const [ivPct, setIvPct] = useState(0);
  const [daysFwd, setDaysFwd] = useState(0);
  // Reset sliders whenever the underlying contract changes.
  useEffect(() => {
    setSpotPct(0); setIvPct(0); setDaysFwd(0);
  }, [scenario?.strike, scenario?.right, scenario?.dteYears, scenario?.iv]);

  const dteDays = scenario ? Math.max(1, Math.round(scenario.dteYears * 365.25)) : 0;
  const isScenarioActive = scenarioOpen && (spotPct !== 0 || ivPct !== 0 || daysFwd !== 0);

  // What-if Greeks + P/L. We compute analytic Greeks at the scenario
  // point so users see how Δ/Γ/Θ/ν all shift together — this is the
  // value of the slider over a static table that just changes price.
  const whatIf = useMemo(() => {
    if (!scenario) return null;
    const s = scenario.spot * (1 + spotPct / 100);
    const tRem = Math.max(0, scenario.dteYears - daysFwd / 365.25);
    const sigma = Math.max(0, scenario.iv * (1 + ivPct / 100));
    const g = bsGreeks(s, scenario.strike, tRem, sigma, 0.05, 0, scenario.right === "C");
    const inputs: PnlInputs = {
      spot: scenario.spot, strike: scenario.strike, dteYears: scenario.dteYears,
      iv: scenario.iv, isCall: scenario.right === "C", isLong,
      entryPrice: scenario.entryPrice, quantity: qty,
    };
    const pnl = bsPnl(s, tRem, sigma, inputs);
    return { g, pnl, s, tRem, sigma };
  }, [scenario, spotPct, ivPct, daysFwd, isLong, qty]);

  // Per-contract values for the headline (raw IB Greeks are per-share).
  // When scenario is ACTIVE, swap in the what-if values so the cards
  // reflect the slider state — the headline is whatever the user is
  // exploring, not the baseline.
  const baseDelta = isScenarioActive && whatIf ? whatIf.g.delta : delta;
  const baseGamma = isScenarioActive && whatIf ? whatIf.g.gamma : gamma;
  const baseTheta = isScenarioActive && whatIf ? whatIf.g.theta : theta;
  const baseVega  = isScenarioActive && whatIf ? whatIf.g.vega  : vega;

  const deltaC = baseDelta != null ? baseDelta * MULT : null;
  const gammaC = baseGamma != null ? baseGamma * MULT : null;
  const thetaC = baseTheta != null ? baseTheta * MULT : null;
  const vegaC  = baseVega  != null ? baseVega  * MULT : null;
  const posDelta = deltaC != null ? deltaC * sign * qty : null;
  const posGamma = gammaC != null ? gammaC * sign * qty : null;
  const posTheta = thetaC != null ? thetaC * sign * qty : null;
  const posVega  = vegaC  != null ? vegaC  * sign * qty : null;

  // Baseline (always shown beside the headline when scenario is active)
  // so traders see the magnitude of the shift, not just the new value.
  const baselineCmp = isScenarioActive && whatIf
    ? {
        delta: delta != null ? delta * MULT : null,
        gamma: gamma != null ? gamma * MULT : null,
        theta: theta != null ? theta * MULT : null,
        vega:  vega  != null ? vega  * MULT : null,
      }
    : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <GreekCell
          symbol="Δ" name="Delta"
          raw={deltaC} positional={posDelta}
          baseline={baselineCmp?.delta ?? null}
          magnitude={baseDelta != null ? Math.abs(baseDelta) : 0} magnitudeMax={1}
          accent="sky"
          rawFmt={(v) => v.toFixed(2)}
          posFmt={(v) => (v >= 0 ? `+${v.toFixed(0)}` : v.toFixed(0)) + " shares Δ"}
          hint={getDeltaHint(baseDelta, isLong)}
        />
        <GreekCell
          symbol="Γ" name="Gamma"
          raw={gammaC} positional={posGamma}
          baseline={baselineCmp?.gamma ?? null}
          magnitude={baseGamma != null ? Math.min(Math.abs(baseGamma) / 0.1, 1) : 0} magnitudeMax={1}
          accent="violet"
          rawFmt={(v) => v.toFixed(3)}
          posFmt={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)} Δ/$1`}
          hint={getGammaHint(baseGamma, isLong)}
        />
        <GreekCell
          symbol="Θ" name="Theta"
          raw={thetaC} positional={posTheta}
          baseline={baselineCmp?.theta ?? null}
          magnitude={baseTheta != null ? Math.min(Math.abs(baseTheta) / 0.5, 1) : 0} magnitudeMax={1}
          accent={posTheta != null && posTheta >= 0 ? "green" : "red"}
          rawFmt={(v) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`}
          posFmt={(v) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}/day`}
          hint={getThetaHint(baseTheta, isLong)}
        />
        <GreekCell
          symbol="ν" name="Vega"
          raw={vegaC} positional={posVega}
          baseline={baselineCmp?.vega ?? null}
          magnitude={baseVega != null ? Math.min(Math.abs(baseVega) / 0.5, 1) : 0} magnitudeMax={1}
          accent="amber"
          rawFmt={(v) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`}
          posFmt={(v) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}/1%IV`}
          hint={getVegaHint(baseVega, isLong)}
        />
      </div>

      {scenario && (
        <ScenarioControls
          open={scenarioOpen}
          onToggle={() => setScenarioOpen((v) => !v)}
          spotPct={spotPct} setSpotPct={setSpotPct}
          ivPct={ivPct} setIvPct={setIvPct}
          daysFwd={daysFwd} setDaysFwd={setDaysFwd}
          dteDays={dteDays}
          scenario={scenario}
          whatIf={whatIf}
          active={isScenarioActive}
          onReset={() => { setSpotPct(0); setIvPct(0); setDaysFwd(0); }}
        />
      )}
    </div>
  );
}

interface CellProps {
  symbol: string;
  name: string;
  raw: number | null;
  positional: number | null;
  /** Baseline per-contract Greek for comparison readout. Null when
   *  scenario sliders are at default (no comparison needed). */
  baseline: number | null;
  magnitude: number;
  magnitudeMax: number;
  accent: "sky" | "violet" | "green" | "red" | "amber";
  rawFmt: (v: number) => string;
  posFmt: (v: number) => string;
  hint: string;
}

function GreekCell({
  symbol, name, raw, positional, baseline, magnitude, accent,
  rawFmt, posFmt, hint,
}: CellProps) {
  const pct = Math.max(0, Math.min(1, magnitude)) * 100;
  const accentClasses: Record<typeof accent, { bar: string; text: string; bg: string }> = {
    sky: { bar: "bg-sky-400", text: "text-sky-400", bg: "bg-sky-400/10" },
    violet: { bar: "bg-violet-400", text: "text-violet-400", bg: "bg-violet-400/10" },
    green: { bar: "bg-up", text: "text-up", bg: "bg-up/10" },
    red: { bar: "bg-down", text: "text-down", bg: "bg-down/10" },
    amber: { bar: "bg-amber-400", text: "text-amber-400", bg: "bg-amber-400/10" },
  };
  const c = accentClasses[accent];
  // ΔΔ — how much the Greek moved under the current scenario sliders.
  // Shown as a small chip beside the headline so the magnitude of the
  // what-if change is obvious without mental math.
  const shift = baseline != null && raw != null ? raw - baseline : null;
  const shiftIsMeaningful = shift != null && Math.abs(shift) > Math.max(1e-4, Math.abs(baseline ?? 0) * 0.005);

  return (
    <div className="rounded-md border border-border bg-surface p-3 flex flex-col gap-2 relative overflow-hidden">
      <div className={cn("absolute inset-0 opacity-50", c.bg)} style={{ maskImage: "linear-gradient(to bottom, black 0%, transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom, black 0%, transparent 100%)" }} />
      <div className="relative">
        <div className="flex items-baseline gap-2">
          <span className={cn("text-2xl font-semibold leading-none", c.text)}>{symbol}</span>
          <span className="text-[10px] uppercase tracking-wider text-text-muted">{name}</span>
          {shiftIsMeaningful && (
            <span
              className={cn(
                "ml-auto text-[9px] tabular px-1 py-0.5 rounded leading-none",
                shift! >= 0 ? "text-up bg-up/10" : "text-down bg-down/10",
              )}
              title={`From baseline ${rawFmt(baseline!)}`}
            >
              {shift! >= 0 ? "+" : ""}{rawFmt(shift!)}
            </span>
          )}
        </div>
        <div className="mt-2 text-base font-medium tabular-nums text-text-primary">
          {raw != null ? rawFmt(raw) : "—"}
        </div>
        <div className="text-[10px] tabular-nums text-text-secondary">
          {positional != null ? posFmt(positional) : "—"}
        </div>
        <div className="h-1 rounded-full bg-surface-2 mt-2 overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-500", c.bar)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[10px] text-text-muted leading-snug mt-1.5">{hint}</p>
      </div>
    </div>
  );
}

// ── ScenarioControls ──────────────────────────────────────────────────
//   Three sliders + a position-P/L readout so the trader sees both
//   "what shifted Greeks-wise" (chips in each cell above) AND "what's
//   the new dollar P/L" (the bottom strip). Defaults at the right
//   end mean "nothing happens" so the panel is safe to open.

function ScenarioControls({
  open, onToggle,
  spotPct, setSpotPct, ivPct, setIvPct, daysFwd, setDaysFwd,
  dteDays, scenario, whatIf, active, onReset,
}: {
  open: boolean;
  onToggle: () => void;
  spotPct: number; setSpotPct: (v: number) => void;
  ivPct: number; setIvPct: (v: number) => void;
  daysFwd: number; setDaysFwd: (v: number) => void;
  dteDays: number;
  scenario: NonNullable<Props["scenario"]>;
  whatIf: { pnl: number; s: number; sigma: number; tRem: number } | null;
  active: boolean;
  onReset: () => void;
}) {
  const newSpot = scenario.spot * (1 + spotPct / 100);
  const newIv = scenario.iv * (1 + ivPct / 100);
  const tRemDays = Math.max(0, dteDays - daysFwd);

  return (
    <div className="rounded-md border border-border bg-surface">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 h-7 border-b border-border/60 text-left hover:bg-surface-2/40 transition-colors"
      >
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          What-if scenario
        </span>
        <span className="text-[10px] tabular text-text-muted">
          sliders drive Greeks via BS · default = baseline
        </span>
        {active && whatIf && (
          <span className={cn(
            "ml-auto text-[10px] tabular font-medium",
            whatIf.pnl >= 0 ? "text-up" : "text-down",
          )}>
            P/L {whatIf.pnl >= 0 ? "+" : ""}${whatIf.pnl.toFixed(0)}
          </span>
        )}
        <span className={cn("text-[10px] text-text-muted transition-transform", active && "ml-2", open && "rotate-180")}>
          ▾
        </span>
      </button>

      {open && (
        <div className="p-3 grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-3">
          <ScenarioSlider
            label="Spot"
            accent={CHART.ref.strike}
            valueText={`$${newSpot.toFixed(2)}`}
            subText={`${spotPct >= 0 ? "+" : ""}${spotPct.toFixed(1)}% from $${scenario.spot.toFixed(2)}`}
            min={-30} max={30} step={0.5}
            value={spotPct} onChange={setSpotPct}
            isDefault={spotPct === 0}
            onReset={() => setSpotPct(0)}
            presets={[
              { label: "−10%", value: -10 }, { label: "−5%", value: -5 },
              { label: "now", value: 0 },
              { label: "+5%", value: 5 }, { label: "+10%", value: 10 },
            ]}
            step1={0.5}
          />
          <ScenarioSlider
            label="IV"
            accent={CHART.forecast.cone}
            valueText={`${(newIv * 100).toFixed(1)}%`}
            subText={`${ivPct >= 0 ? "+" : ""}${ivPct.toFixed(0)}% from ${(scenario.iv * 100).toFixed(1)}%`}
            min={-60} max={120} step={1}
            value={ivPct} onChange={setIvPct}
            isDefault={ivPct === 0}
            onReset={() => setIvPct(0)}
            presets={[
              { label: "−30%", value: -30 }, { label: "−10%", value: -10 },
              { label: "now", value: 0 },
              { label: "+10%", value: 10 }, { label: "+30%", value: 30 },
            ]}
            step1={1}
          />
          <ScenarioSlider
            label="Days fwd"
            accent={CHART.pnl.expiry}
            valueText={daysFwd === 0 ? "today" : daysFwd >= dteDays ? "expiry" : `+${daysFwd}d`}
            subText={`${tRemDays}d to expiry · IV ${(newIv * 100).toFixed(0)}%`}
            min={0} max={dteDays} step={1}
            value={daysFwd} onChange={setDaysFwd}
            isDefault={daysFwd === 0}
            onReset={() => setDaysFwd(0)}
            presets={[
              { label: "today", value: 0 },
              { label: "+1d", value: 1 },
              { label: "+7d", value: Math.min(7, dteDays) },
              { label: "½", value: Math.round(dteDays / 2) },
              { label: "exp", value: dteDays },
            ]}
            step1={1}
          />

          {active && (
            <div className="md:col-span-3 mt-1 pt-2 border-t border-border/40 flex items-baseline justify-between gap-3 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">
                Reading the scenario
              </span>
              <span className="text-[11px] text-text-secondary flex-1 min-w-0">
                Greek values above swap to what they'd be at <b>${newSpot.toFixed(2)}</b>,
                IV <b>{(newIv * 100).toFixed(1)}%</b>, in <b>{daysFwd}d</b>.
                ΔΔ chip = shift from baseline.
              </span>
              <button
                type="button" onClick={onReset}
                className="text-[10px] uppercase tracking-wider text-text-muted hover:text-text-secondary"
              >
                reset all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScenarioSlider({
  label, accent, valueText, subText, min, max, step, value, onChange,
  isDefault, onReset, presets, step1: _step,
}: {
  label: string;
  accent: string;
  valueText: string;
  subText: string;
  min: number; max: number; step: number;
  value: number;
  onChange: (v: number) => void;
  isDefault: boolean;
  onReset: () => void;
  presets: { label: string; value: number }[];
  step1: number;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const isActivePreset = (pv: number) => Math.abs(value - pv) < step / 2;
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
        <span className="text-[13px] tabular font-semibold leading-none" style={{ color: accent }}>
          {valueText}
        </span>
        {!isDefault && (
          <button
            type="button" onClick={onReset}
            className="ml-auto text-[10px] uppercase tracking-wider text-text-muted hover:text-text-secondary"
            title="Reset"
          >
            reset
          </button>
        )}
      </div>
      <span className="text-[10px] tabular text-text-muted leading-none">{subText}</span>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider-range w-full mt-1"
        style={{
          background: `linear-gradient(to right, ${accent} 0%, ${accent} ${pct}%, ${CHART.surface} ${pct}%, ${CHART.surface} 100%)`,
        }}
      />
      <div className="flex items-center gap-1 mt-0.5">
        {presets.map((p) => {
          const active = isActivePreset(p.value);
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange(p.value)}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] tabular border transition-colors",
                active
                  ? "border-transparent text-bg font-semibold"
                  : "border-border text-text-muted hover:text-text-secondary hover:border-text-muted/50",
              )}
              style={active ? { backgroundColor: accent } : undefined}
            >
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function getDeltaHint(delta: number | null, isLong: boolean): string {
  if (delta == null) return "—";
  const abs = Math.abs(delta);
  if (abs >= 0.7) return `Deep ITM · ~${(abs * 100).toFixed(0)}% prob. expire ITM`;
  if (abs >= 0.45) return `Near-ATM · ~${(abs * 100).toFixed(0)}% prob. expire ITM`;
  if (abs >= 0.25) return `OTM · ~${(abs * 100).toFixed(0)}% prob. expire ITM`;
  return `Far OTM · ~${(abs * 100).toFixed(0)}% prob. expire ITM`;
}

function getGammaHint(gamma: number | null, isLong: boolean): string {
  if (gamma == null) return "—";
  const abs = Math.abs(gamma);
  if (abs > 0.05) return isLong ? "High gamma — Δ moves fast with spot" : "High gamma — short side, watch volatility";
  if (abs > 0.02) return "Moderate gamma — typical near-ATM behavior";
  return "Low gamma — Δ stable across price moves";
}

function getThetaHint(theta: number | null, isLong: boolean): string {
  if (theta == null) return "—";
  if (isLong) return theta < -0.05 ? "Heavy decay — time is against you" : "Mild decay — manageable";
  return theta > 0.05 ? "Strong decay collection — time is with you" : "Mild decay benefit";
}

function getVegaHint(vega: number | null, isLong: boolean): string {
  if (vega == null) return "—";
  if (isLong) return vega > 0.2 ? "IV-sensitive — rising IV helps you" : "Low IV exposure";
  return vega > 0.2 ? "Rising IV hurts a short — watch earnings/events" : "Low IV exposure";
}
