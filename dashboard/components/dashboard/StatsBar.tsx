"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { fmtCurrency, cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { Skeleton } from "@/components/ui/skeleton";
import { useHealth } from "@/lib/health";
import type { Position } from "@/types";

// Account KPI band at the top of the dashboard.
//
// Layout follows a stat-tile contract: sentence-case label, one value, and an
// optional context line underneath. Net liquidation leads (the one larger
// figure in the band); P&L tiles are signed AND carry a direction arrow so
// up/down never rests on red/green alone; win rate gets a thin meter with a
// 50% reference tick. Everything stays in one dense row on desktop and wraps
// into a 2-column grid on narrow screens instead of scrolling sideways.
export const StatsBar = memo(function StatsBar() {
  const { account, initialLoad } = useHealth();
  // Positions are WS-pushed by the API every ~10s (via the `snapshot` event in
  // WSProvider) and on every IB position-update. Keep a slow REST safety net
  // for cold start / when WS is disconnected.
  const wsPositions = useStore((s) => s.positions);
  const setStorePositions = useStore((s) => s.setPositions);
  const [restHydrated, setRestHydrated] = useState(false);

  useEffect(() => {
    const load = () => {
      api
        .positions()
        .then((p) => {
          setStorePositions(p);
          setRestHydrated(true);
        })
        .catch(() => undefined);
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [setStorePositions]);

  const positions = restHydrated || wsPositions.length > 0 ? wsPositions : null;

  // Recompute only when positions change, not on every quote tick.
  const book = useMemo(() => summarizeBook(positions ?? []), [positions]);

  const loading = initialLoad && !account;
  const equity = account?.equity ?? null;
  const realized = account?.realized_pnl ?? 0;
  const winRate = account?.win_rate ?? 0;
  const trades = account?.total_trades ?? 0;

  const upnlPctOfEquity =
    positions !== null && equity && equity > 0 ? (book.upnl / equity) * 100 : null;

  return (
    <section
      aria-label="Account summary"
      className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 bg-surface border-b border-border shrink-0"
    >
      <Tile label="Net liquidation" lead loading={loading}>
        {account ? (
          <>
            <Value lead>{fmtCurrency(equity)}</Value>
            <Hint>Cash {fmtCurrency(account.balance)}</Hint>
          </>
        ) : (
          <Empty />
        )}
      </Tile>

      <Tile label="Unrealized P&L" loading={loading}>
        {positions !== null ? (
          <>
            <Signed value={book.upnl} />
            <Hint>
              {upnlPctOfEquity != null
                ? `${upnlPctOfEquity >= 0 ? "+" : "−"}${Math.abs(upnlPctOfEquity).toFixed(2)}% of net liq`
                : "Open positions"}
            </Hint>
          </>
        ) : (
          <Empty />
        )}
      </Tile>

      <Tile label="Realized P&L" loading={loading}>
        {account ? (
          <>
            <Signed value={realized} />
            <Hint>Closed trades</Hint>
          </>
        ) : (
          <Empty />
        )}
      </Tile>

      <Tile label="Open positions" loading={loading}>
        {positions !== null ? (
          <>
            <Value>{positions.length.toString()}</Value>
            <Hint>{positionsHint(book)}</Hint>
          </>
        ) : (
          <Empty />
        )}
      </Tile>

      <Tile label="Win rate" loading={loading}>
        {account ? (
          <>
            <div className="flex items-baseline gap-2">
              <Value>{trades > 0 ? `${winRate.toFixed(0)}%` : "—"}</Value>
              <span className="text-2xs text-text-muted tabular">
                {trades} {trades === 1 ? "trade" : "trades"}
              </span>
            </div>
            <WinMeter pct={trades > 0 ? winRate : null} />
          </>
        ) : (
          <Empty />
        )}
      </Tile>

      <Tile label="Buying power" loading={loading} last>
        {account ? (
          <>
            <Value muted>{fmtCurrency(account.buying_power ?? 0)}</Value>
            <Hint>{account.mode ? `${account.mode.toUpperCase()} account` : "Available"}</Hint>
          </>
        ) : (
          <Empty />
        )}
      </Tile>
    </section>
  );
});

// ── Book summary ────────────────────────────────────────────────────────────

interface BookSummary {
  upnl: number;
  options: number;
  stock: number;
  /** Days until the nearest option expiry in the book, or null if none. */
  nearestDte: number | null;
  nearestExpiry: string | null;
}

function summarizeBook(positions: Position[]): BookSummary {
  let upnl = 0;
  let options = 0;
  let stock = 0;
  let nearestDte: number | null = null;
  let nearestExpiry: string | null = null;
  const today = startOfToday();
  for (const p of positions) {
    upnl += p.unrealized_pnl ?? 0;
    if (p.is_option) {
      options += 1;
      const d = parseYmd(p.expiry);
      if (d) {
        const dte = Math.round((d.getTime() - today) / 86_400_000);
        if (dte >= 0 && (nearestDte === null || dte < nearestDte)) {
          nearestDte = dte;
          nearestExpiry = p.expiry ?? null;
        }
      }
    } else {
      stock += 1;
    }
  }
  return { upnl, options, stock, nearestDte, nearestExpiry };
}

function positionsHint(b: BookSummary): string {
  if (b.options === 0 && b.stock === 0) return "Flat";
  const parts: string[] = [];
  if (b.options) parts.push(`${b.options} opt`);
  if (b.stock) parts.push(`${b.stock} stk`);
  if (b.nearestDte !== null && b.nearestExpiry) {
    const d = parseYmd(b.nearestExpiry)!;
    parts.push(`exp ${d.getMonth() + 1}/${d.getDate()} (${b.nearestDte}d)`);
  }
  return parts.join(", ");
}

function parseYmd(s?: string): Date | null {
  if (!s || s.length < 8) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function startOfToday(): number {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Tile({
  label,
  children,
  loading,
  lead,
  last,
}: {
  label: string;
  children: React.ReactNode;
  loading?: boolean;
  lead?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col justify-start min-w-0 h-[68px] px-4 pt-2.5 pb-2 border-border",
        "border-b lg:border-b-0",
        !last && "border-r",
        lead && "plate"
      )}
    >
      <span className={cn("text-2xs font-medium leading-4 truncate", lead ? "opacity-70" : "text-text-muted")}>{label}</span>
      {loading ? (
        <div className="flex flex-col gap-1.5 mt-1">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function Value({
  children,
  lead,
  muted,
}: {
  children: React.ReactNode;
  lead?: boolean;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "font-semibold text-lg leading-6 truncate",
        lead ? "figure" : "tabular",
        muted ? "text-text-secondary" : "text-text-primary"
      )}
    >
      {children}
    </span>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span className="text-2xs text-text-muted [.plate_&]:text-current [.plate_&]:opacity-70 [font-variant-numeric:tabular-nums] leading-4 truncate">{children}</span>;
}

function Empty() {
  return (
    <>
      <span className="text-lg font-semibold leading-6 text-text-muted tabular">n/a</span>
      <Hint>No data</Hint>
    </>
  );
}

// Signed currency. The explicit sign carries the direction; colour only
// reinforces it, and a screen reader hears the word.
function Signed({ value }: { value: number }) {
  const dir = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const sign = dir === "up" ? "+" : dir === "down" ? "−" : "";
  return (
    <span
      className={cn(
        "flex items-center gap-1 text-lg font-semibold leading-6 tabular truncate",
        dir === "up" ? "text-up" : dir === "down" ? "text-down" : "text-text-secondary"
      )}
    >
      <span>
        {sign}
        {fmtCurrency(Math.abs(value))}
      </span>
      <span className="sr-only">{dir === "up" ? "gain" : dir === "down" ? "loss" : "flat"}</span>
    </span>
  );
}

// 4px meter: fill = win rate, track = lighter step of the same hue, hairline
// tick at 50% so "above / below a coin flip" reads without a number.
function WinMeter({ pct }: { pct: number | null }) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const tone = pct == null ? "bg-text-muted" : v >= 50 ? "bg-up" : v >= 30 ? "bg-warning" : "bg-down";
  const track = pct == null ? "bg-surface-3" : v >= 50 ? "bg-up/15" : v >= 30 ? "bg-warning/15" : "bg-down/15";
  return (
    <div
      role="meter"
      aria-label="Win rate"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct == null ? undefined : Math.round(v)}
      className={cn("relative h-1 w-full max-w-[120px] rounded-full mt-1", track)}
    >
      <div className={cn("absolute inset-y-0 left-0 rounded-full", tone)} style={{ width: `${v}%` }} />
      <div className="absolute -top-0.5 -bottom-0.5 left-1/2 w-px bg-text-secondary/60" aria-hidden />
    </div>
  );
}
