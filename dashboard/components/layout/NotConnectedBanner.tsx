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
    ? "The trading API is unreachable. The backend container may be down."
    : "IBKR Gateway is offline. Log in via VNC (port 5900) and the dashboard reconnects on its own.";
  const Icon = apiDown ? WifiOff : AlertTriangle;

  return (
    <div className={cn(
      "flex items-center gap-3 px-3 h-9 rounded-2lg text-body-2-regular shrink-0 animate-fade-in",
      apiDown ? "bg-status-rose-background" : "bg-status-yellow-background",
    )}>
      <Icon size={16} className={cn("shrink-0", apiDown ? "text-status-rose-text" : "text-status-yellow-text")} />
      <div className="flex-1 flex items-center gap-2 min-w-0">
        <span className={cn("text-body-2-medium", apiDown ? "text-status-rose-text" : "text-status-yellow-text")}>
          {label}
        </span>
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
