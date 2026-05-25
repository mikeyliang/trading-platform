"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  api,
  type SpreadCandidate,
  type SpreadScanResult,
  type SpreadSpec,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { RefreshCw, CheckCircle2, XCircle, ChevronDown } from "lucide-react";
import { useLiveBankroll } from "@/lib/useLiveBankroll";
import { MonitorMiniStrip } from "@/components/monitor/MonitorMiniStrip";

const DEFAULT_SYMBOL = "ALL";
const REFRESH_OPTIONS: { label: string; seconds: number }[] = [
  { label: "Manual", seconds: 0 },
  { label: "5 min", seconds: 300 },
  { label: "30 min", seconds: 1800 },
  { label: "Hourly", seconds: 3600 },
];

const TRADE_LABEL: Record<string, string> = {
  rut: "RUT",
  mars: "Mars",
  marsmax: "Mars Max",
  space: "Space",
};
const TRADE_TONE: Record<string, string> = {
  rut: "text-text-secondary",
  mars: "text-accent",
  marsmax: "text-warning",
  space: "text-up",
};
const TRADE_DOT: Record<string, string> = {
  rut: "bg-text-secondary",
  mars: "bg-accent",
  marsmax: "bg-warning",
  space: "bg-up",
};

export function SpreadFinder() {
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [pending, setPending] = useState(symbol);
  const {
    value: bankroll,
    set: setBankroll,
    mode: bankrollMode,
    live: liveBankroll,
    resetToLive,
  } = useLiveBankroll();
  const [result, setResult] = useState<SpreadScanResult | null>(null);
  const [specs, setSpecs] = useState<Record<string, SpreadSpec> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshSec, setRefreshSec] = useState<number>(1800);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [hydratedFromCache, setHydratedFromCache] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    api
      .spreadSpecs()
      .then(setSpecs)
      .catch(() => setSpecs(null));
  }, []);

  // Hydrate from latest persisted scan on mount.
  useEffect(() => {
    let alive = true;
    api
      .scansLatest(symbol)
      .then((rec) => {
        if (!alive || !rec?.payload) return;
        setResult(rec.payload);
        setHydratedFromCache(true);
        if (rec.ran_at) setLastRefreshAt(new Date(rec.ran_at).getTime());
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol]);

  async function scan(sym: string = symbol) {
    setLoading(true);
    setError(null);
    try {
      const r = await api.spreadScan(sym, "put");
      setResult(r);
      setLastRefreshAt(Date.now());
      setHydratedFromCache(false);
      if (r.error) setError(r.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Auto-refresh tick.
  useEffect(() => {
    if (refreshSec <= 0) return;
    const id = setInterval(() => {
      if (!loading) scan(symbol);
    }, refreshSec * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSec, symbol, loading]);

  const onScan = () => {
    setSymbol(pending);
    scan(pending);
  };

  const recommendedType = result?.recommendation?.trade_type;
  const topPicks = useMemo(() => {
    const out: { type: string; cand: SpreadCandidate | null }[] = [];
    const order = ["rut", "mars", "marsmax", "space"];
    for (const t of order) {
      out.push({ type: t, cand: result?.top_picks?.[t] ?? null });
    }
    return out;
  }, [result]);

  const allCandidates = useMemo(() => {
    if (!result) return [];
    const out: { type: string; cand: SpreadCandidate }[] = [];
    for (const [type, cands] of Object.entries(result.trade_types)) {
      for (const c of cands) out.push({ type, cand: c });
    }
    return out;
  }, [result]);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Options · monthly spread scanner"
        title="Spread Finder"
        description="Mars · Mars Max · Space · RUT — same trade types as Picker, ranked side-by-side."
        actions={
          <div className="flex items-end gap-2 flex-wrap">
            <Field label="Symbol">
              <Input
                value={pending}
                onChange={(e) => setPending(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onScan();
                }}
                placeholder="ALL"
                className="h-8 w-24 uppercase tabular"
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
                className="h-8 w-28 tabular"
              />
            </Field>
            <Field label="Refresh">
              <Select
                value={String(refreshSec)}
                onValueChange={(v: string) => setRefreshSec(Number(v))}
              >
                <SelectTrigger className="h-8 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REFRESH_OPTIONS.map((o) => (
                    <SelectItem key={o.seconds} value={String(o.seconds)}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button
              onClick={onScan}
              disabled={loading}
              variant="default"
              size="sm"
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              {loading ? "Scanning…" : "Scan"}
            </Button>
          </div>
        }
      />

      <StatusLine
        lastRefreshAt={lastRefreshAt}
        refreshSec={refreshSec}
        loading={loading}
        hydratedFromCache={hydratedFromCache}
        candidates={allCandidates.length}
      />

      <MonitorMiniStrip />

      {error && <div className="text-[11px] text-down/80">{error}</div>}

      {!result && !loading && (
        <div className="py-12 text-center text-sm text-text-secondary">
          No cached scan yet — the picker hits IBKR for you.
          <div className="text-xs text-text-muted mt-1.5">
            Daily 09:30 ET fills this in automatically.
          </div>
        </div>
      )}

      {result && <RecommendationRow result={result} bankroll={bankroll} />}

      {result && (
        <PicksTable
          topPicks={topPicks}
          specs={specs}
          recommendedType={recommendedType}
          underlyingPrices={result.underlying_prices ?? {}}
          bankroll={bankroll}
        />
      )}

      {result &&
        allCandidates.length > topPicks.filter((p) => p.cand).length && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="self-start inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-secondary"
          >
            <ChevronDown
              size={11}
              className={cn("transition-transform", showAll && "rotate-180")}
            />
            {showAll ? "Hide" : "Show"} all {allCandidates.length} candidates
          </button>
        )}

      {result && showAll && (
        <AllCandidates rows={allCandidates} recommendedType={recommendedType} />
      )}
    </PageShell>
  );
}

// ─── Header bits ──────────────────────────────────────────────────────────────

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
    <label className="flex flex-col gap-1">
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

function StatusLine({
  lastRefreshAt,
  refreshSec,
  loading,
  hydratedFromCache,
  candidates,
}: {
  lastRefreshAt: number | null;
  refreshSec: number;
  loading: boolean;
  hydratedFromCache: boolean;
  candidates: number;
}) {
  const ago = lastRefreshAt ? fmtAgo(Date.now() - lastRefreshAt) : null;
  const mode =
    refreshSec === 0
      ? "manual"
      : refreshSec === 300
        ? "every 5 min"
        : refreshSec === 1800
          ? "every 30 min"
          : "hourly";
  return (
    <div className="flex items-center flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            loading
              ? "bg-warning animate-pulse"
              : refreshSec > 0
                ? "bg-up"
                : "bg-text-muted",
          )}
        />
        {loading ? "Scanning…" : refreshSec === 0 ? "Manual" : `Auto · ${mode}`}
      </span>
      {ago && (
        <span>
          last <span className="text-text-secondary tabular">{ago}</span> ago
        </span>
      )}
      {hydratedFromCache && !loading && (
        <span className="text-text-secondary">· from cache</span>
      )}
      {candidates > 0 && <span>· {candidates} candidates</span>}
    </div>
  );
}

// ─── Recommendation row ───────────────────────────────────────────────────────

function RecommendationRow({
  result,
  bankroll,
}: {
  result: SpreadScanResult;
  bankroll: number;
}) {
  const rec = result.recommendation;
  if (!rec) return null;
  const c = rec.candidate;
  const tone = TRADE_TONE[rec.trade_type] ?? "text-text-primary";
  const label = TRADE_LABEL[rec.trade_type] ?? rec.trade_type;
  const sizing = computeSizing(c, bankroll);
  const chartHref =
    `/chart/${c.symbol}?pinShort=${c.short_strike}&pinLong=${c.long_strike}` +
    `&pinExpiry=${c.expiry}&pinType=${c.trade_type}&pinSide=${c.side}`;

  return (
    <div className="py-4 border-y border-border/40 flex flex-col gap-3">
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          Recommended
        </span>
        <span className={cn("text-base font-semibold tracking-tight", tone)}>
          {label}
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
        <Stat label="AROC" value={`${c.aroc_pct.toFixed(0)}%`} tone="up" />
        <Stat label="Kelly" value={c.kelly_pct.toFixed(0)} />
        <Stat label="POP" value={`${c.win_prob_pct.toFixed(0)}%`} />
        <Stat label="Δ" value={(c.short_delta * 100).toFixed(0)} />
        <Stat label="adj %" value={`${c.adj_distance_pct.toFixed(1)}%`} />
        <Stat
          label="size"
          value={`${sizing.recommendedContracts} ×`}
          tone="up"
        />
      </div>
      <p className="text-[11px] text-text-muted leading-relaxed">
        {rec.reason}
      </p>
      <div className="flex gap-3 text-[11px]">
        <Link href={chartHref} className="text-accent hover:underline">
          View on chart →
        </Link>
      </div>
    </div>
  );
}

function Stat({
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

// ─── Top-picks table ──────────────────────────────────────────────────────────

function PicksTable({
  topPicks,
  specs,
  recommendedType,
  underlyingPrices,
  bankroll,
}: {
  topPicks: { type: string; cand: SpreadCandidate | null }[];
  specs: Record<string, SpreadSpec> | null;
  recommendedType?: string;
  underlyingPrices: Record<string, number | null>;
  bankroll: number;
}) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-[11px] tabular">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-text-muted">
            <Th>Trade</Th>
            <Th align="right">Spot</Th>
            <Th align="right">Strikes</Th>
            <Th align="right">Δ</Th>
            <Th align="right">exit Δ</Th>
            <Th align="right">AROC</Th>
            <Th align="right">Kelly</Th>
            <Th align="right">adj %</Th>
            <Th align="right">size</Th>
            <Th align="center">Status</Th>
          </tr>
        </thead>
        <tbody>
          {topPicks.map(({ type, cand }) => (
            <PickRow
              key={type}
              type={type}
              cand={cand}
              spec={specs?.[type] ?? null}
              spot={cand ? (underlyingPrices[cand.symbol] ?? null) : null}
              isRecommended={recommendedType === type}
              bankroll={bankroll}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right" | "center";
}) {
  return (
    <th
      className={cn(
        "px-3 py-2 font-medium",
        align === "right"
          ? "text-right"
          : align === "center"
            ? "text-center"
            : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function PickRow({
  type,
  cand,
  spec,
  spot,
  isRecommended,
  bankroll,
}: {
  type: string;
  cand: SpreadCandidate | null;
  spec: SpreadSpec | null;
  spot: number | null;
  isRecommended: boolean;
  bankroll: number;
}) {
  const label = TRADE_LABEL[type] ?? type;
  const tone = TRADE_TONE[type] ?? "text-text-secondary";
  const dot = TRADE_DOT[type] ?? "bg-text-secondary";

  if (!cand) {
    return (
      <tr className="border-t border-border/30">
        <td className="px-3 py-2.5">
          <span className="inline-flex items-baseline gap-2">
            <span
              className={cn("w-1.5 h-1.5 rounded-full translate-y-[-2px]", dot)}
            />
            <span className={tone}>{label}</span>
          </span>
        </td>
        <td colSpan={9} className="px-3 py-2.5 text-text-muted">
          no qualifying setup{spec ? ` on ${spec.underlying}` : ""}
        </td>
      </tr>
    );
  }

  const allPass = Object.values(cand.passes).every(Boolean);
  const sizing = computeSizing(cand, bankroll);
  const chartHref =
    `/chart/${cand.symbol}?pinShort=${cand.short_strike}&pinLong=${cand.long_strike}` +
    `&pinExpiry=${cand.expiry}&pinType=${cand.trade_type}&pinSide=${cand.side}`;

  return (
    <tr
      className={cn(
        "border-t border-border/30 hover:bg-surface-2/30 transition-colors",
        isRecommended && "bg-accent/[0.04]",
      )}
    >
      <td className="px-3 py-2.5">
        <Link
          href={chartHref}
          className="inline-flex items-baseline gap-2 hover:underline"
        >
          <span
            className={cn("w-1.5 h-1.5 rounded-full translate-y-[-2px]", dot)}
          />
          <span className={tone}>{label}</span>
          {isRecommended && (
            <span className="text-[9px] uppercase tracking-wider text-up">
              pick
            </span>
          )}
        </Link>
      </td>
      <td className="px-3 py-2.5 text-right text-text-secondary">
        {spot != null ? spot.toFixed(2) : "—"}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-text-primary">
        {cand.short_strike}
        <span className="text-text-muted">/</span>
        {cand.long_strike}
      </td>
      <td className="px-3 py-2.5 text-right text-text-secondary">
        {(cand.short_delta * 100).toFixed(0)}
      </td>
      <td className="px-3 py-2.5 text-right text-text-muted">
        {spec ? Math.round(spec.delta_exit * 100) : "—"}
      </td>
      <td
        className={cn(
          "px-3 py-2.5 text-right",
          cand.passes.aroc ? "text-up" : "text-down/80",
        )}
      >
        {cand.aroc_pct.toFixed(0)}%
      </td>
      <td
        className={cn(
          "px-3 py-2.5 text-right",
          cand.passes.kelly ? "text-text-primary" : "text-down/80",
        )}
      >
        {cand.kelly_pct.toFixed(0)}
      </td>
      <td
        className={cn(
          "px-3 py-2.5 text-right",
          cand.passes.adj_distance ? "text-text-secondary" : "text-down/80",
        )}
      >
        {cand.adj_distance_pct.toFixed(1)}%
      </td>
      <td className="px-3 py-2.5 text-right text-text-secondary">
        {sizing.recommendedContracts}×
      </td>
      <td className="px-3 py-2.5 text-center">
        {allPass ? (
          <CheckCircle2 size={13} className="inline text-up" />
        ) : (
          <XCircle size={13} className="inline text-down/60" />
        )}
      </td>
    </tr>
  );
}

// ─── All-candidates expansion ─────────────────────────────────────────────────

function AllCandidates({
  rows,
  recommendedType,
}: {
  rows: { type: string; cand: SpreadCandidate }[];
  recommendedType?: string;
}) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-[11px] tabular">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-text-muted">
            <Th>Trade</Th>
            <Th align="right">Strikes</Th>
            <Th align="right">Δ</Th>
            <Th align="right">AROC</Th>
            <Th align="right">Kelly</Th>
            <Th align="right">adj %</Th>
            <Th align="center">Pass</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ type, cand }, i) => {
            const allPass = Object.values(cand.passes).every(Boolean);
            const label = TRADE_LABEL[type] ?? type;
            const tone = TRADE_TONE[type] ?? "text-text-secondary";
            const dot = TRADE_DOT[type] ?? "bg-text-secondary";
            const chartHref =
              `/chart/${cand.symbol}?pinShort=${cand.short_strike}&pinLong=${cand.long_strike}` +
              `&pinExpiry=${cand.expiry}&pinType=${cand.trade_type}&pinSide=${cand.side}`;
            return (
              <tr
                key={`${type}-${cand.short_strike}-${i}`}
                className={cn(
                  "border-t border-border/20 hover:bg-surface-2/30",
                  recommendedType === type && "bg-accent/[0.03]",
                )}
              >
                <td className="px-3 py-2">
                  <Link
                    href={chartHref}
                    className="inline-flex items-baseline gap-2 hover:underline"
                  >
                    <span
                      className={cn(
                        "w-1 h-1 rounded-full translate-y-[-2px]",
                        dot,
                      )}
                    />
                    <span className={tone}>{label}</span>
                  </Link>
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-primary">
                  {cand.short_strike}
                  <span className="text-text-muted">/</span>
                  {cand.long_strike}
                </td>
                <td className="px-3 py-2 text-right text-text-secondary">
                  {(cand.short_delta * 100).toFixed(0)}
                </td>
                <td
                  className={cn(
                    "px-3 py-2 text-right",
                    cand.passes.aroc ? "text-up" : "text-down/80",
                  )}
                >
                  {cand.aroc_pct.toFixed(0)}%
                </td>
                <td
                  className={cn(
                    "px-3 py-2 text-right",
                    cand.passes.kelly ? "text-text-primary" : "text-down/80",
                  )}
                >
                  {cand.kelly_pct.toFixed(0)}
                </td>
                <td
                  className={cn(
                    "px-3 py-2 text-right",
                    cand.passes.adj_distance
                      ? "text-text-secondary"
                      : "text-down/80",
                  )}
                >
                  {cand.adj_distance_pct.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-center">
                  {allPass ? (
                    <CheckCircle2 size={12} className="inline text-up" />
                  ) : (
                    <XCircle size={12} className="inline text-down/60" />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function formatExpiry(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
