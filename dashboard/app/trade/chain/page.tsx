import { Suspense } from "react";
import { OptionChain } from "@/components/trade/OptionChain";

export const metadata = {
  title: "Chain · Trade",
};

export default function ChainPage() {
  return (
    <Suspense>
      <OptionChain />
    </Suspense>
  );
}
