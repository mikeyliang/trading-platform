"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  api,
  type RecentAgentRun,
  type ForecastTrackRecord,
} from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Logo } from "@/components/ui/logo";
import { toast } from "@/components/ui/toaster";
import { cn, fmt, fmtCurrency } from "@/lib/utils";
import { RiRefreshLine as RefreshCw, RiFocus3Line as Target, RiBrainLine as Brain, RiArrowRightUpLine as ArrowUpRight, RiAlertFill as AlertTriangle, RiTimeLine as Clock } from "@remixicon/react";

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
  up: "text-status-lime-text",
  down: "text-status-rose-text",
  warning: "text-status-yellow-text",
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
            (s.skipped ? `, ${s.skipped} already done today` : "") +
            (s.failed ? `, ${s.failed} failed` : "")
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
        description="Every AI verdict and forecast you have run, tracked over time."
        actions={
          <>
            <Button variant="secondary" size="icon" onClick={load} title="Refresh" aria-label="Refresh">
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
            <Button
              variant="secondary"
              onClick={scoreNow}
              disabled={scoring}
              title="Score forecasts whose horizon has elapsed against realised closes"
            >
              <Target className={cn(scoring && "animate-pulse")} />
              {scoring ? "Scoring" : "Score forecasts"}
            </Button>
            <Button
              variant="default"
              onClick={analyzePositions}
              disabled={analyzing}
              title="Run the AI agents on every open option position now and store each verdict"
            >
              <Brain className={cn(analyzing && "animate-pulse")} />
              {analyzing ? "Analyzing" : "Analyze positions"}
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
  mean_reversion: "Mean reversion",
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
  const models = useMemo(() => track?.models ?? {}, [track]);
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
      <CardHeader>
        <CardTitle>Forecast track record</CardTitle>
        {c && (
          <div className="flex items-center gap-1.5">
            <Badge variant="muted" className="tabular">{c.logged} logged</Badge>
            <Badge variant="up" className="tabular">{c.scored} scored</Badge>
            <Badge variant="warning" className="tabular">{c.pending} pending</Badge>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {loading && !track ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ) : !hasScored ? (
          <div className="flex items-start gap-3 rounded-2lg bg-background-secondary-default p-3 text-body-2-regular text-text-secondary">
            <Clock size={18} className="text-status-yellow-text mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <span className="text-text-primary text-body-2-medium">{c?.pending ?? 0} forecasts logged, accumulating.</span>{" "}
              Each prediction is scored against the realised close once its horizon elapses
              (nightly, or press Score forecasts to backfill now). Per-model
              accuracy appears here as soon as the first horizon completes.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* per-model accuracy */}
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-center">
              <div className="contents text-caption-1-medium text-text-tertiary">
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
                    <div className="text-body-2-medium text-text-primary flex items-center gap-1.5">
                      {MODEL_LABEL[m] ?? m}
                      <span className="text-caption-1-medium text-text-tertiary tabular">n={s.n}</span>
                    </div>
                    <div className="grid grid-cols-[3rem_3rem_1fr] gap-2 items-center text-body-2-medium tabular">
                      <span className="text-right text-text-secondary">
                        {s.mae_pct != null ? `${fmt(s.mae_pct, 2)}%` : "n/a"}
                      </span>
                      <span className="text-right text-text-secondary">
                        {s.rmse_pct != null ? `${fmt(s.rmse_pct, 2)}%` : "n/a"}
                      </span>
                      <HitRateBar value={hr} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* per-symbol ensemble breakdown */}
            {track && track.per_symbol.length > 0 && (
              <div className="rounded-2lg bg-background-secondary-default p-3">
                <div className="text-caption-1-medium text-text-tertiary mb-2">
                  Ensemble by symbol
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {track.per_symbol.map((p) => (
                    <div
                      key={p.symbol}
                      className="flex items-center gap-1.5 px-2 h-6 rounded-md bg-background-primary-default shadow-xs"
                      title={`${p.n} scored, MAE ${p.mae_pct ?? "n/a"}%`}
                    >
                      <Logo symbol={p.symbol} size={14} />
                      <span className="text-caption-1-medium text-text-primary">{p.symbol}</span>
                      <span
                        className={cn(
                          "text-caption-1-medium tabular",
                          (p.hit_rate ?? 0) >= 0.5 ? "text-status-lime-text" : "text-status-rose-text"
                        )}
                      >
                        {p.hit_rate != null ? `${Math.round(p.hit_rate * 100)}%` : "n/a"}
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
      <div className="flex-1 h-1.5 rounded-full bg-background-tertiary-default overflow-hidden relative">
        {/* 50% reference marker */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-separator-border z-10" />
        <div
          className={cn(
            "h-full rounded-full",
            good ? "bg-status-lime-text" : mid ? "bg-status-yellow-text" : "bg-status-rose-text"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={cn(
          "w-9 text-right tabular",
          good ? "text-status-lime-text" : mid ? "text-status-yellow-text" : "text-status-rose-text"
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
  const count = runs?.length ?? 0;
  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>AI verdicts</CardTitle>
          {runs && <Badge variant="muted" className="tabular">{count}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading && !runs ? (
          <div className="flex flex-col">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-2 px-4 py-3 border-b border-separator-border last:border-b-0">
                <Skeleton className="h-3 w-1/4" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : !runs || runs.length === 0 ? (
          <EmptyState
            icon={Brain}
            title="No AI runs yet"
            description="Open a contract in the analyzer and run the AI agents. Verdicts land here as a portfolio-wide log you can revisit without re-spending tokens."
          />
        ) : (
          <ul className="flex flex-col">
            {runs.map((r) => (
              <li key={r.id} className="border-b border-separator-border last:border-b-0">
                <VerdictRow run={r} nowMs={nowMs} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function VerdictRow({ run, nowMs }: { run: RecentAgentRun; nowMs: number }) {
  const tone = verdictTone(run.verdict, run.is_long);
  const dir = run.is_long ? "Long" : "Short";
  const qty = Math.abs(run.quantity);
  return (
    <Link
      href={analyzerHref(run)}
      className="group flex items-stretch gap-3 px-4 py-3 hover:bg-background-secondary-hover transition-colors"
    >
      {/* tone rail */}
      <div
        className={cn(
          "w-0.5 rounded-full shrink-0",
          tone === "up" && "bg-status-lime-text",
          tone === "down" && "bg-status-rose-text",
          tone === "warning" && "bg-status-yellow-text",
          tone === "muted" && "bg-separator-border"
        )}
      />
      <div className="flex-1 min-w-0">
        {/* contract line */}
        <div className="flex items-center gap-2 mb-1">
          <Logo symbol={run.symbol} size={16} />
          <span className="text-body-2-medium text-text-primary tabular">
            {run.symbol} {fmt(run.strike, 0)}
            {run.right}
          </span>
          <span className="flex items-center gap-2 text-caption-1-medium tabular text-text-tertiary">
            <span>{qty} contract{qty === 1 ? "" : "s"}</span>
            <span>{dir}</span>
            <span>{fmtExpiry(run.expiry)}</span>
          </span>
          {run.failed_agents > 0 && (
            <Badge variant="warning">
              <AlertTriangle size={14} aria-hidden="true" />
              {run.failed_agents} failed
            </Badge>
          )}
          <span className="ml-auto text-caption-1-medium tabular text-text-tertiary shrink-0">
            {timeAgo(run.ran_at, nowMs)}
          </span>
        </div>
        {/* verdict */}
        <div className={cn("text-body-2-medium line-clamp-2", TONE_TEXT[tone])}>
          {run.verdict ?? "n/a"}
        </div>
        {run.rationale && (
          <div className="text-body-2-regular text-text-secondary mt-0.5 line-clamp-2">
            {run.rationale}
          </div>
        )}
        {/* context strip */}
        <div className="flex items-center gap-3 mt-1.5 text-caption-1-medium tabular text-text-tertiary">
          {run.spot_at_run != null && <span>Spot {fmt(run.spot_at_run, 2)}</span>}
          {run.mid_at_run != null && <span>Mid {fmtCurrency(run.mid_at_run)}</span>}
          {run.duration_ms != null && <span>{(run.duration_ms / 1000).toFixed(1)}s</span>}
          <span className="ml-auto flex items-center gap-0.5 text-accent-600 opacity-0 group-hover:opacity-100 transition-opacity">
            Open analyzer <ArrowUpRight size={14} aria-hidden="true" />
          </span>
        </div>
      </div>
    </Link>
  );
}
