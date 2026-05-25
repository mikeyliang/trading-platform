"use client";

import { useEffect } from "react";
import { ws } from "@/lib/ws";
import { useStore } from "@/lib/store";
import type { AccountInfo, Position, Quote, WSMessage } from "@/types";

interface SnapshotPayload {
  health?: { ib_connected: boolean; mode: string; mock_mode: boolean };
  account?: AccountInfo | null;
  positions?: Position[];
}

export function WSProvider({ children }: { children: React.ReactNode }) {
  const {
    setWsConnected,
    updateQuote,
    setAccount,
    setPositions,
    setLiveHealth,
  } = useStore();

  useEffect(() => {
    ws.connect();

    const unsub = ws.on((msg: WSMessage) => {
      if (msg.type === "connected") setWsConnected(true);
      if (msg.type === "disconnected") setWsConnected(false);
      if (msg.type === "quote" && msg.data) updateQuote(msg.data as Quote);
      if (msg.type === "snapshot" && msg.data) {
        const snap = msg.data as SnapshotPayload;
        if (snap.health) setLiveHealth(snap.health);
        if (snap.account !== undefined && snap.account !== null)
          setAccount(snap.account);
        if (snap.positions) setPositions(snap.positions);
      }
      // Single-position deltas — broadcast on every IB fill / mark update.
      if (msg.type === "position" && msg.data) {
        const p = msg.data as Position;
        // Merge by symbol — replace existing or append.
        useStore.setState((s) => {
          const idx = s.positions.findIndex((x) => x.symbol === p.symbol);
          if (idx === -1) return { positions: [...s.positions, p] };
          const next = s.positions.slice();
          next[idx] = p;
          return { positions: next };
        });
      }
    });

    const onVisibility = () => {
      if (document.visibilityState === "visible") ws.connect();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [setWsConnected, updateQuote, setAccount, setPositions, setLiveHealth]);

  return <>{children}</>;
}
