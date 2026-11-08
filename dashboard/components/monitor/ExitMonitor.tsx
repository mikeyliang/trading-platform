"use client";

import { useEffect, useState } from "react";
import { api, type MonitorEntry, type MonitorSnapshot, type ScheduledJob } from "@/lib/api";
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
import { SpreadHistoryCard } from "./SpreadHistoryCard";

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

  const entries = Array.isArray(snap?.entries) ? snap!.entries : [];
  const initialLoading = !snap && !error;

  return (
    <PageShell>
      <PageHeader
        title="Exit monitor"
        description="Watches every open credit spread and flags it when the short leg's delta crosses the exit threshold for its trade type."
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
          {error && snap && (
            <Badge variant="down">
              <ErrorIcon size={14} aria-hidden="true" />
              Stale, last refresh failed
            </Badge>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {initialLoading ? (
            <SpreadsTable>
              <TableSkeletonRows rows={3} cols={8} widths={["w-24", "w-16", "w-16", "w-full", "w-10", "w-10", "w-10", "w-8"]} />
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
            <SpreadsTable>
              {entries.map((e) => (
                <Row key={e.spread_id} entry={e} />
              ))}
            </SpreadsTable>
          )}
        </CardContent>
        <Footer jobs={jobs} lastRun={snap?.last_run ?? null} />
      </Card>

      <SpreadHistoryCard />
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

function SpreadsTable({ children }: { children: React.ReactNode }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Spread</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="min-w-[220px]">Delta scale</TableHead>
          <TableHead className="text-right">Short delta</TableHead>
          <TableHead className="text-right">Exit at</TableHead>
          <TableHead className="text-right">Headroom</TableHead>
          <TableHead className="text-right">Contracts</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function Row({ entry }: { entry: MonitorEntry }) {
  const meta = STATUS_META[entry.status];
  const trigger = entry.exit_delta;
  const current = entry.current_delta;
  // Position the marker on a 0..50 delta scale.
  const pct = current != null ? Math.min(100, (current / 50) * 100) : 0;
  const triggerPct = Math.min(100, (trigger / 50) * 100);

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        {entry.symbol} {entry.short_strike}
        <span className="text-text-tertiary"> / </span>
        {entry.long_strike}
      </TableCell>
      <TableCell className="text-text-secondary">{entry.spread_type}</TableCell>
      <TableCell>
        <Badge variant={meta.badge}>{meta.label}</Badge>
      </TableCell>
      <TableCell>
        <div className="relative h-5" aria-label={`short delta ${current ?? "n/a"}, exit at ${trigger}`}>
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-background-tertiary-default" />
          <div
            className="absolute top-0.5 bottom-0.5 w-px bg-status-rose-text"
            style={{ left: `${triggerPct}%` }}
            title={`exit at delta ${trigger}`}
          />
          {current != null && (
            <div
              className={cn(
                "absolute top-1/2 size-2.5 rounded-full ring-2 ring-background-primary-default",
                entry.status === "trigger" ? "bg-status-rose-text" : entry.status === "warning" ? "bg-status-yellow-text" : "bg-status-lime-text"
              )}
              style={{ left: `${pct}%`, transform: "translate(-50%, -50%)" }}
            />
          )}
        </div>
      </TableCell>
      <TableCell className={cn("text-right", meta.tone)}>{current != null ? current.toFixed(1) : "n/a"}</TableCell>
      <TableCell className="text-right text-text-secondary">{trigger}</TableCell>
      <TableCell className={cn("text-right", meta.tone)}>{entry.headroom != null ? entry.headroom.toFixed(1) : "n/a"}</TableCell>
      <TableCell className="text-right text-text-secondary">{entry.quantity}</TableCell>
    </TableRow>
  );
}

function Footer({ jobs, lastRun }: { jobs: ScheduledJob[]; lastRun: string | null }) {
  const scheduled = Array.isArray(jobs) && jobs.length > 0;
  return (
    <CardFooter className="justify-between">
      <span className="text-caption-1-medium text-text-tertiary tabular">
        Last checked {lastRun ? new Date(lastRun).toLocaleTimeString() : "never"}
      </span>
      <span className="text-caption-1-medium text-text-tertiary truncate">
        {scheduled ? `Scheduled: ${jobs.map((j) => j.id).join(", ")}` : "No jobs scheduled"}
      </span>
    </CardFooter>
  );
}
