"use client";

import dynamic from "next/dynamic";
import { ErrorBoundary, LoadingState } from "@/components/ErrorBoundary";

const BacktestPanel = dynamic(
  () => import("@/components/backtest/BacktestPanel").then((m) => m.BacktestPanel),
  { ssr: false, loading: () => <LoadingState message="Loading backtester…" /> }
);

export default function BacktestPage() {
  return (
    <ErrorBoundary>
      <BacktestPanel />
    </ErrorBoundary>
  );
}
