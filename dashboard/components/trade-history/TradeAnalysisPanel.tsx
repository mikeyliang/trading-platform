"use client";

import { memo, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  Award,
  Clock,
  DollarSign,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  type TradeAnalysisResponse,
  type TradeAnalysisTrade,
} from "@/lib/api";
import { cn, fmtCurrency, fmtPct, pnlClass } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

const REFRESH_MS = 60_000;

export const TradeAnalysisPanel = memo(function TradeAnalysisPanel() {
  const [data, setData] = useState<TradeAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  }, []);

  if (error) {
    return (
      <EmptyState
        icon={Activity}
        title="Couldn't load trade analysis"
        description={error}
      />
    );
  }

  if (loading && !data) return <LoadingSkeleton />;

  if (!data || isEmpty(data)) {
    return (
      <EmptyState
        icon={Activity}
        title="No analysis available yet"
        description="Close some trades with realized P&L and they'll show up here."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-2 p-2">
      <InsightCard
        title="Best trade"
        subtitle="by % return"
        icon={TrendingUp}
        tone="up"
        trade={data.best_trade}
        showPct
      />
      <InsightCard
        title="Worst trade"
        subtitle="by % return"
        icon={TrendingDown}
        tone="down"
        trade={data.worst_trade}
        showPct
      />
      <InsightCard
        title="Biggest win"
        subtitle="by $ P&L"
        icon={Award}
        tone="up"
        trade={data.biggest_win}
      />
      <InsightCard
        title="Biggest loss"
        subtitle="by $ P&L"
        icon={DollarSign}
        tone="down"
        trade={data.biggest_loss}
      />
      <HoldTimeCard seconds={data.avg_hold_time_seconds} />
    </div>
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

function CardShell({
  title,
  subtitle,
  icon: Icon,
  tone,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  tone?: "up" | "down" | "neutral";
  children: React.ReactNode;
}) {
  const iconCls =
    tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text-muted";
  return (
    <div className="rounded-md border border-border bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 h-7 border-b border-border/60">
        <div className="flex items-center gap-1.5">
          <Icon size={11} className={iconCls} />
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            {title}
          </span>
        </div>
        {subtitle && (
          <span className="text-[9px] uppercase tracking-wider text-text-muted/70">
            {subtitle}
          </span>
        )}
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
  icon: LucideIcon;
  tone: "up" | "down";
  trade: TradeAnalysisTrade | null;
  showPct?: boolean;
}) {
  return (
    <CardShell title={title} subtitle={subtitle} icon={icon} tone={tone}>
      {trade ? (
        <div className="px-3 py-2.5 flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-text-primary tabular">
              {trade.symbol ?? "—"}
            </span>
            {trade.side && (
              <Badge variant={trade.side === "BUY" ? "up" : "down"}>{trade.side}</Badge>
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "text-base font-semibold tabular tabular-nums",
                trade.pnl != null ? pnlClass(trade.pnl) : "text-text-muted"
              )}
            >
              {trade.pnl != null ? fmtCurrency(trade.pnl) : "—"}
            </span>
            {showPct && trade.pnl_percentage != null && (
              <span className={cn("text-[11px] tabular", pnlClass(trade.pnl_percentage))}>
                {fmtPct(trade.pnl_percentage)}
              </span>
            )}
          </div>
          <div
            className="text-[10px] text-text-muted tabular"
            title={new Date(trade.timestamp).toLocaleString()}
          >
            {fmtRelative(trade.timestamp)}
          </div>
        </div>
      ) : (
        <div className="px-3 py-4 text-[11px] text-text-muted text-center">
          no qualifying trade
        </div>
      )}
    </CardShell>
  );
}

function HoldTimeCard({ seconds }: { seconds: number | null }) {
  return (
    <CardShell title="Avg hold time" icon={Clock} tone="neutral">
      <div className="px-3 py-2.5 flex flex-col gap-1">
        {seconds == null ? (
          <span className="text-sm font-medium text-text-muted">—</span>
        ) : (
          <>
            <span className="text-base font-semibold text-text-primary tabular tabular-nums">
              {fmtDuration(seconds)}
            </span>
            <span className="text-[10px] text-text-muted">
              average BUY → SELL gap per symbol
            </span>
          </>
        )}
      </div>
    </CardShell>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-2 p-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  );
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true });
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = seconds / 60;
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  const d = h / 24;
  return `${d.toFixed(d < 10 ? 1 : 0)}d`;
}
