"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type TradeHistoryRecord, type TradeStats } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { formatDistanceToNow } from "date-fns";

const SIDE_COLORS: Record<string, string> = {
  buy: "text-up",
  sell: "text-down",
};

export function TradeHistoryPanel() {
  const [trades, setTrades] = useState<TradeHistoryRecord[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  
  // Filters
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState("");
  const [strategy, setStrategy] = useState("");
  
  // Calculate stats
  const displayStats = useMemo(() => {
    if (stats) return stats;
    if (trades.length === 0) return null;
    
    // Calculate from current trades
    const total = trades.length;
    const winning = trades.filter(t => t.pnl && t.pnl > 0);
    const losing = trades.filter(t => t.pnl && t.pnl < 0);
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    
    return {
      total_trades: total,
      winning_trades: winning.length,
      losing_trades: losing.length,
      win_rate: total > 0 ? (winning.length / total) * 100 : 0,
      total_pnl: totalPnl,
      avg_pnl: total > 0 ? totalPnl / total : 0,
      profit_factor: 0,
    } as TradeStats;
  }, [stats, trades]);

  // Load trades
  useEffect(() => {
    let alive = true;
    setLoading(true);
    
    const params: any = { page, page_size: pageSize };
    if (symbol) params.symbol = symbol;
    if (side) params.side = side;
    if (strategy) params.strategy = strategy;
    
    api.tradeHistory(params)
      .then((r) => { if (alive) setTrades(r.trades || []); })
      .finally(() => { if (alive) setLoading(false); });
    
    return () => { alive = false; };
  }, [page, pageSize, symbol, side, strategy]);

  // Load stats
  useEffect(() => {
    let alive = true;
    setStatsLoading(true);
    
    api.tradeHistoryStats()
      .then((s) => { if (alive) setStats(s); })
      .finally(() => { if (alive) setStatsLoading(false); });
    
    return () => { alive = false; };
  }, []);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Trade history"
        title="Past Trades"
        description="All executed trades with P&L tracking. Filter by symbol, side, or strategy."
      />

      {/* Stats Strip */}
      {!statsLoading && displayStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard label="Total Trades" value={displayStats.total_trades} />
          <StatCard label="Win Rate" value={`${displayStats.win_rate.toFixed(1)}%`} />
          <StatCard 
            label="Total P&L" 
            value={`$${displayStats.total_pnl.toFixed(2)}`}
            positive={displayStats.total_pnl > 0}
            negative={displayStats.total_pnl < 0}
          />
          <StatCard 
            label="Avg P&L" 
            value={`$${displayStats.avg_pnl.toFixed(2)}`}
            positive={displayStats.avg_pnl > 0}
            negative={displayStats.avg_pnl < 0}
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Symbol..."
          value={symbol}
          onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setPage(1); }}
          className="h-7 px-2 text-[11px] bg-surface-1 border border-surface-2 rounded-sm w-24"
        />
        
        <select
          value={side}
          onChange={(e) => { setSide(e.target.value); setPage(1); }}
          className="h-7 px-2 text-[11px] bg-surface-1 border border-surface-2 rounded-sm"
        >
          <option value="">All Sides</option>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>

        <input
          type="text"
          placeholder="Strategy..."
          value={strategy}
          onChange={(e) => { setStrategy(e.target.value); setPage(1); }}
          className="h-7 px-2 text-[11px] bg-surface-1 border border-surface-2 rounded-sm w-32"
        />
      </div>

      {/* Loading State */}
      {loading && <SkeletonList />}

      {/* Empty State */}
      {!loading && trades.length === 0 && (
        <div className="py-16 text-center">
          <p className="text-sm text-text-secondary">No trades recorded yet.</p>
          <p className="text-xs text-text-muted mt-2">
            Trades will appear here after execution by agents or manual entry.
          </p>
        </div>
      )}

      {/* Trades Table */}
      {!loading && trades.length > 0 && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[11px] tabular">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-text-muted">
                <th className="px-3 py-2 text-left font-medium">Time</th>
                <th className="px-3 py-2 text-left font-medium">Symbol</th>
                <th className="px-3 py-2 text-left font-medium">Side</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="px-3 py-2 text-right font-medium">P&L</th>
                <th className="px-3 py-2 text-left font-medium">Strategy</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-t border-surface-2 hover:bg-surface-2/50 transition-colors">
                  <td className="px-3 py-2 text-text-secondary">
                    {t.timestamp ? formatDistanceToNow(new Date(t.timestamp), { addSuffix: true }) : '-'}
                  </td>
                  <td className="px-3 py-2 font-medium">{t.symbol}</td>
                  <td className={cn("px-3 py-2 font-medium", SIDE_COLORS[t.side] || "")}>
                    {t.side.toUpperCase()}
                  </td>
                  <td className="px-3 py-2 text-right">{t.quantity}</td>
                  <td className="px-3 py-2 text-right">${t.price.toFixed(2)}</td>
                  <td className={cn("px-3 py-2 text-right font-medium", 
                    t.pnl && t.pnl > 0 ? "text-up" : t.pnl && t.pnl < 0 ? "text-down" : ""
                  )}>
                    {t.pnl ? `$${t.pnl.toFixed(2)}` : '-'}
                  </td>
                  <td className="px-3 py-2 text-text-secondary">{t.strategy || '-'}</td>
                  <td className="px-3 py-2">
                    <span className={cn(
                      "px-1.5 py-0.5 rounded text-[10px]",
                      t.status === 'filled' ? "bg-accent/20 text-accent" :
                      t.status === 'partial' ? "bg-warning/20 text-warning" :
                      "bg-destructive/20 text-destructive"
                    )}>
                      {t.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

function StatCard({ 
  label, 
  value, 
  positive, 
  negative 
}: { 
  label: string; 
  value: string | number; 
  positive?: boolean; 
  negative?: boolean; 
}) {
  return (
    <div className="bg-surface-1 border border-surface-2 rounded p-3">
      <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{label}</p>
      <p className={cn(
        "text-lg font-semibold tabular",
        positive && "text-up",
        negative && "text-down"
      )}>
        {value}
      </p>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-8 bg-surface-1 animate-pulse rounded" />
      ))}
    </div>
  );
}
