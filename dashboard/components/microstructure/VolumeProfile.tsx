"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type VolumeProfile as VPData } from "@/lib/api";
import { cn, fmtCompact } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { RiBarChartBoxLine as BarChart3, RiLoader4Line as Loader2 } from "@remixicon/react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

interface Props {
  symbol: string;
  defaultTimeframe?: string;
  defaultDays?: number;
}

/** Horizontal volume-by-price histogram. POC (busiest band) is highlighted
 *  and the value area (70% of volume around POC) is shaded, that's the band
 *  inside which most real activity actually transacted. */
export function VolumeProfile({ symbol, defaultTimeframe = "15m", defaultDays = 20 }: Props) {
  const [tf, setTf] = useState(defaultTimeframe);
  const [days, setDays] = useState(defaultDays);
  const [data, setData] = useState<VPData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    api.volumeProfile(symbol, tf, days, 40)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => null)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, tf, days]);

  const maxVol = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...(data.bins ?? []).map((b) => b.volume));
  }, [data]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-2 h-7 border-b border-separator-border text-caption-2-regular text-text-tertiary">
        <BarChart3 size={10} className="text-accent-500" />
        <span>Volume Profile · {symbol}</span>
        <Select value={tf} onValueChange={setTf}>
          <SelectTrigger className="h-6 w-[72px] text-caption-2-regular tabular ml-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["5m", "15m", "30m", "1h", "1d"].map((t) => (
              <SelectItem key={t} value={t} className="text-caption-2-regular tabular">{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(days)} onValueChange={(v: string) => setDays(Number(v))}>
          <SelectTrigger className="h-6 w-[72px] text-caption-2-regular tabular">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[5, 10, 20, 60].map((d) => (
              <SelectItem key={d} value={String(d)} className="text-caption-2-regular tabular">{d}d</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={14} className="animate-spin text-text-tertiary" />
        </div>
      ) : !data || !data.bins?.length ? (
        <EmptyState
          icon={BarChart3}
          title="No volume to profile"
          description="Not enough bar data for this symbol / window."
        />
      ) : (
        <div className="flex-1 overflow-auto">
          {/* Bins are returned low → high; render high → low so prices read top-down like a chart axis. */}
          {data.bins.slice().reverse().map((b, i) => {
            const isPoc = data.poc != null && b.price_low <= data.poc && data.poc <= b.price_high;
            const inVA = data.value_area_low != null && data.value_area_high != null &&
              b.price_mid >= data.value_area_low && b.price_mid <= data.value_area_high;
            const w = (b.volume / maxVol) * 100;
            return (
              <div
                key={i}
                className={cn(
                  "relative grid grid-cols-[60px_1fr_64px] items-center h-[14px] px-2 text-caption-2-regular tabular border-b border-separator-border",
                  inVA && !isPoc && "bg-status-blue-background",
                  isPoc && "bg-status-blue-background"
                )}
              >
                <span className="text-text-secondary">{b.price_mid.toFixed(2)}</span>
                <div className="relative h-full flex items-center">
                  <span
                    className={cn(
                      "h-[10px] rounded-sm",
                      isPoc ? "bg-accent-500" : inVA ? "bg-status-blue-background" : "bg-foreground-icon-quaternary/40"
                    )}
                    style={{ width: `${Math.max(2, w)}%` }}
                  />
                </div>
                <span className="text-right text-text-tertiary">{fmtCompact(b.volume)}</span>
              </div>
            );
          })}
        </div>
      )}

      {data && data.poc != null && (
        <div className="flex items-center justify-between px-2 h-6 border-t border-separator-border text-caption-2-regular tabular text-text-tertiary">
          <span>POC <span className="text-accent-500 font-medium">{data.poc.toFixed(2)}</span></span>
          {data.value_area_low != null && data.value_area_high != null && (
            <span>VA <span className="text-text-secondary font-medium">
              {data.value_area_low.toFixed(2)} to {data.value_area_high.toFixed(2)}
            </span></span>
          )}
          <span>Σ {fmtCompact(data.total_volume)}</span>
        </div>
      )}
    </div>
  );
}
