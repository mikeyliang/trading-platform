"use client";

import { useHealth } from "@/lib/health";
import { useStore } from "@/lib/store";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RiRefreshLine } from "@remixicon/react";
import { cn } from "@/lib/utils";

const FEEDS: [string, string][] = [
  ["account", "Account"],
  ["positions", "Positions"],
  ["quotes", "Quotes"],
  ["bars", "History"],
  ["chain", "Option chains"],
];

function sourceLabel(source?: string) {
  if (source === "web") return "Web API";
  if (source === "gateway") return "Gateway";
  return "n/a";
}

export default function SettingsPage() {
  const { health, lastCheckedAt, apiReachable, refetch } = useHealth();
  const { wsConnected } = useStore();
  const mode = (health?.mode ?? "n/a").toUpperCase();
  const ibOk = !!health?.ib_connected;
  const data = health?.data;
  const web = data?.web_api;
  const webState = !web || !web.enabled ? "Not configured" : web.authenticated ? "Connected" : web.last_error ? "Error" : "Connecting";
  const webClass =
    webState === "Connected" ? "text-status-lime-text" : webState === "Error" ? "text-status-rose-text" : "text-text-tertiary";

  return (
    <PageShell>
      <PageHeader
        title="Settings"
        description="Connections and where each feed comes from."
        actions={
          <Button variant="ghost" size="icon" onClick={() => refetch()} aria-label="Check again" title="Check again">
            <RiRefreshLine />
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
            <span className="text-caption-1-regular tabular text-text-tertiary">
              {lastCheckedAt ? `Checked ${new Date(lastCheckedAt).toLocaleTimeString()}` : "Not checked yet"}
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <Rows>
              <Row label="Mode" value={mode === "LIVE" ? "Live" : "Paper"} valueClass={mode === "LIVE" ? "text-status-yellow-text" : "text-text-primary"} />
              <Row label="IBKR Web API" value={webState} valueClass={webClass} />
              <Row label="IBKR Gateway" value={ibOk ? "Connected" : "Offline"} valueClass={ibOk ? "text-status-lime-text" : "text-status-rose-text"} />
              <Row label="Realtime stream" value={wsConnected ? "Live" : "Offline"} valueClass={wsConnected ? "text-status-lime-text" : "text-status-rose-text"} />
              <Row
                label="API"
                value={apiReachable === false ? "Unreachable" : "OK"}
                valueClass={apiReachable === false ? "text-status-rose-text" : "text-status-lime-text"}
              />
              {health?.mock_mode && <Row label="Mock data" value="On" valueClass="text-status-yellow-text" />}
            </Rows>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Data sources</CardTitle>
            {web?.account_id && <span className="text-caption-1-regular tabular text-text-tertiary">{web.account_id}</span>}
          </CardHeader>
          <CardContent className="p-0">
            <Rows>
              {FEEDS.map(([key, label]) => {
                const s = data?.sources?.[key];
                return <Row key={key} label={label} value={sourceLabel(s?.source)} valueClass={s?.source === "web" ? "text-text-primary" : "text-text-tertiary"} />;
              })}
              <Row label="Tape and depth" value="Gateway" valueClass="text-text-tertiary" />
              <Row label="Bot orders" value="Gateway" valueClass="text-text-tertiary" />
            </Rows>
            {web?.last_error && (
              <p className="px-4 py-2 text-caption-1-regular text-text-tertiary truncate" title={web.last_error}>
                {web.last_error}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Shortcuts</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Rows>
              <Row label="Command palette" value={<Kbd>⌘K</Kbd>} />
              <Row label="AI co-pilot" value={<Kbd>⌘J</Kbd>} />
            </Rows>
          </CardContent>
        </Card>
      </div>
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
    <div className="flex items-center justify-between gap-3 px-4 h-9">
      <span className="text-caption-1-medium text-text-tertiary">{label}</span>
      <span className={cn("text-body-2-medium", mono && "tabular", valueClass ?? "text-text-primary")}>{value}</span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center h-5 px-1.5 rounded-md bg-kbd-background text-kbd-foreground text-caption-1-medium tabular">
      {children}
    </kbd>
  );
}
