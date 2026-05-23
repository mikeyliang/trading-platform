"use client";

import { useStore } from "@/lib/store";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { PositionsPanel } from "@/components/dashboard/PositionsPanel";
import { WatchlistPanel } from "@/components/watchlist/WatchlistPanel";
import { ResizableSplit } from "@/components/ui/resizable-split";
import { ErrorBoundary, LoadingState } from "@/components/ErrorBoundary";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Menu } from "lucide-react";

const TradingChart = dynamic(
  () => import("@/components/chart/TradingChart").then((m) => m.TradingChart),
  { 
    ssr: false,
    loading: () => <LoadingState message="Loading chart..." />
  }
);

export default function DashboardPage() {
  // Default lands on the user's currently-active symbol so toggling between
  // /chart/[symbol] and / doesn't whiplash. Store seeds to AAPL on first load.
  const symbol = useStore((s) => s.activeSymbol);
  const [watchlistOpen, setWatchlistOpen] = useState(false);

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-full min-h-0">
        <ErrorBoundary fallback={<LoadingState message="Loading stats..." />}>
          <StatsBar />
        </ErrorBoundary>
        <div className="flex flex-1 min-h-0 relative">
          <div className="flex flex-col flex-1 min-w-0">
            <ResizableSplit
              storageKey="dash:bottom-h"
              defaultBottomHeight={220}
              minPx={100}
              top={<TradingChart symbol={symbol} height={undefined} />}
              bottom={
                <ErrorBoundary fallback={<LoadingState message="Loading positions..." />}>
                  <PositionsPanel />
                </ErrorBoundary>
              }
            />
          </div>
          
          {/* Mobile watchlist toggle */}
          <button
            onClick={() => setWatchlistOpen(!watchlistOpen)}
            className="md:hidden absolute top-2 right-2 z-30 p-1.5 bg-gray-800 text-white rounded-md"
          >
            <Menu size={16} />
          </button>

          {/* Watchlist - hidden on mobile unless toggled, fixed width on desktop */}
          <div className={`
            ${watchlistOpen ? 'block' : 'hidden'} 
            md:block 
            w-56 bg-bg shrink-0 border-l border-border
            absolute md:relative top-0 right-0 h-full z-20 md:z-auto
            md:h-auto
          `}>
            <ErrorBoundary fallback={<LoadingState message="Loading watchlist..." />}>
              <WatchlistPanel />
            </ErrorBoundary>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
