import { Suspense } from "react";
import { PricingPlans } from "@/components/research/PricingPlans";

export const metadata = {
  title: "Research Pricing · Trading Terminal",
};

// PricingPlans reads useSearchParams (Stripe checkout redirect state),
// which requires a Suspense boundary during static prerender.
export default function ResearchPricingPage() {
  return (
    <Suspense>
      <PricingPlans />
    </Suspense>
  );
}
