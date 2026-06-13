'use client';

import { FlexBackfillCard } from '@/components/trade-history/FlexBackfillCard';
import { TradeAnalysisPanel } from '@/components/trade-history/TradeAnalysisPanel';
import { TradeHistoryPanel } from '@/components/trade-history/TradeHistoryPanel';

export default function TradeHistoryPage() {
  return (
    <div className="space-y-4">
      <FlexBackfillCard />
      <TradeAnalysisPanel />
      <TradeHistoryPanel />
    </div>
  );
}
