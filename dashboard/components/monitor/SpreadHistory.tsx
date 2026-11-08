"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  api,
  type HistoryTally,
  type RegimeStrategySummary,
  type RegimeSummary,
  type SpreadOutcome,
  type SpreadStrategyId,
} from "@/lib/api";
import { chartChrome } from "@/lib/chartTheme";
import { cn, fmt } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { InfoIcon } from "@/components/ui/info-icon";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat, StatGroup } from "@/components/ui/stat";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { RiRefreshLine as RefreshCw, RiErrorWarningFill as ErrorIcon } from "@remixicon/react";

const STRATEGY_OPTIONS: { value: SpreadStrategyId; label: string }[] = [
  { value: "rut", label: "RUT" },
  { value: "mars", label: "Mars" },
  { value: "marsmax", label: "Mars max" },
  { value: "space", label: "Space" },
];

const OUTCOME_LABEL: Record<SpreadOutcome, string> = {
  win: "Expired worthless",
  delta_exit: "Delta exit",
  last_day_exit: "Thursday exit",
  partial_loss: "Expired in the money",
  max_loss: "Max loss",
};

const OUTCOME_BADGE: Record<SpreadOutcome, "up" | "warning" | "down"> = {
  win: "up",
  delta_exit: "warning",
  last_day_exit: "warning",
  partial_loss: "down",
  max_loss: "down",
};

function useChrome() {
  const [chrome, setChrome] = useState(() => chartChrome());
  useEffect(() => {
    setChrome(chartChrome());
    const obs = new MutationObserver(() => setChrome(chartChrome()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => obs.disconnect();
  }, []);
  return chrome;
}

export function SpreadHistory() {
  const [summary, setSummary] = useState<RegimeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [strategy, setStrategy] = useState<SpreadStrategyId>("space");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await api.regimeSummary());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const s = useMemo(() => summary?.strategies.find((x) => x.id === strategy) ?? null, [summary, strategy]);
  const cov = summary?.coverage;

  return (
    <PageShell>
      <PageHeader
        title="History"
        description={
          cov
            ? `${cov.trades} monthly cycles from ${cov.first_entry?.slice(0, 4)} to ${cov.last_entry?.slice(0, 4)}, replayed under the course rules, to show what has moved the odds and what has not.`
            : "Every monthly cycle since 2005, replayed under the course rules."
        }
        actions={
          <>
            <ToggleGroup options={STRATEGY_OPTIONS} value={strategy} onChange={setStrategy} ariaLabel="Strategy" />
            <Button variant="secondary" size="icon" onClick={load} disabled={loading} title="Refresh" aria-label="Refresh">
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </>
        }
      />

      {error && !summary ? (
        <Card className="shrink-0">
          <CardContent className="flex flex-col items-center gap-3 py-10">
            <Badge variant="down">
              <ErrorIcon size={14} aria-hidden="true" />
              {error}
            </Badge>
            <Button variant="secondary" onClick={load}>
              <RefreshCw />
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : !s ? (
        <Card className="shrink-0">
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : (
        <>
          <FindingCard s={s} />
          <div className="grid gap-3 lg:grid-cols-[3fr_2fr] shrink-0">
            <VixCard s={s} />
            <TrendCard s={s} />
          </div>
          <OddsGridCard s={s} />
          <NonWinsCard s={s} />
          <MethodCard />
        </>
      )}
    </PageShell>
  );
}

// ── finding + headline numbers ───────────────────────────────────────
function FindingCard({ s }: { s: RegimeStrategySummary }) {
  const o = s.overall;
  const delta = s.non_wins.filter((t) => t.outcome === "delta_exit").length;
  const thursday = s.non_wins.filter((t) => t.outcome === "last_day_exit").length;
  return (
    <Card className="shrink-0">
      <CardContent className="flex flex-col gap-4">
        <p className="text-body-regular text-text-primary max-w-3xl">{s.finding}</p>
        <StatGroup cols={6}>
          <Stat label="Cycles" value={o.n} size="md" />
          <Stat
            label="Went wrong"
            value={`${fmt(o.non_win_pct, 0)}%`}
            hint={`${o.exited + o.held_to_loss} of ${o.n}`}
            size="md"
            tone={(o.non_win_pct ?? 0) > 10 ? "warning" : "default"}
          />
          <Stat label="Delta exits" value={delta} hint={`at delta ${s.exit_delta}`} size="md" />
          <Stat label="Thursday exits" value={thursday} size="md" />
          <Stat label="Held to a loss" value={o.held_to_loss} size="md" tone={o.held_to_loss > 0 ? "down" : "default"} />
          <Stat
            label="Avg return on risk"
            value={o.avg_ror_pct != null ? `${o.avg_ror_pct >= 0 ? "+" : ""}${o.avg_ror_pct.toFixed(1)}%` : "n/a"}
            hint="per cycle, modeled"
            size="md"
            tone={(o.avg_ror_pct ?? 0) >= 0 ? "up" : "down"}
          />
        </StatGroup>
      </CardContent>
    </Card>
  );
}

// ── VIX at entry ─────────────────────────────────────────────────────
function VixCard({ s }: { s: RegimeStrategySummary }) {
  const c = useChrome();
  const overall = s.overall.non_win_pct ?? 0;
  const data = s.by_vix.map((b) => ({
    bucket: b.bucket,
    pct: b.non_win_pct ?? 0,
    n: b.n,
    bad: b.exited + b.held_to_loss,
  }));
  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Went wrong, by VIX at entry</CardTitle>
          <InfoIcon size={12} hint="Share of cycles that hit an exit or expired in the money, grouped by the VIX close on entry day. The dashed line is the strategy's overall rate." />
        </div>
      </CardHeader>
      <CardContent className="h-56 p-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 18, right: 12, bottom: 4, left: 0 }} barCategoryGap="28%">
            <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="bucket" tick={{ fill: c.axisText, fontSize: 11 }} stroke={c.axis} tickLine={false} />
            <YAxis
              tick={{ fill: c.axisText, fontSize: 10 }}
              stroke={c.axis}
              tickLine={false}
              width={32}
              tickFormatter={(v: number) => `${v}%`}
              domain={[0, (max: number) => Math.max(10, Math.ceil((max + 3) / 10) * 10)]}
              tickCount={4}
            />
            <ReferenceLine y={overall} stroke={c.axisText} strokeDasharray="2 4" />
            <Tooltip
              cursor={{ fill: c.grid, opacity: 0.4 }}
              contentStyle={{ backgroundColor: c.bg, border: `1px solid ${c.axis}`, borderRadius: 8, fontSize: 11, padding: "6px 8px" }}
              labelStyle={{ color: c.axisText, marginBottom: 2 }}
              itemStyle={{ color: c.text }}
              labelFormatter={(v) => `VIX ${v}`}
              formatter={(value, _name, item) => {
                const p = (item?.payload ?? {}) as { n?: number; bad?: number };
                return [`${(value as number).toFixed(0)}%  (${p.bad ?? 0} of ${p.n ?? 0})`, "went wrong"];
              }}
            />
            <Bar dataKey="pct" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.bucket} fill={d.pct > overall * 1.3 ? c.down : c.accent} fillOpacity={d.n < 15 ? 0.45 : 0.9} />
              ))}
              <LabelList dataKey="n" position="top" formatter={(v: number) => `n=${v}`} fill={c.axisText} fontSize={10} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ── trend at entry ───────────────────────────────────────────────────
function TrendCard({ s }: { s: RegimeStrategySummary }) {
  const up = s.by_trend.find((t) => t.trend === "up");
  const down = s.by_trend.find((t) => t.trend === "down");
  const p = s.downtrend_p;
  const verdict =
    p < 0.05 ? "Significant" : p < 0.1 ? "Suggestive, not conclusive" : "No reliable difference";
  const tone = p < 0.05 ? "down" : p < 0.1 ? "warning" : "muted";
  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Trend at entry</CardTitle>
          <InfoIcon size={12} hint="Entry-day close above or below the 10-week average. The p-value is a one-sided Fisher test that downtrend entries go wrong more often; below 0.05 counts as real." />
        </div>
        <Badge variant={tone}>{verdict}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <StatGroup cols={2}>
          <TrendStat label="Above 10-week avg" t={up} />
          <TrendStat label="Below 10-week avg" t={down} />
        </StatGroup>
        <div className="text-caption-1-regular text-text-tertiary tabular">p = {p.toFixed(2)}</div>
      </CardContent>
    </Card>
  );
}

function TrendStat({ label, t }: { label: string; t: HistoryTally | undefined }) {
  if (!t) return <Stat label={label} value="n/a" size="lg" />;
  return (
    <Stat
      label={label}
      value={`${fmt(t.non_win_pct, 0)}%`}
      hint={`${t.exited + t.held_to_loss} of ${t.n} went wrong`}
      size="lg"
    />
  );
}

// ── exit odds by delta × time left ───────────────────────────────────
function OddsGridCard({ s }: { s: RegimeStrategySummary }) {
  const bands = Array.from(new Set(s.odds_grid.map((g) => g.days_band)));
  const bins = Array.from(new Set(s.odds_grid.map((g) => `${g.delta_lo}-${g.delta_hi}`)));
  const cell = (band: string, bin: string) =>
    s.odds_grid.find((g) => g.days_band === band && `${g.delta_lo}-${g.delta_hi}` === bin);
  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Odds of a later exit, by short delta and time left</CardTitle>
          <InfoIcon size={12} hint={`Each cell: of the open trades whose short delta sat in that range at a weekly close with that much time left, the share that later hit the delta-${s.exit_delta} or Thursday exit. This is the lookup behind the Exit tab's "past trades in this spot".`} />
        </div>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Time left</TableHead>
              {bins.map((b) => (
                <TableHead key={b} className="text-right">Δ {b}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {bands.map((band) => (
              <TableRow key={band} className="hover:bg-transparent">
                <TableCell className="text-text-secondary whitespace-nowrap">{band}</TableCell>
                {bins.map((bin) => {
                  const g = cell(band, bin);
                  const pct = g?.exit_pct;
                  const thin = (g?.n ?? 0) < 8;
                  return (
                    <TableCell key={bin} className="text-right tabular">
                      {g && g.n > 0 ? (
                        <div className="flex flex-col items-end">
                          <span
                            className={cn(
                              thin
                                ? "text-text-tertiary"
                                : (pct ?? 0) >= 50
                                  ? "text-status-rose-text"
                                  : (pct ?? 0) >= 25
                                    ? "text-status-yellow-text"
                                    : "text-text-primary"
                            )}
                          >
                            {fmt(pct, 0)}%
                          </span>
                          <span className="text-caption-1-regular text-text-tertiary">n={g.n}</span>
                        </div>
                      ) : (
                        <span className="text-text-tertiary">–</span>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <CardFooter>
        <span className="text-caption-1-regular text-text-tertiary">
          Grey cells have fewer than 8 trades. Yellow from 25%, red from 50%.
        </span>
      </CardFooter>
    </Card>
  );
}

// ── every trade that went wrong ──────────────────────────────────────
function NonWinsCard({ s }: { s: RegimeStrategySummary }) {
  const rows = [...s.non_wins].sort((a, b) => (a.entry < b.entry ? 1 : -1));
  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>Every cycle that went wrong</CardTitle>
          <Badge variant="muted" className="tabular">{rows.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0 max-h-[420px] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Entry</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">VIX</TableHead>
              <TableHead>Trend</TableHead>
              <TableHead className="text-right">Entry Δ</TableHead>
              <TableHead className="text-right">Distance</TableHead>
              <TableHead className="text-right">Return on risk</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => (
              <TableRow key={t.entry}>
                <TableCell className="tabular">{t.entry}</TableCell>
                <TableCell className="tabular text-text-secondary">{t.expiry}</TableCell>
                <TableCell>
                  <Badge variant={OUTCOME_BADGE[t.outcome]}>{OUTCOME_LABEL[t.outcome]}</Badge>
                </TableCell>
                <TableCell className="text-right tabular">{t.vix.toFixed(1)}</TableCell>
                <TableCell className="text-text-secondary">{t.trend === "up" ? "Above avg" : "Below avg"}</TableCell>
                <TableCell className="text-right tabular">{t.entry_delta.toFixed(1)}</TableCell>
                <TableCell className="text-right tabular">{t.distance_pct.toFixed(1)}%</TableCell>
                <TableCell className={cn("text-right tabular", (t.ror ?? 0) < 0 ? "text-status-rose-text" : "text-status-lime-text")}>
                  {t.ror != null ? `${t.ror >= 0 ? "+" : ""}${t.ror.toFixed(0)}%` : "n/a"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ── method ───────────────────────────────────────────────────────────
function MethodCard() {
  return (
    <Card className="shrink-0">
      <CardHeader>
        <CardTitle>How this was built</CardTitle>
      </CardHeader>
      <CardContent className="text-body-2-regular text-text-secondary flex flex-col gap-2 max-w-3xl">
        <p>
          Weekly SPX, RUT and VIX closes from IBKR since 2004. Every third Friday a spread is opened for the next
          monthly expiry at the first 5-point strike that clears the strategy&apos;s distance floor and delta cap,
          $10 wide. At each weekly close it is closed if the short delta reaches the exit threshold, on the Thursday
          before expiry if the index is within the buffer, and otherwise held to settlement.
        </p>
        <p>
          Deltas and credits come from Black-Scholes with a put-skew overlay calibrated to the live SPX chain on
          6 Nov 2026 (within about one vol point and 5% of quoted mids). RUT vol is VIX × 1.33. The course&apos;s AROC and
          Kelly checks are not applied, because they turn on cents the model cannot promise.
        </p>
        <p>
          Checks: over the last five years the weekly replay agrees with a daily replay on 54 to 56 of 57 cycles per
          strategy, and the 2012 to 2023 exit counts land at 8, 11 and 11 against the course&apos;s own 8, 9 and 9. Treat
          exit and win counts as the reliable part and dollar returns as directional.
        </p>
      </CardContent>
    </Card>
  );
}
