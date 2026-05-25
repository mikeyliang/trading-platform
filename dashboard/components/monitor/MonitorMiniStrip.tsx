"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type MonitorEntry, type MonitorSnapshot } from "@/lib/api";
import { ws } from "@/lib/ws";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import type { WSMessage } from "@/types";

const STATUS_TONE: Record<MonitorEntry["status"], string> = {
  safe: "text-up",
  warning: "text-warning",
  trigger: "text-down",
  unknown: "text-text-muted",
};
const STATUS_DOT: Record<MonitorEntry["status"], string> = {
  safe: "bg-up",
  warning: "bg-warning",
  trigger: "bg-down",
  unknown: "bg-text-muted",
};

/**
 * Compact strip — top of the Picker/Finder — that surfaces the exit monitor
 * for any open spreads so the user is alerted in-place when a short-leg Δ
 * crosses the trade-type exit threshold, instead of having to detour to
 * /monitor/exit. Renders nothing when no spreads are being watched.
 */
export function MonitorMiniStrip() {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = async () => {
    try {
      setSnap(await api.monitorState());
    } catch {
      // keep last good
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    const unsub = ws.on((msg: WSMessage) => {
      if (msg.type !== "monitor_alert" || !msg.data) return;
      const e = msg.data as MonitorEntry;
      const head =
        e.status === "trigger"
          ? `EXIT NOW — ${e.symbol} ${e.short_strike}`
          : `Near trigger — ${e.symbol} ${e.short_strike}`;
      const body = `short Δ ${e.current_delta?.toFixed(1)} · trigger ${e.exit_delta}`;
      if (e.status === "trigger") toast.error(head, { description: body });
      else toast(head, { description: body });
      load();
    });
    return () => {
      clearInterval(id);
      unsub();
    };
  }, []);

  if (!snap || snap.count === 0) return null;

  const safe = snap.count - snap.warning - snap.triggered;
  const allSafe = snap.warning === 0 && snap.triggered === 0;
  const attention = snap.entries.filter(
    (e) => e.status === "warning" || e.status === "trigger",
  );
  const showRows = expanded || attention.length > 0;

  return (
    <section className="border-t border-b border-border/40 -mx-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-baseline justify-between gap-3 py-2 text-left"
      >
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            In-trade monitor
          </span>
          <Pill label="watching" value={snap.count} />
          <Pill
            label="safe"
            value={safe}
            tone={safe > 0 ? "text-up" : undefined}
          />
          <Pill
            label="near"
            value={snap.warning}
            tone={snap.warning > 0 ? "text-warning" : undefined}
          />
          <Pill
            label="trigger"
            value={snap.triggered}
            tone={snap.triggered > 0 ? "text-down" : undefined}
          />
          {allSafe && (
            <span className="text-[10px] text-text-muted">· all clear</span>
          )}
        </div>
        <Link
          href="/monitor/exit"
          className="text-[10px] text-accent hover:underline shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          full monitor →
        </Link>
      </button>

      {showRows && (
        <div className="flex flex-col pb-2">
          {(expanded ? snap.entries : attention).map((e) => (
            <MiniRow key={e.spread_id} entry={e} />
          ))}
        </div>
      )}
    </section>
  );
}

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className={cn("text-[12px] tabular", tone ?? "text-text-primary")}>
        {value}
      </span>
    </span>
  );
}

function MiniRow({ entry }: { entry: MonitorEntry }) {
  const tone = STATUS_TONE[entry.status];
  const dot = STATUS_DOT[entry.status];
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 border-t border-border/20">
      <div className="flex items-baseline gap-2 min-w-0">
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full translate-y-[-2px] shrink-0",
            dot,
          )}
        />
        <span className="font-mono text-[12px] tabular text-text-primary truncate">
          {entry.symbol} {entry.short_strike}
          <span className="text-text-muted"> / </span>
          {entry.long_strike}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-text-muted hidden sm:inline">
          {entry.spread_type}
        </span>
      </div>
      <div className="flex items-baseline gap-x-3 text-[11px] tabular shrink-0">
        <span className="text-text-muted">
          Δ{" "}
          <span className="text-text-primary">
            {entry.current_delta != null ? entry.current_delta.toFixed(1) : "—"}
          </span>
        </span>
        <span className="text-text-muted">
          exit <span className="text-text-secondary">{entry.exit_delta}</span>
        </span>
        <span className="text-text-muted">
          head{" "}
          <span className={cn(tone, "font-medium")}>
            {entry.headroom != null ? entry.headroom.toFixed(1) : "—"}
          </span>
        </span>
      </div>
    </div>
  );
}
