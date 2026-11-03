"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { useHealth } from "@/lib/health";
import type { Position, Trade } from "@/types";
import { cn, fmtCurrency, fmtPct, pnlClass } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Stat, StatGroup } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, TableSkeletonRows } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Logo } from "@/components/ui/logo";
import {
  RiLinkM as LinkIcon,
  RiBriefcaseLine as PositionsIcon,
  RiExchangeLine as FillsIcon,
  RiErrorWarningFill as ErrorIcon,
  RiRefreshLine as RefreshCw,
} from "@remixicon/react";

export default function PerformancePage() {
  const { account, initialLoad } = useHealth();
  // Positions are WS-pushed via the store; REST safety net runs in
  // PositionsPanel and StatsBar already. We don't double-poll here.
  const positions = useStore((s) => s.positions);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradesLoaded, setTradesLoaded] = useState(false);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const loadTrades = () =>
    api
      .trades()
      .then((t) => {
        setTrades(t);
        setTradesError(null);
      })
      .catch((e) => setTradesError(e instanceof Error ? e.message : "Could not load fills"))
      .finally(() => setTradesLoaded(true));
  useEffect(() => {
    loadTrades();
    const id = setInterval(loadTrades, 30000);
    return () => clearInterval(id);
  }, []);

  const upnl = useMemo(
    () => positions.reduce((s, p) => s + (p.unrealized_pnl ?? 0), 0),
    [positions]
  );
  const longExposure = useMemo(
    () => positions.reduce((s, p) => {
      const qty = p.quantity ?? 0;
      const price = p.current_price ?? p.avg_price ?? 0;
      return s + (qty > 0 ? qty * price : 0);
    }, 0),
    [positions]
  );
  const shortExposure = useMemo(
    () => positions.reduce((s, p) => {
      const qty = p.quantity ?? 0;
      const price = p.current_price ?? p.avg_price ?? 0;
      return s + (qty < 0 ? Math.abs(qty) * price : 0);
    }, 0),
    [positions]
  );

  return (
    <PageShell>
      <PageHeader
        title="Performance"
        description="IBKR account snapshot, open positions marked to market, and recent fills."
      />

      <AccountCard
        loading={initialLoad && !account}
        equity={account?.equity ?? null}
        buyingPower={account?.buying_power ?? null}
        realized={account?.realized_pnl ?? null}
        unrealized={upnl}
        longExp={longExposure}
        shortExp={shortExposure}
      />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 min-w-0">
            <CardTitle>Positions</CardTitle>
            <Badge variant="muted" className="tabular">{positions.length}</Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {positions.length === 0 ? (
            <EmptyState
              icon={PositionsIcon}
              title="No open positions"
              description="The IBKR position stream fills this in real time."
            />
          ) : (
            <PositionsTable positions={positions} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 min-w-0">
            <CardTitle>Fills</CardTitle>
            {tradesLoaded && <Badge variant="muted" className="tabular">{trades.length}</Badge>}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!tradesLoaded ? (
            <FillsTable>
              <TableSkeletonRows rows={3} cols={7} />
            </FillsTable>
          ) : tradesError ? (
            <div className="flex flex-col items-center gap-3 py-12">
              <Badge variant="down">
                <ErrorIcon size={14} aria-hidden="true" />
                {tradesError}
              </Badge>
              <Button variant="secondary" onClick={loadTrades}>
                <RefreshCw />
                Retry
              </Button>
            </div>
          ) : trades.length === 0 ? (
            <EmptyState
              icon={FillsIcon}
              title="No fills yet"
              description="Closed positions and order fills for the current IBKR session appear here."
            />
          ) : (
            <FillsTable>
              {trades.map((t) => <FillRow key={`${t.timestamp}-${t.symbol}`} t={t} />)}
            </FillsTable>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

// ─── Account stats ────────────────────────────────────────────────────────────
function AccountCard({
  loading, equity, buyingPower, realized, unrealized, longExp, shortExp,
}: {
  loading: boolean;
  equity: number | null;
  buyingPower: number | null;
  realized: number | null;
  unrealized: number;
  longExp: number;
  shortExp: number;
}) {
  const r = realized ?? 0;
  return (
    <Card>
      <CardContent>
        <StatGroup cols={6}>
          {loading ? (
            [0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-5 w-20" />
              </div>
            ))
          ) : (
            <>
              <Stat label="Equity" value={equity != null ? fmtCurrency(equity) : "n/a"} size="md" />
              <Stat label="Buying power" value={buyingPower != null ? fmtCurrency(buyingPower) : "n/a"} size="md" tone="muted" />
              <Stat
                label="Unrealized P&L"
                value={signed(unrealized)}
                size="md"
                tone={unrealized > 0 ? "up" : unrealized < 0 ? "down" : "default"}
              />
              <Stat
                label="Realized P&L"
                value={realized != null ? signed(r) : "n/a"}
                size="md"
                tone={r > 0 ? "up" : r < 0 ? "down" : "default"}
              />
              <Stat label="Long exposure" value={longExp ? fmtCurrency(longExp) : "n/a"} size="md" tone="muted" />
              <Stat label="Short exposure" value={shortExp ? fmtCurrency(shortExp) : "n/a"} size="md" tone="muted" />
            </>
          )}
        </StatGroup>
      </CardContent>
    </Card>
  );
}

function signed(v: number): string {
  return v > 0 ? `+${fmtCurrency(v)}` : fmtCurrency(v);
}

// ─── Positions table ──────────────────────────────────────────────────────────
function PositionsTable({ positions }: { positions: Position[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Symbol</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Avg</TableHead>
          <TableHead className="text-right">Mark</TableHead>
          <TableHead className="text-right">Change vs avg</TableHead>
          <TableHead className="text-right">Market value</TableHead>
          <TableHead className="text-right">Unrealized</TableHead>
          <TableHead className="text-right">Return</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((p, i) => {
          const mkt = (p.current_price ?? 0) * (p.quantity ?? 0);
          const delta = (p.current_price ?? 0) - (p.avg_price ?? 0);
          const qty = p.quantity ?? 0;
          return (
            <TableRow key={`${p.symbol}-${i}`}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Logo symbol={p.symbol} size={16} />
                  <a href={`/chart/${p.symbol}`} className="text-text-primary hover:underline">
                    {p.symbol}
                  </a>
                </div>
              </TableCell>
              <TableCell className={cn("text-right", qty >= 0 ? "text-text-secondary" : "text-status-rose-text")}>
                {qty.toLocaleString()}
              </TableCell>
              <TableCell className="text-right text-text-secondary">
                {p.avg_price != null ? `$${p.avg_price.toFixed(2)}` : "n/a"}
              </TableCell>
              <TableCell className="text-right">
                {p.current_price != null ? `$${p.current_price.toFixed(2)}` : "n/a"}
              </TableCell>
              <TableCell className={cn("text-right", pnlClass(delta))}>
                {delta >= 0 ? "+" : ""}{delta.toFixed(2)}
              </TableCell>
              <TableCell className="text-right text-text-secondary">{fmtCurrency(mkt)}</TableCell>
              <TableCell className={cn("text-right", pnlClass(p.unrealized_pnl ?? 0))}>
                {signed(p.unrealized_pnl ?? 0)}
              </TableCell>
              <TableCell className={cn("text-right", pnlClass(p.unrealized_pnl_pct ?? 0))}>
                {fmtPct(p.unrealized_pnl_pct ?? 0)}
              </TableCell>
              <TableCell className="text-right">
                <a
                  href={`/chart/${p.symbol}`}
                  className="inline-flex text-foreground-icon-tertiary hover:text-text-primary"
                  title="Open chart"
                  aria-label={`Open ${p.symbol} chart`}
                >
                  <LinkIcon size={16} />
                </a>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ─── Fills table ──────────────────────────────────────────────────────────────
function FillsTable({ children }: { children: React.ReactNode }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>When</TableHead>
          <TableHead>Symbol</TableHead>
          <TableHead>Side</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">P&L</TableHead>
          <TableHead>Strategy</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function FillRow({ t }: { t: Trade }) {
  const d = new Date(t.timestamp);
  const pnl = t.pnl ?? 0;
  const buy = t.side === "BUY";
  return (
    <TableRow>
      <TableCell className="text-text-secondary whitespace-nowrap">
        {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        {" "}
        <span className="text-text-tertiary">
          {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </TableCell>
      <TableCell>
        <a href={`/chart/${t.symbol}`} className="text-text-primary hover:underline">{t.symbol}</a>
      </TableCell>
      <TableCell>
        <Badge variant={buy ? "up" : "down"}>{buy ? "Buy" : "Sell"}</Badge>
      </TableCell>
      <TableCell className="text-right text-text-secondary">{t.quantity.toLocaleString()}</TableCell>
      <TableCell className="text-right text-text-secondary">${t.price.toFixed(2)}</TableCell>
      <TableCell className={cn("text-right", pnlClass(pnl))}>
        {t.pnl != null ? signed(pnl) : "n/a"}
      </TableCell>
      <TableCell className="text-text-tertiary">{t.strategy ?? "n/a"}</TableCell>
    </TableRow>
  );
}
