"use client";

import { useEffect, useState } from "react";
import { useHealth } from "@/lib/health";
import { cn, fmtCurrency } from "@/lib/utils";
import { useConnectionStatus, type ConnState } from "@/lib/connection";

// Slim status bar pinned to the bottom of every page, modeled on the IBKR TWS
// footer: connection state, data stream, mode, server time, last update.
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
      className="h-5 flex items-center gap-3 px-3 bg-bg border-t border-border/60 text-[10px] tabular font-mono text-text-muted shrink-0 select-none"
    >
      <StatusDot state={ib} label={ibLabel(ib)} />
      <Sep />
      <StatusDot state={ws} label={wsLabel(ws)} />
      <Sep />
      <StatusDot state={api} label={apiLabel(api)} />
      <Sep />
      <span className={cn("uppercase tracking-wider", mode === "LIVE" ? "text-warning" : "text-text-secondary")}>
        {mode}
      </span>

      {account && (
        <>
          <Sep />
          <span className="text-text-secondary">
            EQ <span className="text-text-primary">{fmtCurrency(account.equity ?? 0)}</span>
          </span>
          <Sep />
          <span className="text-text-secondary">
            BP <span className="text-text-primary">{fmtCurrency(account.buying_power ?? 0)}</span>
          </span>
        </>
      )}

      <span className="ml-auto flex items-center gap-3">
        <span>
          {session.label} <span className="text-text-secondary">{session.state}</span>
        </span>
        <Sep />
        <span suppressHydrationWarning>{now ? formatTime(now) : "--:--:--"} ET</span>
        <Sep />
        <span suppressHydrationWarning>
          UPD {lastCheckedAt ? formatRelative(lastCheckedAt) : "--"}
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
      <span className={cn("uppercase tracking-wider", text)}>{label}</span>
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
  return <span className="text-border">|</span>;
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

function marketSession(d: Date | null): { label: string; state: string } {
  if (!d) return { label: "MKT", state: "—" };
  // Compute time in ET via Intl parts.
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
  if (isWeekend) return { label: "MKT", state: "CLOSED" };

  // Regular: 09:30–16:00 ET. Pre: 04:00–09:30. After: 16:00–20:00.
  if (m >= 570 && m < 960) return { label: "RTH", state: "OPEN" };
  if (m >= 240 && m < 570) return { label: "PRE", state: "OPEN" };
  if (m >= 960 && m < 1200) return { label: "AH", state: "OPEN" };
  return { label: "MKT", state: "CLOSED" };
}
