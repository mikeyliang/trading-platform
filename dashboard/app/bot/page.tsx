"use client";

import dynamic from "next/dynamic";
import { ErrorBoundary, LoadingState } from "@/components/ErrorBoundary";

const BotPanel = dynamic(
  () => import("@/components/bot/BotPanel").then((m) => m.BotPanel),
  { ssr: false, loading: () => <LoadingState message="Loading bot…" /> }
);

export default function BotPage() {
  return (
    <ErrorBoundary>
      <BotPanel />
    </ErrorBoundary>
  );
}
