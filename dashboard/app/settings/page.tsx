"use client";

import { useHealth } from "@/lib/health";
import { useStore } from "@/lib/store";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, fmtCurrency } from "@/lib/utils";

export default function SettingsPage() {
  const { health, account, lastCheckedAt, apiReachable, refetch } = useHealth();
  const { wsConnected, activeSymbol, activeTimeframe } = useStore();

  const mode = (health?.mode ?? "—").toUpperCase();
  const ibOk = !!health?.ib_connected;

  return (
    <PageShell>
      <PageHeader
        title="Settings"
        description="Runtime status, account binding, and session preferences."
        actions={
          <button
            onClick={() => refetch()}
            className="h-6 px-2 text-[11px] rounded-sm bg-surface-2 hover:bg-surface-3 text-text-secondary border border-border/60"
          >
            Refresh
          </button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
            <span className="text-[10px] tabular font-mono text-text-muted">
              {lastCheckedAt ? new Date(lastCheckedAt).toLocaleTimeString() : "—"}
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <Rows>
              <Row label="Mode" value={mode} valueClass={mode === "LIVE" ? "text-warning" : "text-text-primary"} />
              <Row label="IBKR Gateway" value={ibOk ? "Connected" : "Offline"} valueClass={ibOk ? "text-up" : "text-down"} />
              <Row label="Realtime stream" value={wsConnected ? "Live" : "Offline"} valueClass={wsConnected ? "text-up" : "text-down"} />
              <Row
                label="API"
                value={apiReachable === false ? "Unreachable" : "OK"}
                valueClass={apiReachable === false ? "text-down" : "text-up"}
              />
              <Row label="Mock data" value={health?.mock_mode ? "On" : "Off"} />
            </Rows>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <span className={cn("text-[10px] tabular font-mono", account ? "text-text-secondary" : "text-text-muted")}>
              {account ? "live" : "no binding"}
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <Rows>
              <Row label="Equity" value={account ? fmtCurrency(account.equity ?? 0) : "—"} mono />
              <Row label="Buying power" value={account ? fmtCurrency(account.buying_power ?? 0) : "—"} mono />
              <Row label="Balance" value={account ? fmtCurrency(account.balance ?? 0) : "—"} mono />
              <Row
                label="Unrealized PnL"
                value={account ? fmtCurrency(account.unrealized_pnl ?? 0) : "—"}
                valueClass={pnlColor(account?.unrealized_pnl ?? 0)}
                mono
              />
              <Row
                label="Realized PnL"
                value={account ? fmtCurrency(account.realized_pnl ?? 0) : "—"}
                valueClass={pnlColor(account?.realized_pnl ?? 0)}
                mono
              />
              <Row label="Trades · win-rate" value={account ? `${account.total_trades} · ${(account.win_rate * 100).toFixed(1)}%` : "—"} mono />
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
              <Row label="Theme" value="Dark · Terminal" />
              <Row label="Density" value="Compact (IBKR-style)" />
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
              <Row label="Toggle chart" value="—" mono />
            </Rows>
          </CardContent>
        </Card>
      </div>

      <p className="text-[10px] text-text-muted">
        Persistent preferences (theme switching, custom layouts, API endpoint overrides) are not yet wired —
        runtime values shown here are read-only.
      </p>
    </PageShell>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border/40">{children}</div>;
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
      <span className="text-[11px] text-text-muted">{label}</span>
      <span
        className={cn(
          "text-[11px]",
          mono && "tabular font-mono",
          valueClass ?? "text-text-primary"
        )}
      >
        {value}
      </span>
    </div>
  );
}

function pnlColor(n: number): string {
  if (n > 0) return "text-up";
  if (n < 0) return "text-down";
  return "text-text-primary";
}
