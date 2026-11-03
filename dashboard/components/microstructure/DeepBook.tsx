"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DepthSnapshot, type DepthLevel } from "@/lib/api";
import { StreamWebSocket } from "@/lib/ws-stream";
import { cn, fmtCompact } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
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

  if (unavailable || (snap && !snap.available && (snap.bids ?? []).length === 0 && (snap.asks ?? []).length === 0)) {
    return (
      <EmptyState
        icon={Layers}
        title="No depth subscription"
        description="Level 2 requires an IBKR market-depth bundle. For SPY/QQQ try NYSE ArcaBook ($3/mo non-pro); for NASDAQ-listed names try TotalView ($9/mo)."
      />
    );
  }

  const imb = snap?.imbalance ?? null;
  const imbColor = imb == null ? "text-text-tertiary" : imb > 0.15 ? "text-status-lime-text" : imb < -0.15 ? "text-status-rose-text" : "text-text-secondary";

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-2 h-7 border-b border-separator-border text-caption-2-regular text-text-tertiary">
        <span className="flex items-center gap-1.5">
          <Layers size={10} className="text-accent-500" />
          Depth · {symbol}
          <span
            className={cn(
              "ml-1 inline-block w-1 h-1 rounded-full",
              streaming ? "bg-status-lime-text" : "bg-foreground-icon-quaternary"
            )}
          />
        </span>
        {imb != null && (
          <span className={cn("tabular", imbColor)}>
            imb {imb >= 0 ? "+" : ""}{(imb * 100).toFixed(1)}%
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 text-caption-2-regular tabular">
        <BookSide side="bid" levels={snap?.bids ?? []} maxSize={maxSize} rows={rows} />
        <BookSide side="ask" levels={snap?.asks ?? []} maxSize={maxSize} rows={rows} />
      </div>

      {snap && (
        <div className="grid grid-cols-2 px-2 h-6 items-center text-caption-2-regular tabular border-t border-separator-border text-text-tertiary">
          <span>bid Σ <span className="text-status-lime-text font-medium">{fmtCompact(snap.bid_size_total)}</span></span>
          <span className="text-right">ask Σ <span className="text-status-rose-text font-medium">{fmtCompact(snap.ask_size_total)}</span></span>
        </div>
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
          className="relative h-[18px] flex items-center px-2"
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
            "relative z-10 flex w-full",
            side === "bid" ? "justify-between" : "flex-row-reverse justify-between"
          )}>
            <span className={side === "bid" ? "text-status-lime-text font-medium" : "text-status-rose-text font-medium"}>
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
