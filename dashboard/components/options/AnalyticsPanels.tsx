"use client";

import { cn } from "@/lib/utils";
import type { OptionAnalyzeResult } from "@/lib/api";

/** Four dense panels that complement the chart and Greeks: probability,
 *  expected move, IV vs realized vol context, and contract liquidity.
 *  Each panel is information-first — no decoration, all numbers tabular. */

export function ProbabilityPanel({ result }: { result: OptionAnalyzeResult }) {
  const { pop, prob_itm, prob_touch } = result.probability;
  const em = result.sigma_ranges.expected_move_abs;
  const emPct = result.sigma_ranges.expected_move_pct;
  return (
    <Panel title="Probability · risk-neutral">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2 text-[11px] tabular">
        <Stat
          label="POP at expiry"
          value={pct(pop)}
          tone={tonePOP(pop, result.is_long)}
        />
        <Stat label="P(ITM)" value={pct(prob_itm)} />
        <Stat
          label="P(touch BE)"
          value={pct(prob_touch)}
          hint="rough Brownian estimate"
        />
        <Stat
          label="Expected 1σ move"
          value={
            em != null && emPct != null
              ? `±$${em.toFixed(2)} (${emPct.toFixed(1)}%)`
              : "—"
          }
          hint="by expiry, per IV"
        />
      </div>
    </Panel>
  );
}

export function VolContextPanel({ result }: { result: OptionAnalyzeResult }) {
  const iv = result.option.iv;
  const rv30 = result.vol_context.realized_vol_30d;
  const rv90 = result.vol_context.realized_vol_90d;
  const ratio = result.vol_context.iv_to_rv_ratio;
  const verdict =
    ratio == null
      ? "—"
      : ratio >= 1.4
        ? "rich"
        : ratio >= 1.1
          ? "elevated"
          : ratio >= 0.9
            ? "fair"
            : "cheap";
  const verdictTone =
    verdict === "rich"
      ? "down"
      : verdict === "elevated"
        ? "warning"
        : verdict === "cheap"
          ? "up"
          : "muted";
  return (
    <Panel title="Volatility · IV vs realised">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2 text-[11px] tabular">
        <Stat label="Implied vol" value={pctNum(iv)} />
        <Stat label="Realised 30d" value={pctNum(rv30)} />
        <Stat label="Realised 90d" value={pctNum(rv90)} />
        <Stat
          label="IV / RV ratio"
          value={ratio != null ? `${ratio.toFixed(2)}× · ${verdict}` : "—"}
          tone={verdictTone as any}
          hint={
            verdict === "rich"
              ? "options pricing more vol than underlying produces"
              : verdict === "cheap"
                ? "options pricing less vol than underlying produces"
                : undefined
          }
        />
      </div>
    </Panel>
  );
}

export function LiquidityPanel({ result }: { result: OptionAnalyzeResult }) {
  const l = result.liquidity;
  const gradeTone =
    l.grade === "tight"
      ? "up"
      : l.grade === "normal"
        ? "muted"
        : l.grade === "wide"
          ? "warning"
          : "down";
  return (
    <Panel title="Liquidity · this contract">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2 text-[11px] tabular">
        <Stat
          label="Bid / Ask"
          value={
            l.bid != null && l.ask != null
              ? `$${l.bid.toFixed(2)} / $${l.ask.toFixed(2)}`
              : "—"
          }
        />
        <Stat
          label="Spread"
          value={
            l.spread != null && l.spread_pct != null
              ? `$${l.spread.toFixed(2)} (${l.spread_pct.toFixed(1)}%)`
              : "—"
          }
          tone={gradeTone as any}
        />
        <Stat label="Volume (today)" value={fmtInt(l.volume)} />
        <Stat label="Open interest" value={fmtInt(l.open_interest)} />
        <Stat
          label="Grade"
          value={l.grade.toUpperCase()}
          tone={gradeTone as any}
        />
        <Stat
          label="Last print"
          value={l.last != null ? `$${l.last.toFixed(2)}` : "—"}
        />
      </div>
    </Panel>
  );
}

/** Spot ±% × time slices PnL matrix. Compact, dense, no chart needed. */
export function ScenarioMatrixPanel({
  result,
}: {
  result: OptionAnalyzeResult;
}) {
  const cols: { label: string; pct: number }[] = [
    { label: "−15%", pct: -0.15 },
    { label: "−10%", pct: -0.1 },
    { label: "−5%", pct: -0.05 },
    { label: "spot", pct: 0 },
    { label: "+5%", pct: 0.05 },
    { label: "+10%", pct: 0.1 },
    { label: "+15%", pct: 0.15 },
  ];
  const { prices, today, halfway, expiry } = result.pnl_profile;

  // Look up nearest sample for each (time, scenario) combo.
  const lookup = (arr: number[], target: number) => {
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < prices.length; i++) {
      const d = Math.abs(prices[i] - target);
      if (d < bestDiff) {
        bestDiff = d;
        best = i;
      }
    }
    return arr[best];
  };

  const rows: { label: string; data: number[] }[] = [
    {
      label: "today",
      data: cols.map((c) => lookup(today, result.spot * (1 + c.pct))),
    },
    {
      label: "½ DTE",
      data: cols.map((c) => lookup(halfway, result.spot * (1 + c.pct))),
    },
    {
      label: "expiry",
      data: cols.map((c) => lookup(expiry, result.spot * (1 + c.pct))),
    },
  ];

  return (
    <Panel title="Scenario matrix · PnL by spot × time">
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] tabular">
          <thead>
            <tr className="text-text-muted border-b border-border/40">
              <th className="text-left px-3 py-1.5 font-normal text-[10px] uppercase tracking-wider">
                When
              </th>
              {cols.map((c) => (
                <th
                  key={c.label}
                  className={cn(
                    "text-right px-2 py-1.5 font-normal text-[10px]",
                    c.pct === 0 && "text-text-secondary font-medium",
                  )}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr
                key={r.label}
                className={cn(
                  "border-b border-border/15",
                  ri === rows.length - 1 && "border-b-0",
                )}
              >
                <td className="px-3 py-1 text-text-secondary">{r.label}</td>
                {r.data.map((v, i) => (
                  <td
                    key={i}
                    className={cn(
                      "px-2 py-1 text-right font-medium",
                      v > 0
                        ? "text-up"
                        : v < 0
                          ? "text-down"
                          : "text-text-muted",
                      cols[i].pct === 0 && "bg-surface-2/40",
                    )}
                  >
                    {fmtPnl(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ─── building blocks ────────────────────────────────────────────────────────

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-surface overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-7 border-b border-border/60">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "up" | "down" | "warning" | "muted";
}) {
  const toneCls =
    tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : tone === "warning"
          ? "text-warning"
          : "text-text-primary";
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className={cn("font-medium tabular", toneCls)}>{value}</span>
      {hint && (
        <span className="text-[9px] text-text-muted italic">{hint}</span>
      )}
    </div>
  );
}

// ─── format helpers ─────────────────────────────────────────────────────────

function pct(v: number | null): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(0)}%`;
}
function pctNum(v: number | null): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}
function fmtInt(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}
function fmtPnl(v: number): string {
  if (!isFinite(v)) return v > 0 ? "∞" : "−∞";
  const a = Math.abs(v);
  if (a >= 1_000_000)
    return `${v < 0 ? "-" : ""}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${v < 0 ? "-" : ""}$${(a / 1_000).toFixed(1)}k`;
  return `${v < 0 ? "-" : ""}$${a.toFixed(0)}`;
}

function tonePOP(
  pop: number | null,
  isLong: boolean,
): "up" | "down" | "warning" | "muted" {
  if (pop == null) return "muted";
  if (pop >= 0.6) return "up";
  if (pop >= 0.4) return "warning";
  return "down";
}
