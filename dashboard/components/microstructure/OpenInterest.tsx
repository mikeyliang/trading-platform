"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type OptionsChain } from "@/lib/api";
import { cn, fmtCompact } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { RiLoader4Line as Loader2, RiFunctions as Sigma } from "@remixicon/react";
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-2 h-7 border-b border-separator-border text-caption-2-regular text-text-tertiary">
        <Sigma size={10} className="text-accent-500" />
        <span>Open Interest · {symbol}</span>
        <Select value={expiry} onValueChange={setExpiry} disabled={expirations.length === 0}>
          <SelectTrigger className="h-6 w-24 text-caption-2-regular tabular ml-auto">
            <SelectValue placeholder="n/a" />
          </SelectTrigger>
          <SelectContent>
            {expirations.map((e) => (
              <SelectItem key={e} value={e} className="text-caption-2-regular tabular">{fmtExp(e)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading && !chain ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={14} className="animate-spin text-text-tertiary" />
        </div>
      ) : rows.length === 0 || (callOI === 0 && putOI === 0) ? (
        <EmptyState icon={Sigma} title="No OI data" description="Chain returned no open-interest values." />
      ) : (
        <div className="flex-1 overflow-auto">
          {/* Header: calls on the left mirror, strike centre, puts on the right */}
          <div className="grid grid-cols-[1fr_64px_1fr] px-2 h-5 items-center text-caption-2-regular text-text-tertiary border-b border-separator-border">
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
                  "grid grid-cols-[1fr_64px_1fr] items-center h-[16px] px-2 text-caption-2-regular tabular border-b border-separator-border",
                  isMaxPain && "bg-status-yellow-background",
                  isNearSpot && !isMaxPain && "bg-status-blue-background"
                )}
              >
                {/* Call bar (mirrored: grows right→left) */}
                <div className="relative h-full flex items-center justify-end">
                  <span className="absolute right-0 mr-1 text-status-lime-text font-medium z-10">
                    {r.call > 0 ? fmtCompact(r.call) : ""}
                  </span>
                  <span
                    className="h-[10px] bg-status-lime-background rounded-sm"
                    style={{ width: `${callW}%` }}
                  />
                </div>
                <span className={cn(
                  "text-center font-medium",
                  isMaxPain ? "text-status-yellow-text" : isNearSpot ? "text-accent-500" : "text-text-secondary"
                )}>
                  {r.strike}
                </span>
                {/* Put bar (grows left→right) */}
                <div className="relative h-full flex items-center">
                  <span
                    className="h-[10px] bg-status-rose-background rounded-sm"
                    style={{ width: `${putW}%` }}
                  />
                  <span className="absolute left-0 ml-1 text-status-rose-text font-medium z-10">
                    {r.put > 0 ? fmtCompact(r.put) : ""}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rows.length > 0 && (
        <div className="grid grid-cols-3 px-2 h-6 items-center border-t border-separator-border text-caption-2-regular tabular text-text-tertiary">
          <span>P/C OI <span className={cn(
            "font-medium",
            pcr != null && pcr > 1.2 ? "text-status-rose-text" : pcr != null && pcr < 0.7 ? "text-status-lime-text" : "text-text-secondary"
          )}>{pcr != null ? pcr.toFixed(2) : "n/a"}</span></span>
          <span className="text-center">Max Pain <span className="text-status-yellow-text font-medium">{maxPain ?? "n/a"}</span></span>
          <span className="text-right">spot <span className="text-text-primary font-medium">{spot != null ? spot.toFixed(2) : "n/a"}</span></span>
        </div>
      )}
    </div>
  );
}

function fmtExp(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
