"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type OptionsChain } from "@/lib/api";
import { cn, fmtCompact } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { RiFunctions as Sigma } from "@remixicon/react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

interface Props {
  symbol: string;
}

// Up to this many expiries render as a segmented control; longer lists fall
// back to a select so the header never overflows.
const SEGMENTED_MAX = 4;

/** Open interest by strike, calls vs puts. Bars mirror around a centre axis
 *  so call/put concentration is read at a glance. We also surface put/call
 *  OI ratio and the max-pain strike (the strike where total option-holder
 *  P&L is minimised at expiry, often a magnet on big-OI weeks). */
export function OpenInterestByStrike({ symbol }: Props) {
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [expiry, setExpiry] = useState<string>("");
  const [expirations, setExpirations] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setChain(null);
    setExpiry("");
    setExpirations([]);
    api.optionsChain(symbol).then((meta) => {
      if (cancelled) return;
      const exps = Array.isArray(meta?.expirations) ? meta.expirations : [];
      setExpirations(exps);
      if (exps[0]) setExpiry(exps[0]);
    }).catch(() => null);
    return () => { cancelled = true; };
  }, [symbol]);

  useEffect(() => {
    if (!expiry) return;
    let cancelled = false;
    setLoading(true);
    api.optionsChain(symbol, expiry)
      .then((c) => { if (!cancelled) setChain(c); })
      .catch(() => null)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, expiry]);

  const { rows, callOI, putOI, maxOI, pcr, maxPain, spot } = useMemo(() => {
    if (!chain) {
      return { rows: [], callOI: 0, putOI: 0, maxOI: 1, pcr: null as number | null, maxPain: null as number | null, spot: null as number | null };
    }
    const byStrike = new Map<number, { strike: number; call: number; put: number }>();
    for (const c of chain.calls) {
      const v = byStrike.get(c.strike) ?? { strike: c.strike, call: 0, put: 0 };
      v.call = c.oi ?? 0;
      byStrike.set(c.strike, v);
    }
    for (const p of chain.puts) {
      const v = byStrike.get(p.strike) ?? { strike: p.strike, call: 0, put: 0 };
      v.put = p.oi ?? 0;
      byStrike.set(p.strike, v);
    }
    const rows = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
    let callOI = 0, putOI = 0;
    let maxOI = 1;
    for (const r of rows) {
      callOI += r.call;
      putOI += r.put;
      maxOI = Math.max(maxOI, r.call, r.put);
    }
    const pcr = callOI > 0 ? putOI / callOI : null;

    // Max-pain: strike S that minimises Σ_K [call_OI(K) * max(S-K,0) + put_OI(K) * max(K-S,0)]
    let maxPain: number | null = null;
    let minPain = Infinity;
    for (const candidate of rows) {
      let pain = 0;
      for (const r of rows) {
        pain += r.call * Math.max(candidate.strike - r.strike, 0);
        pain += r.put * Math.max(r.strike - candidate.strike, 0);
      }
      if (pain < minPain) { minPain = pain; maxPain = candidate.strike; }
    }

    return { rows, callOI, putOI, maxOI, pcr, maxPain, spot: chain.underlying_price };
  }, [chain]);

  const pcrTone =
    pcr != null && pcr > 1.2 ? "text-status-rose-text" : pcr != null && pcr < 0.7 ? "text-status-lime-text" : "text-text-secondary";

  return (
    <div className="flex flex-col h-full min-h-0">
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>Open interest</CardTitle>
          <span className="text-caption-1-medium text-text-tertiary tabular">{symbol}</span>
        </div>
        {expirations.length === 0 ? (
          <span className="text-caption-1-medium text-text-tertiary">Expiry n/a</span>
        ) : expirations.length <= SEGMENTED_MAX ? (
          <ToggleGroup
            size="xs"
            ariaLabel="Expiry"
            className="tabular"
            options={expirations.map((e) => ({ label: fmtExp(e), value: e }))}
            value={expiry}
            onChange={setExpiry}
          />
        ) : (
          <Select value={expiry} onValueChange={setExpiry}>
            <SelectTrigger className="h-6 w-24 tabular text-caption-1-medium" aria-label="Expiry">
              <SelectValue placeholder="n/a" />
            </SelectTrigger>
            <SelectContent>
              {expirations.map((e) => (
                <SelectItem key={e} value={e} className="tabular">{fmtExp(e)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>

      {loading && !chain ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-3" style={{ width: `${40 + ((i * 29) % 55)}%` }} />
          ))}
        </div>
      ) : rows.length === 0 || (callOI === 0 && putOI === 0) ? (
        <EmptyState icon={Sigma} title="No open interest" description="The chain returned no open-interest values for this expiry." />
      ) : (
        <div className="flex-1 overflow-auto">
          {/* Header: calls on the left mirror, strike centre, puts on the right */}
          <div className="grid grid-cols-[1fr_72px_1fr] px-3 h-8 items-center bg-background-secondary-default text-caption-1-medium text-text-tertiary border-b border-separator-border sticky top-0">
            <span className="text-right text-status-lime-text">Calls OI</span>
            <span className="text-center">Strike</span>
            <span className="text-left text-status-rose-text">Puts OI</span>
          </div>
          {rows.slice().reverse().map((r) => {
            const isMaxPain = maxPain != null && r.strike === maxPain;
            const isNearSpot = spot != null && Math.abs(r.strike - spot) < (r.strike * 0.005);
            const callW = (r.call / maxOI) * 100;
            const putW = (r.put / maxOI) * 100;
            return (
              <div
                key={r.strike}
                className={cn(
                  "grid grid-cols-[1fr_72px_1fr] items-center h-5 px-3 text-caption-1-regular tabular border-b border-separator-border",
                  isMaxPain && "bg-status-yellow-background",
                  isNearSpot && !isMaxPain && "bg-status-blue-background"
                )}
              >
                {/* Call bar (mirrored: grows right→left) */}
                <div className="relative h-full flex items-center justify-end">
                  <span className="absolute right-0 mr-1 text-status-lime-text text-caption-1-medium z-10">
                    {r.call > 0 ? fmtCompact(r.call) : ""}
                  </span>
                  <span
                    className="h-2.5 bg-status-lime-background rounded-sm"
                    style={{ width: `${callW}%` }}
                  />
                </div>
                <span className={cn(
                  "text-center text-caption-1-medium",
                  isMaxPain ? "text-status-yellow-text" : isNearSpot ? "text-status-blue-text" : "text-text-secondary"
                )}>
                  {r.strike}
                </span>
                {/* Put bar (grows left→right) */}
                <div className="relative h-full flex items-center">
                  <span
                    className="h-2.5 bg-status-rose-background rounded-sm"
                    style={{ width: `${putW}%` }}
                  />
                  <span className="absolute left-0 ml-1 text-status-rose-text text-caption-1-medium z-10">
                    {r.put > 0 ? fmtCompact(r.put) : ""}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-auto grid grid-cols-3 px-3 h-8 items-center border-t border-separator-border bg-background-secondary-default text-caption-1-medium tabular text-text-tertiary">
          <span>Put/call OI <span className={pcrTone}>{pcr != null ? pcr.toFixed(2) : "n/a"}</span></span>
          <span className="text-center">Max pain <span className="text-status-yellow-text">{maxPain ?? "n/a"}</span></span>
          <span className="text-right">Spot <span className="text-text-primary">{spot != null ? spot.toFixed(2) : "n/a"}</span></span>
        </div>
      )}
    </div>
  );
}

function fmtExp(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
