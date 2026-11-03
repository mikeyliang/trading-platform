"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useStore } from "@/lib/store";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { PositionsPanel } from "@/components/dashboard/PositionsPanel";
import { WatchlistPanel } from "@/components/watchlist/WatchlistPanel";
import { ResizableSplit } from "@/components/ui/resizable-split";
import { ErrorBoundary, LoadingState } from "@/components/ErrorBoundary";
import { RiStarLine as WatchIcon } from "@remixicon/react";
import { cn } from "@/lib/utils";
import type { PinnedSpread } from "@/components/chart/usePinnedSpreadOverlay";

const TradingChart = dynamic(
  () => import("@/components/chart/TradingChart").then((m) => m.TradingChart),
  { ssr: false, loading: () => <LoadingState message="Loading chart..." /> }
);

// Same floating-panel recipe as the desk home (app/page.tsx): every region is
// a BoardUI card on the page ground.
const card = "rounded-3xl border border-border-button-default bg-background-primary-default shadow-card overflow-hidden";

/**
 * Stock-detail view. Same composition as the dashboard home (`/`), stats
 * bar, chart, positions, watchlist, but parameterized on the URL symbol
 * so a stock search lands here and the trader still sees their book.
 *
 * Positions panel is pre-filtered to the searched symbol; the user can
 * clear the chip to see everything again.
 */
export default function StockDetailPage({ params }: { params: { symbol: string } }) {
  const symbol = params.symbol.toUpperCase();
  const sp = useSearchParams();
  const pinnedSpread = parsePinned(sp);
  const setActiveSymbol = useStore((s) => s.setActiveSymbol);
  const [watchlistOpen, setWatchlistOpen] = useState(false);

  // Keep the header's "active symbol" quote pill in sync with the URL.
  useEffect(() => {
    setActiveSymbol(symbol);
  }, [symbol, setActiveSymbol]);

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
              defaultBottomHeight={220}
              minPx={100}
              gap={12}
              top={
                <div className={cn(card, "h-full flex flex-col")}>
                  <TradingChart symbol={symbol} pinnedSpread={pinnedSpread} height={undefined} />
                </div>
              }
              bottom={
                <div className={cn(card, "h-full flex flex-col")}>
                  <ErrorBoundary fallback={<LoadingState message="Loading positions..." />}>
                    <PositionsPanel symbolFilter={symbol} />
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

function parsePinned(sp: URLSearchParams | null): PinnedSpread | null {
  if (!sp) return null;
  const shortStrike = Number(sp.get("pinShort"));
  const longStrike = Number(sp.get("pinLong"));
  const expiry = sp.get("pinExpiry") || "";
  if (!shortStrike || !longStrike || expiry.length !== 8) return null;
  const tradeType = (sp.get("pinType") || "rut").toLowerCase();
  const side = (sp.get("pinSide") || "put").toLowerCase() === "call" ? "call" : "put";
  return { shortStrike, longStrike, expiry, tradeType, side };
}
