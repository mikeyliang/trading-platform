"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  api,
  type PreflightSnapshot,
  type SpreadCandidate,
  type SpreadScanResult,
  type SpreadSpec,
} from "@/lib/api";
import type { Bar } from "@/types";
import { cn } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLiveBankroll } from "@/lib/useLiveBankroll";
import { MonitorMiniStrip } from "@/components/monitor/MonitorMiniStrip";

type TradeType = "rut" | "mars" | "marsmax" | "space";

const TRADE_ORDER: TradeType[] = ["rut", "mars", "marsmax", "space"];

const TRADE_META: Record<
  TradeType,
  { label: string; tone: string; dot: string }
> = {
  rut: { label: "RUT", tone: "text-text-secondary", dot: "bg-text-secondary" },
  mars: { label: "Mars", tone: "text-accent", dot: "bg-accent" },
  marsmax: { label: "Mars Max", tone: "text-warning", dot: "bg-warning" },
  space: { label: "Space", tone: "text-up", dot: "bg-up" },
};

// Pull a Fibonacci floor/ceiling ladder out of recent bars. Mirrors the
// chart overlay's math so the picker shows the same floors Jamal would
// draw on his chart.
const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];

function fibLevelsFrom(bars: Bar[]): number[] {
  if (!bars.length) return [];
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  if (!isFinite(hi) || !isFinite(lo) || hi <= lo) return [];
  return FIB_RATIOS.map((r) => lo + r * (hi - lo));
}

function describeFibPosition(
  strike: number,
  fibs: number[],
  spot: number,
): string {
  if (!fibs.length) return "—";
  const sortedDesc = [...fibs].sort((a, b) => b - a);
  let moneyIdx = sortedDesc.findIndex((p) => p <= spot);
  if (moneyIdx === -1) moneyIdx = sortedDesc.length - 1;
  const below = sortedDesc.filter((p, i) => i > moneyIdx && p > strike).length;
  const ceilingsAbove = sortedDesc.filter(
    (p, i) => i <= moneyIdx && p > strike,
  ).length;
  if (strike > sortedDesc[moneyIdx]) return `above money`;
  if (below >= 2) return `${below} floors below money`;
  if (below === 1) return `1 floor below money`;
  return `${ceilingsAbove} ceiling below`;
}

export function StrikePicker() {
  const [pending, setPending] = useState("ALL");
  const [symbol, setSymbol] = useState("ALL");
  const {
    value: bankroll,
    set: setBankroll,
    mode: bankrollMode,
    live: liveBankroll,
    resetToLive,
  } = useLiveBankroll();
  const [scan, setScan] = useState<SpreadScanResult | null>(null);
  const [specs, setSpecs] = useState<Record<string, SpreadSpec> | null>(null);
  const [bars, setBars] = useState<Record<string, Bar[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TradeType | null>(null);
  const [preflight, setPreflight] = useState<PreflightSnapshot | null>(null);

  useEffect(() => {
    api
      .spreadSpecs()
      .then(setSpecs)
      .catch(() => setSpecs(null));
    // Try the most recent cached scan first — covers the daily 09:30 ET
    // scheduled run AND any prior manual scan. Falls back to the preflight
    // cache if no scan rows exist yet (cold start).
    api
      .scansLatest()
      .then((rec) => {
        if (rec?.payload) {
          setScan(rec.payload);
        }
      })
      .catch(() => undefined);
    api
      .preflightState()
      .then((p) => {
        setPreflight(p);
        if (p?.scan && !scan) setScan(p.scan);
      })
      .catch(() => setPreflight(null));
  }, []);

  async function runScan(sym = symbol) {
    setLoading(true);
    setError(null);
    try {
      const r = await api.spreadScan(sym, "put");
      setScan(r);
      if (r.error) setError(r.error);
      // Hydrate bars for fib levels for every underlying we scanned.
      const tickers = r.underlyings_scanned ?? [sym];
      const barsByU: Record<string, Bar[]> = {};
      await Promise.all(
        tickers.map(async (u) => {
          try {
            const b = await api.bars(u, "1d", 180);
            barsByU[u] = b.bars;
          } catch {
            barsByU[u] = [];
          }
        }),
      );
      setBars(barsByU);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const onScan = () => {
    setSymbol(pending);
    runScan(pending);
  };

  // Top pick per trade type — already passing all checks.
  const picks = useMemo<Record<TradeType, SpreadCandidate | null>>(() => {
    const out = { rut: null, mars: null, marsmax: null, space: null } as Record<
      TradeType,
      SpreadCandidate | null
    >;
    if (!scan) return out;
    for (const t of TRADE_ORDER) {
      out[t] = scan.top_picks?.[t] ?? null;
    }
    return out;
  }, [scan]);

  const recommended = scan?.recommendation?.trade_type as TradeType | undefined;

  return (
    <PageShell>
      <PageHeader
        eyebrow="Options · monthly bull-put"
        title="Strike Picker"
        description="One chart, four trade types. Pick the short strike that gives the most premium without crossing the next fib level."
        actions={
          <div className="flex flex-wrap items-end gap-2 md:gap-3">
            <Field label="Underlying">
              <Input
                value={pending}
                onChange={(e) => setPending(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onScan();
                }}
                placeholder="ALL"
                className="h-8 w-20 sm:w-24 uppercase tabular"
              />
            </Field>
            <Field
              label="Bankroll"
              hint={
                bankrollMode === "live" ? (
                  "● live · IBKR equity"
                ) : (
                  <button
                    type="button"
                    onClick={resetToLive}
                    className="text-accent hover:underline"
                  >
                    manual · reset to live
                    {liveBankroll != null
                      ? ` ($${(liveBankroll / 1000).toFixed(0)}k)`
                      : ""}
                  </button>
                )
              }
            >
              <Input
                type="number"
                value={bankroll}
                onChange={(e) => setBankroll(Number(e.target.value) || 0)}
                step="1000"
                className="h-8 w-24 sm:w-28 tabular"
              />
            </Field>
            <Button
              onClick={onScan}
              disabled={loading}
              size="sm"
              variant="default"
            >
              {loading ? "Scanning…" : "Scan"}
            </Button>
          </div>
        }
      />

      {error && <div className="text-xs text-down/80">{error}</div>}

      <MonitorMiniStrip />

      <PreflightStrip
        preflight={preflight}
        onRun={async () => {
          setLoading(true);
          try {
            const p = await api.preflightRun();
            setPreflight(p);
            if (p.scan) setScan(p.scan);
          } finally {
            setLoading(false);
          }
        }}
        running={loading}
      />

      {!scan && loading && <ScanSkeleton />}

      {!scan && !loading && <EmptyHint />}

      {scan && (
        <>
          <RecommendationStrip scan={scan} bankroll={bankroll} />

          <div className="grid md:grid-cols-[minmax(0,1fr)_20rem] lg:grid-cols-[minmax(0,1fr)_22rem] gap-4 md:gap-5">
            <StrikeMap
              scan={scan}
              picks={picks}
              bars={bars}
              selected={selected}
              recommended={recommended}
            />
            <CandidateRail
              scan={scan}
              picks={picks}
              specs={specs}
              bars={bars}
              bankroll={bankroll}
              selected={selected}
              setSelected={setSelected}
              recommended={recommended}
            />
          </div>
        </>
      )}
    </PageShell>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      {children}
      {hint && (
        <span
          className={cn(
            "text-[10px] tabular",
            typeof hint === "string" && hint.startsWith("●")
              ? "text-up"
              : "text-text-muted",
          )}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

function PreflightStrip({
  preflight,
  onRun,
  running,
}: {
  preflight: PreflightSnapshot | null;
  onRun: () => void;
  running: boolean;
}) {
  const ranAt = preflight?.ran_at ? new Date(preflight.ran_at) : null;
  return (
    <div className="flex items-baseline justify-between py-3 border-t border-b border-border/40 -mx-1">
      <div className="flex items-baseline gap-3">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          3rd-Friday pre-flight
        </span>
        <span className="text-xs text-text-secondary">
          {ranAt
            ? `last ran ${ranAt.toLocaleDateString()} at ${ranAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "never run — fires automatically 09:05 ET on the monthly"}
        </span>
      </div>
      <button
        type="button"
        onClick={onRun}
        disabled={running}
        className="text-[11px] text-accent hover:underline disabled:opacity-50"
      >
        {running ? "Running…" : "Run now"}
      </button>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="py-8 text-center">
      <p className="text-[12px] text-text-secondary">
        Run a scan to compare RUT, Mars, Mars Max, and Space side by side.
      </p>
      <p className="text-[11px] text-text-muted mt-1">
        Index monthly bull-puts only. On the 3rd Friday of the month.
      </p>
    </div>
  );
}

function ScanSkeleton() {
  return (
    <div className="grid md:grid-cols-[minmax(0,1fr)_20rem] lg:grid-cols-[minmax(0,1fr)_22rem] gap-4 md:gap-5 animate-pulse">
      <div className="h-[460px] rounded-md bg-surface-2/40" />
      <div className="flex flex-col gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-32 rounded-md bg-surface-2/40" />
        ))}
      </div>
    </div>
  );
}

// ─── Recommendation strip ─────────────────────────────────────────────────────
function RecommendationStrip({
  scan,
  bankroll,
}: {
  scan: SpreadScanResult;
  bankroll: number;
}) {
  const rec = scan.recommendation;
  if (!rec) {
    return (
      <div className="py-3 text-center text-[11px] text-text-muted border-y border-border/30">
        No qualifying trade in this chain right now.
      </div>
    );
  }
  const c = rec.candidate;
  const meta = TRADE_META[rec.trade_type as TradeType] ?? TRADE_META.rut;
  const sizing = computeSizing(c, bankroll);

  return (
    <section className="py-3 border-y border-border/40">
      <div className="flex items-baseline gap-3 flex-wrap mb-2">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          Take
        </span>
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full translate-y-[-1px]",
            meta.dot,
          )}
        />
        <span
          className={cn("text-base font-semibold tracking-tight", meta.tone)}
        >
          {meta.label}
        </span>
        <span className="font-mono text-sm tabular text-text-primary">
          {c.short_strike}
          <span className="text-text-muted"> / </span>
          {c.long_strike}
          {c.side === "put" ? "P" : "C"}
        </span>
        <span className="text-[11px] text-text-muted tabular">
          {formatExpiry(c.expiry)} · {c.dte}d
        </span>
      </div>
      <div className="flex items-baseline gap-x-6 gap-y-2 flex-wrap text-[11px] tabular">
        <Metric label="AROC" value={`${c.aroc_pct.toFixed(0)}%`} tone="up" />
        <Metric label="Kelly" value={c.kelly_pct.toFixed(0)} />
        <Metric label="POP" value={`${c.win_prob_pct.toFixed(0)}%`} />
        <Metric label="Δ" value={(c.short_delta * 100).toFixed(0)} />
        <Metric
          label="size"
          value={`${sizing.recommendedContracts} ×`}
          tone="up"
        />
        <Metric
          label="Kelly$"
          value={`$${(sizing.kellyDollars / 1000).toFixed(0)}k`}
        />
      </div>
      <p className="text-[11px] text-text-muted leading-relaxed mt-2">
        {rec.reason}
      </p>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span
        className={cn(
          tone === "up"
            ? "text-up"
            : tone === "down"
              ? "text-down"
              : "text-text-primary",
        )}
      >
        {value}
      </span>
    </span>
  );
}

// ─── Vertical strike-map visualization ────────────────────────────────────────
function StrikeMap({
  scan,
  picks,
  bars,
  selected,
  recommended,
}: {
  scan: SpreadScanResult;
  picks: Record<TradeType, SpreadCandidate | null>;
  bars: Record<string, Bar[]>;
  selected: TradeType | null;
  recommended?: TradeType;
}) {
  // Group picks by underlying so we render one chart per underlying.
  const byUnderlying: Record<string, TradeType[]> = {};
  for (const t of TRADE_ORDER) {
    const p = picks[t];
    if (!p) continue;
    (byUnderlying[p.symbol] ||= []).push(t);
  }

  const underlyings = Object.keys(byUnderlying);
  if (!underlyings.length) {
    return <div className="text-sm text-text-muted">No strikes to plot.</div>;
  }

  return (
    <div className="flex flex-col gap-12">
      {underlyings.map((u) => (
        <UnderlyingMap
          key={u}
          underlying={u}
          tradeTypes={byUnderlying[u]}
          picks={picks}
          spot={scan.underlying_prices?.[u] ?? null}
          bars={bars[u] ?? []}
          selected={selected}
          recommended={recommended}
        />
      ))}
    </div>
  );
}

function UnderlyingMap({
  underlying,
  tradeTypes,
  picks,
  spot,
  bars,
  selected,
  recommended,
}: {
  underlying: string;
  tradeTypes: TradeType[];
  picks: Record<TradeType, SpreadCandidate | null>;
  spot: number | null;
  bars: Bar[];
  selected: TradeType | null;
  recommended?: TradeType;
}) {
  const fibs = useMemo(() => fibLevelsFrom(bars), [bars]);

  // Build the price axis: spot at top, all strikes & fibs below, with a bit of headroom.
  const strikeValues = tradeTypes.flatMap((t) => {
    const c = picks[t];
    return c ? [c.short_strike, c.long_strike] : [];
  });
  const allPoints = [...(spot != null ? [spot] : []), ...fibs, ...strikeValues];
  if (!allPoints.length) return null;

  const lo = Math.min(...allPoints);
  const hi = Math.max(...allPoints);
  const pad = (hi - lo) * 0.06 || 1;
  const yMin = lo - pad;
  const yMax = hi + pad;

  // SVG geometry — tall + narrow looks chart-like and clean.
  const H = 460;
  const W = 640;
  const padTop = 24;
  const padBot = 28;
  const usableH = H - padTop - padBot;
  const priceToY = (p: number) =>
    padTop + (1 - (p - yMin) / (yMax - yMin)) * usableH;

  // Fib level decoration — money line + next-floor reference.
  const fibSortedDesc = [...fibs].sort((a, b) => b - a);
  const moneyIdx =
    spot != null ? fibSortedDesc.findIndex((p) => p <= spot) : -1;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">
            {underlying}
          </div>
          <div className="text-xl font-semibold tabular tracking-tight">
            {spot != null ? spot.toFixed(2) : "—"}
          </div>
        </div>
        <div className="text-[10px] uppercase tracking-wider text-text-muted">
          short strikes vs. fib
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto max-h-[calc(100vh-22rem)] md:max-h-[60vh]"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* fib floors */}
        {fibSortedDesc.map((p, i) => {
          const y = priceToY(p);
          const isMoney = i === moneyIdx;
          return (
            <g key={`fib-${i}-${p}`}>
              <line
                x1={0}
                x2={W}
                y1={y}
                y2={y}
                stroke={isMoney ? "#3b82f6" : "#2c2c2c"}
                strokeDasharray={isMoney ? "0" : "4 4"}
                strokeWidth={isMoney ? 1 : 1}
                opacity={isMoney ? 0.55 : 0.45}
              />
              <text
                x={W - 6}
                y={y - 4}
                textAnchor="end"
                fontSize={9}
                className="fill-text-muted"
                style={{ fontFamily: "ui-monospace, monospace" }}
              >
                {isMoney ? `fib · money ${p.toFixed(0)}` : p.toFixed(0)}
              </text>
            </g>
          );
        })}

        {/* spot marker */}
        {spot != null && (
          <g>
            <line
              x1={0}
              x2={W}
              y1={priceToY(spot)}
              y2={priceToY(spot)}
              stroke="#3b82f6"
              strokeWidth={1.25}
              opacity={0.9}
            />
            <circle cx={28} cy={priceToY(spot)} r={3.5} fill="#3b82f6" />
            <text
              x={36}
              y={priceToY(spot) - 6}
              fontSize={10}
              className="fill-accent"
              style={{ fontFamily: "ui-monospace, monospace" }}
            >
              spot {spot.toFixed(2)}
            </text>
          </g>
        )}

        {/* strike lines per trade type */}
        {tradeTypes.map((t, idx) => {
          const c = picks[t];
          if (!c) return null;
          const meta = TRADE_META[t];
          const yShort = priceToY(c.short_strike);
          const yLong = priceToY(c.long_strike);
          const isSelected = selected === t;
          const isRecommended = recommended === t;
          const xStart = 110 + idx * 70;
          const xEnd = xStart + 50;
          const color = (
            {
              rut: "#a1a1aa",
              mars: "#3b82f6",
              marsmax: "#f59e0b",
              space: "#22c55e",
            } as Record<TradeType, string>
          )[t];

          return (
            <g key={t} opacity={selected && !isSelected ? 0.32 : 1}>
              {/* spread band */}
              <rect
                x={xStart}
                y={Math.min(yShort, yLong)}
                width={xEnd - xStart}
                height={Math.abs(yLong - yShort)}
                fill={color}
                opacity={0.08}
              />
              {/* short strike line */}
              <line
                x1={xStart - 8}
                x2={xEnd + 8}
                y1={yShort}
                y2={yShort}
                stroke={color}
                strokeWidth={isSelected || isRecommended ? 2 : 1.5}
              />
              {/* long strike line */}
              <line
                x1={xStart}
                x2={xEnd}
                y1={yLong}
                y2={yLong}
                stroke={color}
                strokeWidth={1}
                opacity={0.55}
                strokeDasharray="3 3"
              />
              {/* label */}
              <text
                x={(xStart + xEnd) / 2}
                y={yShort - 8}
                fontSize={10}
                fontWeight={isRecommended ? 700 : 500}
                textAnchor="middle"
                fill={color}
                style={{ fontFamily: "ui-monospace, monospace" }}
              >
                {meta.label}
              </text>
              <text
                x={(xStart + xEnd) / 2}
                y={yShort + 14}
                fontSize={9}
                textAnchor="middle"
                fill={color}
                opacity={0.85}
                style={{ fontFamily: "ui-monospace, monospace" }}
              >
                {c.short_strike}
              </text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}

// ─── Candidate rail ───────────────────────────────────────────────────────────
function CandidateRail({
  scan,
  picks,
  specs,
  bars,
  bankroll,
  selected,
  setSelected,
  recommended,
}: {
  scan: SpreadScanResult;
  picks: Record<TradeType, SpreadCandidate | null>;
  specs: Record<string, SpreadSpec> | null;
  bars: Record<string, Bar[]>;
  bankroll: number;
  selected: TradeType | null;
  setSelected: (t: TradeType | null) => void;
  recommended?: TradeType;
}) {
  return (
    <div className="flex flex-col">
      <div className="text-[10px] uppercase tracking-wider text-text-muted pb-2 mb-1 border-b border-border/40">
        Compare trade types
      </div>
      {TRADE_ORDER.map((t) => (
        <CandidateCard
          key={t}
          tradeType={t}
          candidate={picks[t]}
          spec={specs?.[t] ?? null}
          spot={
            picks[t]
              ? (scan.underlying_prices?.[picks[t]!.symbol] ?? null)
              : null
          }
          fibs={picks[t] ? fibLevelsFrom(bars[picks[t]!.symbol] ?? []) : []}
          bankroll={bankroll}
          selected={selected === t}
          onSelect={() => setSelected(selected === t ? null : t)}
          isRecommended={recommended === t}
        />
      ))}
    </div>
  );
}

function CandidateCard({
  tradeType,
  candidate,
  spec,
  spot,
  fibs,
  bankroll,
  selected,
  onSelect,
  isRecommended,
}: {
  tradeType: TradeType;
  candidate: SpreadCandidate | null;
  spec: SpreadSpec | null;
  spot: number | null;
  fibs: number[];
  bankroll: number;
  selected: boolean;
  onSelect: () => void;
  isRecommended: boolean;
}) {
  const meta = TRADE_META[tradeType];

  if (!candidate) {
    return (
      <div className="py-3 px-3 -mx-3 border-t border-border/30 first:border-t-0">
        <div className="flex items-center gap-2 mb-1.5">
          <span className={cn("w-1.5 h-1.5 rounded-full", meta.dot)} />
          <span className={cn("text-[13px]", meta.tone)}>{meta.label}</span>
        </div>
        <div className="text-[10px] text-text-muted">
          no qualifying setup{spec?.underlying ? ` on ${spec.underlying}` : ""}
        </div>
      </div>
    );
  }

  const c = candidate;
  const allPass = Object.values(c.passes).every(Boolean);
  const fibPos =
    spot != null ? describeFibPosition(c.short_strike, fibs, spot) : "—";
  const sizing = computeSizing(c, bankroll);
  const chartHref =
    `/chart/${c.symbol}?pinShort=${c.short_strike}&pinLong=${c.long_strike}` +
    `&pinExpiry=${c.expiry}&pinType=${c.trade_type}&pinSide=${c.side}`;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "text-left py-3 px-3 -mx-3 rounded-md border-t border-border/30 transition-colors first:border-t-0",
        selected ? "bg-surface-2/50" : "hover:bg-surface-2/30",
      )}
    >
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full translate-y-[-2px] shrink-0",
              meta.dot,
            )}
          />
          <span className={cn("text-[13px] font-medium", meta.tone)}>
            {meta.label}
          </span>
          {isRecommended && (
            <span className="text-[9px] uppercase tracking-wider text-up">
              pick
            </span>
          )}
        </div>
        <span
          className={cn(
            "text-[10px] uppercase tracking-wider shrink-0",
            allPass ? "text-up" : "text-down/70",
          )}
        >
          {allPass
            ? "✓"
            : `${Object.values(c.passes).filter(Boolean).length}/4`}
        </span>
      </div>

      <div className="font-mono text-[13px] tabular text-text-primary mb-2.5">
        {c.short_strike}
        <span className="text-text-muted"> / </span>
        {c.long_strike}
      </div>

      <div className="flex items-baseline gap-x-4 gap-y-1.5 flex-wrap text-[11px] tabular">
        <Chip label="Δ" value={(c.short_delta * 100).toFixed(0)} />
        <Chip
          label="AROC"
          value={`${c.aroc_pct.toFixed(0)}%`}
          tone={c.passes.aroc ? "up" : "down"}
        />
        <Chip
          label="Kelly"
          value={c.kelly_pct.toFixed(0)}
          tone={c.passes.kelly ? undefined : "down"}
        />
        <Chip
          label="adj"
          value={`${c.adj_distance_pct.toFixed(1)}%`}
          tone={c.passes.adj_distance ? undefined : "down"}
        />
      </div>

      <div className="mt-2 text-[10px] text-text-muted">{fibPos}</div>

      {selected && (
        <div className="mt-3 pt-3 border-t border-border/30 flex flex-col gap-2 text-[11px] tabular">
          <div className="flex items-baseline gap-x-4 gap-y-1.5 flex-wrap">
            <Chip label="credit" value={`$${c.credit.toFixed(2)}`} />
            <Chip label="risk" value={`$${c.max_risk.toFixed(2)}`} />
            <Chip label="POP" value={`${c.win_prob_pct.toFixed(0)}%`} />
            <Chip
              label="contracts"
              value={String(sizing.recommendedContracts)}
              tone="up"
            />
          </div>
          <Link
            href={chartHref}
            className="text-[11px] text-accent hover:underline self-start"
            onClick={(e) => e.stopPropagation()}
          >
            Pin on chart →
          </Link>
        </div>
      )}
    </button>
  );
}

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span
        className={cn(
          tone === "up"
            ? "text-up"
            : tone === "down"
              ? "text-down/80"
              : "text-text-primary",
        )}
      >
        {value}
      </span>
    </span>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function computeSizing(c: SpreadCandidate, bankroll: number) {
  const kellyFraction = c.kelly_pct / 100;
  const kellyDollars = Math.max(0, Math.floor(bankroll * kellyFraction));
  const oneThirdCap = Math.floor(bankroll / 3);
  const maxLossPerContract = c.max_risk * 100;
  const kellyCapContracts =
    maxLossPerContract > 0 ? Math.floor(kellyDollars / maxLossPerContract) : 0;
  const oneThirdCapContracts =
    maxLossPerContract > 0 ? Math.floor(oneThirdCap / maxLossPerContract) : 0;
  const recommendedContracts = Math.max(
    1,
    Math.min(kellyCapContracts, oneThirdCapContracts),
  );
  return { kellyDollars, oneThirdCap, recommendedContracts };
}

function formatExpiry(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
