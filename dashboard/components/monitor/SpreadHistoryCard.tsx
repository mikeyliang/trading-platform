"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type HistoryOdds, type OpenSpreadContext, type RegimeOpenSpreads } from "@/lib/api";
import { cn, fmt } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoIcon } from "@/components/ui/info-icon";
import { TableSkeletonRows } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  RiRefreshLine as RefreshCw,
  RiHistoryLine as HistoryIcon,
  RiErrorWarningFill as ErrorIcon,
  RiArrowRightUpLine as ArrowUpRight,
} from "@remixicon/react";

const REFRESH_MS = 60_000;

const STATUS_BADGE: Record<OpenSpreadContext["status"], { label: string; variant: "up" | "warning" | "down" | "muted" }> = {
  safe:    { label: "Safe",         variant: "up" },
  warning: { label: "Near trigger", variant: "warning" },
  trigger: { label: "Exit now",     variant: "down" },
  unknown: { label: "No delta",     variant: "muted" },
};

/**
 * Every open spread (exit monitor + OKW tracker) with the one number the
 * exit monitor cannot give: of the past trades that sat at this delta with
 * this much time left, how many went on to hit an exit.
 */
export function SpreadHistoryCard() {
  const [data, setData] = useState<RegimeOpenSpreads | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.regimeOpenSpreads());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const spreads = data?.spreads ?? [];
  const cov = data?.coverage;
  const initial = !data && !error;

  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>What history says</CardTitle>
          <InfoIcon
            size={12}
            hint={
              cov
                ? `${cov.trades} replayed monthly cycles since ${cov.first_entry?.slice(0, 4)}. For each open spread we look up past trades of the same strategy that sat within 5 delta points at the same time to expiry, and count how many later hit the delta or Thursday exit.`
                : "Past trades of the same strategy that sat at the same delta with the same time left, and what happened to them."
            }
          />
          {data && <Badge variant="muted" className="tabular">{spreads.length}</Badge>}
          {error && data && (
            <Badge variant="down">
              <ErrorIcon size={14} aria-hidden="true" />
              Stale
            </Badge>
          )}
        </div>
        <Button variant="secondary" size="icon" onClick={load} disabled={loading} title="Refresh" aria-label="Refresh">
          <RefreshCw className={cn(loading && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {initial ? (
          <HistoryTable>
            <TableSkeletonRows rows={2} cols={8} widths={["w-24", "w-14", "w-16", "w-12", "w-12", "w-14", "w-full", "w-10"]} />
          </HistoryTable>
        ) : error && !data ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <Badge variant="down">
              <ErrorIcon size={14} aria-hidden="true" />
              {error}
            </Badge>
            <Button variant="secondary" onClick={load}>
              <RefreshCw />
              Retry
            </Button>
          </div>
        ) : spreads.length === 0 ? (
          <EmptyState
            icon={HistoryIcon}
            title="No open spreads to compare"
            description="Spreads the bot opened and trades logged in the Tracker both show up here with their historical odds."
          />
        ) : (
          <HistoryTable>
            {spreads.map((s) => (
              <Row key={s.id} s={s} />
            ))}
          </HistoryTable>
        )}
      </CardContent>
      <CardFooter className="justify-between">
        <span className="text-caption-1-medium text-text-tertiary tabular">
          {cov ? `${cov.trades} replayed cycles, ${cov.first_entry?.slice(0, 4)} to ${cov.last_entry?.slice(0, 4)}` : ""}
        </span>
        <Link
          href="/monitor/history"
          className="flex items-center gap-0.5 text-caption-1-medium text-accent-600 hover:underline"
        >
          Full history <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </CardFooter>
    </Card>
  );
}

function HistoryTable({ children }: { children: React.ReactNode }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Spread</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Short delta</TableHead>
          <TableHead className="text-right">Cushion</TableHead>
          <TableHead className="text-right">Days left</TableHead>
          <TableHead className="text-right">
            <span className="inline-flex items-center gap-1">
              Thursday line
              <InfoIcon hint="Exit rule 2: on the Thursday before expiry, close if the index is at or below this level (short strike plus the buffer)." />
            </span>
          </TableHead>
          <TableHead className="min-w-[260px]">Past trades in this spot</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function Row({ s }: { s: OpenSpreadContext }) {
  const badge = STATUS_BADGE[s.status];
  const h = s.history;
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        <div className="flex flex-col">
          <span className="tabular">
            {s.symbol} {fmt(s.short_strike, 0)}
            <span className="text-text-tertiary"> / </span>
            {fmt(s.long_strike, 0)}
          </span>
          <span className="text-caption-1-medium text-text-tertiary">
            {s.strategy_label} · {s.contracts} contract{s.contracts === 1 ? "" : "s"}
            {s.source === "okw" ? " · tracker" : ""}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </TableCell>
      <TableCell className="text-right tabular">
        {s.delta != null ? (
          <span className="inline-flex items-baseline gap-1">
            <span className={cn(s.status === "trigger" ? "text-status-rose-text" : s.status === "warning" ? "text-status-yellow-text" : "text-text-primary")}>
              {s.delta.toFixed(1)}
            </span>
            <span className="text-text-tertiary">/ {s.exit_delta ?? "n/a"}</span>
            {s.delta_source === "model" && (
              <InfoIcon hint="Modeled from the index level and VIX because this trade has no live chain. Usually within one or two delta points of the quoted delta." />
            )}
          </span>
        ) : (
          <span className="text-text-tertiary">n/a</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular">
        {s.cushion_pct != null ? (
          <span className={cn(s.cushion_pct < (s.last_day_buffer_pct ?? 2) ? "text-status-rose-text" : "text-text-primary")}>
            {s.cushion_pct.toFixed(1)}%
          </span>
        ) : (
          <span className="text-text-tertiary">n/a</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular">
        {s.days_left != null ? s.days_left : <span className="text-text-tertiary">n/a</span>}
      </TableCell>
      <TableCell className="text-right tabular text-text-secondary">
        {s.last_day_line != null ? fmt(s.last_day_line, 0) : "n/a"}
      </TableCell>
      <TableCell>
        <Odds h={h} />
      </TableCell>
    </TableRow>
  );
}

function Odds({ h }: { h: HistoryOdds | null }) {
  if (!h || h.n === 0) {
    return <span className="text-caption-1-regular text-text-tertiary">No comparable past trades.</span>;
  }
  const exitPct = h.exit_pct ?? 0;
  const tone = exitPct >= 50 ? "text-status-rose-text" : exitPct >= 25 ? "text-status-yellow-text" : "text-status-lime-text";
  const wentWrong = h.exited + h.held_to_loss;
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2">
        <OddsBar exited={h.exited} lost={h.held_to_loss} wins={h.wins} />
        <span className={cn("text-body-2-medium tabular shrink-0", tone)}>
          {wentWrong} of {h.n}
        </span>
        <span className="text-caption-1-regular text-text-secondary truncate">
          later hit an exit{h.held_to_loss > 0 ? " or expired in the money" : ""}
        </span>
      </div>
      <div className="text-caption-1-regular text-text-tertiary tabular truncate">
        Same strategy, delta ±{h.band.delta}, {h.query.days_left}d ±{h.band.days}
        {h.thin ? " · few matches, read loosely" : h.band.widened ? " · band widened to find matches" : ""}
        {h.avg_ror_pct != null ? ` · avg return ${h.avg_ror_pct >= 0 ? "+" : ""}${h.avg_ror_pct.toFixed(0)}% of risk` : ""}
      </div>
    </div>
  );
}

function OddsBar({ exited, lost, wins }: { exited: number; lost: number; wins: number }) {
  const n = exited + lost + wins || 1;
  return (
    <div className="flex h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-background-tertiary-default" aria-hidden="true">
      <div className="bg-status-rose-text" style={{ width: `${(lost / n) * 100}%` }} />
      <div className="bg-status-yellow-text" style={{ width: `${(exited / n) * 100}%` }} />
      <div className="bg-status-lime-text" style={{ width: `${(wins / n) * 100}%` }} />
    </div>
  );
}
