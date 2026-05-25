"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useStore } from "@/lib/store";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { PositionsPanel } from "@/components/dashboard/PositionsPanel";
import { WatchlistPanel } from "@/components/watchlist/WatchlistPanel";
import { ResizableSplit } from "@/components/ui/resizable-split";
import type { PinnedSpread } from "@/components/chart/usePinnedSpreadOverlay";

const TradingChart = dynamic(
  () => import("@/components/chart/TradingChart").then((m) => m.TradingChart),
  { ssr: false },
);

/**
 * Stock-detail view. Same composition as the dashboard home (`/`) — stats
 * bar, chart, positions, watchlist — but parameterized on the URL symbol
 * so a stock search lands here and the trader still sees their book.
 *
 * Positions panel is pre-filtered to the searched symbol; the user can
 * clear the chip to see everything again.
 */
export default function StockDetailPage({
  params,
}: {
  params: { symbol: string };
}) {
  const symbol = params.symbol.toUpperCase();
  const sp = useSearchParams();
  const pinnedSpread = parsePinned(sp);
  const setActiveSymbol = useStore((s) => s.setActiveSymbol);

  // Keep the header's "active symbol" quote pill in sync with the URL.
  useEffect(() => {
    setActiveSymbol(symbol);
  }, [symbol, setActiveSymbol]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <StatsBar />
      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0">
          <ResizableSplit
            storageKey="dash:bottom-h"
            defaultBottomHeight={220}
            minPx={100}
            top={
              <TradingChart
                symbol={symbol}
                pinnedSpread={pinnedSpread}
                height={undefined}
              />
            }
            bottom={<PositionsPanel symbolFilter={symbol} />}
          />
        </div>
        <div className="w-56 bg-bg shrink-0 border-l border-border">
          <WatchlistPanel />
        </div>
      </div>
    </div>
  );
}

function parsePinned(sp: URLSearchParams | null): PinnedSpread | null {
  if (!sp) return null;
  const shortStrike = Number(sp.get("pinShort"));
  const longStrike = Number(sp.get("pinLong"));
  const expiry = sp.get("pinExpiry") || "";
  if (!shortStrike || !longStrike || expiry.length !== 8) return null;
  const tradeType = (sp.get("pinType") || "rut").toLowerCase();
  const side =
    (sp.get("pinSide") || "put").toLowerCase() === "call" ? "call" : "put";
  return { shortStrike, longStrike, expiry, tradeType, side };
}
