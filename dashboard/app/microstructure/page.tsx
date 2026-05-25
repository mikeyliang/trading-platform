"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/ui/logo";
import { DeepBook } from "@/components/microstructure/DeepBook";
import { TimeAndSales } from "@/components/microstructure/TimeAndSales";
import { VolumeProfile } from "@/components/microstructure/VolumeProfile";
import { OpenInterestByStrike } from "@/components/microstructure/OpenInterest";

export default function MicrostructurePage() {
  return (
    <Suspense fallback={null}>
      <MicrostructurePageInner />
    </Suspense>
  );
}

/** Market microstructure page — the four "where did real activity happen"
 *  views grouped together. Single symbol selector, dense four-quadrant grid
 *  (depth + tape on top, volume profile + OI on bottom). */
function MicrostructurePageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = (params?.get("symbol") || "SPY").toUpperCase();

  const [symbol, setSymbol] = useState(initial);
  const [pending, setPending] = useState(initial);

  const commit = (s: string) => {
    const next = s.trim().toUpperCase();
    if (!next || next === symbol) return;
    setSymbol(next);
    setPending(next);
    router.replace(`/microstructure?symbol=${next}`);
  };

  return (
    <PageShell>
      <PageHeader
        title="Market Microstructure"
        eyebrow="Where activity actually happened"
        actions={
          <div className="flex items-center gap-2">
            <Logo symbol={symbol} size={20} />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                commit(pending);
              }}
            >
              <Input
                value={pending}
                onChange={(e) => setPending(e.target.value.toUpperCase())}
                className="h-7 w-24 font-semibold tabular text-xs"
              />
            </form>
          </div>
        }
      />

      {/* Four-quadrant dense layout. Each card is fixed-height so the page
          stays scannable and doesn't reflow as data populates. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 flex-1 min-h-0">
        <Card className="overflow-hidden flex flex-col min-h-[360px]">
          <DeepBook symbol={symbol} />
        </Card>
        <Card className="overflow-hidden flex flex-col min-h-[360px]">
          <TimeAndSales symbol={symbol} />
        </Card>
        <Card className="overflow-hidden flex flex-col min-h-[360px]">
          <VolumeProfile symbol={symbol} />
        </Card>
        <Card className="overflow-hidden flex flex-col min-h-[360px]">
          <OpenInterestByStrike symbol={symbol} />
        </Card>
      </div>
    </PageShell>
  );
}
