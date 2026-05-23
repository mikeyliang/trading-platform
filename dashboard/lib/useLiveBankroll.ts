"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const FALLBACK = 100_000;

/**
 * Sizing capital input that tracks the live IBKR account by default. The
 * picker and finder use this to make Kelly / one-third-cap sizing reflect
 * actual buying power instead of a hardcoded 100k.
 *
 * Live mode: re-syncs from `/api/account` (prefers `equity`, falls back to
 * `balance`) on mount and whenever `refresh()` is called. As soon as the
 * user edits the input we flip to manual mode and stop pulling.
 */
export function useLiveBankroll() {
  const [value, setValue] = useState<number>(FALLBACK);
  const [live, setLive] = useState<number | null>(null);
  const [mode, setMode] = useState<"live" | "manual">("live");
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const acct = await api.account();
      const next = acct.equity > 0 ? acct.equity : acct.balance;
      const resolved = next > 0 ? next : FALLBACK;
      setLive(next > 0 ? next : null);
      setValue((cur) => (mode === "live" ? resolved : cur));
    } catch {
      setLive(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (next: number) => {
    setMode("manual");
    setValue(Math.max(0, next));
  };

  const resetToLive = () => {
    setMode("live");
    if (live != null) setValue(live);
    else refresh();
  };

  return { value, set, mode, live, loading, resetToLive };
}
