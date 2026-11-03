"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DepthSnapshot, type DepthLevel } from "@/lib/api";
import { StreamWebSocket } from "@/lib/ws-stream";
import { cn, fmtCompact } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RiStackLine as Layers } from "@remixicon/react";

interface Props {
  symbol: string;
  rows?: number;
}

/** Level 2 ladder. Bids on the left, asks on the right, sorted from tightest
 *  to deepest. Per-row size is normalized to the max-size in the snapshot so
 *  the depth bar gives an instant read on where the displayed liquidity sits.
 *
 *  When IBKR has no depth entitlement we show an empty state with a hint about
 *  which subscription unlocks it for common venues. */
export function DeepBook({ symbol, rows = 10 }: Props) {
  const [snap, setSnap] = useState<DepthSnapshot | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const wsRef = useRef<StreamWebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSnap(null);
    setUnavailable(false);
    api.depthSnapshot(symbol, rows).then((s) => {
      if (cancelled) return;
      setSnap(s);
      if (!s.available) setUnavailable(true);
    }).catch(() => null);
    return () => { cancelled = true; };
  }, [symbol, rows]);

  useEffect(() => {
    const ws = new StreamWebSocket(`/api/depth/ws/${symbol}?rows=${rows}`);
    wsRef.current = ws;
    const off = ws.on((msg) => {
      if (msg.type === "open") setStreaming(true);
      if (msg.type === "close") setStreaming(false);
      if (msg.type === "depth" && msg.data) setSnap(msg.data as DepthSnapshot);
      if (msg.type === "unavailable") setUnavailable(true);
    });
    ws.connect();
    return () => { off(); ws.disconnect(); };
  }, [symbol, rows]);

  const maxSize = useMemo(() => {
    if (!snap) return 1;
    return Math.max(
      1,
      ...(snap.bids ?? []).map((b) => b.size),
      ...(snap.asks ?? []).map((a) => a.size),
    );
  }, [snap]);

  const empty =
    unavailable || (snap && !snap.available && (snap.bids ?? []).length === 0 && (snap.asks ?? []).length === 0);

  const imb = snap?.imbalance ?? null;
  const imbVariant = imb == null ? "muted" : imb > 0.15 ? "up" : imb < -0.15 ? "down" : "muted";

  return (
    <div className="flex flex-col h-full min-h-0">
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>Depth</CardTitle>
          <span className="text-caption-1-medium text-text-tertiary tabular">{symbol}</span>
          <Badge variant={streaming ? "up" : "muted"}>{streaming ? "Live" : "Snapshot"}</Badge>
        </div>
        {imb != null && (
          <Badge variant={imbVariant} className="tabular">
            Imbalance {imb >= 0 ? "+" : ""}{(imb * 100).toFixed(1)}%
          </Badge>
        )}
      </CardHeader>

      {empty ? (
        <EmptyState
          icon={Layers}
          title="No depth subscription"
          description="Level 2 requires an IBKR market-depth bundle. For SPY/QQQ try NYSE ArcaBook ($3/mo non-pro); for NASDAQ-listed names try TotalView ($9/mo)."
        />
      ) : !snap ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 p-4">
          {Array.from({ length: rows * 2 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 h-8 items-center bg-background-secondary-default text-caption-1-medium text-text-tertiary border-b border-separator-border">
            <div className="flex justify-between px-3"><span>Bid</span><span>Size</span></div>
            <div className="flex justify-between px-3 border-l border-separator-border"><span>Size</span><span>Ask</span></div>
          </div>
          <div className="grid grid-cols-2 text-caption-1-regular tabular">
            <BookSide side="bid" levels={snap.bids ?? []} maxSize={maxSize} rows={rows} />
            <BookSide side="ask" levels={snap.asks ?? []} maxSize={maxSize} rows={rows} />
          </div>
          <div className="mt-auto grid grid-cols-2 px-3 h-8 items-center text-caption-1-medium tabular border-t border-separator-border bg-background-secondary-default text-text-tertiary">
            <span>Bid total <span className="text-status-lime-text">{fmtCompact(snap.bid_size_total)}</span></span>
            <span className="text-right">Ask total <span className="text-status-rose-text">{fmtCompact(snap.ask_size_total)}</span></span>
          </div>
        </>
      )}
    </div>
  );
}

function BookSide({
  side, levels, maxSize, rows,
}: { side: "bid" | "ask"; levels: DepthLevel[]; maxSize: number; rows: number }) {
  // Pad to ``rows`` so the two columns stay visually balanced even when only
  // one side is populated.
  const padded: (DepthLevel | null)[] = [...levels];
  while (padded.length < rows) padded.push(null);

  return (
    <div className={cn("flex flex-col", side === "ask" && "border-l border-separator-border")}>
      {padded.slice(0, rows).map((lv, i) => (
        <div
          key={i}
          className="relative h-6 flex items-center px-3 border-b border-separator-border"
        >
          {lv && (
            <span
              className={cn(
                "absolute inset-y-0",
                side === "bid" ? "right-0 bg-status-lime-background" : "left-0 bg-status-rose-background"
              )}
              style={{ width: `${Math.max(2, (lv.size / maxSize) * 100)}%` }}
            />
          )}
          <span className={cn(
            "relative z-10 flex w-full text-body-2-medium",
            side === "bid" ? "justify-between" : "flex-row-reverse justify-between"
          )}>
            <span className={side === "bid" ? "text-status-lime-text" : "text-status-rose-text"}>
              {lv ? lv.price.toFixed(2) : "n/a"}
            </span>
            <span className="text-text-secondary">
              {lv ? fmtCompact(lv.size) : ""}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
