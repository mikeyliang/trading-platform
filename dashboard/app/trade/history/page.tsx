"use client";

import { useEffect } from "react";
import { FlexBackfillCard } from "@/components/trade-history/FlexBackfillCard";
import { TradeAnalysisPanel } from "@/components/trade-history/TradeAnalysisPanel";
import { TradeHistoryPanel } from "@/components/trade-history/TradeHistoryPanel";

// The one history page: Flex backfill, the analysis strip and the filled
// trade log. /trade-history redirects here so the old deep links keep working.
export default function TradeHistoryPage() {
  useEffect(() => {
    document.title = "History · Trade";
  }, []);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <FlexBackfillCard />
      <TradeAnalysisPanel />
      <TradeHistoryPanel />
    </div>
  );
}
