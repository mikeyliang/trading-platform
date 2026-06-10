"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Trade } from "@/types";
import { Clock } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function TradeHistoryPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = "Trade History · Trade";
  }, []);

  useEffect(() => {
    api.trades()
      .then(setTrades)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <Clock size={18} className="text-text-muted" />
        <h1 className="text-lg font-semibold">Trade History</h1>
        <Badge variant="muted" className="ml-2">{trades.length}</Badge>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64 text-text-muted">
          Loading trades...
        </div>
      ) : trades.length === 0 ? (
        <div className="flex items-center justify-center h-64 text-text-muted">
          No trades found. Executed trades from IBKR will appear here.
        </div>
      ) : (
        <div className="rounded-md border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-surface-2">
                <TableHead>Time</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">P&L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="text-text-muted tabular font-mono text-xs">
                    {new Date(t.timestamp).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-medium">{t.symbol}</TableCell>
                  <TableCell>{t.side}</TableCell>
                  <TableCell className="text-right tabular">{t.quantity}</TableCell>
                  <TableCell className="text-right tabular font-mono">
                    ${t.price.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right tabular font-mono">
                    {t.pnl != null ? `$${t.pnl.toFixed(2)}` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
