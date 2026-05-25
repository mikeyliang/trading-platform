"use client";

import { useStore } from "@/lib/store";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { PositionsPanel } from "@/components/dashboard/PositionsPanel";
import { WatchlistPanel } from "@/components/watchlist/WatchlistPanel";
import { ResizableSplit } from "@/components/ui/resizable-split";
import dynamic from "next/dynamic";

const TradingChart = dynamic(
  () => import("@/components/chart/TradingChart").then((m) => m.TradingChart),
  { ssr: false },
);

export default function DashboardPage() {
  // Default lands on the user's currently-active symbol so toggling between
  // /chart/[symbol] and / doesn't whiplash. Store seeds to AAPL on first load.
  const symbol = useStore((s) => s.activeSymbol);

  return (
    <div className="flex flex-col h-full min-h-0">
      <StatsBar />
      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0">
          <ResizableSplit
            storageKey="dash:bottom-h"
            defaultBottomHeight={220}
            minPx={100}
            top={<TradingChart symbol={symbol} height={undefined} />}
            bottom={<PositionsPanel />}
          />
        </div>
        <div className="w-56 bg-bg shrink-0 border-l border-border">
          <WatchlistPanel />
        </div>
      </div>
    </div>
  );
}
