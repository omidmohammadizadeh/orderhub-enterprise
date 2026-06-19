"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DollarSign,
  TrendingUp,
  RefreshCw,
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  AlertTriangle,
  CreditCard,
  Banknote,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";
import { BrandConnectSection } from "@/components/payments/brand-connect-section";

interface LedgerEntry {
  id: string;
  type: string;
  amount: string;
  currency: string;
  description: string;
  reference: string | null;
  createdAt: string;
}

interface Payout {
  id: string;
  stripePayoutId: string;
  amount: string;
  currency: string;
  status: string;
  arrivalDate: string | null;
  description: string | null;
  createdAt: string;
}

interface ReconcileResult {
  date: string;
  totalPayments: string;
  totalRefunds: string;
  totalFees: string;
  net: string;
}

interface ConnectAccount {
  stripeAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
}

const LEDGER_COLORS: Record<string, string> = {
  PAYMENT: "text-emerald-600",
  REFUND: "text-red-500",
  PAYOUT: "text-blue-600",
  PLATFORM_FEE: "text-orange-500",
  PROCESSING_FEE: "text-zinc-500",
  TIP: "text-purple-600",
  ADJUSTMENT: "text-amber-600",
};

const PAYOUT_STATUS: Record<string, { label: string; className: string }> = {
  PAID:       { label: "Paid",       className: "text-emerald-700 bg-emerald-100" },
  IN_TRANSIT: { label: "In transit", className: "text-blue-700 bg-blue-100" },
  PENDING:    { label: "Pending",    className: "text-amber-700 bg-amber-100" },
  FAILED:     { label: "Failed",     className: "text-red-700 bg-red-100" },
};

export default function PaymentsPage() {
  const { user } = useAuthStore();
  const [reconcileDate, setReconcileDate] = useState(
    new Date().toISOString().split("T")[0],
  );

  const { data: ledger, isLoading: ledgerLoading } = useQuery({
    queryKey: ["ledger"],
    queryFn: () =>
      apiClient.get("/v1/payments/ledger?limit=50").then((r) => r.data as { entries: LedgerEntry[]; total: number }),
  });

  const { data: payouts, isLoading: payoutsLoading } = useQuery({
    queryKey: ["payouts"],
    queryFn: () =>
      apiClient.get("/v1/payments/payouts").then((r) => r.data as Payout[]),
  });

  const { data: reconcile, isLoading: reconcileLoading } = useQuery({
    queryKey: ["reconcile", reconcileDate],
    queryFn: () =>
      apiClient
        .get(`/v1/payments/reconcile?date=${reconcileDate}`)
        .then((r) => r.data as ReconcileResult),
  });

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
        <h1 className="text-xl font-semibold text-zinc-900">Payments & Financial</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Ledger, payouts, reconciliation, and Stripe Connect</p>
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

      {/* Daily reconciliation */}
      <div className="bg-white border border-zinc-200 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-5 h-5 text-blue-500" />
            <h2 className="font-medium text-zinc-900">Daily Reconciliation</h2>
          </div>
          <input
            type="date"
            value={reconcileDate}
            onChange={(e) => setReconcileDate(e.target.value)}
            className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>
        {reconcileLoading ? (
          <div className="flex items-center justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-zinc-400" /></div>
        ) : reconcile ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Gross payments", value: reconcile.totalPayments, icon: ArrowUpRight, color: "text-emerald-600" },
              { label: "Refunds", value: reconcile.totalRefunds, icon: ArrowDownRight, color: "text-red-500" },
              { label: "Fees", value: reconcile.totalFees, icon: DollarSign, color: "text-orange-500" },
              { label: "Net", value: reconcile.net, icon: TrendingUp, color: "text-zinc-900", bold: true },
            ].map(({ label, value, icon: Icon, color, bold }) => (
              <div key={label} className="bg-zinc-50 rounded-xl p-4">
                <div className="text-xs text-zinc-500 mb-1">{label}</div>
                <div className={cn("text-xl font-bold", color, bold && "text-2xl")}>
                  £{parseFloat(value).toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Payouts */}
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-100">
            <Banknote className="w-5 h-5 text-purple-500" />
            <h2 className="font-medium text-zinc-900">Recent Payouts</h2>
          </div>
          {payoutsLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
            </div>
          ) : !payouts?.length ? (
            <div className="text-center py-10 text-zinc-500 text-sm">No payouts yet.</div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {payouts.slice(0, 8).map((p) => {
                const statusInfo = PAYOUT_STATUS[p.status] ?? { label: p.status, className: "bg-zinc-100 text-zinc-600" };
                return (
                  <div key={p.id} className="px-5 py-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-zinc-900">
                        {p.currency.toUpperCase()} {parseFloat(p.amount).toFixed(2)}
                      </div>
                      <div className="text-xs text-zinc-500 mt-0.5">
                        {p.arrivalDate
                          ? `Arrives ${new Date(p.arrivalDate).toLocaleDateString()}`
                          : new Date(p.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", statusInfo.className)}>
                      {statusInfo.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Ledger */}
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-100">
            <Calendar className="w-5 h-5 text-blue-500" />
            <h2 className="font-medium text-zinc-900">Transaction Ledger</h2>
          </div>
          {ledgerLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
            </div>
          ) : !ledger?.entries?.length ? (
            <div className="text-center py-10 text-zinc-500 text-sm">No transactions yet.</div>
          ) : (
            <div className="divide-y divide-zinc-50 max-h-80 overflow-y-auto">
              {ledger.entries.map((e) => (
                <div key={e.id} className="px-5 py-3 flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-zinc-700 truncate">{e.description}</div>
                    <div className="text-xs text-zinc-400 mt-0.5">
                      {new Date(e.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className={cn("text-sm font-semibold ml-3 flex-shrink-0", LEDGER_COLORS[e.type] ?? "text-zinc-700")}>
                    {["REFUND", "PLATFORM_FEE", "PROCESSING_FEE"].includes(e.type) ? "−" : "+"}
                    £{parseFloat(e.amount).toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
