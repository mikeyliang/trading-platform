"use client";

import { useEffect, useRef } from "react";
import { toast } from "@/components/ui/toaster";
import { useConnectionStatus, type ConnState } from "@/lib/connection";

// Fires sonner toasts when a connection line transitions. Stays silent at app
// start — only reports state changes once a line has been observed up or
// down, so opening the dashboard doesn't spam the corner.
export function ConnectionToasts() {
  const { ib, ws, api } = useConnectionStatus();
  const prev = useRef<{ ib: ConnState; ws: ConnState; api: ConnState } | null>(null);
  const wasDown = useRef({ ib: false, ws: false, api: false });

  useEffect(() => {
    const previous = prev.current;
    prev.current = { ib, ws, api };

    handle("IBKR", previous?.ib, ib, "ib", wasDown.current,
      "Gateway connection restored — market data resuming.",
      "IBKR gateway dropped — automatically retrying.",
      "IBKR gateway is offline. Log in via VNC (port 5900) to reconnect.");
    handle("Stream", previous?.ws, ws, "ws", wasDown.current,
      "Live data stream reconnected.",
      "Live stream dropped — automatically retrying.",
      "Live stream offline — falling back to REST polling.");
    handle("API", previous?.api, api, "api", wasDown.current,
      "Trading API back online.",
      "Trading API unreachable — retrying.",
      "Trading API offline — backend may be down.");
  }, [ib, ws, api]);

  return null;
}

type LineKey = "ib" | "ws" | "api";

function handle(
  label: string,
  from: ConnState | undefined,
  to: ConnState,
  key: LineKey,
  wasDownMap: Record<LineKey, boolean>,
  recoveredMsg: string,
  reconnectingMsg: string,
  disconnectedMsg: string,
) {
  if (from === undefined || from === to) return;

  if (to === "disconnected") {
    toast.error(`${label} disconnected`, {
      description: disconnectedMsg,
      duration: 8000,
      id: `conn-${key}`,
    });
    wasDownMap[key] = true;
  } else if (to === "reconnecting" && from === "connected") {
    toast.warning(`${label} reconnecting…`, {
      description: reconnectingMsg,
      duration: 5000,
      id: `conn-${key}`,
    });
    wasDownMap[key] = true;
  } else if (to === "connected" && wasDownMap[key]) {
    toast.success(`${label} reconnected`, {
      description: recoveredMsg,
      duration: 4000,
      id: `conn-${key}`,
    });
    wasDownMap[key] = false;
  }
}
