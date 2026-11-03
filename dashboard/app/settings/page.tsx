"use client";

import { useEffect, useState } from "react";
import { useHealth } from "@/lib/health";
import { useStore } from "@/lib/store";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, fmtCurrency } from "@/lib/utils";

export default function SettingsPage() {
  const { health, account, lastCheckedAt, apiReachable, refetch } = useHealth();
  const { wsConnected, activeSymbol, activeTimeframe } = useStore();
  const [theme, setTheme] = useState("Dark");
  useEffect(() => {
    const read = () => setTheme(document.documentElement.classList.contains("dark") ? "Dark" : "Light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  const mode = (health?.mode ?? "n/a").toUpperCase();
  const ibOk = !!health?.ib_connected;

  return (
    <PageShell>
      <PageHeader
        title="Settings"
        description="Runtime status, account binding, and session preferences."
        actions={
          <button
            onClick={() => refetch()}
            className="h-6 px-2 text-caption-1-regular rounded-sm bg-background-secondary-default hover:bg-background-tertiary-hover text-text-secondary border border-separator-border"
          >
            Refresh
          </button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
            <span className="text-caption-2-regular tabular tabular text-text-tertiary">
              {lastCheckedAt ? new Date(lastCheckedAt).toLocaleTimeString() : "n/a"}
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <Rows>
              <Row label="Mode" value={mode === "LIVE" ? "Live" : "Paper"} valueClass={mode === "LIVE" ? "text-status-yellow-text" : "text-text-primary"} />
              <Row label="IBKR Gateway" value={ibOk ? "Connected" : "Offline"} valueClass={ibOk ? "text-status-lime-text" : "text-status-rose-text"} />
              <Row label="Realtime stream" value={wsConnected ? "Live" : "Offline"} valueClass={wsConnected ? "text-status-lime-text" : "text-status-rose-text"} />
              <Row
                label="API"
                value={apiReachable === false ? "Unreachable" : "OK"}
                valueClass={apiReachable === false ? "text-status-rose-text" : "text-status-lime-text"}
              />
              <Row label="Mock data" value={health?.mock_mode ? "On" : "Off"} />
            </Rows>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <span className={cn("text-caption-2-regular tabular tabular", account ? "text-text-secondary" : "text-text-tertiary")}>
              {account ? "live" : "no binding"}
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <Rows>
              <Row label="Equity" value={account ? fmtCurrency(account.equity ?? 0) : "n/a"} mono />
              <Row label="Buying power" value={account ? fmtCurrency(account.buying_power ?? 0) : "n/a"} mono />
              <Row label="Balance" value={account ? fmtCurrency(account.balance ?? 0) : "n/a"} mono />
              <Row
                label="Unrealized PnL"
                value={account ? fmtCurrency(account.unrealized_pnl ?? 0) : "n/a"}
                valueClass={pnlColor(account?.unrealized_pnl ?? 0)}
                mono
              />
              <Row
                label="Realized PnL"
                value={account ? fmtCurrency(account.realized_pnl ?? 0) : "n/a"}
                valueClass={pnlColor(account?.realized_pnl ?? 0)}
                mono
              />
              <Row label="Trades" value={account ? String(account.total_trades) : "n/a"} mono />
              <Row label="Win rate" value={account ? `${Number(account.win_rate).toFixed(1)}%` : "n/a"} mono />
            </Rows>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Session</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Rows>
              <Row label="Active symbol" value={activeSymbol} mono />
              <Row label="Active timeframe" value={activeTimeframe} mono />
              <Row label="Theme" value={theme} />
              <Row label="Density" value="Compact" />
            </Rows>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Shortcuts</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Rows>
              <Row label="Command palette" value="⌘K" mono />
              <Row label="AI co-pilot" value="⌘J" mono />
              <Row label="Toggle chart" value="n/a" mono />
            </Rows>
          </CardContent>
        </Card>
      </div>

      <p className="text-caption-2-regular text-text-tertiary">
        Persistent preferences (theme switching, custom layouts, API endpoint overrides) are not yet wired;
        runtime values shown here are read-only.
      </p>
    </PageShell>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-separator-border">{children}</div>;
}

function Row({
  label,
  value,
  valueClass,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-3 h-7">
      <span className="text-caption-1-regular text-text-tertiary">{label}</span>
      <span
        className={cn(
          "text-caption-1-regular",
          mono && "tabular tabular",
          valueClass ?? "text-text-primary"
        )}
      >
        {value}
      </span>
    </div>
  );
}

function pnlColor(n: number): string {
  if (n > 0) return "text-status-lime-text";
  if (n < 0) return "text-status-rose-text";
  return "text-text-primary";
}
