"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { AccountInfo } from "@/types";

export interface HealthState {
  status: string;
  ib_connected: boolean;
  mode: string;
  mock_mode: boolean;
}

interface HealthContextValue {
  health: HealthState | null;
  account: AccountInfo | null;
  lastCheckedAt: number | null;
  apiReachable: boolean | null;
  initialLoad: boolean;
  refetch: () => Promise<void>;
}

const HealthContext = createContext<HealthContextValue | null>(null);

// Slow safety-net poll. The WS `snapshot` event pushes health + account every
// 10s, so this REST poll is just for cold-start hydration and as a fallback
// when the WS is disconnected.
const POLL_MS = 30000;

export function HealthProvider({ children }: { children: React.ReactNode }) {
  const [restHealth, setRestHealth] = useState<HealthState | null>(null);
  const [restAccount, setRestAccount] = useState<AccountInfo | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const [initialLoad, setInitialLoad] = useState(true);
  const inFlight = useRef(false);

  // WS-pushed values take priority over the REST snapshot when available.
  const wsHealth = useStore((s) => s.liveHealth);
  const wsAccount = useStore((s) => s.account);

  const health = useMemo<HealthState | null>(() => {
    if (wsHealth) {
      return {
        status: "healthy",
        ib_connected: wsHealth.ib_connected,
        mode: wsHealth.mode,
        mock_mode: wsHealth.mock_mode,
      };
    }
    return restHealth;
  }, [wsHealth, restHealth]);

  const account = wsAccount ?? restAccount;

  const refetch = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [h, a] = await Promise.allSettled([api.health(), api.account()]);
      if (h.status === "fulfilled") {
        setRestHealth(h.value);
        setApiReachable(true);
      } else {
        setApiReachable(false);
      }
      if (a.status === "fulfilled") setRestAccount(a.value);
      // intentionally do NOT reset account/health to null on failure — keep
      // last good values visible so the UI doesn't flicker.
      setLastCheckedAt(Date.now());
    } finally {
      inFlight.current = false;
      setInitialLoad(false);
    }
  }, []);

  useEffect(() => {
    refetch();
    const id = setInterval(refetch, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refetch]);

  return (
    <HealthContext.Provider
      value={{ health, account, lastCheckedAt, apiReachable, initialLoad, refetch }}
    >
      {children}
    </HealthContext.Provider>
  );
}

export function useHealth(): HealthContextValue {
  const ctx = useContext(HealthContext);
  if (!ctx) {
    throw new Error("useHealth must be used within HealthProvider");
  }
  return ctx;
}
