"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type VolumeProfile as VPData } from "@/lib/api";
import { cn, fmtCompact } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { RiBarChartBoxLine as BarChart3 } from "@remixicon/react";

interface Props {
  symbol: string;
  defaultTimeframe?: string;
  defaultDays?: number;
}

const TIMEFRAMES = ["5m", "15m", "30m", "1h", "1d"].map((t) => ({ label: t, value: t }));
const WINDOWS = ["5", "10", "20", "60"].map((d) => ({ label: `${d}d`, value: d }));

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
    <div className="flex flex-col h-full min-h-0">
      <CardHeader>
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle>Volume profile</CardTitle>
          <span className="text-caption-1-medium text-text-tertiary tabular">{symbol}</span>
        </div>
        <div className="flex items-center gap-2">
          <ToggleGroup size="xs" ariaLabel="Bar size" options={TIMEFRAMES} value={tf} onChange={setTf} className="tabular" />
          <ToggleGroup
            size="xs"
            ariaLabel="Lookback"
            options={WINDOWS}
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            className="tabular"
          />
        </div>
      </CardHeader>

      {loading && !data ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-3" style={{ width: `${40 + ((i * 37) % 55)}%` }} />
          ))}
        </div>
      ) : !data || !data.bins?.length ? (
        <EmptyState
          icon={BarChart3}
          title="No volume to profile"
          description="Not enough bar data for this symbol and window."
        />
      ) : (
        <>
          <div className="grid grid-cols-[64px_1fr_72px] px-3 h-8 items-center bg-background-secondary-default text-caption-1-medium text-text-tertiary border-b border-separator-border">
            <span>Price</span>
            <span>Volume</span>
            <span className="text-right">Total</span>
          </div>
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
                    "relative grid grid-cols-[64px_1fr_72px] items-center h-5 px-3 text-caption-1-regular tabular border-b border-separator-border",
                    (inVA || isPoc) && "bg-status-blue-background"
                  )}
                >
                  <span className={cn(isPoc ? "text-text-primary text-caption-1-medium" : "text-text-secondary")}>{b.price_mid.toFixed(2)}</span>
                  <div className="relative h-full flex items-center">
                    <span
                      className={cn(
                        "h-2.5 rounded-sm",
                        isPoc ? "bg-accent-500" : inVA ? "bg-status-blue-text/50" : "bg-foreground-icon-tertiary/40"
                      )}
                      style={{ width: `${Math.max(2, w)}%` }}
                    />
                  </div>
                  <span className="text-right text-text-tertiary">{fmtCompact(b.volume)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {data && data.poc != null && (
        <div className="mt-auto flex items-center justify-between gap-3 px-3 h-8 border-t border-separator-border bg-background-secondary-default text-caption-1-medium tabular text-text-tertiary">
          <span>POC <span className="text-accent-500">{data.poc.toFixed(2)}</span></span>
          {data.value_area_low != null && data.value_area_high != null && (
            <span>Value area <span className="text-text-secondary">
              {data.value_area_low.toFixed(2)} to {data.value_area_high.toFixed(2)}
            </span></span>
          )}
          <span>Total <span className="text-text-secondary">{fmtCompact(data.total_volume)}</span></span>
        </div>
      )}
    </div>
  );
}
