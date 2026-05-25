"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
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
    return (
      <BannerImpl
        apiDown
        lastCheckedAt={lastCheckedAt}
        now={now}
        retry={retry}
        retrying={retrying}
      />
    );
  }
  // API up, IBKR gateway down: hard warning. IBKR is the only data source,
  // so no bars / quotes / chains until the gateway authenticates.
  if (apiReachable && health && health.ib_connected === false) {
    return (
      <BannerImpl
        apiDown={false}
        lastCheckedAt={lastCheckedAt}
        now={now}
        retry={retry}
        retrying={retrying}
      />
    );
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
  const label = apiDown ? "API Offline" : "IBKR Offline";
  const message = apiDown
    ? "Trading API is unreachable — backend container may be down."
    : "IBKR Gateway is offline — log in via VNC (port 5900) and the dashboard will reconnect automatically.";
  const Icon = apiDown ? WifiOff : AlertTriangle;

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 h-9 border-b text-[11px] shrink-0 animate-fade-in",
        apiDown
          ? "bg-down/10 border-down/20"
          : "bg-warning/10 border-warning/20",
      )}
    >
      <Icon
        size={13}
        className={cn("shrink-0", apiDown ? "text-down" : "text-warning")}
      />
      <div className="flex-1 flex items-center gap-2 min-w-0">
        <span
          className={cn(
            "font-medium uppercase tracking-wider",
            apiDown ? "text-down" : "text-warning",
          )}
        >
          {label}
        </span>
        <span className="text-text-secondary truncate">{message}</span>
      </div>
      {lastCheckedAt && (
        <span className="text-text-muted tabular hidden sm:inline">
          checked {fmtAgo(now - lastCheckedAt)}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={retry}
        disabled={retrying}
        className={cn(
          "shrink-0",
          apiDown
            ? "border-down/30 text-down hover:bg-down/10 hover:text-down"
            : "border-warning/30 text-warning hover:bg-warning/10 hover:text-warning",
        )}
      >
        <RefreshCw className={retrying ? "animate-spin" : ""} />
        retry
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
