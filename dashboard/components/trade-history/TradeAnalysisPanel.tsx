"use client";

import { memo, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  RiPulseLine,
  RiAwardLine,
  RiTimeLine,
  RiMoneyDollarCircleLine,
  RiArrowRightDownLine,
  RiArrowRightUpLine,
  RiErrorWarningFill,
  type RemixiconComponentType,
} from "@remixicon/react";
import {
  api,
  type TradeAnalysisResponse,
  type TradeAnalysisTrade,
} from "@/lib/api";
import { cn, fmtCurrency, fmtPct, pnlClass } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

const REFRESH_MS = 60_000;

export const TradeAnalysisPanel = memo(function TradeAnalysisPanel() {
  const [data, setData] = useState<TradeAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.tradeHistoryAnalysis();
        if (cancelled) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [nonce]);

  let body: React.ReactNode;
  if (error) {
    body = (
      <EmptyState
        icon={RiErrorWarningFill}
        title="Analysis unavailable"
        description={error}
        action={<Button onClick={() => setNonce((n) => n + 1)}>Retry</Button>}
      />
    );
  } else if (loading && !data) {
    body = <LoadingSkeleton />;
  } else if (!data || isEmpty(data)) {
    body = (
      <EmptyState
        icon={RiPulseLine}
        title="No analysis yet"
        description="Close some trades with realized P&L and the best, worst and biggest show up here."
      />
    );
  } else {
    body = (
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          <InsightCard
            title="Best trade"
            subtitle="by return"
            icon={RiArrowRightUpLine}
            tone="up"
            trade={data.best_trade}
            showPct
          />
          <InsightCard
            title="Worst trade"
            subtitle="by return"
            icon={RiArrowRightDownLine}
            tone="down"
            trade={data.worst_trade}
            showPct
          />
          <InsightCard
            title="Biggest win"
            subtitle="by P&L"
            icon={RiAwardLine}
            tone="up"
            trade={data.biggest_win}
          />
          <InsightCard
            title="Biggest loss"
            subtitle="by P&L"
            icon={RiMoneyDollarCircleLine}
            tone="down"
            trade={data.biggest_loss}
          />
          <HoldTimeCard seconds={data.avg_hold_time_seconds} />
        </div>
      </CardContent>
    );
  }

  return (
    <Card className="shrink-0">
      <CardHeader>
        <CardTitle>Trade analysis</CardTitle>
        <span className="text-caption-1-regular text-text-tertiary">Realized P&L, refreshed every minute</span>
      </CardHeader>
      {body}
    </Card>
  );
});

function isEmpty(d: TradeAnalysisResponse): boolean {
  return (
    !d.best_trade &&
    !d.worst_trade &&
    !d.biggest_win &&
    !d.biggest_loss &&
    d.avg_hold_time_seconds == null
  );
}

function Tile({
  title,
  subtitle,
  icon: Icon,
  tone,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: RemixiconComponentType;
  tone?: "up" | "down" | "neutral";
  children: React.ReactNode;
}) {
  const iconCls =
    tone === "up" ? "text-status-lime-text" : tone === "down" ? "text-status-rose-text" : "text-foreground-icon-tertiary";
  return (
    <div className="rounded-2lg bg-background-secondary-default p-3 flex flex-col gap-2 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon size={16} className={cn("shrink-0", iconCls)} aria-hidden />
          <span className="text-caption-1-medium text-text-tertiary truncate">{title}</span>
        </div>
        {subtitle && <span className="text-caption-1-regular text-text-tertiary whitespace-nowrap">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function InsightCard({
  title,
  subtitle,
  icon,
  tone,
  trade,
  showPct,
}: {
  title: string;
  subtitle: string;
  icon: RemixiconComponentType;
  tone: "up" | "down";
  trade: TradeAnalysisTrade | null;
  showPct?: boolean;
}) {
  return (
    <Tile title={title} subtitle={subtitle} icon={icon} tone={tone}>
      {trade ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-body-2-medium text-text-primary tabular truncate">{trade.symbol ?? "n/a"}</span>
            {trade.side && (
              <Badge variant={trade.side === "BUY" ? "up" : "down"}>{trade.side === "BUY" ? "Buy" : "Sell"}</Badge>
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "text-headline-semibold tabular",
                trade.pnl != null ? pnlClass(trade.pnl) : "text-text-tertiary"
              )}
            >
              {trade.pnl != null ? fmtCurrency(trade.pnl) : "n/a"}
            </span>
            {showPct && trade.pnl_percentage != null && (
              <span className={cn("text-caption-1-medium tabular", pnlClass(trade.pnl_percentage))}>
                {fmtPct(trade.pnl_percentage)}
              </span>
            )}
          </div>
          <div
            className="text-caption-1-regular text-text-tertiary tabular"
            title={new Date(trade.timestamp).toLocaleString()}
          >
            {fmtRelative(trade.timestamp)}
          </div>
        </div>
      ) : (
        <div className="py-3 text-caption-1-regular text-text-tertiary">No qualifying trade</div>
      )}
    </Tile>
  );
}

function HoldTimeCard({ seconds }: { seconds: number | null }) {
  return (
    <Tile title="Avg hold time" icon={RiTimeLine} tone="neutral">
      <div className="flex flex-col gap-1">
        {seconds == null ? (
          <span className="text-headline-semibold text-text-tertiary">n/a</span>
        ) : (
          <>
            <span className="text-headline-semibold text-text-primary tabular">{fmtDuration(seconds)}</span>
            <span className="text-caption-1-regular text-text-tertiary">Average buy to sell gap per symbol</span>
          </>
        )}
      </div>
    </Tile>
  );
}

function LoadingSkeleton() {
  return (
    <CardContent>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3" role="status" aria-label="Loading analysis">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-2lg" />
        ))}
      </div>
    </CardContent>
  );
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "n/a";
  return formatDistanceToNow(d, { addSuffix: true });
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "n/a";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = seconds / 60;
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  const d = h / 24;
  return `${d.toFixed(d < 10 ? 1 : 0)}d`;
}
