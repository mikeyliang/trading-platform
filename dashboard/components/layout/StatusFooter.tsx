"use client";

import { useEffect, useState } from "react";
import { useHealth } from "@/lib/health";
import { cn } from "@/lib/utils";
import { useConnectionStatus, type ConnState } from "@/lib/connection";

// Status strip pinned to the bottom of every page: connection state, data
// stream, market session, Eastern clock, last refresh. Mode and account
// figures live in the header and stats band, not here.
export function StatusFooter() {
  const { lastCheckedAt } = useHealth();
  const { ib, ws, api } = useConnectionStatus();
  const [now, setNow] = useState<Date | null>(null);

  // Avoid hydration mismatch, only mount the clock after the client renders.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const session = marketSession(now);

  return (
    <footer
      role="contentinfo"
      className="h-5 flex items-center gap-3 px-1 text-caption-1-regular text-text-tertiary shrink-0 select-none overflow-hidden"
    >
      <StatusDot state={ib} label={ibLabel(ib)} />
      <StatusDot state={ws} label={wsLabel(ws)} />
      <StatusDot state={api} label={apiLabel(api)} />
      <span className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn("h-1.5 w-1.5 rounded-full", session.open ? "bg-status-lime-text" : "bg-foreground-icon-quaternary")}
          />
          {session.label} <span className="text-text-secondary">{session.state}</span>
        </span>
        <Sep />
        <span suppressHydrationWarning className="tabular">{now ? formatTime(now) : "--:--:--"} ET</span>
        <Sep />
        <span suppressHydrationWarning className="hidden sm:inline">
          upd {lastCheckedAt ? formatRelative(lastCheckedAt) : "--"}
        </span>
      </span>
    </footer>
  );
}

function StatusDot({ state, label }: { state: ConnState; label: string }) {
  const color =
    state === "connected" ? "bg-status-lime-text"
      : state === "reconnecting" ? "bg-status-yellow-text"
        : "bg-status-rose-text";
  const text =
    state === "connected" ? "text-text-tertiary"
      : state === "reconnecting" ? "text-status-yellow-text"
        : "text-status-rose-text";

  return (
    <span className="flex items-center gap-1.5">
      <span className="relative inline-flex items-center justify-center w-1.5 h-1.5">
        <span className={cn("absolute inset-0 rounded-full", color)} />
        {state === "reconnecting" && (
          <span className={cn("absolute inset-0 rounded-full animate-ping opacity-75", color)} />
        )}
      </span>
      <span className={cn("", text)}>{label}</span>
    </span>
  );
}

function ibLabel(s: ConnState) {
  return s === "connected" ? "IB" : s === "reconnecting" ? "IB reconnecting" : "IB offline";
}
function wsLabel(s: ConnState) {
  return s === "connected" ? "Stream" : s === "reconnecting" ? "Stream reconnecting" : "Stream down";
}
function apiLabel(s: ConnState) {
  return s === "connected" ? "API" : s === "reconnecting" ? "API checking" : "API down";
}

function Sep() {
  return <span aria-hidden className="h-3 w-px bg-separator-border-strong" />;
}

function formatTime(d: Date): string {
  // US/Eastern wall-clock. Intl handles DST automatically.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

function formatRelative(ts: number): string {
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  return `${Math.floor(delta / 3600)}h`;
}

function marketSession(d: Date | null): { label: string; state: string; open: boolean } {
  if (!d) return { label: "Market", state: "n/a", open: false };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  const hh = parseInt(get("hour"), 10);
  const mm = parseInt(get("minute"), 10);
  const m = hh * 60 + mm;

  const isWeekend = wd === "Sat" || wd === "Sun";
  if (isWeekend) return { label: "Market", state: "closed", open: false };

  // Regular: 09:30 to 16:00 ET. Pre: 04:00 to 09:30. After: 16:00 to 20:00.
  if (m >= 570 && m < 960) return { label: "Market", state: "open", open: true };
  if (m >= 240 && m < 570) return { label: "Pre-market", state: "open", open: true };
  if (m >= 960 && m < 1200) return { label: "After hours", state: "open", open: true };
  return { label: "Market", state: "closed", open: false };
}
