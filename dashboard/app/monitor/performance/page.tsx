"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { useHealth } from "@/lib/health";
import type { Position, Trade } from "@/types";
import { cn, fmtCurrency, fmtPct, pnlClass } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Logo } from "@/components/ui/logo";
import { RiLinkM as LinkIcon } from "@remixicon/react";

export default function PerformancePage() {
  const { account } = useHealth();
  // Positions are WS-pushed via the store; REST safety net runs in
  // PositionsPanel and StatsBar already. We don't double-poll here.
  const positions = useStore((s) => s.positions);

  const [trades, setTrades] = useState<Trade[]>([]);
  useEffect(() => {
    const load = () => api.trades().then(setTrades).catch(() => undefined);
    load();
    const id = setInterval(load, 30000);
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
        eyebrow="Account"
        title="Performance"
        description="IBKR account snapshot, open positions mark-to-market, recent fills."
      />

      <HeroStats
        equity={account?.equity ?? null}
        buyingPower={account?.buying_power ?? null}
        realized={account?.realized_pnl ?? null}
        unrealized={upnl}
        longExp={longExposure}
        shortExp={shortExposure}
      />

      <Section title="Positions" trail={`${positions.length} open`}>
        {positions.length === 0 ? (
          <Empty hint="No open positions. The IBKR position stream populates this in real time." />
        ) : (
          <PositionsTable positions={positions} />
        )}
      </Section>

      <Section title="Fills" trail={`${trades.length} recent`}>
        {trades.length === 0 ? (
          <Empty hint="No fills yet for the current IBKR session. Closed positions and order fills will appear here." />
        ) : (
          <FillsTable trades={trades} />
        )}
      </Section>
    </PageShell>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────
function HeroStats({
  equity, buyingPower, realized, unrealized, longExp, shortExp,
}: {
  equity: number | null;
  buyingPower: number | null;
  realized: number | null;
  unrealized: number;
  longExp: number;
  shortExp: number;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-x-4 gap-y-2 py-1">
      <Big label="Equity"
           value={equity != null ? fmtCurrency(equity) : "n/a"} />
      <Big label="Buying power"
           value={buyingPower != null ? fmtCurrency(buyingPower) : "n/a"}
           muted />
      <Big label="Unrealized"
           value={unrealized !== 0 ? fmtCurrency(unrealized) : "$0"}
           tone={unrealized > 0 ? "up" : unrealized < 0 ? "down" : undefined} />
      <Big label="Realized"
           value={realized != null ? fmtCurrency(realized) : "$0"}
           tone={(realized ?? 0) > 0 ? "up" : (realized ?? 0) < 0 ? "down" : undefined} />
      <Big label="Long exp"
           value={longExp ? fmtCurrency(longExp) : "n/a"}
           muted />
      <Big label="Short exp"
           value={shortExp ? fmtCurrency(shortExp) : "n/a"}
           muted />
    </div>
  );
}

function Big({ label, value, tone, muted }: { label: string; value: string; tone?: "up" | "down"; muted?: boolean }) {
  return (
    <div>
      <div className="text-caption-2-regular text-text-tertiary mb-1.5">{label}</div>
      <div className={cn(
        "text-headline-regular md:text-title-3-regular font-semibold tabular",
        tone === "up" ? "text-status-lime-text" : tone === "down" ? "text-status-rose-text" : muted ? "text-text-secondary" : "text-text-primary"
      )}>
        {value}
      </div>
    </div>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────
function Section({ title, trail, children }: { title: string; trail?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between border-b border-separator-border pb-1.5">
        <h2 className="text-caption-1-regular text-text-secondary">{title}</h2>
        {trail && <span className="text-caption-2-regular text-text-tertiary tabular">{trail}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ hint }: { hint: string }) {
  return <div className="py-3 text-caption-1-regular text-text-tertiary">{hint}</div>;
}

// ─── Positions table ──────────────────────────────────────────────────────────
function PositionsTable({ positions }: { positions: Position[] }) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-caption-1-regular tabular">
        <thead className="text-caption-2-regular text-text-tertiary">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Symbol</th>
            <th className="px-2 py-1 text-right font-medium">Qty</th>
            <th className="px-2 py-1 text-right font-medium">Avg</th>
            <th className="px-2 py-1 text-right font-medium">Mark</th>
            <th className="px-2 py-1 text-right font-medium">Δ vs avg</th>
            <th className="px-2 py-1 text-right font-medium">Mkt value</th>
            <th className="px-2 py-1 text-right font-medium">Unrealized</th>
            <th className="px-2 py-1 text-right font-medium">%</th>
            <th className="px-2 py-1"></th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const mkt = (p.current_price ?? 0) * (p.quantity ?? 0);
            const delta = (p.current_price ?? 0) - (p.avg_price ?? 0);
            return (
              <tr key={p.symbol} className="border-t border-separator-border hover:bg-background-secondary-hover transition-colors">
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <Logo symbol={p.symbol} size={16} />
                    <a
                      href={`/chart/${p.symbol}`}
                      className="font-medium text-text-primary hover:underline"
                    >
                      {p.symbol}
                    </a>
                  </div>
                </td>
                <td className={cn(
                  "px-2 py-1.5 text-right",
                  (p.quantity ?? 0) >= 0 ? "text-text-secondary" : "text-status-rose-text"
                )}>
                  {(p.quantity ?? 0).toLocaleString()}
                </td>
                <td className="px-2 py-1.5 text-right text-text-secondary">
                  ${p.avg_price?.toFixed(2) ?? "n/a"}
                </td>
                <td className="px-2 py-1.5 text-right text-text-primary">
                  ${p.current_price?.toFixed(2) ?? "n/a"}
                </td>
                <td className={cn("px-2 py-1.5 text-right", pnlClass(delta))}>
                  {delta >= 0 ? "+" : ""}{delta.toFixed(2)}
                </td>
                <td className="px-2 py-1.5 text-right text-text-secondary">
                  {fmtCurrency(mkt)}
                </td>
                <td className={cn("px-2 py-1.5 text-right font-medium", pnlClass(p.unrealized_pnl ?? 0))}>
                  {fmtCurrency(p.unrealized_pnl ?? 0)}
                </td>
                <td className={cn("px-2 py-1.5 text-right", pnlClass(p.unrealized_pnl_pct ?? 0))}>
                  {fmtPct(p.unrealized_pnl_pct ?? 0)}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <a href={`/chart/${p.symbol}`} className="text-text-tertiary hover:text-accent-500 inline-flex" title="Open chart">
                    <LinkIcon size={12} />
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Fills table ──────────────────────────────────────────────────────────────
function FillsTable({ trades }: { trades: Trade[] }) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-caption-1-regular tabular">
        <thead className="text-caption-2-regular text-text-tertiary">
          <tr>
            <th className="px-2 py-1 text-left font-medium">When</th>
            <th className="px-2 py-1 text-left font-medium">Symbol</th>
            <th className="px-2 py-1 text-left font-medium">Side</th>
            <th className="px-2 py-1 text-right font-medium">Qty</th>
            <th className="px-2 py-1 text-right font-medium">Price</th>
            <th className="px-2 py-1 text-right font-medium">P&L</th>
            <th className="px-2 py-1 text-left font-medium">Strategy</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const d = new Date(t.timestamp);
            const pnl = t.pnl ?? 0;
            return (
              <tr key={`${t.timestamp}-${t.symbol}`} className="border-t border-separator-border hover:bg-background-secondary-hover">
                <td className="px-2 py-1.5 text-text-secondary whitespace-nowrap">
                  {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  {" "}
                  <span className="text-text-tertiary">
                    {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </td>
                <td className="px-2 py-1.5">
                  <a href={`/chart/${t.symbol}`} className="font-medium text-text-primary hover:underline">{t.symbol}</a>
                </td>
                <td className={cn("px-2 py-1.5 text-caption-2-regular",
                  t.side === "BUY" ? "text-status-lime-text" : "text-status-rose-text"
                )}>{t.side}</td>
                <td className="px-2 py-1.5 text-right text-text-secondary">{t.quantity.toLocaleString()}</td>
                <td className="px-2 py-1.5 text-right text-text-secondary">${t.price.toFixed(2)}</td>
                <td className={cn("px-2 py-1.5 text-right", pnlClass(pnl))}>
                  {t.pnl != null ? fmtCurrency(pnl) : "n/a"}
                </td>
                <td className="px-2 py-1.5 text-text-tertiary text-caption-2-regular">
                  {t.strategy ?? "n/a"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
