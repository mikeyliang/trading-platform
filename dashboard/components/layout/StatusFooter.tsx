"use client";

import { useEffect, useState } from "react";
import { useHealth } from "@/lib/health";
import { cn, fmtCurrency } from "@/lib/utils";
import { useConnectionStatus, type ConnState } from "@/lib/connection";

// Status strip pinned to the bottom of every page: connection state, data
// stream, account mode, market session, Eastern clock, last refresh.
export function StatusFooter() {
  const { health, account, lastCheckedAt } = useHealth();
  const { ib, ws, api } = useConnectionStatus();
  const [now, setNow] = useState<Date | null>(null);

  // Avoid hydration mismatch — only mount the clock after the client renders.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const mode = (health?.mode ?? "paper").toUpperCase();
  const session = marketSession(now);

  return (
    <footer
      role="contentinfo"
      className="h-6 flex items-center gap-3 px-3 bg-surface border-t border-border text-2xs font-mono tabular text-text-muted shrink-0 select-none overflow-hidden"
    >
      <StatusDot state={ib} label={ibLabel(ib)} />
      <StatusDot state={ws} label={wsLabel(ws)} />
      <StatusDot state={api} label={apiLabel(api)} />
      <Sep />
      <span className={cn("", mode === "LIVE" ? "text-warning" : "text-text-secondary")}>
        {mode}
      </span>

      {account && (
        <span className="hidden md:flex items-center gap-3">
          <Sep />
          <span>
            NLV <span className="text-text-secondary">{fmtCurrency(account.equity ?? 0)}</span>
          </span>
          <span>
            BP <span className="text-text-secondary">{fmtCurrency(account.buying_power ?? 0)}</span>
          </span>
        </span>
      )}

      <span className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn("h-1.5 w-1.5 rounded-full", session.open ? "bg-up" : "bg-text-muted")}
          />
          {session.label} <span className="text-text-secondary">{session.state}</span>
        </span>
        <Sep />
        <span suppressHydrationWarning>{now ? formatTime(now) : "--:--:--"} ET</span>
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
    state === "connected" ? "bg-up"
      : state === "reconnecting" ? "bg-warning"
        : "bg-down";
  const text =
    state === "connected" ? "text-text-muted"
      : state === "reconnecting" ? "text-warning"
        : "text-down";

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
  return s === "connected" ? "IB" : s === "reconnecting" ? "IB RECONNECTING" : "IB OFFLINE";
}
function wsLabel(s: ConnState) {
  return s === "connected" ? "STREAM" : s === "reconnecting" ? "STREAM RECONNECTING" : "STREAM DOWN";
}
function apiLabel(s: ConnState) {
  return s === "connected" ? "API" : s === "reconnecting" ? "API CHECKING" : "API DOWN";
}

function Sep() {
  return <span aria-hidden className="h-3 w-px bg-border" />;
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
  if (!d) return { label: "MKT", state: "—", open: false };
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
  if (isWeekend) return { label: "MKT", state: "CLOSED", open: false };

  // Regular: 09:30–16:00 ET. Pre: 04:00–09:30. After: 16:00–20:00.
  if (m >= 570 && m < 960) return { label: "RTH", state: "OPEN", open: true };
  if (m >= 240 && m < 570) return { label: "PRE", state: "OPEN", open: true };
  if (m >= 960 && m < 1200) return { label: "AH", state: "OPEN", open: true };
  return { label: "MKT", state: "CLOSED", open: false };
}
