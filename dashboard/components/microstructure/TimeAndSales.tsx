"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TapePrint } from "@/lib/api";
import { StreamWebSocket } from "@/lib/ws-stream";
import { cn, fmtCompact } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { Receipt } from "lucide-react";

interface Props {
  symbol: string;
  /** Cap on rows kept in memory; older prints scroll off the top. */
  maxRows?: number;
  /** Sizes ≥ this get the "large print" highlight. Sensible defaults for
   *  retail ETF tape; will need adjusting for thinner names. */
  largePrintThreshold?: number;
}

export function TimeAndSales({ symbol, maxRows = 120, largePrintThreshold = 1000 }: Props) {
  const [prints, setPrints] = useState<TapePrint[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const wsRef = useRef<StreamWebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPrints([]);
    setUnavailable(false);
    api.recentPrints(symbol, maxRows).then((s) => {
      if (cancelled) return;
      if (!s.available) setUnavailable(true);
      else setPrints(s.prints.slice().reverse());
    }).catch(() => null);
    return () => { cancelled = true; };
  }, [symbol, maxRows]);

  useEffect(() => {
    const ws = new StreamWebSocket(`/api/ticks/ws/${symbol}`);
    wsRef.current = ws;
    const off = ws.on((msg) => {
      if (msg.type === "open") setStreaming(true);
      if (msg.type === "close") setStreaming(false);
      if (msg.type === "unavailable") setUnavailable(true);
      if (msg.type === "tape" && msg.data) {
        const d = msg.data as { prints: TapePrint[] };
        setPrints(d.prints.slice().reverse());
      }
      if (msg.type === "print" && msg.data) {
        const p = msg.data as TapePrint;
        setPrints((prev) => [p, ...prev].slice(0, maxRows));
      }
    });
    ws.connect();
    return () => { off(); ws.disconnect(); };
  }, [symbol, maxRows]);

  const stats = useMemo(() => {
    let buy = 0, sell = 0;
    for (const p of prints) {
      if (p.side === "buy") buy += p.size;
      else if (p.side === "sell") sell += p.size;
    }
    const total = buy + sell;
    const ratio = total > 0 ? (buy - sell) / total : null;
    return { buy, sell, ratio };
  }, [prints]);

  if (unavailable) {
    return (
      <EmptyState
        icon={Receipt}
        title="No tick-by-tick subscription"
        description="Time & Sales needs an IBKR streaming bundle (e.g. US Securities Snapshot, ~$10/mo non-pro). Available now in IBKR Client Portal → Market Data Subscriptions."
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 h-7 border-b border-border/60 text-[10px] uppercase tracking-wider text-text-muted">
        <span className="flex items-center gap-1.5">
          <Receipt size={10} className="text-accent" />
          Tape · {symbol}
          <span
            className={cn(
              "ml-1 inline-block w-1 h-1 rounded-full",
              streaming ? "bg-up" : "bg-text-muted"
            )}
          />
        </span>
        {stats.ratio != null && (
          <span className={cn(
            "tabular",
            stats.ratio > 0.1 ? "text-up" : stats.ratio < -0.1 ? "text-down" : "text-text-secondary"
          )}>
            buy {fmtCompact(stats.buy)} / sell {fmtCompact(stats.sell)} · {stats.ratio >= 0 ? "+" : ""}{(stats.ratio * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {/* Header row */}
      <div className="grid grid-cols-[64px_1fr_72px] px-2 h-5 items-center text-[9px] uppercase tracking-wider text-text-muted border-b border-border/40">
        <span>Time</span>
        <span>Price</span>
        <span className="text-right">Size</span>
      </div>

      <div className="flex-1 overflow-auto">
        {prints.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[10px] text-text-muted">
            awaiting prints…
          </div>
        ) : (
          prints.map((p, i) => {
            const isLarge = p.size >= largePrintThreshold;
            const sideCol =
              p.side === "buy" ? "text-up" :
              p.side === "sell" ? "text-down" :
              "text-text-secondary";
            return (
              <div
                key={`${p.ts}-${i}`}
                className={cn(
                  "grid grid-cols-[64px_1fr_72px] px-2 h-[18px] items-center text-[10px] tabular border-b border-border/15",
                  isLarge && "bg-warning/10"
                )}
              >
                <span className="text-text-muted">{fmtTime(p.ts)}</span>
                <span className={cn("font-medium", sideCol)}>{p.price.toFixed(2)}</span>
                <span className={cn("text-right", isLarge ? "text-warning font-semibold" : "text-text-secondary")}>
                  {fmtCompact(p.size)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function fmtTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
