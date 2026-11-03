"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type RuleOneCandidate, type RuleOneCycle } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RiLoader4Line as Loader2 } from "@remixicon/react";

interface Props {
  symbol: string;
}

const STRATEGY_LABELS: Record<RuleOneCandidate["strategy_id"], string> = {
  rut: "TRAD",
  mars: "MARS",
  marsmax: "MAX",
  space: "SPACE",
};

// Symbols that should render this card. Other symbols simply hide it.
const SUPPORTED = new Set(["RUT", "IWM", "SPX", "SPY"]);

// Matches MonitorMiniStrip / ExitMonitor cadence. Cycle data is option-chain
// driven so spot moves matter most around third-Friday entry day.
const REFRESH_MS = 60_000;
// How often the "refreshed Xm ago" label re-renders (no fetch, just display).
const TICK_MS = 15_000;

export function RuleOneCycleCard({ symbol }: Props) {
  const [cycle, setCycle] = useState<RuleOneCycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshed, setRefreshed] = useState<number>(Date.now());
  const [, forceTick] = useState(0);
  const inFlight = useRef(false);

  const fetchCycle = useCallback(
    async (mode: "user" | "background") => {
      if (!SUPPORTED.has(symbol)) return;
      if (inFlight.current) return;
      inFlight.current = true;
      if (mode === "user") setLoading(true);
      try {
        const r = await api.ruleoneCycle(symbol);
        setCycle(r);
        setRefreshed(Date.now());
      } catch {
        // Background failure: keep last-good silently. Initial/user failure:
        // surface the unavailable state.
        if (mode === "user") setCycle(null);
      } finally {
        inFlight.current = false;
        if (mode === "user") setLoading(false);
      }
    },
    [symbol],
  );

  // Initial load on mount / symbol change.
  useEffect(() => {
    if (!SUPPORTED.has(symbol)) {
      setCycle(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchCycle("user");
  }, [symbol, fetchCycle]);

  // Silent background polling + visibility-driven refresh.
  useEffect(() => {
    if (!SUPPORTED.has(symbol)) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fetchCycle("background");
    }, REFRESH_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") fetchCycle("background");
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [symbol, fetchCycle]);

  // Tick the "Xm ago" label without refetching.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  if (!SUPPORTED.has(symbol)) return null;

  return (
    <div className="w-[290px] bg-background-primary-default backdrop-blur-md rounded-lg shadow-dropdown pointer-events-auto">
      <header className="flex items-baseline gap-2 px-3.5 pt-2.5 pb-1.5">
        <span className="w-1 h-1 rounded-full bg-status-yellow-text translate-y-[-1px]" />
        <span className="text-caption-2-regular text-text-secondary font-medium">
          Rule One cycle
        </span>
        {cycle?.cycle_label && (
          <span className="text-caption-2-regular text-text-tertiary">· {cycle.cycle_label}</span>
        )}
        {loading && (
          <Loader2 size={10} className="ml-auto animate-spin text-text-tertiary" />
        )}
      </header>

      {cycle ? (
        <div className="px-3.5 pb-3">
          <DatesGrid cycle={cycle} />
          <div className="my-2.5 h-px bg-separator-border" />
          {cycle.scanner_error ? (
            <div className="text-caption-2-regular text-status-rose-text tabular py-1">
              Scanner error · {cycle.scanner_error}
            </div>
          ) : cycle.candidates.length === 0 ? (
            <div className="text-caption-2-regular text-text-tertiary tabular py-1">
              No strikes scanned yet
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {cycle.candidates.map((c) => (
                <CandidateRow key={c.strategy_id} c={c} />
              ))}
            </ul>
          )}
          <footer className="mt-2.5 pt-2 border-t border-separator-border text-caption-2-regular text-text-tertiary tabular">
            <button
              type="button"
              onClick={() => fetchCycle("user")}
              className="group inline-flex items-center gap-1.5 hover:text-text-secondary transition-colors"
              title="Auto-refreshes every 60s · click to refresh now"
            >
              <span className="inline-block h-1 w-1 rounded-full bg-status-lime-background animate-pulse" />
              <span>refreshed {formatRelative(refreshed)}</span>
            </button>
          </footer>
        </div>
      ) : !loading ? (
        <div className="px-3.5 pb-3 text-caption-2-regular text-text-tertiary">
          Unavailable for {symbol}
        </div>
      ) : (
        <div className="px-3.5 pb-3 h-[80px]" />
      )}
    </div>
  );
}

function DatesGrid({ cycle }: { cycle: RuleOneCycle }) {
  const today = parseISO(cycle.today);
  const entry = cycle.entry_date ? parseISO(cycle.entry_date) : null;
  const expiry = cycle.expiry_date ? parseISO(cycle.expiry_date) : null;
  return (
    <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-caption-1-regular tabular">
      <Row label="today" date={today} />
      <Row
        label="enter"
        date={entry}
        suffix={dteSuffix(cycle.days_to_entry, "in")}
      />
      <Row
        label="expire"
        date={expiry}
        suffix={dteSuffix(cycle.days_to_expiry, "in")}
      />
    </div>
  );
}

function Row({
  label,
  date,
  suffix,
}: {
  label: string;
  date: Date | null;
  suffix?: string;
}) {
  return (
    <>
      <span className="text-text-tertiary">{label}</span>
      <span className="text-text-primary">
        {date ? formatShortDate(date) : "n/a"}
      </span>
      <span className="text-right text-text-tertiary">{suffix ?? ""}</span>
    </>
  );
}

function CandidateRow({ c }: { c: RuleOneCandidate }) {
  const strikeLabel =
    c.short_strike != null && c.long_strike != null
      ? `${Math.round(c.short_strike)} / ${Math.round(c.long_strike)} ${c.side === "put" ? "P" : "C"}`
      : "n/a";
  const creditLabel = c.credit != null ? `+${c.credit.toFixed(2)}` : "n/a";
  return (
    <li className="grid grid-cols-[42px_1fr_auto_14px] items-center gap-2 text-caption-1-regular tabular">
      <span className="text-caption-2-regular tabular text-text-secondary">
        {STRATEGY_LABELS[c.strategy_id]}
      </span>
      <span className="text-text-primary tabular">{strikeLabel}</span>
      <span className={cn("tabular", c.credit != null ? "text-status-lime-text" : "text-text-tertiary")}>
        {creditLabel}
      </span>
      <PassMark passes={c.passes} reasons={c.fail_reasons} />
    </li>
  );
}

function PassMark({ passes, reasons }: { passes: boolean; reasons: string[] }) {
  const title = passes ? "all checks pass" : `fails: ${reasons.join(", ")}`;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center justify-center w-3.5 h-3.5 text-caption-2-regular leading-none rounded-sm font-medium",
        passes ? "text-status-lime-text bg-status-lime-background" : "text-status-rose-text bg-status-rose-background"
      )}
    >
      {passes ? "✓" : "✗"}
    </span>
  );
}

function parseISO(s: string): Date {
  // YYYY-MM-DD as local date (no timezone shift).
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function dteSuffix(days: number | null, prefix: string): string {
  if (days == null) return "";
  if (days === 0) return "today";
  if (days < 0) return `${prefix} ${Math.abs(days)}d ago`;
  return `${prefix} ${days}d`;
}

function formatRelative(ts: number): string {
  const dt = (Date.now() - ts) / 1000;
  if (dt < 60) return "just now";
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  return `${Math.floor(dt / 3600)}h ago`;
}
