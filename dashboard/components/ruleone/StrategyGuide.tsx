"use client";

import { useState } from "react";
import { BookOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { STRATEGIES, winRatePct, type StrategySpec } from "@/lib/ruleone";

// Visual reference for the four Rule One credit-spread strategies. One
// place that answers: where does each trade sit relative to the money,
// what are the entry gates, when do I exit, and which one do I pick when
// several qualify. Spec values come straight from lib/ruleone.ts — the
// same source the scanner and exit monitor use, so this guide can never
// drift from the live rules.

const TONE: Record<string, { text: string; bg: string; border: string }> = {
  rut:     { text: "text-text-secondary", bg: "bg-text-secondary/10", border: "border-text-secondary/40" },
  mars:    { text: "text-accent",         bg: "bg-accent/10",         border: "border-accent/40" },
  marsmax: { text: "text-warning",        bg: "bg-warning/10",        border: "border-warning/40" },
  space:   { text: "text-up",             bg: "bg-up/10",             border: "border-up/40" },
};

export function StrategyGuideButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 h-6 px-2 rounded-sm border border-border bg-surface-2/60",
            "text-[10px] text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors",
            className,
          )}
          title="Rule One strategy guide — entry gates, exit rules, decision tree"
        >
          <BookOpen size={11} />
          Guide
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Rule One strategy guide</DialogTitle>
          <DialogDescription>
            Monthly bull-put credit spreads, ~25–34 DTE, next-strike wings. Size at
            min(Kelly%, ⅓ bankroll). Both exit rules are always live.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <LevelDiagram />
          <SpecTable />
          <ExitRules />
          <DecisionTree />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Level ladder — where a bull-put trade lives relative to spot ──────────
// Generic (percent-based) so it reads as a mental model, not one quote.
function LevelDiagram() {
  // Vertical positions (% of diagram height) for each level, top → bottom.
  const Y = { spot: 12, alert: 42, exit: 56, short: 70, long: 88 };
  return (
    <section>
      <SectionLabel>Anatomy of the trade · bull put</SectionLabel>
      <div className="relative rounded-md border border-border bg-bg overflow-hidden" style={{ height: 230 }}>
        {/* Zones between levels — the state machine the monitor runs. */}
        <Zone top={0} bottom={Y.alert} className="bg-up/[0.05]" label="SAFE" labelTone="text-up/70"
          hint="price comfortably above the alert level — let theta work" />
        <Zone top={Y.alert} bottom={Y.exit} className="bg-warning/[0.07]" label="WARNING" labelTone="text-warning/80"
          hint="alert fired — watch short Δ; on the last day this is the soft band" />
        <Zone top={Y.exit} bottom={Y.short} className="bg-down/[0.08]" label="EXIT" labelTone="text-down/80"
          hint="rule #2 zone — within the buffer of the short strike: close, don't negotiate" />
        <Zone top={Y.short} bottom={100} className="bg-down/[0.14]" label="MAX-LOSS TERRITORY" labelTone="text-down"
          hint="below the short strike the spread goes intrinsic; the long leg caps the bleed" />

        <Level y={Y.spot} dashed={false} cls="bg-text-primary"
          left="SPOT" right="underlying now" rightCls="text-text-secondary" />
        <Level y={Y.alert} dashed cls="bg-warning/80"
          left="ALERT" leftCls="text-warning"
          right="strike + ½·buffer — set your broker alert here" rightCls="text-warning/90" />
        <Level y={Y.exit} dashed cls="bg-down/80"
          left="R2 EXIT" leftCls="text-down"
          right="strike + buffer (3% trad RUT · 2% Mars/Max/Space)" rightCls="text-down/90" />
        <Level y={Y.short} dashed={false} cls="bg-accent"
          left="SHORT" leftCls="text-accent"
          right="short strike — Δ ≤ 10–14 at entry, ~9–11% adj OTM" rightCls="text-accent/90" />
        <Level y={Y.long} dashed cls="bg-text-muted"
          left="LONG" leftCls="text-text-muted"
          right="long strike — next strike down, caps max loss" rightCls="text-text-muted" />
      </div>
      <p className="mt-1.5 text-[10px] text-text-muted leading-relaxed">
        Call-side (bear call) mirrors this picture above spot. The exit monitor colors each open
        spread by which zone it&apos;s in and fires rule #1 (Δ trigger) / rule #2 (buffer on the
        last trade day) automatically.
      </p>
    </section>
  );
}

function Zone({ top, bottom, className, label, labelTone, hint }: {
  top: number; bottom: number; className: string; label: string; labelTone: string; hint: string;
}) {
  return (
    <div
      className={cn("absolute inset-x-0", className)}
      style={{ top: `${top}%`, height: `${bottom - top}%` }}
      title={hint}
    >
      <span className={cn(
        "absolute left-2 top-1/2 -translate-y-1/2 text-[9px] uppercase tracking-[0.2em] font-medium select-none",
        labelTone,
      )}>
        {label}
      </span>
    </div>
  );
}

function Level({ y, dashed, cls, left, leftCls, right, rightCls }: {
  y: number; dashed: boolean; cls: string;
  left: string; leftCls?: string; right: string; rightCls?: string;
}) {
  return (
    <div className="absolute inset-x-0 flex items-center" style={{ top: `${y}%` }}>
      <span className={cn("w-16 text-right pr-2 text-[9px] uppercase tracking-wider font-semibold shrink-0", leftCls ?? "text-text-primary")}>
        {left}
      </span>
      <div className={cn("flex-1 h-px", cls, dashed && "opacity-90 [mask-image:repeating-linear-gradient(90deg,black_0_6px,transparent_6px_12px)]")} />
      <span className={cn("pl-2 pr-2 text-[9px] tabular shrink-0 max-w-[55%] truncate", rightCls ?? "text-text-muted")}>
        {right}
      </span>
    </div>
  );
}

// ─── Spec comparison table ──────────────────────────────────────────────────
function SpecTable() {
  const rows: { label: string; group?: string; value: (s: StrategySpec) => string; hint?: string }[] = [
    { label: "Underlying",   value: (s) => s.underlying },
    { label: "Short Δ cap",  group: "entry", value: (s) => `≤ ${s.maxDelta}`,
      hint: "Short-leg delta at entry, ×100. Start at the cap and back off until the gates pass." },
    { label: "Adj %OTM min", group: "entry", value: (s) => `≥ ${s.minAdjOTM}%`,
      hint: "Distance to short strike × √(DTE/30) — time-normalized cushion." },
    { label: "AROC min",     group: "entry", value: (s) => `≥ ${s.arocTarget}%`,
      hint: "Annualized return on capital: (credit / max risk) × (365 / DTE)." },
    { label: "Kelly min",    group: "entry", value: (s) => `≥ ${s.minKelly}`,
      hint: "Kelly fraction ×100 — sizing gate. Trade must justify real size." },
    { label: "Fib floors",   group: "entry", value: (s) => (s.floorRequired ? "2 below" : "—"),
      hint: "Traditional RUT requires the short strike ≥ 2 fib floors below the money." },
    { label: "Exit Δ (rule 1)", group: "exit", value: (s) => `${s.exitDelta}`,
      hint: "Close immediately when short-leg |Δ| reaches this. No waiting." },
    { label: "Buffer (rule 2)", group: "exit", value: (s) => `${s.lastDayBufferPct}%`,
      hint: "On the last trade day, close if the underlying is within this % of the short strike." },
    { label: "CAGR ’08–’19", group: "hist", value: (s) => `${s.histCagrPct}%` },
    { label: "Win rate",     group: "hist", value: (s) => `${winRatePct(s).toFixed(0)}%` },
    { label: "Avg / max loss", group: "hist", value: (s) => `${s.histAvgLossPct}% / ${s.histMaxLossPct}%`,
      hint: "Of capital at risk, when an exit was triggered. Mars Max losses have reached ~70% — size down." },
    { label: "$10k grew to", group: "hist", value: (s) => `$${compact(s.hist10kGrewTo)}` },
  ];

  return (
    <section>
      <SectionLabel>Entry gates · exit rules · 12-yr backtest</SectionLabel>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-[11px] tabular">
          <thead>
            <tr className="border-b border-border bg-surface-2/40">
              <th className="text-left px-3 py-2 font-normal text-[10px] uppercase tracking-wider text-text-muted">Rule</th>
              {STRATEGIES.map((s) => (
                <th key={s.id} className={cn("text-right px-3 py-2 font-semibold", TONE[s.id].text)}>
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.label}
                className={cn("border-b border-border/30 last:border-b-0", i % 2 === 1 && "bg-surface-2/20")}
                title={r.hint}
              >
                <td className={cn(
                  "px-3 py-1.5 text-text-secondary",
                  r.group === "exit" && "text-down/90",
                  r.group === "hist" && "text-text-muted",
                )}>
                  {r.label}
                </td>
                {STRATEGIES.map((s) => (
                  <td key={s.id} className="px-3 py-1.5 text-right text-text-primary">
                    {r.value(s)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Exit rules ─────────────────────────────────────────────────────────────
function ExitRules() {
  return (
    <section>
      <SectionLabel>The two exit rules — both always in effect</SectionLabel>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div className="rounded-md border border-down/30 bg-down/[0.05] px-3 py-2.5">
          <div className="text-[11px] font-semibold text-down mb-1">Rule #1 · delta trigger</div>
          <p className="text-[11px] text-text-secondary leading-relaxed">
            Close the moment short-leg |Δ| reaches the trade&apos;s exit delta
            (30 / 36 / 42 / 32). The monitor tracks this every 5 minutes during
            RTH and flags <span className="text-warning">warning</span> within 12 points of the
            trigger.
          </p>
        </div>
        <div className="rounded-md border border-down/30 bg-down/[0.05] px-3 py-2.5">
          <div className="text-[11px] font-semibold text-down mb-1">Rule #2 · last trade day</div>
          <p className="text-[11px] text-text-secondary leading-relaxed">
            On the Thursday before expiration (index options stop trading Thursday
            close), close if the underlying is within the buffer (3% trad RUT, 2%
            others) of the short strike. Never carry it into settlement.
          </p>
        </div>
      </div>
    </section>
  );
}

// ─── Decision tree ──────────────────────────────────────────────────────────
function DecisionTree() {
  const steps = [
    {
      q: "Build all qualifying RUT trades on the chart",
      a: "Trad RUT, Mars, Mars Max — same expiry, each at its own delta cap.",
    },
    {
      q: "Short strikes cluster within ~3%?",
      a: "Take the MOST aggressive (Mars Max) — the safer trades give up premium without real added distance.",
      tone: "marsmax" as const,
    },
    {
      q: "Meaningful separation (≥ a fib step)?",
      a: "Take the SAFEST trade that sits below the floor — “if Mars is below the fib but Max is above, take Mars.”",
      tone: "mars" as const,
    },
    {
      q: "Space qualifies too?",
      a: "Independent SPX book — can be placed alongside the RUT trade. The 44-Kelly floor makes it rare.",
      tone: "space" as const,
    },
  ];
  return (
    <section>
      <SectionLabel>Which one to place — webinar1 decision tree</SectionLabel>
      <ol className="flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 rounded-md border border-border/60 bg-surface-2/30 px-3 py-2">
            <span className="shrink-0 w-4 h-4 rounded-full bg-surface-2 border border-border text-[9px] tabular text-text-secondary flex items-center justify-center mt-0.5">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-text-primary">{s.q}</div>
              <div className={cn("text-[11px] leading-relaxed", s.tone ? TONE[s.tone].text : "text-text-secondary")}>
                {s.a}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-text-muted font-medium mb-1.5">
      {children}
    </div>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
