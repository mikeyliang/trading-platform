"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { fmtCurrency, pnlClass, cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { Skeleton } from "@/components/ui/skeleton";
import { useHealth } from "@/lib/health";

export const StatsBar = memo(function StatsBar() {
  const { account, initialLoad } = useHealth();
  // Positions are now WS-pushed by the API every ~10s (via the `snapshot`
  // event in WSProvider) and on every IB position-update. We keep a slow
  // REST safety net for cold start / when WS is disconnected.
  const wsPositions = useStore((s) => s.positions);
  const setStorePositions = useStore((s) => s.setPositions);
  const [restHydrated, setRestHydrated] = useState(false);

  useEffect(() => {
    const load = () => {
      api.positions().then((p) => {
        setStorePositions(p);
        setRestHydrated(true);
      }).catch(() => undefined);
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [setStorePositions]);

  const positions = restHydrated || wsPositions.length > 0 ? wsPositions : null;


  const totalUpnl = (positions ?? []).reduce((s, p) => s + (p.unrealized_pnl ?? 0), 0);
  const winRate = account?.win_rate ?? 0;
  const loading = initialLoad && !account;

  return (
    <div className="flex items-center bg-surface border-b border-border px-3 h-8 overflow-x-auto shrink-0">
      {/* Primary: account value */}
      <Group>
        <Stat
          label="Equity"
          value={account ? fmtCurrency(account.equity) : null}
          loading={loading}
          primary
        />
      </Group>

      {/* P&L cluster */}
      <Group>
        <Stat
          label="Unrealized"
          value={positions !== null ? fmtCurrency(totalUpnl) : null}
          valueClassName={pnlClass(totalUpnl)}
          loading={loading}
        />
        <Stat
          label="Realized"
          value={account ? fmtCurrency(account.realized_pnl ?? 0) : null}
          valueClassName={pnlClass(account?.realized_pnl ?? 0)}
          loading={loading}
        />
      </Group>

      {/* Activity cluster */}
      <Group>
        <Stat
          label="Positions"
          value={positions !== null ? positions.length.toString() : null}
          loading={loading}
        />
        <Stat
          label="Trades"
          value={account ? (account.total_trades ?? 0).toString() : null}
          loading={loading}
        />
        <Stat
          label="Win"
          value={account ? winRate.toFixed(0) + "%" : null}
          valueClassName={
            account
              ? winRate >= 50
                ? "text-up"
                : winRate >= 30
                ? "text-warning"
                : "text-down"
              : undefined
          }
          loading={loading}
        />
      </Group>

      <Group last>
        <Stat
          label="Buying power"
          value={account ? fmtCurrency(account.buying_power ?? 0) : null}
          loading={loading}
          muted
        />
      </Group>
    </div>
  );
});

function Group({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 first:pl-0",
        !last && "border-r border-border/40"
      )}
    >
      {children}
    </div>
  );
}

interface StatProps {
  label: string;
  value: string | null;
  valueClassName?: string;
  loading?: boolean;
  primary?: boolean;
  muted?: boolean;
}

const Stat = memo(function Stat({ label, value, valueClassName, loading, primary, muted }: StatProps) {
  return (
    <div className="flex items-baseline gap-1.5 shrink-0">
      <span
        className={cn(
          "text-[10px] uppercase tracking-wider",
          muted ? "text-text-muted/70" : "text-text-muted"
        )}
      >
        {label}
      </span>
      {loading ? (
        <Skeleton className="h-3 w-14" />
      ) : value === null ? (
        <span className="tabular text-xs font-medium text-text-muted">—</span>
      ) : (
        <span
          className={cn(
            "tabular tabular-nums font-medium",
            primary ? "text-sm text-text-primary" : "text-xs text-text-primary",
            muted && !valueClassName && "text-text-secondary",
            valueClassName
          )}
        >
          {value}
        </span>
      )}
    </div>
  );
});
