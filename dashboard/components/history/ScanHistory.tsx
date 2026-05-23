"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type ScanRecord } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/ui/page-header";

const TRADE_FILTERS = [
  { value: "",        label: "All" },
  { value: "rut",     label: "RUT" },
  { value: "mars",    label: "Mars" },
  { value: "marsmax", label: "Max" },
  { value: "space",   label: "Space" },
];

const TRADE_TONE: Record<string, string> = {
  rut:     "text-text-secondary",
  mars:    "text-accent",
  marsmax: "text-warning",
  space:   "text-up",
};

export function ScanHistory() {
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.scansHistory({ limit: 50, trade_type: filter || undefined })
      .then((r) => { if (alive) setScans(r.scans); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filter]);

  const stats = useMemo(() => summarize(scans), [scans]);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Scan history"
        title="Past Picker runs"
        description="Every scan — daily 09:30 ET, monthly pre-flight, and manual runs. Filter to see what trade type's been hitting."
        actions={
          <div className="flex items-center gap-0.5 flex-wrap">
            {TRADE_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={cn(
                  "h-7 px-2.5 text-[11px] tabular rounded-sm transition-colors",
                  filter === f.value
                    ? "text-text-primary bg-surface-2"
                    : "text-text-muted hover:text-text-secondary hover:bg-surface-2/60"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      />

      {!loading && scans.length > 0 && <SummaryStrip stats={stats} />}

      {loading && <SkeletonList />}

      {!loading && scans.length === 0 && (
        <div className="py-16 text-center">
          <p className="text-sm text-text-secondary">No scans recorded yet.</p>
          <p className="text-xs text-text-muted mt-2">
            Open the Picker and run a scan, or wait for the 09:30 ET daily job.
          </p>
        </div>
      )}

      {!loading && scans.length > 0 && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[11px] tabular">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-text-muted">
                <th className="px-3 py-2 text-left font-medium">When</th>
                <th className="px-3 py-2 text-left font-medium">Scope</th>
                <th className="px-3 py-2 text-left font-medium">Sym</th>
                <th className="px-3 py-2 text-left font-medium">Pick</th>
                <th className="px-3 py-2 text-right font-medium">Strikes</th>
                <th className="px-3 py-2 text-right font-medium">Exp</th>
                <th className="px-3 py-2 text-right font-medium">AROC</th>
                <th className="px-3 py-2 text-right font-medium">Kelly</th>
                <th className="px-3 py-2 text-right font-medium">Δ</th>
              </tr>
            </thead>
            <tbody>
              {scans.map((s) => (
                <Row key={s.id ?? Math.random()} scan={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

interface Stats {
  total: number;
  withPick: number;
  bestAroc: number | null;
  byType: Record<string, number>;
}

function summarize(scans: ScanRecord[]): Stats {
  let total = 0, withPick = 0, bestAroc: number | null = null;
  const byType: Record<string, number> = {};
  for (const s of scans) {
    total++;
    const cand = s.payload?.recommendation?.candidate;
    if (s.recommendation) {
      withPick++;
      byType[s.recommendation] = (byType[s.recommendation] ?? 0) + 1;
    }
    if (cand?.aroc_pct != null && (bestAroc == null || cand.aroc_pct > bestAroc)) {
      bestAroc = cand.aroc_pct;
    }
  }
  return { total, withPick, bestAroc, byType };
}

function SummaryStrip({ stats }: { stats: Stats }) {
  const topType = Object.entries(stats.byType).sort((a, b) => b[1] - a[1])[0];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-10 gap-y-4 py-2">
      <Metric label="Total scans" value={stats.total.toString()} />
      <Metric
        label="With a pick"
        value={stats.withPick.toString()}
        sub={stats.total > 0 ? `${Math.round((stats.withPick / stats.total) * 100)}%` : undefined}
      />
      <Metric
        label="Best AROC"
        value={stats.bestAroc != null ? `${stats.bestAroc.toFixed(0)}%` : "—"}
        tone={stats.bestAroc != null ? "up" : undefined}
      />
      <Metric
        label="Most-picked"
        value={topType ? topType[0].toUpperCase() : "—"}
        sub={topType ? `${topType[1]}×` : undefined}
        tone={topType ? "accent" : undefined}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "accent";
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1.5">{label}</div>
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "text-xl md:text-2xl font-semibold tabular tracking-tight",
            tone === "up" ? "text-up" : tone === "accent" ? "text-accent" : "text-text-primary",
          )}
        >
          {value}
        </span>
        {sub && <span className="text-xs text-text-muted tabular">{sub}</span>}
      </div>
    </div>
  );
}

function Row({ scan }: { scan: ScanRecord }) {
  const ran = scan.ran_at ? new Date(scan.ran_at) : null;
  const dateStr = ran
    ? `${ran.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${ran.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "—";
  const reco = scan.recommendation;
  const tone = reco ? (TRADE_TONE[reco] ?? "text-text-secondary") : "text-text-muted";
  const cand = scan.payload?.recommendation?.candidate;

  return (
    <tr className="border-t border-border/30 hover:bg-surface-2/30 transition-colors">
      <td className="px-3 py-2.5 text-text-secondary tabular whitespace-nowrap">{dateStr}</td>
      <td className="px-3 py-2.5 text-text-muted text-[10px] uppercase tracking-wider whitespace-nowrap">{scan.scope ?? "—"}</td>
      <td className="px-3 py-2.5 text-text-secondary">{scan.symbol ?? "—"}</td>
      <td className={cn("px-3 py-2.5 uppercase text-[10px] tracking-wider", tone)}>
        {reco ?? "—"}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-text-primary">
        {cand ? <>{cand.short_strike}<span className="text-text-muted">/</span>{cand.long_strike}</> : "—"}
      </td>
      <td className="px-3 py-2.5 text-right text-text-secondary whitespace-nowrap">
        {cand ? <>{formatExpiry(cand.expiry)} <span className="text-text-muted">· {cand.dte}d</span></> : "—"}
      </td>
      <td className={cn("px-3 py-2.5 text-right", cand ? "text-up" : "text-text-muted")}>
        {cand ? `${cand.aroc_pct.toFixed(0)}%` : "—"}
      </td>
      <td className="px-3 py-2.5 text-right text-text-secondary">
        {cand ? cand.kelly_pct.toFixed(0) : "—"}
      </td>
      <td className="px-3 py-2.5 text-right text-text-secondary">
        {cand ? (cand.short_delta * 100).toFixed(0) : "—"}
      </td>
    </tr>
  );
}

function SkeletonList() {
  return (
    <div className="flex flex-col gap-2 animate-pulse">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-24 rounded bg-surface-2/40" />
      ))}
    </div>
  );
}

function formatExpiry(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
