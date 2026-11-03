"use client";

import { useEffect } from "react";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { FlexBackfillCard } from "@/components/trade-history/FlexBackfillCard";
import { TradeAnalysisPanel } from "@/components/trade-history/TradeAnalysisPanel";
import { TradeHistoryPanel } from "@/components/trade-history/TradeHistoryPanel";

// The one history page: Flex backfill, the analysis strip and the filled
// trade log. /trade-history redirects here so the old deep links keep working.
export default function TradeHistoryPage() {
  useEffect(() => {
    document.title = "Trade history";
  }, []);

  return (
    <PageShell>
      <PageHeader
        title="Trade history"
        description="Fills from IBKR Flex, realized P&L analysis and the full trade log."
      />
      <FlexBackfillCard />
      <TradeAnalysisPanel />
      <TradeHistoryPanel />
    </PageShell>
  );
}
