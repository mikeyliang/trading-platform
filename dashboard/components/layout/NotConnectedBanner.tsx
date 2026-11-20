"use client";

import { useEffect, useState } from "react";
import { RiAlertFill as AlertTriangle, RiRefreshLine as RefreshCw, RiWifiOffFill as WifiOff } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { useHealth } from "@/lib/health";
import { cn } from "@/lib/utils";

export function NotConnectedBanner() {
  const { health, apiReachable, lastCheckedAt, refetch } = useHealth();
  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const retry = async () => {
    setRetrying(true);
    await refetch();
    setTimeout(() => setRetrying(false), 500);
  };

  // Don't render while we have no info yet (avoid flashing).
  if (apiReachable === null && !health) return null;
  // API down: hard error
  if (apiReachable === false) {
    return <BannerImpl apiDown lastCheckedAt={lastCheckedAt} now={now} retry={retry} retrying={retrying} />;
  }
  // API up, IBKR gateway down: hard warning. IBKR is the only data source,
  // so no bars / quotes / chains until the gateway authenticates.
  if (apiReachable && health && health.ib_connected === false) {
    return <BannerImpl apiDown={false} lastCheckedAt={lastCheckedAt} now={now} retry={retry} retrying={retrying} />;
  }
  return null;
}

function BannerImpl({
  apiDown,
  lastCheckedAt,
  now,
  retry,
  retrying,
}: {
  apiDown: boolean;
  lastCheckedAt: number | null;
  now: number;
  retry: () => Promise<void>;
  retrying: boolean;
}) {
  const label = apiDown ? "API offline" : "IBKR offline";
  const message = apiDown
    ? "The trading API can't be reached. The backend container may be down."
    : "Log in to IBKR Gateway over VNC (port 5900). Quotes, chains and positions come back on their own.";
  const Icon = apiDown ? WifiOff : AlertTriangle;

  return (
    // A quiet row, not a coloured block: the icon carries the tone, the text
    // stays neutral, and it sits on the same surface as every other panel.
    <div
      className="flex items-center gap-3 pl-3 pr-1.5 h-10 rounded-2xl border border-border-button-default bg-background-primary-default text-body-2-regular shrink-0 animate-fade-in"
    >
      <Icon size={16} className={cn("shrink-0", apiDown ? "text-status-rose-text" : "text-status-yellow-text")} />
      {/* Only the label and message are announced; the ticking "checked ago"
          stays outside the live region so a screen reader does not repeat it
          every second during an outage. */}
      <div role="status" className="flex-1 flex items-center gap-2 min-w-0">
        <span className="text-body-2-medium text-text-primary shrink-0">{label}</span>
        <span className="text-text-secondary truncate">{message}</span>
      </div>
      {lastCheckedAt && (
        <span className="text-text-tertiary tabular hidden sm:inline">
          checked {fmtAgo(now - lastCheckedAt)}
        </span>
      )}
      <Button
        variant="secondary"
        size="sm"
        onClick={retry}
        disabled={retrying}
        className="shrink-0"
      >
        <RefreshCw className={retrying ? "animate-spin" : ""} />
        Retry
      </Button>
    </div>
  );
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
