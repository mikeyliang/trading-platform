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
        <Stat label="POP at expiry" value={pct(pop)} tone={tonePOP(pop, result.is_long)} />
        <Stat label="P(ITM)" value={pct(prob_itm)} />
        <Stat label="P(touch BE)" value={pct(prob_touch)} hint="rough Brownian estimate" />
        <Stat
          label="Expected 1σ move"
          value={em != null && emPct != null ? `±$${em.toFixed(2)} (${emPct.toFixed(1)}%)` : "—"}
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
  const ivRank = result.vol_context.iv_rank;
  const ivPctile = result.vol_context.iv_percentile;
  const iv52Hi = result.vol_context.iv_52w_high;
  const iv52Lo = result.vol_context.iv_52w_low;
  const verdict =
    ratio == null ? "—" :
    ratio >= 1.4 ? "rich" :
    ratio >= 1.1 ? "elevated" :
    ratio >= 0.9 ? "fair" :
    "cheap";
  const verdictTone =
    verdict === "rich" ? "down" :
    verdict === "elevated" ? "warning" :
    verdict === "cheap" ? "up" :
    "muted";
  // High IV rank favors sellers, hurts buyers — tone follows the position.
  const rankTone =
    ivRank == null ? undefined :
    ivRank >= 70 ? (result.is_long ? "down" : "up") :
    ivRank <= 20 ? (result.is_long ? "up" : "down") :
    undefined;
  return (
    <Panel title="Volatility · IV regime (IBKR vol indices)">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-2 px-3 py-2 text-[11px] tabular">
        <Stat label="Implied vol" value={pctNum(iv)} />
        <Stat label="Realised 30d" value={pctNum(rv30)} />
        <Stat label="Realised 90d" value={pctNum(rv90)} />
        <Stat
          label="IV / RV ratio"
          value={ratio != null ? `${ratio.toFixed(2)}× · ${verdict}` : "—"}
          tone={verdictTone as any}
          hint={
            verdict === "rich" ? "options pricing more vol than underlying produces" :
            verdict === "cheap" ? "options pricing less vol than underlying produces" :
            undefined
          }
        />
        <Stat
          label="IV rank · 52w"
          value={ivRank != null ? ivRank.toFixed(0) : "—"}
          tone={rankTone as any}
          hint={ivRank != null ? "0 = at 52w IV low, 100 = at 52w high" : "needs IBKR vol history"}
        />
        <Stat
          label="IV percentile"
          value={ivPctile != null ? `${ivPctile.toFixed(0)}%` : "—"}
          hint="% of days this year with lower IV"
        />
        <Stat
          label="52w IV range"
          value={iv52Lo != null && iv52Hi != null ? `${(iv52Lo * 100).toFixed(0)}–${(iv52Hi * 100).toFixed(0)}%` : "—"}
        />
        <Stat
          label="IV index now"
          value={pctNum(result.vol_context.underlying_iv_now)}
          hint="~30d ATM IV of the underlying"
        />
      </div>
      {ivRank != null && (
        <div className="px-3 pb-2">
          {/* IV rank position bar — where today sits in the 52w IV range. */}
          <div className="relative h-1.5 rounded-full overflow-hidden bg-gradient-to-r from-up/40 via-warning/40 to-down/40">
            <div
              className="absolute top-0 bottom-0 w-1 rounded-full bg-text-primary"
              style={{ left: `${Math.max(0, Math.min(100, ivRank))}%`, transform: "translateX(-50%)" }}
            />
          </div>
          <div className="flex justify-between text-[8px] tabular text-text-muted/70 mt-0.5">
            <span>52w low</span>
            <span>52w high</span>
          </div>
        </div>
      )}
      <IvHistoryChart
        ivHistory={result.vol_context.iv_history ?? []}
        hvHistory={result.vol_context.hv_history ?? []}
        contractIv={iv}
      />
    </Panel>
  );
}

/** Daily IV-index vs HV history (IBKR), with the analyzed contract's own IV
 *  as a reference line. Lightweight inline SVG — no chart lib needed for a
 *  250-point context sparkline. */
function IvHistoryChart({
  ivHistory, hvHistory, contractIv,
}: {
  ivHistory: { time: number; value: number }[];
  hvHistory: { time: number; value: number }[];
  contractIv: number;
}) {
  if (ivHistory.length < 10) return null;
  const W = 600, H = 110, PAD = 4;
  const all = [...ivHistory.map((p) => p.value), ...hvHistory.map((p) => p.value), contractIv]
    .filter((v) => Number.isFinite(v) && v > 0);
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = hi - lo || 1;
  const t0 = ivHistory[0].time;
  const t1 = ivHistory[ivHistory.length - 1].time;
  const tSpan = t1 - t0 || 1;
  const x = (t: number) => PAD + ((t - t0) / tSpan) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - 2 * PAD);
  const path = (pts: { time: number; value: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const ivY = y(contractIv);
  const first = ivHistory[0]?.time;
  const last = ivHistory[ivHistory.length - 1]?.time;
  const fmtD = (t?: number) =>
    t ? new Date(t * 1000).toLocaleDateString(undefined, { month: "short", year: "2-digit" }) : "";
  return (
    <div className="px-3 pb-3">
      <div className="flex items-center gap-3 text-[9px] uppercase tracking-wider text-text-muted mb-1">
        <span className="flex items-center gap-1">
          <span className="w-2 h-0.5 inline-block bg-accent" /> IV index (daily)
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-0.5 inline-block bg-text-muted" /> HV 30d
        </span>
        <span className="flex items-center gap-1 text-warning">
          <span className="w-2 h-px inline-block border-t border-dashed border-warning" /> this contract&apos;s IV
        </span>
        <span className="ml-auto tabular normal-case">{fmtD(first)} – {fmtD(last)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[110px]" preserveAspectRatio="none">
        {hvHistory.length >= 2 && (
          <path d={path(hvHistory)} fill="none" className="stroke-text-muted/60" strokeWidth={1} />
        )}
        <path d={path(ivHistory)} fill="none" className="stroke-accent" strokeWidth={1.5} />
        {Number.isFinite(ivY) && (
          <line x1={PAD} x2={W - PAD} y1={ivY} y2={ivY}
            className="stroke-warning" strokeWidth={1} strokeDasharray="4 3" />
        )}
      </svg>
    </div>
  );
}

export function LiquidityPanel({ result }: { result: OptionAnalyzeResult }) {
  const l = result.liquidity;
  const gradeTone =
    l.grade === "tight" ? "up" :
    l.grade === "normal" ? "muted" :
    l.grade === "wide" ? "warning" :
    "down";
  return (
    <Panel title="Liquidity · this contract">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2 text-[11px] tabular">
        <Stat
          label="Bid / Ask"
          value={l.bid != null && l.ask != null ? `$${l.bid.toFixed(2)} / $${l.ask.toFixed(2)}` : "—"}
        />
        <Stat
          label="Spread"
          value={l.spread != null && l.spread_pct != null ? `$${l.spread.toFixed(2)} (${l.spread_pct.toFixed(1)}%)` : "—"}
          tone={gradeTone as any}
        />
        <Stat label="Volume (today)" value={fmtInt(l.volume)} />
        <Stat label="Open interest" value={fmtInt(l.open_interest)} />
        <Stat label="Grade" value={l.grade.toUpperCase()} tone={gradeTone as any} />
        <Stat label="Last print" value={l.last != null ? `$${l.last.toFixed(2)}` : "—"} />
      </div>
    </Panel>
  );
}

/** Spot ±% × time slices PnL matrix. Compact, dense, no chart needed. */
export function ScenarioMatrixPanel({ result }: { result: OptionAnalyzeResult }) {
  const cols: { label: string; pct: number }[] = [
    { label: "−15%", pct: -0.15 },
    { label: "−10%", pct: -0.10 },
    { label: "−5%", pct: -0.05 },
    { label: "spot", pct: 0 },
    { label: "+5%", pct: 0.05 },
    { label: "+10%", pct: 0.10 },
    { label: "+15%", pct: 0.15 },
  ];
  const { prices, today, halfway, expiry } = result.pnl_profile;

  // Look up nearest sample for each (time, scenario) combo.
  const lookup = (arr: number[], target: number) => {
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < prices.length; i++) {
      const d = Math.abs(prices[i] - target);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return arr[best];
  };

  const rows: { label: string; data: number[] }[] = [
    { label: "today", data: cols.map((c) => lookup(today,   result.spot * (1 + c.pct))) },
    { label: "½ DTE", data: cols.map((c) => lookup(halfway, result.spot * (1 + c.pct))) },
    { label: "expiry", data: cols.map((c) => lookup(expiry, result.spot * (1 + c.pct))) },
  ];

  return (
    <Panel title="Scenario matrix · PnL by spot × time">
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] tabular">
          <thead>
            <tr className="text-text-muted border-b border-border/40">
              <th className="text-left px-3 py-1.5 font-normal text-[10px] uppercase tracking-wider">When</th>
              {cols.map((c) => (
                <th key={c.label} className={cn(
                  "text-right px-2 py-1.5 font-normal text-[10px]",
                  c.pct === 0 && "text-text-secondary font-medium"
                )}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.label} className={cn("border-b border-border/15", ri === rows.length - 1 && "border-b-0")}>
                <td className="px-3 py-1 text-text-secondary">{r.label}</td>
                {r.data.map((v, i) => (
                  <td
                    key={i}
                    className={cn(
                      "px-2 py-1 text-right font-medium",
                      v > 0 ? "text-up" : v < 0 ? "text-down" : "text-text-muted",
                      cols[i].pct === 0 && "bg-surface-2/40"
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
  title, children,
}: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-7 border-b border-border/60">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">{title}</span>
      </div>
      {children}
    </div>
  );
}

function Stat({
  label, value, hint, tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "up" | "down" | "warning" | "muted";
}) {
  const toneCls =
    tone === "up" ? "text-up" :
    tone === "down" ? "text-down" :
    tone === "warning" ? "text-warning" :
    "text-text-primary";
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wider text-text-muted">{label}</span>
      <span className={cn("font-medium tabular", toneCls)}>{value}</span>
      {hint && <span className="text-[9px] text-text-muted italic">{hint}</span>}
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
  if (a >= 1_000_000) return `${v < 0 ? "-" : ""}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${v < 0 ? "-" : ""}$${(a / 1_000).toFixed(1)}k`;
  return `${v < 0 ? "-" : ""}$${a.toFixed(0)}`;
}

function tonePOP(pop: number | null, isLong: boolean): "up" | "down" | "warning" | "muted" {
  if (pop == null) return "muted";
  if (pop >= 0.60) return "up";
  if (pop >= 0.40) return "warning";
  return "down";
}
