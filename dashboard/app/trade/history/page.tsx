"use client";

import { useEffect } from "react";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { FlexBackfillCard } from "@/components/trade-history/FlexBackfillCard";
import { TradeAnalysisPanel } from "@/components/trade-history/TradeAnalysisPanel";
import { TradeHistoryPanel } from "@/components/trade-history/TradeHistoryPanel";

// The one trade log: what you came for (stats, filters, the fills) first,
// standouts below it, and the Flex import, a setup task, folded away at the
// bottom. /trade-history redirects here so old deep links keep working.
export default function TradeHistoryPage() {
  useEffect(() => {
    document.title = "Trades";
  }, []);

  return (
    <PageShell>
      <PageHeader
        title="Trades"
        description="Every fill from IBKR with its realized P&L, newest first."
      />
      <TradeHistoryPanel />
      <TradeAnalysisPanel />
      <FlexBackfillCard />
    </PageShell>
  );
}
