"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  api,
  type RecentAgentRun,
  type ForecastTrackRecord,
} from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Logo } from "@/components/ui/logo";
import { toast } from "@/components/ui/toaster";
import { cn, fmt, fmtCurrency } from "@/lib/utils";
import {
  Sparkles,
  RefreshCw,
  Target,
  Brain,
  ArrowUpRight,
  AlertTriangle,
  Clock,
} from "lucide-react";

// ── helpers ──────────────────────────────────────────────────────────
type Tone = "up" | "down" | "warning" | "muted";

/** Classify a synthesis verdict into a tone by its leading action word. */
function verdictTone(verdict: string | null, isLong: boolean): Tone {
  if (!verdict) return "muted";
  const v = verdict.toLowerCase();
  if (/\b(close|exit|cut|sell|trim|reduce|dump)\b/.test(v)) return "warning";
  if (/\b(add|open|buy|roll up|accumulate|size up)\b/.test(v)) return "up";
  if (/\b(hold|keep|stay|let it ride|hold the)\b/.test(v)) return isLong ? "up" : "down";
  if (/\b(hedge|roll|defend|protect)\b/.test(v)) return "warning";
  return "muted";
}

function fmtExpiry(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  return `${yyyymmdd.slice(6, 8)} ${mo[m] ?? "?"} '${yyyymmdd.slice(2, 4)}`;
}

function timeAgo(iso: string, nowMs: number): string {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function analyzerHref(r: RecentAgentRun): string {
  const q = new URLSearchParams({
    symbol: r.symbol,
    expiry: r.expiry,
    strike: String(r.strike),
    right: r.right,
    qty: String(Math.abs(r.quantity) || 1),
  });
  return `/monitor/analyzer?${q.toString()}`;
}

const TONE_TEXT: Record<Tone, string> = {
  up: "text-up",
  down: "text-down",
  warning: "text-warning",
  muted: "text-text-secondary",
};

// ── page ─────────────────────────────────────────────────────────────
export default function InsightsPage() {
  const [runs, setRuns] = useState<RecentAgentRun[] | null>(null);
  const [track, setTrack] = useState<ForecastTrackRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [scoring, setScoring] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [nowMs, setNowMs] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, t] = await Promise.all([
        api.recentAgentRuns({ limit: 60 }).catch(() => [] as RecentAgentRun[]),
        api.forecastTrackRecord().catch(() => null),
      ]);
      setRuns(r);
      setTrack(t);
    } finally {
      setLoading(false);
      setNowMs(Date.now());
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const scoreNow = useCallback(async () => {
    setScoring(true);
    try {
      const { scored } = await api.forecastScoreNow();
      toast.success(
        scored > 0
          ? `Scored ${scored} forecast${scored === 1 ? "" : "s"}`
          : "No forecasts ready to score yet"
      );
      setTrack(await api.forecastTrackRecord().catch(() => null));
    } catch {
      toast.error("Scoring failed");
    } finally {
      setScoring(false);
    }
  }, []);

  const analyzePositions = useCallback(async () => {
    setAnalyzing(true);
    try {
      const s = await api.analyzePositions();
      if (s.open_options === 0) {
        toast.info("No open option positions to analyze");
      } else {
        toast.success(
          `Analyzed ${s.analysed} of ${s.open_options} position${s.open_options === 1 ? "" : "s"}` +
            (s.skipped ? ` · ${s.skipped} already done today` : "") +
            (s.failed ? ` · ${s.failed} failed` : "")
        );
      }
      setRuns(await api.recentAgentRuns({ limit: 60 }).catch(() => null));
      setNowMs(Date.now());
    } catch {
      toast.error("Position analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }, []);

  return (
    <PageShell>
      <PageHeader
        title="Insights"
        eyebrow="Stored analysis"
        description="Every AI verdict and forecast you've run, tracked over time."
        actions={
          <>
            <Button
              variant="default"
              size="sm"
              onClick={analyzePositions}
              disabled={analyzing}
              title="Run the AI agents on every open option position now and store each verdict"
            >
              <Brain size={12} className={cn(analyzing && "animate-pulse")} />
              {analyzing ? "Analyzing…" : "Analyze positions"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={scoreNow}
              disabled={scoring}
              title="Score forecasts whose horizon has elapsed against realised closes"
            >
              <Target size={12} className={cn(scoring && "animate-pulse")} />
              {scoring ? "Scoring…" : "Score forecasts"}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={load} title="Refresh">
              <RefreshCw size={13} className={cn(loading && "animate-spin")} />
            </Button>
          </>
        }
      />

      <ForecastTrackCard track={track} loading={loading} />

      <VerdictTimeline runs={runs} loading={loading} nowMs={nowMs} />
    </PageShell>
  );
}

// ── forecast track record ────────────────────────────────────────────
const MODEL_LABEL: Record<string, string> = {
  ensemble: "Ensemble",
  chronos: "Chronos-2",
  momentum: "Momentum",
  mean_reversion: "Mean rev.",
  martingale: "Martingale",
};
const MODEL_ORDER = ["ensemble", "chronos", "momentum", "mean_reversion", "martingale"];

function ForecastTrackCard({
  track,
  loading,
}: {
  track: ForecastTrackRecord | null;
  loading: boolean;
}) {
  const models = track?.models ?? {};
  const ordered = useMemo(
    () =>
      Object.keys(models).sort(
        (a, b) => (MODEL_ORDER.indexOf(a) + 1 || 99) - (MODEL_ORDER.indexOf(b) + 1 || 99)
      ),
    [models]
  );
  const c = track?.counts;
  const hasScored = (c?.scored ?? 0) > 0;

  return (
    <Card className="shrink-0">
      <div className="flex items-center justify-between px-3 h-7 border-b border-border/60">
        <div className="flex items-center gap-1.5">
          <Target size={12} className="text-accent" />
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            Forecast track record
          </span>
        </div>
        {c && (
          <div className="flex items-center gap-2 text-[10px] tabular text-text-muted">
            <span>
              <span className="text-text-secondary">{c.logged}</span> logged
            </span>
            <span className="text-border">·</span>
            <span>
              <span className="text-up">{c.scored}</span> scored
            </span>
            <span className="text-border">·</span>
            <span>
              <span className="text-warning">{c.pending}</span> pending
            </span>
          </div>
        )}
      </div>
      <CardContent className="p-3">
        {loading && !track ? (
          <div className="h-20 skeleton rounded" />
        ) : !hasScored ? (
          <div className="flex items-start gap-2.5 text-[11px] text-text-secondary">
            <Clock size={14} className="text-warning mt-0.5 shrink-0" />
            <div className="leading-relaxed">
              <span className="text-text-primary">{c?.pending ?? 0} forecasts logged, accumulating.</span>{" "}
              Each prediction is scored against the realised close once its horizon elapses
              (run automatically nightly, or hit{" "}
              <span className="text-text-primary">Score forecasts</span> to backfill now). Per-model
              accuracy appears here as soon as the first horizon completes.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* per-model accuracy */}
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 items-center">
              <div className="contents text-[9px] uppercase tracking-wider text-text-muted">
                <div>Model</div>
                <div className="grid grid-cols-[3rem_3rem_1fr] gap-2">
                  <span className="text-right">MAE</span>
                  <span className="text-right">RMSE</span>
                  <span>Direction hit-rate</span>
                </div>
              </div>
              {ordered.map((m) => {
                const s = models[m];
                const hr = s.sign_hit_rate ?? 0;
                return (
                  <div key={m} className="contents">
                    <div className="text-[11px] text-text-primary flex items-center gap-1.5">
                      {MODEL_LABEL[m] ?? m}
                      <span className="text-[9px] text-text-muted tabular">n={s.n}</span>
                    </div>
                    <div className="grid grid-cols-[3rem_3rem_1fr] gap-2 items-center text-[11px] tabular">
                      <span className="text-right text-text-secondary">
                        {s.mae_pct != null ? `${fmt(s.mae_pct, 2)}%` : "—"}
                      </span>
                      <span className="text-right text-text-secondary">
                        {s.rmse_pct != null ? `${fmt(s.rmse_pct, 2)}%` : "—"}
                      </span>
                      <HitRateBar value={hr} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* per-symbol ensemble breakdown */}
            {track && track.per_symbol.length > 0 && (
              <div className="border-t border-border/60 pt-2.5">
                <div className="text-[9px] uppercase tracking-wider text-text-muted mb-1.5">
                  Ensemble by symbol
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {track.per_symbol.map((p) => (
                    <div
                      key={p.symbol}
                      className="flex items-center gap-1.5 px-1.5 py-1 rounded bg-surface-2 border border-border/60"
                      title={`${p.n} scored · MAE ${p.mae_pct ?? "—"}%`}
                    >
                      <Logo symbol={p.symbol} size={14} />
                      <span className="text-[10px] text-text-primary">{p.symbol}</span>
                      <span
                        className={cn(
                          "text-[10px] tabular",
                          (p.hit_rate ?? 0) >= 0.5 ? "text-up" : "text-down"
                        )}
                      >
                        {p.hit_rate != null ? `${Math.round(p.hit_rate * 100)}%` : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HitRateBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const good = value >= 0.55;
  const mid = value >= 0.45 && value < 0.55;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-surface-3 overflow-hidden relative">
        {/* 50% reference marker */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-border z-10" />
        <div
          className={cn(
            "h-full rounded-full",
            good ? "bg-up" : mid ? "bg-warning" : "bg-down"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={cn(
          "w-9 text-right tabular",
          good ? "text-up" : mid ? "text-warning" : "text-down"
        )}
      >
        {pct}%
      </span>
    </div>
  );
}

// ── AI verdict timeline ──────────────────────────────────────────────
function VerdictTimeline({
  runs,
  loading,
  nowMs,
}: {
  runs: RecentAgentRun[] | null;
  loading: boolean;
  nowMs: number;
}) {
  if (loading && !runs) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 skeleton rounded" />
        ))}
      </div>
    );
  }
  if (!runs || runs.length === 0) {
    return (
      <EmptyState
        icon={Brain}
        title="No AI runs yet"
        description="Open a contract in the Analyzer and run the AI agents — verdicts land here, building a portfolio-wide log you can revisit without re-spending tokens."
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5 min-h-0">
      <div className="flex items-center gap-1.5 px-0.5">
        <Sparkles size={12} className="text-accent" />
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          AI verdicts
        </span>
        <span className="text-[10px] tabular text-text-muted">· {runs.length}</span>
      </div>
      {runs.map((r) => (
        <VerdictRow key={r.id} run={r} nowMs={nowMs} />
      ))}
    </div>
  );
}

function VerdictRow({ run, nowMs }: { run: RecentAgentRun; nowMs: number }) {
  const tone = verdictTone(run.verdict, run.is_long);
  const dir = run.is_long ? "Long" : "Short";
  const qty = Math.abs(run.quantity);
  return (
    <Link
      href={analyzerHref(run)}
      className="group block rounded border border-border/60 bg-surface hover:bg-surface-2 hover:border-border transition-colors"
    >
      <div className="flex items-stretch gap-3 p-2.5">
        {/* tone rail */}
        <div
          className={cn(
            "w-0.5 rounded-full shrink-0",
            tone === "up" && "bg-up",
            tone === "down" && "bg-down",
            tone === "warning" && "bg-warning",
            tone === "muted" && "bg-border"
          )}
        />
        <div className="flex-1 min-w-0">
          {/* contract line */}
          <div className="flex items-center gap-2 mb-1">
            <Logo symbol={run.symbol} size={16} />
            <span className="text-[12px] text-text-primary font-medium tabular">
              {run.symbol} {fmt(run.strike, 0)}
              {run.right}
            </span>
            <span className="text-[10px] tabular text-text-muted">
              ×{qty} · {dir} · {fmtExpiry(run.expiry)}
            </span>
            {run.failed_agents > 0 && (
              <Badge variant="warning" className="gap-1">
                <AlertTriangle size={9} />
                {run.failed_agents} failed
              </Badge>
            )}
            <span className="ml-auto text-[10px] tabular text-text-muted shrink-0">
              {timeAgo(run.ran_at, nowMs)}
            </span>
          </div>
          {/* verdict */}
          <div className={cn("text-[12px] leading-snug line-clamp-2", TONE_TEXT[tone])}>
            {run.verdict ?? "—"}
          </div>
          {run.rationale && (
            <div className="text-[11px] text-text-secondary leading-snug mt-0.5 line-clamp-2">
              {run.rationale}
            </div>
          )}
          {/* context strip */}
          <div className="flex items-center gap-2.5 mt-1.5 text-[10px] tabular text-text-muted">
            {run.spot_at_run != null && <span>spot {fmt(run.spot_at_run, 2)}</span>}
            {run.mid_at_run != null && <span>mid {fmtCurrency(run.mid_at_run)}</span>}
            {run.duration_ms != null && <span>{(run.duration_ms / 1000).toFixed(1)}s</span>}
            <span className="ml-auto flex items-center gap-0.5 text-accent opacity-0 group-hover:opacity-100 transition-opacity">
              Open analyzer <ArrowUpRight size={11} />
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}
