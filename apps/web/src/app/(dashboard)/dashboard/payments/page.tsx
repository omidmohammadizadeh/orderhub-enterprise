"use client";

import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  CreditCard,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { BrandConnectSection } from "@/components/payments/brand-connect-section";

interface ConnectAccount {
  stripeAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
}

// Stripe Connect onboarding only.
//
// This page used to carry a Daily Reconciliation summary, a Recent Payouts
// list and a Transaction Ledger. They were removed: /dashboard/payouts
// already does all three properly, scoped per shop, and the copies here were
// tenant-wide — the payouts list on a location-scoped page was showing other
// shops' money. One page owns payouts now, and it is not this one.
export default function PaymentsPage() {
  const { data: connectAccount } = useQuery({
    queryKey: ["connect-account"],
    queryFn: () =>
      apiClient.get("/v1/payments/connect/account").then((r) => r.data as ConnectAccount).catch(() => null),
  });

  const onboardMutation = useMutation({
    mutationFn: () =>
      apiClient.post("/v1/payments/connect/onboard").then((r) => r.data as { url: string }),
    onSuccess: (data) => {
      window.open(data.url, "_blank");
    },
  });

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Payments</h1>
        <p className="text-sm text-zinc-500 mt-0.5">
          Connect a shop to Stripe so it can take card payments. Payouts,
          balances and the day&apos;s takings live on the Payouts page, where
          they are scoped per shop.
        </p>
      </div>

      {/* Phase AW-30 — per-brand Connect with embedded onboarding */}
      <BrandConnectSection />

      {/* Stripe Connect status */}
      <div className={cn(
        "rounded-2xl p-5 border",
        connectAccount?.onboardingComplete
          ? "bg-emerald-50 border-emerald-200"
          : "bg-amber-50 border-amber-200",
      )}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={cn(
              "w-10 h-10 rounded-xl flex items-center justify-center",
              connectAccount?.onboardingComplete ? "bg-emerald-500" : "bg-amber-400",
            )}>
              <CreditCard className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="font-medium text-zinc-900">Stripe Connect</div>
              <div className="text-sm text-zinc-600 mt-0.5">
                {connectAccount?.onboardingComplete
                  ? `Connected · ${connectAccount.stripeAccountId}`
                  : "Set up Stripe Connect to accept payments and receive payouts"}
              </div>
            </div>
          </div>
          {connectAccount?.onboardingComplete ? (
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                {connectAccount.chargesEnabled ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                ) : (
                  <XCircle className="w-4 h-4 text-zinc-400" />
                )}
                <span className="text-zinc-600">Charges</span>
              </div>
              <div className="flex items-center gap-1.5">
                {connectAccount.payoutsEnabled ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                ) : (
                  <XCircle className="w-4 h-4 text-zinc-400" />
                )}
                <span className="text-zinc-600">Payouts</span>
              </div>
            </div>
          ) : (
            <button
              onClick={() => onboardMutation.mutate()}
              disabled={onboardMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-700 disabled:opacity-50"
            >
              {onboardMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
              Start onboarding
            </button>
          )}
        </div>
      </div>

    </div>
  );
}
