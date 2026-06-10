"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Coins, CreditCard, Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  type CreditAccount, type PricingInfo,
  researchApi,
} from "@/lib/research";

export function PricingPlans() {
  const [pricing, setPricing] = useState<PricingInfo | null>(null);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useSearchParams();

  const reload = useCallback(() => {
    researchApi.pricing().then(setPricing).catch(() => {});
    researchApi.credits().then(setAccount).catch(() => {});
  }, []);

  useEffect(reload, [reload]);

  // Returning from hosted Stripe Checkout.
  useEffect(() => {
    const state = search?.get("checkout");
    if (state === "success") {
      setNotice("Payment received — credits land as soon as Stripe confirms (usually seconds). Refresh if needed.");
    } else if (state === "cancelled") {
      setError("Checkout cancelled — no charge was made.");
    }
  }, [search]);

  const buy = async (packId: string) => {
    setBusy(packId);
    setError(null);
    setNotice(null);
    try {
      const res = await researchApi.checkout(packId);
      if (res.checkout_url) {
        window.location.href = res.checkout_url;
        return;
      }
      if (res.balance != null) {
        setAccount((prev) => (prev ? { ...prev, balance: res.balance! } : prev));
      }
      setNotice(
        res.dev_mode
          ? `${res.pack.credits} credits added (dev mode — configure STRIPE_SECRET_KEY for real checkout).`
          : `${res.pack.credits} credits added.`
      );
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const subscribe = async (planId: string) => {
    setBusy(`plan:${planId}`);
    setError(null);
    setNotice(null);
    try {
      const res = await researchApi.subscribe(planId);
      setAccount((prev) => (prev ? { ...prev, plan: res.plan, balance: res.balance } : prev));
      setNotice(`Switched to the ${res.plan} plan — monthly credits applied.`);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4 space-y-4 max-w-5xl mx-auto">
      <div className="rounded-lg border border-accent/25 bg-gradient-to-br from-accent/15 via-surface to-surface p-4 md:p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-md bg-accent/20 border border-accent/30 flex items-center justify-center">
                <Sparkles size={14} className="text-accent" />
              </span>
              <h1 className="text-lg font-semibold text-text-primary tracking-tight">Research pricing</h1>
            </div>
            <p className="text-xs text-text-secondary max-w-xl leading-relaxed">
              Every run is priced in credits, set by the agents you pick and how deep they go.
              Plans cover monthly volume; packs top you up on demand.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="accent" className="text-xs normal-case tracking-normal px-2.5 py-1.5">
              <CreditCard size={12} />
              {account ? `${account.balance} credits` : "…"}
            </Badge>
            <Button asChild variant="outline" size="sm">
              <Link href="/research"><ArrowLeft size={12} /> Back to research</Link>
            </Button>
          </div>
        </div>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-md border border-up/30 bg-up/10 px-3 py-2 text-xs text-up">
          <Check size={13} /> {notice}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-down/30 bg-down/10 px-3 py-2 text-xs text-down">{error}</div>
      )}

      {/* plans */}
      <div className="grid gap-3 md:grid-cols-3">
        {(pricing?.plans ?? []).map((plan) => {
          const current = account?.plan === plan.id;
          const featured = plan.id === "pro";
          return (
            <Card key={plan.id} className={cn(featured && "border-accent/50 shadow-[0_0_24px_-12px] shadow-accent/40")}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  {plan.name}
                  {featured && <Badge variant="accent">Popular</Badge>}
                  {current && <Badge variant="muted">Current</Badge>}
                </CardTitle>
                <div className="text-2xl font-semibold text-text-primary">
                  ${plan.price_usd_month}
                  <span className="text-xs font-normal text-text-muted"> /mo</span>
                </div>
                <p className="text-[11px] text-text-secondary">{plan.blurb}</p>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="space-y-1 text-xs text-text-secondary">
                  {plan.features.map((f, i) => (
                    <li key={i} className="flex gap-1.5">
                      <Check size={12} className="mt-0.5 shrink-0 text-up" /> {f}
                    </li>
                  ))}
                </ul>
                <Button
                  className="w-full mt-3"
                  variant={featured ? "default" : "outline"}
                  size="sm"
                  disabled={current || busy != null}
                  onClick={() => subscribe(plan.id)}
                >
                  {busy === `plan:${plan.id}` ? <Loader2 size={12} className="animate-spin" /> : null}
                  {current ? "Current plan" : plan.price_usd_month === 0 ? "Switch to Free" : `Choose ${plan.name}`}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* credit packs */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <Coins size={13} className="text-accent" /> Credit packs
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid gap-2 sm:grid-cols-3">
            {(pricing?.packs ?? []).map((pack) => (
              <div key={pack.id} className="rounded-md border border-border bg-surface-2 p-3 flex flex-col gap-1">
                <div className="text-xs text-text-secondary">{pack.name}</div>
                <div className="text-lg font-semibold text-text-primary">
                  {pack.credits.toLocaleString()} <span className="text-xs font-normal text-text-muted">credits</span>
                </div>
                <div className="text-[11px] text-text-muted">
                  ${pack.price_usd} · ${(pack.price_usd / pack.credits).toFixed(3)}/credit
                </div>
                <Button size="sm" className="mt-1" onClick={() => buy(pack.id)} disabled={busy != null}>
                  {busy === pack.id ? <Loader2 size={12} className="animate-spin" /> : <CreditCard size={12} />}
                  Buy
                </Button>
              </div>
            ))}
          </div>
          {pricing && (
            <p className="text-[11px] text-text-muted mt-3">
              Example run costs: quick {pricing.example_costs.quick} · standard {pricing.example_costs.standard} ·
              deep {pricing.example_costs.deep} credits (3 analysts). New accounts start with {pricing.signup_credits} free credits.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ledger */}
      {account && account.ledger.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Credit history</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="divide-y divide-border/60">
              {account.ledger.map((entry, i) => (
                <div key={i} className="flex items-center gap-3 py-1.5 text-xs">
                  <span className={cn("font-mono w-14", entry.delta >= 0 ? "text-up" : "text-down")}>
                    {entry.delta >= 0 ? `+${entry.delta}` : entry.delta}
                  </span>
                  <span className="text-text-secondary">{entry.reason}</span>
                  <span className="ml-auto text-text-muted">
                    bal {entry.balance_after}
                    {entry.created_at ? ` · ${new Date(entry.created_at).toLocaleString()}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
