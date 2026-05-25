"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type VolumeProfile as VPData } from "@/lib/api";
import { cn, fmtCompact } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { BarChart3, Loader2 } from "lucide-react";
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
 *  and the value area (70% of volume around POC) is shaded — that's the band
 *  inside which most real activity actually transacted. */
export function VolumeProfile({
  symbol,
  defaultTimeframe = "15m",
  defaultDays = 20,
}: Props) {
  const [tf, setTf] = useState(defaultTimeframe);
  const [days, setDays] = useState(defaultDays);
  const [data, setData] = useState<VPData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    api
      .volumeProfile(symbol, tf, days, 40)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => null)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tf, days]);

  const maxVol = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.bins.map((b) => b.volume));
  }, [data]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-2 h-7 border-b border-border/60 text-[10px] uppercase tracking-wider text-text-muted">
        <BarChart3 size={10} className="text-accent" />
        <span>Volume Profile · {symbol}</span>
        <Select value={tf} onValueChange={setTf}>
          <SelectTrigger className="h-5 w-14 text-[10px] tabular ml-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["5m", "15m", "30m", "1h", "1d"].map((t) => (
              <SelectItem key={t} value={t} className="text-[10px] tabular">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(days)}
          onValueChange={(v: string) => setDays(Number(v))}
        >
          <SelectTrigger className="h-5 w-14 text-[10px] tabular">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[5, 10, 20, 60].map((d) => (
              <SelectItem
                key={d}
                value={String(d)}
                className="text-[10px] tabular"
              >
                {d}d
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={14} className="animate-spin text-text-muted" />
        </div>
      ) : !data || data.bins.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No volume to profile"
          description="Not enough bar data for this symbol / window."
        />
      ) : (
        <div className="flex-1 overflow-auto">
          {/* Bins are returned low → high; render high → low so prices read top-down like a chart axis. */}
          {data.bins
            .slice()
            .reverse()
            .map((b, i) => {
              const isPoc =
                data.poc != null &&
                b.price_low <= data.poc &&
                data.poc <= b.price_high;
              const inVA =
                data.value_area_low != null &&
                data.value_area_high != null &&
                b.price_mid >= data.value_area_low &&
                b.price_mid <= data.value_area_high;
              const w = (b.volume / maxVol) * 100;
              return (
                <div
                  key={i}
                  className={cn(
                    "relative grid grid-cols-[60px_1fr_64px] items-center h-[14px] px-2 text-[10px] tabular border-b border-border/15",
                    inVA && !isPoc && "bg-accent/5",
                    isPoc && "bg-accent/15",
                  )}
                >
                  <span className="text-text-secondary">
                    {b.price_mid.toFixed(2)}
                  </span>
                  <div className="relative h-full flex items-center">
                    <span
                      className={cn(
                        "h-[10px] rounded-sm",
                        isPoc
                          ? "bg-accent"
                          : inVA
                            ? "bg-accent/60"
                            : "bg-text-muted/40",
                      )}
                      style={{ width: `${Math.max(2, w)}%` }}
                    />
                  </div>
                  <span className="text-right text-text-muted">
                    {fmtCompact(b.volume)}
                  </span>
                </div>
              );
            })}
        </div>
      )}

      {data && data.poc != null && (
        <div className="flex items-center justify-between px-2 h-6 border-t border-border/60 text-[9px] tabular text-text-muted">
          <span>
            POC{" "}
            <span className="text-accent font-medium">
              {data.poc.toFixed(2)}
            </span>
          </span>
          {data.value_area_low != null && data.value_area_high != null && (
            <span>
              VA{" "}
              <span className="text-text-secondary font-medium">
                {data.value_area_low.toFixed(2)}–
                {data.value_area_high.toFixed(2)}
              </span>
            </span>
          )}
          <span>Σ {fmtCompact(data.total_volume)}</span>
        </div>
      )}
    </div>
  );
}
