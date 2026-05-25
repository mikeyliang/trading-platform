"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Sparkline } from "@/components/ui/sparkline";
import { Skeleton } from "@/components/ui/skeleton";

// module-level cache so navigation doesn't refetch
const cache = new Map<string, number[]>();
const inflight = new Map<string, Promise<number[]>>();

async function fetchSpark(symbol: string): Promise<number[]> {
  const cached = cache.get(symbol);
  if (cached) return cached;
  const pending = inflight.get(symbol);
  if (pending) return pending;
  const p = api
    .bars(symbol, "1d", 60)
    .then((r) => {
      const vals = (r.bars ?? [])
        .map((b: any) => b.close)
        .filter((v: number) => Number.isFinite(v));
      cache.set(symbol, vals);
      return vals;
    })
    .catch(() => {
      cache.set(symbol, []);
      return [];
    })
    .finally(() => inflight.delete(symbol));
  inflight.set(symbol, p);
  return p;
}

interface Props {
  symbol: string;
  width?: number;
  height?: number;
}

export function WatchlistSparkline({
  symbol,
  width = 100,
  height = 24,
}: Props) {
  const [values, setValues] = useState<number[] | null>(
    cache.get(symbol) ?? null,
  );

  useEffect(() => {
    if (values) return;
    let alive = true;
    fetchSpark(symbol).then((v) => {
      if (alive) setValues(v);
    });
    return () => {
      alive = false;
    };
  }, [symbol, values]);

  if (values === null) {
    return <Skeleton style={{ width, height }} />;
  }
  if (values.length < 2) {
    return <div style={{ width, height }} aria-hidden />;
  }
  return <Sparkline data={values} width={width} height={height} />;
}
