"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, type MonitorEntry, type MonitorSnapshot, type OpenSpreadContext, type ScheduledJob } from "@/lib/api";
import { ws } from "@/lib/ws";
import type { WSMessage } from "@/types";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Stat, StatGroup } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, TableSkeletonRows } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { RiRefreshLine as RefreshCw, RiShieldCheckLine as ShieldIcon, RiErrorWarningFill as ErrorIcon } from "@remixicon/react";
import { InfoIcon } from "@/components/ui/info-icon";
import { Odds, SpreadHistoryCard, spreadKey, useOpenSpreadOdds } from "./SpreadHistoryCard";

const STATUS_META: Record<MonitorEntry["status"], { label: string; tone: string; badge: "up" | "warning" | "down" | "muted" }> = {
  safe:    { label: "Safe",         tone: "text-status-lime-text",   badge: "up" },
  warning: { label: "Near trigger", tone: "text-status-yellow-text", badge: "warning" },
  trigger: { label: "Exit now",     tone: "text-status-rose-text",   badge: "down" },
  unknown: { label: "No data",      tone: "text-text-tertiary",      badge: "muted" },
};

export function ExitMonitor() {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const s = await api.monitorState();
      setSnap(s);
      setError(null);
    } catch (e) {
      // keep last good snapshot; surface the failure only when we have nothing
      setError(e instanceof Error ? e.message : "Could not reach the monitor");
    }
  };

  useEffect(() => {
    load();
    api.scheduledJobs().then((r) => setJobs(r.jobs)).catch(() => setJobs([]));
    // Reduce polling to 60s now that WS push-alerts the page on every
    // threshold crossing. The interval is a safety-net catch-up.
    const id = setInterval(load, 60000);
    const unsub = ws.on((msg: WSMessage) => {
      if (msg.type !== "monitor_alert" || !msg.data) return;
      const entry = msg.data as MonitorEntry;
      // Toast immediately on push, then refresh state so the row updates.
      const tone = entry.status === "trigger" ? "error" : "warning";
      const headline = entry.status === "trigger"
        ? `Exit now, ${entry.symbol} ${entry.short_strike}`
        : `Near trigger, ${entry.symbol} ${entry.short_strike}`;
      const body = `Short delta ${entry.current_delta?.toFixed(1)}, trigger ${entry.exit_delta}`;
      if (tone === "error") toast.error(headline, { description: body });
      else toast(headline, { description: body });
      load();
    });
    return () => {
      clearInterval(id);
      unsub();
    };
  }, []);

  const refresh = async () => {
    setLoading(true);
    try {
      const s = await api.monitorRefresh();
      setSnap(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  };

  const entries = useMemo(() => (Array.isArray(snap?.entries) ? snap!.entries : []), [snap]);
  const initialLoading = !snap && !error;

  // History odds for every open spread, matched to the monitor's rows so the
  // book is one table: delta against its trigger, and what past trades in
  // the same spot went on to do.
  const odds = useOpenSpreadOdds();
  const byKey = useMemo(() => {
    const m = new Map<string, OpenSpreadContext>();
    for (const x of odds.data?.spreads ?? []) m.set(spreadKey(x.symbol, x.expiry, x.short_strike, x.long_strike), x);
    return m;
  }, [odds.data]);
  const shown = useMemo(
    () => new Set(entries.map((e) => spreadKey(e.symbol, e.expiry, e.short_strike, e.long_strike))),
    [entries]
  );
  const cov = odds.data?.coverage;

  return (
    <PageShell>
      <PageHeader
        title="Exit monitor"
        description="Every open credit spread, its short delta against the exit trigger, and what past trades in the same spot went on to do."
        actions={
          <Button onClick={refresh} disabled={loading} variant="secondary">
            <RefreshCw className={loading ? "animate-spin" : ""} />
            {loading ? "Refreshing" : "Refresh now"}
          </Button>
        }
      />

      <SummaryCard snap={snap} loading={initialLoading} />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 min-w-0">
            <CardTitle>Open spreads</CardTitle>
            {snap && <Badge variant="muted" className="tabular">{entries.length}</Badge>}
          </div>
          <div className="flex items-center gap-3">
            {error && snap && (
              <Badge variant="down">
                <ErrorIcon size={14} aria-hidden="true" />
                Stale, last refresh failed
              </Badge>
            )}
            <Link href="/odds" className="text-caption-1-medium text-accent-600 hover:underline">
              All spread odds
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {initialLoading ? (
            <SpreadsTable>
              <TableSkeletonRows rows={3} cols={6} widths={["w-24", "w-16", "w-full", "w-12", "w-12", "w-full"]} />
            </SpreadsTable>
          ) : error && !snap ? (
            <div className="flex flex-col items-center gap-3 py-12">
              <Badge variant="down">
                <ErrorIcon size={14} aria-hidden="true" />
                {error}
              </Badge>
              <Button variant="secondary" onClick={load}>
                <RefreshCw />
                Retry
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={ShieldIcon}
              title="No open spreads to watch"
              description="When you open a credit spread it appears here and the monitor tracks its delta every 5 minutes during market hours."
            />
          ) : (
            <SpreadsTable historyHint={cov ? `${cov.trades.toLocaleString()} replayed monthly cycles since ${cov.first_entry?.slice(0, 4)}. Past trades of the same strategy within 5 delta points at the same time to expiry, and how many later hit the delta or Thursday exit.` : undefined}>
              {entries.map((e) => (
                <Row key={e.spread_id} entry={e} ctx={byKey.get(spreadKey(e.symbol, e.expiry, e.short_strike, e.long_strike))} />
              ))}
            </SpreadsTable>
          )}
        </CardContent>
        <Footer jobs={jobs} lastRun={snap?.last_run ?? null} />
      </Card>

      <SpreadHistoryCard odds={odds} exclude={shown} />
    </PageShell>
  );
}

function SummaryCard({ snap, loading }: { snap: MonitorSnapshot | null; loading: boolean }) {
  const hasCounts = !!snap && typeof snap.count === "number";
  const safe = hasCounts ? snap!.count - (snap!.warning ?? 0) - (snap!.triggered ?? 0) : 0;
  return (
    <Card>
      <CardContent>
        <StatGroup cols={4}>
          {loading ? (
            [0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-5 w-10" />
              </div>
            ))
          ) : (
            <>
              <Stat label="Watching" value={hasCounts ? snap!.count : "n/a"} size="md" />
              <Stat label="Safe" value={hasCounts ? safe : "n/a"} size="md" tone={safe > 0 ? "up" : "default"} />
              <Stat label="Near trigger" value={hasCounts ? snap!.warning : "n/a"} size="md" tone={hasCounts && snap!.warning > 0 ? "warning" : "default"} />
              <Stat label="Exit now" value={hasCounts ? snap!.triggered : "n/a"} size="md" tone={hasCounts && snap!.triggered > 0 ? "down" : "default"} />
            </>
          )}
        </StatGroup>
      </CardContent>
    </Card>
  );
}

function SpreadsTable({ children, historyHint }: { children: React.ReactNode; historyHint?: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Spread</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="min-w-[200px]">Short delta against exit</TableHead>
          <TableHead className="text-right">Cushion</TableHead>
          <TableHead className="text-right">Days left</TableHead>
          <TableHead className="min-w-[240px]">
            <span className="inline-flex items-center gap-1">
              Past trades in this spot
              {historyHint && <InfoIcon hint={historyHint} />}
            </span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function Row({ entry, ctx }: { entry: MonitorEntry; ctx?: OpenSpreadContext }) {
  const meta = STATUS_META[entry.status];
  const trigger = entry.exit_delta;
  const current = entry.current_delta;
  // Position the marker on a 0..50 delta scale.
  const pct = current != null ? Math.min(100, (current / 50) * 100) : 0;
  const triggerPct = Math.min(100, (trigger / 50) * 100);
  const fill = entry.status === "trigger" ? "bg-status-rose-text" : entry.status === "warning" ? "bg-status-yellow-text" : "bg-status-lime-text";

  return (
    <TableRow className="h-14">
      <TableCell className="whitespace-nowrap">
        <div className="flex flex-col">
          <span className="tabular">
            {entry.symbol} {entry.short_strike}
            <span className="text-text-tertiary"> / </span>
            {entry.long_strike}
          </span>
          <span className="text-caption-1-medium text-text-tertiary">
            {entry.spread_type}, {entry.quantity} contract{entry.quantity === 1 ? "" : "s"}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={meta.badge}>{meta.label}</Badge>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-3">
          <div className="relative h-5 flex-1 min-w-[96px]" aria-label={`short delta ${current ?? "n/a"}, exit at ${trigger}`}>
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-background-tertiary-default" />
            {current != null && (
              <div className={cn("absolute left-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full opacity-40", fill)} style={{ width: `${pct}%` }} />
            )}
            <div
              className="absolute top-0 bottom-0 w-0.5 -ml-px rounded-full bg-status-rose-text"
              style={{ left: `${triggerPct}%` }}
              title={`exit at delta ${trigger}`}
            />
            {current != null && (
              <div
                className={cn("absolute top-1/2 size-2.5 rounded-full ring-2 ring-background-primary-default", fill)}
                style={{ left: `${pct}%`, transform: "translate(-50%, -50%)" }}
              />
            )}
          </div>
          <span className="tabular whitespace-nowrap text-right w-[72px] shrink-0">
            <span className={meta.tone}>{current != null ? current.toFixed(1) : "n/a"}</span>
            <span className="text-text-tertiary"> / {trigger}</span>
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right tabular">
        {ctx?.cushion_pct != null ? (
          <span className={cn(ctx.cushion_pct < (ctx.last_day_buffer_pct ?? 2) ? "text-status-rose-text" : "text-text-primary")}>
            {ctx.cushion_pct.toFixed(1)}%
          </span>
        ) : (
          <span className="text-text-tertiary">n/a</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular">
        {ctx?.days_left != null ? ctx.days_left : <span className="text-text-tertiary">n/a</span>}
      </TableCell>
      <TableCell>
        {ctx ? <Odds h={ctx.history} /> : <span className="text-caption-1-regular text-text-tertiary">Loading odds</span>}
      </TableCell>
    </TableRow>
  );
}

// Plain words for the footer: when it last looked and whether it will look
// again on its own. Job ids are for the logs, not the desk.
function Footer({ jobs, lastRun }: { jobs: ScheduledJob[]; lastRun: string | null }) {
  const job = Array.isArray(jobs) ? jobs.find((j) => j.id.includes("exit")) : undefined;
  const next = job?.next_run_time ? new Date(job.next_run_time) : null;
  return (
    <CardFooter className="justify-between">
      <span className="text-caption-1-medium text-text-tertiary tabular">
        Last checked {lastRun ? new Date(lastRun).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "never"}
      </span>
      <span className="text-caption-1-medium text-text-tertiary truncate tabular">
        {job
          ? next && !Number.isNaN(next.getTime())
            ? `Checks every 5 minutes in market hours, next at ${next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : "Checks every 5 minutes in market hours"
          : "Automatic checks are off"}
      </span>
    </CardFooter>
  );
}
