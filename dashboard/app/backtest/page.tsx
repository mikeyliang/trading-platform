"use client";

import dynamic from "next/dynamic";
import { ErrorBoundary, LoadingState } from "@/components/ErrorBoundary";

const SimPanel = dynamic(
  () => import("@/components/sim/SimPanel").then((m) => m.SimPanel),
  { ssr: false, loading: () => <LoadingState message="Loading simulator…" /> }
);

export default function BacktestPage() {
  return (
    <ErrorBoundary>
      <SimPanel />
    </ErrorBoundary>
  );
}
