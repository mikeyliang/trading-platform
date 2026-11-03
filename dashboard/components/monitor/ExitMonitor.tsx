"use client";

import { useEffect, useState } from "react";
import { api, type MonitorEntry, type MonitorSnapshot, type ScheduledJob } from "@/lib/api";
import { ws } from "@/lib/ws";
import type { WSMessage } from "@/types";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { RiRefreshLine as RefreshCw } from "@remixicon/react";

const STATUS_META: Record<MonitorEntry["status"], { label: string; tone: string; dot: string }> = {
  safe:    { label: "safe",         tone: "text-status-lime-text",         dot: "bg-status-lime-text" },
  warning: { label: "near trigger", tone: "text-status-yellow-text",    dot: "bg-status-yellow-text" },
  trigger: { label: "exit now",     tone: "text-status-rose-text",       dot: "bg-status-rose-text" },
  unknown: { label: "no data",      tone: "text-text-tertiary", dot: "bg-foreground-icon-quaternary" },
};

export function ExitMonitor() {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    try {
      const s = await api.monitorState();
      setSnap(s);
    } catch {
      // keep last good
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
        ? `EXIT NOW, ${entry.symbol} ${entry.short_strike}`
        : `Near trigger, ${entry.symbol} ${entry.short_strike}`;
      const body = `short Δ ${entry.current_delta?.toFixed(1)} · trigger ${entry.exit_delta}`;
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
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow="Open positions, refreshed every 5 min"
        title="Exit Monitor"
        description="Watches every open credit spread. When the short leg's delta crosses the trade-type exit threshold, you'll see it here before you'd notice it on the chart."
        actions={
          <Button onClick={refresh} disabled={loading} size="sm" variant="default">
            <RefreshCw className={loading ? "animate-spin" : ""} />
            <span className="hidden sm:inline">{loading ? "Refreshing…" : "Refresh now"}</span>
          </Button>
        }
      />

      <SummaryStrip snap={snap} />

      {!snap || snap.entries.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col">
          {snap.entries.map((e) => (
            <Row key={e.spread_id} entry={e} />
          ))}
        </div>
      )}

      <Footer jobs={jobs} lastRun={snap?.last_run ?? null} />
    </PageShell>
  );
}

function SummaryStrip({ snap }: { snap: MonitorSnapshot | null }) {
  if (!snap || typeof snap.count !== "number") return null;
  const safe = snap.count - (snap.warning ?? 0) - (snap.triggered ?? 0);
  const stats: [string, string, string?][] = [
    ["watching",  snap.count.toString()],
    ["safe",      safe.toString(), safe > 0 ? "text-status-lime-text" : undefined],
    ["warning",   snap.warning.toString(), snap.warning > 0 ? "text-status-yellow-text" : undefined],
    ["trigger",   snap.triggered.toString(), snap.triggered > 0 ? "text-status-rose-text" : undefined],
  ];
  return (
    <div className="grid grid-cols-4 gap-x-4 md:gap-x-10 py-2">
      {stats.map(([k, v, tone]) => (
        <div key={k}>
          <div className="text-caption-2-regular text-text-tertiary mb-1.5">{k}</div>
          <div className={cn("text-title-2-regular md:text-title-1-regular font-semibold tabular", tone ?? "text-text-primary")}>
            {v}
          </div>
        </div>
      ))}
    </div>
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
    <div className="border-t border-separator-border py-3">
      <div className="flex items-baseline justify-between gap-4 mb-5">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className={cn("w-1.5 h-1.5 rounded-full translate-y-[-2px] shrink-0", meta.dot)} />
          <div className="tabular text-headline-regular tabular text-text-primary truncate">
            {entry.symbol} {entry.short_strike}<span className="text-text-tertiary"> / </span>{entry.long_strike}
          </div>
          <span className="text-text-tertiary text-caption-2-regular hidden sm:inline">{entry.spread_type}</span>
        </div>
        <div className={cn("text-caption-1-regular shrink-0", meta.tone)}>{meta.label}</div>
      </div>

      <div className="flex flex-col md:flex-row md:items-center md:gap-4 gap-2">
        {/* delta scale */}
        <div className="relative h-8 flex-1">
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-separator-border" />
          {/* trigger threshold marker */}
          <div
            className="absolute top-1 bottom-1 w-px bg-status-rose-background"
            style={{ left: `${triggerPct}%` }}
            aria-label={`exit Δ ${trigger}`}
          />
          <div
            className="absolute -top-0.5 text-caption-2-regular tabular text-status-rose-text/80 -translate-x-1/2"
            style={{ left: `${triggerPct}%` }}
          >
            exit {trigger}
          </div>
          {/* current delta marker */}
          {current != null && (
            <>
              <div
                className={cn(
                  "absolute top-1/2 w-2.5 h-2.5 rounded-full ring-2 ring-bg",
                  entry.status === "trigger" ? "bg-status-rose-text" : entry.status === "warning" ? "bg-status-yellow-text" : "bg-status-lime-text"
                )}
                style={{ left: `${pct}%`, transform: "translate(-50%, -50%)" }}
              />
              <div
                className="absolute -bottom-0.5 text-caption-2-regular tabular text-text-secondary -translate-x-1/2"
                style={{ left: `${pct}%` }}
              >
                Δ {current.toFixed(1)}
              </div>
            </>
          )}
        </div>

        <div className="flex items-baseline justify-between md:justify-end gap-4 md:gap-3 text-caption-1-regular tabular shrink-0">
          <span className="text-text-secondary">{entry.quantity}× contract{entry.quantity !== 1 ? "s" : ""}</span>
          <span className="text-text-tertiary">·</span>
          <span className="text-text-tertiary">
            headroom <span className={cn(meta.tone, "font-medium")}>{entry.headroom != null ? entry.headroom.toFixed(1) : "n/a"}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-16 text-center">
      <p className="text-body-2-regular text-text-secondary">No open spreads to watch.</p>
      <p className="text-caption-1-regular text-text-tertiary mt-2">
        When you open a credit spread, it'll appear here and the monitor will track its delta every 5 minutes during market hours.
      </p>
    </div>
  );
}

function Footer({ jobs, lastRun }: { jobs: ScheduledJob[]; lastRun: string | null }) {
  return (
    <div className="border-t border-separator-border pt-4 flex items-baseline justify-between text-caption-2-regular text-text-tertiary">
      <span>Last checked {lastRun ? new Date(lastRun).toLocaleTimeString() : "never"}</span>
      <span className="text-caption-1-regular text-text-secondary">
        {(Array.isArray(jobs) && jobs.length > 0) ? `Scheduled: ${jobs.map((j) => j.id).join(", ")}` : "No jobs scheduled"}
      </span>
    </div>
  );
}
