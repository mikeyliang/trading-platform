'use client';

import { TradeAnalysisPanel } from '@/components/trade-history/TradeAnalysisPanel';
import { TradeHistoryPanel } from '@/components/trade-history/TradeHistoryPanel';

export default function TradeHistoryPage() {
  return (
    <div className="space-y-6">
      <TradeAnalysisPanel />
      <TradeHistoryPanel />
    </div>
  );
}
