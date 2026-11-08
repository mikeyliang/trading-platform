"use client";

// IBKR Flex backfill control surface. Shows what's currently in the trade
// store from Flex (rows, date span, per-account split), surfaces token /
// cooldown state, and lets the user kick off a multi-year sweep.
//
// The Flex backfill endpoint is long-running (each 365d slice is a fresh
// IBKR report build + poll, ~15-45s per slice). We POST once and let the
// browser hold the connection, there's no job queue yet. While we wait,
// the card stays in a "Pulling…" state and the per-slice log streams in
// once the response lands.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiArrowRightSLine,
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleFill,
  RiErrorWarningFill,
  RiLoader4Line,
  RiRefreshLine,
} from "@remixicon/react";
import {
  api,
  type FlexBackfillResult,
  type FlexBackfillStatus,
  type FlexJobState,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat, StatGroup } from "@/components/ui/stat";
import { ToggleGroup } from "@/components/ui/toggle-group";

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

  const blocked = pulling || cooldownLive > 0 || !status?.configured;

  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>IBKR Flex backfill</CardTitle>
          {status && <ConfiguredBadge configured={status.configured} queryId={status.query_id} />}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={refreshStatus}
          disabled={statusLoading}
          aria-label="Refresh status"
        >
          <RiRefreshLine className={statusLoading ? "animate-spin" : ""} />
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {statusLoading && !status ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" role="status" aria-label="Loading Flex status">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
          </div>
        ) : (
          <StatGroup cols={4}>
            <Stat
              label="Rows from Flex"
              value={status?.total_rows != null ? status.total_rows.toLocaleString() : "n/a"}
            />
            <Stat label="Earliest" value={status?.earliest ? fmtIsoDate(status.earliest) : "n/a"} />
            <Stat label="Latest" value={status?.latest ? fmtIsoDate(status.latest) : "n/a"} />
            <Stat
              label="Accounts"
              value={
                status?.accounts?.length ? (
                  <span className="inline-flex items-baseline gap-3">
                    {status.accounts.map((a) => (
                      <span key={a.account_id}>
                        {a.account_id} <span className="text-caption-1-regular text-text-tertiary">{a.rows.toLocaleString()} rows</span>
                      </span>
                    ))}
                  </span>
                ) : (
                  "n/a"
                )
              }
            />
          </StatGroup>
        )}

        {statusError && (
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="down" className="gap-1 max-w-full">
              <RiErrorWarningFill size={14} aria-hidden />
              <span className="truncate">Status unavailable: {statusError}</span>
            </Badge>
            <Button variant="secondary" size="sm" onClick={refreshStatus}>Retry</Button>
          </div>
        )}

        {/* Progress / result, visible during and after a backfill. */}
        {pullError && <NoteTile tone="error" text={pullError} />}
        {job?.status === "running" && <JobProgress job={job} />}
        {lastResult && job?.status !== "running" && <BackfillResultStrip result={lastResult} />}
      </CardContent>

      <CardFooter className="h-auto min-h-11 py-2 flex-wrap">
        <span className="text-caption-1-medium text-text-tertiary">Pull</span>
        <YearsToggle value={years} onChange={setYears} disabled={pulling} />
        <span className="text-caption-1-regular text-text-tertiary">365-day slice{years > 1 ? "s" : ""}</span>

        <Button
          variant="secondary"
          size="sm"
          aria-pressed={refresh}
          disabled={pulling}
          onClick={() => setRefresh((v) => !v)}
          title="Overwrite existing rows on (source, external_id) conflict, useful to refresh timestamps after parser changes"
        >
          {refresh ? <RiCheckboxCircleFill className="text-accent-600" /> : <RiCheckboxBlankCircleLine />}
          Refresh existing
        </Button>

        <Button
          variant="default"
          onClick={onBackfill}
          disabled={blocked}
          className="ml-auto"
        >
          {pulling ? (
            <>
              <RiLoader4Line className="animate-spin" />
              Pulling
            </>
          ) : cooldownLive > 0 ? (
            <span className="tabular">Cooldown {fmtDuration(cooldownLive)}</span>
          ) : !status?.configured ? (
            "Not configured"
          ) : (
            `${refresh ? "Refresh" : "Backfill"} ${years}y`
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ConfiguredBadge({
  configured, queryId,
}: { configured: boolean; queryId: string | null }) {
  if (!configured) {
    return <Badge variant="warning">Not configured</Badge>;
  }
  return (
    <Badge variant="up" className="tabular" title="IBKR Flex token and query id configured">
      Query {queryId ?? "n/a"}
    </Badge>
  );
}

function YearsToggle({
  value, onChange, disabled,
}: { value: number; onChange: (n: number) => void; disabled: boolean }) {
  return (
    <div className={cn(disabled && "opacity-60 pointer-events-none")}>
      <ToggleGroup
        ariaLabel="Years to pull"
        value={String(value)}
        onChange={(v) => onChange(Number(v))}
        options={YEARS_OPTIONS.map((n) => ({ value: String(n), label: `${n}y` }))}
      />
    </div>
  );
}

function JobProgress({ job }: { job: FlexJobState }) {
  const total = Math.max(1, job.slice_count);
  // Done slices = current_slice - 1 if a slice is in flight, else
  // current_slice. We don't know which, so use current_slice as a proxy
  // for "slices touched so far", close enough for a progress bar.
  const done = Math.min(total, job.current_slice);
  const pct = (done / total) * 100;
  const lastInfo = job.last_slice_info;
  return (
    <div className="rounded-2lg bg-background-secondary-default p-3 flex flex-col gap-2" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-caption-1-regular text-text-secondary tabular">
        <RiLoader4Line size={14} className="animate-spin text-accent-600" aria-hidden />
        <span>
          Slice <span className="text-text-primary">{done}</span> of {total}
        </span>
        {lastInfo?.from && lastInfo?.to && (
          <span className="text-text-tertiary">
            {fmtCompactDate(lastInfo.from)} to {fmtCompactDate(lastInfo.to)}
          </span>
        )}
        <span className="text-text-tertiary ml-auto">Job {job.id}</span>
      </div>
      <div className="relative h-1.5 w-full rounded-full bg-background-tertiary-default overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent-600 transition-[width] duration-500"
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
  const Icon = tone === "good" ? RiCheckboxCircleFill : RiErrorWarningFill;
  return (
    <div className="rounded-2lg bg-background-secondary-default p-3 flex flex-col gap-2">
      <div
        className={cn(
          "flex items-center gap-3 flex-wrap text-caption-1-regular tabular",
          tone === "good" && "text-status-lime-text",
          tone === "info" && "text-text-secondary",
          tone === "warn" && "text-status-yellow-text",
        )}
      >
        <Icon size={14} aria-hidden />
        <span>Fetched {(result.fetched ?? 0).toLocaleString()} ({result.trades} trades, {result.option_eae} EAE)</span>
        <span>Inserted {(result.inserted ?? 0).toLocaleString()}</span>
        {result.refresh && <span>Updated {(result.updated ?? 0).toLocaleString()}</span>}
        <span>
          Skipped {(result.skipped ?? 0).toLocaleString()}
          {result.skipped > 0 && !result.refresh && <span className="text-text-tertiary"> (dedup)</span>}
        </span>
      </div>
      <details className="group text-caption-1-regular text-text-tertiary">
        <summary className="inline-flex items-center gap-1 cursor-pointer hover:text-text-primary select-none list-none">
          <RiArrowRightSLine size={14} className="transition-transform group-open:rotate-90" aria-hidden />
          Slices ({result.slices?.length ?? 0})
        </summary>
        <ul className="mt-2 flex flex-col gap-1 tabular">
          {result.slices.map((s, i) => (
            <li key={i} className="flex items-center gap-3">
              {s.from && s.to ? (
                <span className="text-text-secondary">
                  {fmtCompactDate(s.from)} to {fmtCompactDate(s.to)}
                </span>
              ) : s.info ? (
                <span className="text-text-secondary">{s.info}</span>
              ) : null}
              {s.error ? (
                <span className="text-status-yellow-text">{s.error}</span>
              ) : s.trades != null ? (
                <span className="text-status-lime-text">+{s.trades} trades{s.option_eae ? `, +${s.option_eae} EAE` : ""}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function NoteTile({ tone, text }: { tone: "warn" | "error"; text: string }) {
  return (
    <div
      className={cn(
        "rounded-2lg px-3 py-2 flex items-start gap-2 text-body-2-regular",
        tone === "warn" && "bg-status-yellow-background text-status-yellow-text",
        tone === "error" && "bg-status-rose-background text-status-rose-text",
      )}
    >
      <RiErrorWarningFill size={16} className="shrink-0 mt-0.5" aria-hidden />
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
