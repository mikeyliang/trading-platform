"use client";

import { cn } from "@/lib/utils";

interface Props {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  isLong: boolean;
  quantity: number;
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
 */
export function GreeksPanel({ delta, gamma, theta, vega, isLong, quantity }: Props) {
  const qty = Math.abs(quantity) || 1;
  const sign = isLong ? 1 : -1;
  const MULT = 100; // equity-option contract multiplier
  // Per-contract values shown as the headline (raw IB Greeks are per-share).
  const deltaC = delta != null ? delta * MULT : null;
  const gammaC = gamma != null ? gamma * MULT : null;
  const thetaC = theta != null ? theta * MULT : null;
  const vegaC  = vega  != null ? vega  * MULT : null;
  // Position-aware exposure (per-contract × signed qty).
  const posDelta = deltaC != null ? deltaC * sign * qty : null;
  const posGamma = gammaC != null ? gammaC * sign * qty : null;
  const posTheta = thetaC != null ? thetaC * sign * qty : null;
  const posVega  = vegaC  != null ? vegaC  * sign * qty : null;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
      <GreekCell
        symbol="Δ"
        name="Delta"
        raw={deltaC}
        positional={posDelta}
        magnitude={delta != null ? Math.abs(delta) : 0}
        magnitudeMax={1}
        accent="sky"
        rawFmt={(v) => v.toFixed(2)}
        posFmt={(v) => (v >= 0 ? `+${v.toFixed(0)}` : v.toFixed(0)) + " shares Δ"}
        hint={getDeltaHint(delta, isLong)}
      />
      <GreekCell
        symbol="Γ"
        name="Gamma"
        raw={gammaC}
        positional={posGamma}
        magnitude={gamma != null ? Math.min(Math.abs(gamma) / 0.1, 1) : 0}
        magnitudeMax={1}
        accent="violet"
        rawFmt={(v) => v.toFixed(3)}
        posFmt={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)} Δ/$1`}
        hint={getGammaHint(gamma, isLong)}
      />
      <GreekCell
        symbol="Θ"
        name="Theta"
        raw={thetaC}
        positional={posTheta}
        magnitude={theta != null ? Math.min(Math.abs(theta) / 0.5, 1) : 0}
        magnitudeMax={1}
        accent={posTheta != null && posTheta >= 0 ? "green" : "red"}
        rawFmt={(v) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`}
        posFmt={(v) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}/day`}
        hint={getThetaHint(theta, isLong)}
      />
      <GreekCell
        symbol="ν"
        name="Vega"
        raw={vegaC}
        positional={posVega}
        magnitude={vega != null ? Math.min(Math.abs(vega) / 0.5, 1) : 0}
        magnitudeMax={1}
        accent="amber"
        rawFmt={(v) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`}
        posFmt={(v) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}/1%IV`}
        hint={getVegaHint(vega, isLong)}
      />
    </div>
  );
}

interface CellProps {
  symbol: string;
  name: string;
  raw: number | null;
  positional: number | null;
  magnitude: number;
  magnitudeMax: number;
  accent: "sky" | "violet" | "green" | "red" | "amber";
  rawFmt: (v: number) => string;
  posFmt: (v: number) => string;
  hint: string;
}

function GreekCell({
  symbol,
  name,
  raw,
  positional,
  magnitude,
  accent,
  rawFmt,
  posFmt,
  hint,
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

  return (
    <div className="rounded-md border border-border bg-surface p-3 flex flex-col gap-2 relative overflow-hidden">
      <div className={cn("absolute inset-0 opacity-50", c.bg)} style={{ maskImage: "linear-gradient(to bottom, black 0%, transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom, black 0%, transparent 100%)" }} />
      <div className="relative">
        <div className="flex items-baseline gap-2">
          <span className={cn("text-2xl font-semibold leading-none", c.text)}>{symbol}</span>
          <span className="text-[10px] uppercase tracking-wider text-text-muted">{name}</span>
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
