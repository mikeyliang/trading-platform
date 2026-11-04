"use client";

import { useStore } from "@/lib/store";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { PositionsPanel } from "@/components/dashboard/PositionsPanel";
import { WatchlistPanel } from "@/components/watchlist/WatchlistPanel";
import { ResizableSplit } from "@/components/ui/resizable-split";
import { ErrorBoundary, LoadingState } from "@/components/ErrorBoundary";
import dynamic from "next/dynamic";
import { useState } from "react";
import { RiStarLine as WatchIcon } from "@remixicon/react";
import { cn } from "@/lib/utils";

const TradingChart = dynamic(() => import("@/components/chart/TradingChart").then((m) => m.TradingChart), {
  ssr: false,
  loading: () => <LoadingState message="Loading chart..." />,
});

// The desk: account band across the top, the chart and the book of
// positions in the main column, the watchlist beside them. Every region is
// a BoardUI card floating on the page ground.
const card = "rounded-3xl border border-border-button-default bg-background-primary-default shadow-card overflow-hidden";

export default function DashboardPage() {
  // Default lands on the user's currently-active symbol so toggling between
  // /chart/[symbol] and / doesn't whiplash. Store seeds to AAPL on first load.
  const symbol = useStore((s) => s.activeSymbol);
  const [watchlistOpen, setWatchlistOpen] = useState(false);

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-full min-h-0 gap-3">
        <ErrorBoundary fallback={<LoadingState message="Loading stats..." />}>
          <StatsBar />
        </ErrorBoundary>
        <div className="flex flex-1 min-h-0 gap-3 relative">
          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            <ResizableSplit
              storageKey="dash:bottom-h"
              defaultBottomHeight={240}
              minPx={120}
              gap={12}
              top={
                <div className={cn(card, "h-full flex flex-col")}>
                  <TradingChart symbol={symbol} height={undefined} />
                </div>
              }
              bottom={
                <div className={cn(card, "h-full flex flex-col")}>
                  <ErrorBoundary fallback={<LoadingState message="Loading positions..." />}>
                    <PositionsPanel />
                  </ErrorBoundary>
                </div>
              }
            />
          </div>

          {/* Mobile watchlist toggle */}
          <button
            type="button"
            onClick={() => setWatchlistOpen(!watchlistOpen)}
            aria-label={watchlistOpen ? "Hide watchlist" : "Show watchlist"}
            aria-expanded={watchlistOpen}
            className="md:hidden absolute top-2 right-2 z-30 size-8 inline-flex items-center justify-center rounded-lg bg-background-primary-default border border-border-button-default shadow-xs text-foreground-icon-secondary hover:text-text-primary transition-colors"
          >
            <WatchIcon size={18} />
          </button>

          {/* Watchlist: hidden on mobile unless toggled, fixed width on desktop */}
          <div
            className={cn(
              watchlistOpen ? "block" : "hidden",
              "md:block w-64 shrink-0 absolute md:relative top-0 right-0 h-full z-20 md:z-auto",
              card
            )}
          >
            <ErrorBoundary fallback={<LoadingState message="Loading watchlist..." />}>
              <WatchlistPanel />
            </ErrorBoundary>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
