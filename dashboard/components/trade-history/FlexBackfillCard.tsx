"use client";

// IBKR Flex backfill control surface. Shows what's currently in the trade
// store from Flex (rows, date span, per-account split), surfaces token /
// cooldown state, and lets the user kick off a multi-year sweep.
//
// The Flex backfill endpoint is long-running (each 365d slice is a fresh
// IBKR report build + poll, ~15-45s per slice). We POST once and let the
// browser hold the connection — there's no job queue yet. While we wait,
// the card stays in a "Pulling…" state and the per-slice log streams in
// once the response lands.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Database, Loader2, RefreshCw } from "lucide-react";
import {
  api,
  type FlexBackfillResult,
  type FlexBackfillStatus,
  type FlexJobState,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const YEARS_OPTIONS = [1, 2, 3, 5];

export function FlexBackfillCard() {
  const [status, setStatus] = useState<FlexBackfillStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [years, setYears] = useState<number>(3);
  const [refresh, setRefresh] = useState<boolean>(false);
  const [pulling, setPulling] = useState(false);
  const [lastResult, setLastResult] = useState<FlexBackfillResult | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  // Background-job tracking: when we hand off a multi-slice sweep, the
  // worker reports progress through this state via 2s polling.
  const [job, setJob] = useState<FlexJobState | null>(null);
  const pollAbort = useRef<{ cancelled: boolean } | null>(null);

  // Force re-render every second while a cooldown is active so the
  // "retry in Xs" label counts down without our event loop polling.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!status?.cooldown_sec) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [status?.cooldown_sec]);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.tradeHistoryFlexStatus();
      setStatus(s);
      setStatusError(null);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // Initial fetch + poll every 30s. We also refresh right after a backfill
  // completes so the row counts / latest-date update immediately.
  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 30_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Multi-slice sweeps go through the background path so the browser
  // doesn't hold an open HTTP connection for minutes. Single-year pulls
  // are fast enough to await inline.
  const useBackground = years > 1;

  const pollJob = useCallback(async (jobId: string) => {
    const ctl = { cancelled: false };
    pollAbort.current = ctl;
    while (!ctl.cancelled) {
      try {
        const j = await api.tradeHistoryFlexJob(jobId);
        if (ctl.cancelled) return;
        setJob(j);
        if (j.status !== "running") {
          if (j.result) setLastResult(j.result);
          if (j.error) setPullError(j.error);
          setPulling(false);
          await refreshStatus();
          return;
        }
      } catch (e) {
        if (ctl.cancelled) return;
        setPullError(e instanceof Error ? e.message : String(e));
        setPulling(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }, [refreshStatus]);

  const onBackfill = useCallback(async () => {
    setPulling(true);
    setPullError(null);
    setLastResult(null);
    setJob(null);
    try {
      if (useBackground) {
        const h = await api.tradeHistoryFlexBackfillBackground({
          years_back: years,
          refresh,
        });
        // Seed the job state from the handle so the UI immediately shows
        // "slice 0 / N" instead of an empty progress widget.
        setJob({
          id: h.job_id,
          status: "running",
          started_at: new Date().toISOString(),
          finished_at: null,
          slice_count: h.slice_count,
          current_slice: 0,
          last_slice_info: null,
          result: null,
          error: null,
          refresh: h.refresh,
          years_back: h.years_back,
        });
        await pollJob(h.job_id);
      } else {
        const r = await api.tradeHistoryFlexBackfill({
          years_back: years,
          refresh,
        });
        setLastResult(r);
        await refreshStatus();
        setPulling(false);
      }
    } catch (e) {
      setPullError(e instanceof Error ? e.message : String(e));
      setPulling(false);
    }
  }, [years, refresh, useBackground, refreshStatus, pollJob]);

  // Cancel any in-flight poll on unmount so we don't leak setState calls
  // after the component goes away.
  useEffect(() => {
    return () => {
      if (pollAbort.current) pollAbort.current.cancelled = true;
    };
  }, []);

  const cooldownLive = useMemo(() => {
    if (!status?.cooldown_sec) return 0;
    // We re-render on `tick`; recompute the remaining seconds from the
    // server-supplied value minus elapsed ticks (close-enough estimate).
    return Math.max(0, status.cooldown_sec - tick);
  }, [status?.cooldown_sec, tick]);

  return (
    <div className="border border-border/60 bg-surface rounded-md">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40">
        <Database size={13} className="text-text-muted" />
        <span className="text-[11px] uppercase tracking-wider text-text-secondary font-medium">
          IBKR Flex backfill
        </span>
        {status && (
          <ConfiguredBadge configured={status.configured} queryId={status.query_id} />
        )}
        <button
          type="button"
          onClick={refreshStatus}
          disabled={statusLoading}
          className="ml-auto inline-flex items-center justify-center h-5 w-5 rounded-sm text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors"
          title="Refresh status"
        >
          <RefreshCw size={11} className={statusLoading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 px-3 py-2.5">
        <StatBlock
          label="Rows from Flex"
          value={status ? status.total_rows.toLocaleString() : "—"}
        />
        <StatBlock
          label="Earliest"
          value={status?.earliest ? fmtIsoDate(status.earliest) : "—"}
        />
        <StatBlock
          label="Latest"
          value={status?.latest ? fmtIsoDate(status.latest) : "—"}
        />
        <StatBlock
          label="Accounts"
          value={
            status?.accounts.length
              ? status.accounts.map((a) => `${a.account_id} · ${a.rows}`).join(" · ")
              : "—"
          }
          mono
        />
      </div>

      {statusError && (
        <NoteRow
          tone="warn"
          icon={<AlertCircle size={11} />}
          text={`Couldn't load status: ${statusError}`}
        />
      )}

      <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-t border-border/40 bg-surface-2/20">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Pull</span>
        <YearsToggle value={years} onChange={setYears} disabled={pulling} />
        <span className="text-[10px] text-text-muted">365-day slice{years > 1 ? "s" : ""}</span>

        <label
          className={cn(
            "inline-flex items-center gap-1 h-6 px-2 rounded-sm border text-[10px] cursor-pointer select-none transition-colors",
            refresh
              ? "border-accent/50 bg-accent/10 text-accent"
              : "border-border bg-surface-2/40 text-text-secondary hover:bg-surface-2",
            pulling && "cursor-not-allowed opacity-60",
          )}
          title="Overwrite existing rows on (source, external_id) conflict — useful to refresh timestamps after parser changes"
        >
          <input
            type="checkbox"
            checked={refresh}
            onChange={(e) => setRefresh(e.target.checked)}
            disabled={pulling}
            className="sr-only"
          />
          <span className="tabular">Refresh existing</span>
        </label>

        <button
          type="button"
          onClick={onBackfill}
          disabled={pulling || cooldownLive > 0 || !status?.configured}
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 h-6 px-3 rounded-sm text-[11px] transition-colors",
            pulling || cooldownLive > 0 || !status?.configured
              ? "bg-surface-2 text-text-muted cursor-not-allowed"
              : "bg-accent/15 text-accent hover:bg-accent/25",
          )}
        >
          {pulling ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              <span>Pulling…</span>
            </>
          ) : cooldownLive > 0 ? (
            <span>Cooldown {fmtDuration(cooldownLive)}</span>
          ) : !status?.configured ? (
            <span>Not configured</span>
          ) : (
            <span>{refresh ? "Refresh" : "Backfill"} {years}y</span>
          )}
        </button>
      </div>

      {/* Progress / result strip — visible during and after a backfill. */}
      {(job?.status === "running" || lastResult || pullError) && (
        <div className="px-3 py-2 border-t border-border/40 text-[11px] tabular">
          {pullError && (
            <NoteRow
              tone="error"
              icon={<AlertCircle size={11} />}
              text={pullError}
            />
          )}
          {job?.status === "running" && (
            <JobProgress job={job} />
          )}
          {lastResult && job?.status !== "running" && (
            <BackfillResultStrip result={lastResult} />
          )}
        </div>
      )}
    </div>
  );
}

function StatBlock({
  label, value, mono,
}: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[9px] uppercase tracking-wider text-text-muted">{label}</span>
      <span
        className={cn(
          "text-[12px] text-text-primary truncate",
          mono ? "tabular text-[11px]" : "tabular font-medium",
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function ConfiguredBadge({
  configured, queryId,
}: { configured: boolean; queryId: string | null }) {
  if (!configured) {
    return (
      <span className="px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning text-[10px] uppercase tracking-wider">
        not configured
      </span>
    );
  }
  return (
    <span
      className="px-1.5 py-0.5 rounded-sm bg-up/10 text-up text-[10px] tabular"
      title="IBKR Flex token + query id configured"
    >
      query {queryId ?? "—"}
    </span>
  );
}

function YearsToggle({
  value, onChange, disabled,
}: { value: number; onChange: (n: number) => void; disabled: boolean }) {
  return (
    <div className="flex h-6 rounded-sm border border-border overflow-hidden">
      {YEARS_OPTIONS.map((n, i) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          disabled={disabled}
          className={cn(
            "px-2 text-[10px] tabular transition-colors",
            i > 0 && "border-l border-border",
            value === n
              ? "bg-accent/15 text-accent font-medium"
              : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          {n}y
        </button>
      ))}
    </div>
  );
}

function JobProgress({ job }: { job: FlexJobState }) {
  const total = Math.max(1, job.slice_count);
  // Done slices = current_slice - 1 if a slice is in flight, else
  // current_slice. We don't know which, so use current_slice as a proxy
  // for "slices touched so far" — close enough for a progress bar.
  const done = Math.min(total, job.current_slice);
  const pct = (done / total) * 100;
  const lastInfo = job.last_slice_info;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[11px] text-text-secondary">
        <Loader2 size={11} className="animate-spin text-accent" />
        <span>
          Slice <span className="text-text-primary tabular">{done}</span> / {total}
        </span>
        {lastInfo?.from && lastInfo?.to && (
          <span className="text-text-muted text-[10px]">
            {fmtCompactDate(lastInfo.from)} → {fmtCompactDate(lastInfo.to)}
          </span>
        )}
        <span className="text-text-muted text-[10px] ml-auto">job {job.id}</span>
      </div>
      <div className="relative h-1 w-full rounded-sm bg-surface-2 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-accent/70 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function BackfillResultStrip({ result }: { result: FlexBackfillResult }) {
  const tone =
    result.inserted > 0 || result.updated > 0 ? "good"
    : result.fetched > 0 ? "info"
    : "warn";
  const Icon = tone === "good" ? CheckCircle2 : AlertCircle;
  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          "inline-flex items-center gap-1.5 text-[11px] flex-wrap",
          tone === "good" && "text-up",
          tone === "info" && "text-text-secondary",
          tone === "warn" && "text-warning",
        )}
      >
        <Icon size={11} />
        <span>
          Fetched {result.fetched.toLocaleString()} ({result.trades} trades + {result.option_eae} EAE)
          · inserted {result.inserted.toLocaleString()}
          {result.refresh && (
            <>
              {" · "}updated {result.updated.toLocaleString()}
            </>
          )}
          {" · "}skipped {result.skipped.toLocaleString()}
          {result.skipped > 0 && !result.refresh && (
            <span className="text-text-muted"> (dedup)</span>
          )}
        </span>
      </div>
      <details className="text-[10px] text-text-muted">
        <summary className="cursor-pointer hover:text-text-secondary select-none">
          slices · {result.slices.length}
        </summary>
        <ul className="mt-1 ml-2 space-y-0.5 tabular">
          {result.slices.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              {s.from && s.to ? (
                <span className="text-text-secondary">
                  {fmtCompactDate(s.from)} → {fmtCompactDate(s.to)}
                </span>
              ) : s.info ? (
                <span className="text-text-secondary italic">{s.info}</span>
              ) : null}
              {s.error ? (
                <span className="text-warning">{s.error}</span>
              ) : s.trades != null ? (
                <span className="text-up">+{s.trades} trades{s.option_eae ? ` · +${s.option_eae} EAE` : ""}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function NoteRow({
  tone, icon, text,
}: { tone: "info" | "warn" | "error"; icon: React.ReactNode; text: string }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 w-full",
        tone === "info" && "text-text-secondary bg-surface-2/30",
        tone === "warn" && "text-warning bg-warning/5",
        tone === "error" && "text-down bg-down/5",
      )}
    >
      {icon}
      <span>{text}</span>
    </div>
  );
}

function fmtIsoDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtCompactDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}
