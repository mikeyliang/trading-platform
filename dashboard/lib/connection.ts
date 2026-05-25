"use client";

import { useEffect, useState } from "react";
import { useHealth } from "@/lib/health";
import { useStore } from "@/lib/store";

export type ConnState = "connected" | "reconnecting" | "disconnected";

export interface ConnectionStatus {
  ib: ConnState;
  ws: ConnState;
  api: ConnState;
  overall: ConnState;
  ibLabel: string;
  ibDescription: string;
}

// Grace window: a downstate younger than this is treated as transient
// ("reconnecting") rather than settled ("disconnected"). Long enough to mask
// the first poll after a page load; short enough that a real outage turns red.
const RECONNECT_GRACE_MS = 6000;

// Cross-hook state shared at module scope so multiple consumers (header pill,
// footer dots, toast watcher) agree on transition timing.
const lineState: Record<"ib" | "ws", { ever: boolean; downSince: number | null }> = {
  ib: { ever: false, downSince: null },
  ws: { ever: false, downSince: null },
};

export function useConnectionStatus(): ConnectionStatus {
  const { health, apiReachable, initialLoad } = useHealth();
  const wsConnected = useStore((s) => s.wsConnected);
  const ibUp = !!health?.ib_connected;

  useEffect(() => {
    if (ibUp) {
      lineState.ib.ever = true;
      lineState.ib.downSince = null;
    } else if (lineState.ib.downSince === null) {
      lineState.ib.downSince = Date.now();
    }
  }, [ibUp]);

  useEffect(() => {
    if (wsConnected) {
      lineState.ws.ever = true;
      lineState.ws.downSince = null;
    } else if (lineState.ws.downSince === null) {
      lineState.ws.downSince = Date.now();
    }
  }, [wsConnected]);

  // Tick once a second so the grace window can expire — derived state needs a
  // re-render even when upstream inputs haven't changed.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const ib: ConnState = (() => {
    if (ibUp) return "connected";
    if (apiReachable === false) return "disconnected";
    const ds = lineState.ib.downSince ?? now;
    if (initialLoad || now - ds < RECONNECT_GRACE_MS) return "reconnecting";
    return "disconnected";
  })();

  const ws: ConnState = (() => {
    if (wsConnected) return "connected";
    const ds = lineState.ws.downSince ?? now;
    if (initialLoad || now - ds < RECONNECT_GRACE_MS) return "reconnecting";
    // ws.ts auto-reconnects forever with backoff, so once we've ever been
    // connected we keep showing yellow rather than dropping to red.
    return lineState.ws.ever ? "reconnecting" : "disconnected";
  })();

  const api: ConnState =
    apiReachable === true ? "connected"
      : apiReachable === false ? "disconnected"
        : "reconnecting";

  const order: Record<ConnState, number> = { connected: 0, reconnecting: 1, disconnected: 2 };
  const overall = ([ib, ws, api] as ConnState[]).reduce<ConnState>(
    (worst, s) => (order[s] > order[worst] ? s : worst),
    "connected",
  );

  const ibLabel =
    ib === "connected" ? "IBKR Connected"
      : ib === "reconnecting" ? "IBKR Reconnecting"
        : "IBKR Disconnected";
  const ibDescription =
    ib === "connected" ? "Gateway authenticated · market data streaming"
      : ib === "reconnecting" ? "Waiting for IB Gateway to come back online…"
        : "Log in to IB Gateway (VNC port 5900) — the dashboard will reconnect automatically.";

  return { ib, ws, api, overall, ibLabel, ibDescription };
}
