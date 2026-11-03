"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TapePrint } from "@/lib/api";
import { StreamWebSocket } from "@/lib/ws-stream";
import { cn, fmtCompact } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RiBillLine as Receipt } from "@remixicon/react";

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

  const ratioVariant =
    stats.ratio == null ? "muted" : stats.ratio > 0.1 ? "up" : stats.ratio < -0.1 ? "down" : "muted";

  return (
    <div className="flex flex-col h-full min-h-0">
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>Tape</CardTitle>
          <span className="text-caption-1-medium text-text-tertiary tabular">{symbol}</span>
          <Badge variant={streaming ? "up" : "muted"}>{streaming ? "Live" : "Snapshot"}</Badge>
        </div>
        {stats.ratio != null && (
          <div className="flex items-center gap-2 text-caption-1-medium text-text-tertiary tabular">
            <span>Buy {fmtCompact(stats.buy)}</span>
            <span>Sell {fmtCompact(stats.sell)}</span>
            <Badge variant={ratioVariant}>
              {stats.ratio >= 0 ? "+" : ""}{(stats.ratio * 100).toFixed(0)}% net
            </Badge>
          </div>
        )}
      </CardHeader>

      {unavailable ? (
        <EmptyState
          icon={Receipt}
          title="No tick-by-tick subscription"
          description="Time and sales needs an IBKR streaming bundle (e.g. US Securities Snapshot, ~$10/mo non-pro). Enable it in IBKR Client Portal under Market Data Subscriptions."
        />
      ) : (
        <>
          <div className="grid grid-cols-[72px_1fr_80px] px-3 h-8 items-center bg-background-secondary-default text-caption-1-medium text-text-tertiary border-b border-separator-border">
            <span>Time</span>
            <span className="text-right">Price</span>
            <span className="text-right">Size</span>
          </div>

          <div className="flex-1 overflow-auto">
            {prints.length === 0 ? (
              <EmptyState
                size="sm"
                icon={Receipt}
                title="Waiting for prints"
                description="Rows appear as trades print on the tape."
              />
            ) : (
              prints.map((p, i) => {
                const isLarge = p.size >= largePrintThreshold;
                const sideCol =
                  p.side === "buy" ? "text-status-lime-text" :
                  p.side === "sell" ? "text-status-rose-text" :
                  "text-text-secondary";
                return (
                  <div
                    key={`${p.ts}-${i}`}
                    className={cn(
                      "grid grid-cols-[72px_1fr_80px] px-3 h-6 items-center text-body-2-medium tabular border-b border-separator-border",
                      isLarge && "bg-status-yellow-background"
                    )}
                  >
                    <span className="text-caption-1-regular text-text-tertiary">{fmtTime(p.ts)}</span>
                    <span className={cn("text-right", sideCol)}>{p.price.toFixed(2)}</span>
                    <span className={cn("text-right", isLarge ? "text-status-yellow-text" : "text-text-secondary")}>
                      {fmtCompact(p.size)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
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
