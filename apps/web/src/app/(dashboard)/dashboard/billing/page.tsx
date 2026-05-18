"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CreditCard,
  CheckCircle2,
  Zap,
  Building2,
  FileText,
  Download,
  ArrowUpRight,
  Loader2,
  Star,
  AlertCircle,
  Calendar,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface Plan {
  id: string;
  name: string;
  displayName: string;
  pricePerMonth: string;
  pricePerLocation: string;
  maxLocations: number | null;
  maxUsers: number | null;
  features: string[];
}

interface Subscription {
  id: string;
  status: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  locationCount: number;
  plan: Plan;
}

interface Invoice {
  id: string;
  number: string;
  status: string;
  amountDue: string;
  amountPaid: string;
  currency: string;
  createdAt: string;
  paidAt: string | null;
  pdfUrl: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "text-emerald-700 bg-emerald-100",
  TRIALING: "text-blue-700 bg-blue-100",
  PAST_DUE: "text-red-700 bg-red-100",
  CANCELLED: "text-zinc-500 bg-zinc-100",
  PAUSED: "text-amber-700 bg-amber-100",
};

const INVOICE_STATUS: Record<string, string> = {
  PAID: "text-emerald-700 bg-emerald-100",
  OPEN: "text-amber-700 bg-amber-100",
  VOID: "text-zinc-500 bg-zinc-100",
  UNCOLLECTIBLE: "text-red-700 bg-red-100",
};

const PLAN_ICONS: Record<string, React.ElementType> = {
  STARTER: Zap,
  PROFESSIONAL: Star,
  ENTERPRISE: Building2,
};

export default function BillingPage() {
  const qc = useQueryClient();
  const [upgradeTarget, setUpgradeTarget] = useState<string | null>(null);

  const { data: plans, isLoading: plansLoading } = useQuery({
    queryKey: ["plans"],
    queryFn: () => apiClient.get("/v1/billing/plans").then((r) => r.data as Plan[]),
  });

  const { data: subscription, isLoading: subLoading } = useQuery({
    queryKey: ["subscription"],
    queryFn: () =>
      apiClient.get("/v1/billing/subscription").then((r) => r.data as Subscription).catch(() => null),
  });

  const { data: invoices, isLoading: invLoading } = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiClient.get("/v1/billing/invoices").then((r) => r.data as Invoice[]),
  });

  const upgradeMutation = useMutation({
    mutationFn: (planId: string) =>
      subscription
        ? apiClient.patch("/v1/billing/subscription", { planId }).then((r) => r.data)
        : apiClient.post("/v1/billing/subscription", { planId }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscription"] });
      setUpgradeTarget(null);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiClient.delete("/v1/billing/subscription").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subscription"] }),
  });

  const periodEnd = subscription
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString("en-GB", {
        day: "numeric", month: "long", year: "numeric",
      })
    : null;

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Billing & Subscription</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Manage your plan, invoices, and payment details</p>
      </div>

      {/* Current plan */}
      {subLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
        </div>
      ) : subscription ? (
        <div className="bg-white border border-zinc-200 rounded-2xl p-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
                  {(() => { const Icon = PLAN_ICONS[subscription.plan.name] ?? Zap; return <Icon className="w-5 h-5 text-orange-600" />; })()}
                </div>
                <div>
                  <div className="text-lg font-semibold text-zinc-900">{subscription.plan.displayName} Plan</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", STATUS_COLORS[subscription.status] ?? "bg-zinc-100 text-zinc-600")}>
                      {subscription.status}
                    </span>
                    {subscription.trialEndsAt && new Date(subscription.trialEndsAt) > new Date() && (
                      <span className="text-xs text-blue-600 font-medium">
                        Trial ends {new Date(subscription.trialEndsAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-6">
                <div>
                  <div className="text-xs text-zinc-500">Monthly cost</div>
                  <div className="text-lg font-semibold text-zinc-900 mt-0.5">
                    £{parseFloat(subscription.plan.pricePerMonth).toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-500">Locations</div>
                  <div className="text-lg font-semibold text-zinc-900 mt-0.5">{subscription.locationCount}</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-500">
                    {subscription.cancelAtPeriodEnd ? "Cancels on" : "Renews on"}
                  </div>
                  <div className="text-base font-medium text-zinc-900 mt-0.5">{periodEnd}</div>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              {!subscription.cancelAtPeriodEnd && (
                <button
                  onClick={() => { if (confirm("Cancel at period end?")) cancelMutation.mutate(); }}
                  disabled={cancelMutation.isPending}
                  className="px-3 py-1.5 text-sm border border-zinc-200 rounded-lg text-zinc-600 hover:bg-zinc-50"
                >
                  Cancel plan
                </button>
              )}
            </div>
          </div>
          {subscription.cancelAtPeriodEnd && (
            <div className="mt-4 flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              Your plan will cancel on {periodEnd}. Renew to keep access.
            </div>
          )}
        </div>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center">
          <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
          <div className="font-medium text-zinc-900">No active subscription</div>
          <div className="text-sm text-zinc-500 mt-1">Choose a plan below to get started.</div>
        </div>
      )}

      {/* Plan picker */}
      <div>
        <h2 className="text-base font-semibold text-zinc-900 mb-4">Available Plans</h2>
        {plansLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-zinc-400" /></div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {plans?.map((plan) => {
              const Icon = PLAN_ICONS[plan.name] ?? Zap;
              const isCurrent = subscription?.plan.id === plan.id;
              const isEnterprise = plan.name === "ENTERPRISE";
              return (
                <div
                  key={plan.id}
                  className={cn(
                    "bg-white border rounded-2xl p-6 flex flex-col",
                    isCurrent ? "border-orange-300 ring-2 ring-orange-200" : "border-zinc-200",
                    isEnterprise && "border-purple-200",
                  )}
                >
                  <div className={cn(
                    "w-10 h-10 rounded-xl flex items-center justify-center mb-4",
                    isEnterprise ? "bg-purple-100" : "bg-orange-100",
                  )}>
                    <Icon className={cn("w-5 h-5", isEnterprise ? "text-purple-600" : "text-orange-600")} />
                  </div>
                  <div className="font-semibold text-zinc-900">{plan.displayName}</div>
                  <div className="mt-1">
                    <span className="text-2xl font-bold text-zinc-900">£{parseFloat(plan.pricePerMonth).toFixed(0)}</span>
                    <span className="text-zinc-500 text-sm">/mo</span>
                  </div>
                  {parseFloat(plan.pricePerLocation) > 0 && (
                    <div className="text-xs text-zinc-500 mt-0.5">+£{plan.pricePerLocation}/location/mo</div>
                  )}
                  <div className="mt-4 space-y-2 flex-1">
                    <div className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Includes</div>
                    {plan.features.slice(0, 6).map((f) => (
                      <div key={f} className="flex items-center gap-2 text-sm text-zinc-700">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                        {f.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                      </div>
                    ))}
                    {plan.features.length > 6 && (
                      <div className="text-xs text-zinc-400">+{plan.features.length - 6} more features</div>
                    )}
                  </div>
                  <div className="mt-6">
                    {isCurrent ? (
                      <div className="w-full text-center py-2 rounded-xl bg-zinc-100 text-zinc-500 text-sm font-medium">
                        Current plan
                      </div>
                    ) : (
                      <button
                        onClick={() => setUpgradeTarget(plan.id)}
                        className={cn(
                          "w-full py-2 rounded-xl text-sm font-medium transition-colors",
                          isEnterprise
                            ? "bg-purple-600 text-white hover:bg-purple-700"
                            : "bg-zinc-900 text-white hover:bg-zinc-700",
                        )}
                      >
                        {subscription ? "Switch plan" : "Get started"}
                        <ArrowUpRight className="w-3.5 h-3.5 inline ml-1" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Upgrade confirm */}
      {upgradeTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="font-semibold text-zinc-900 text-lg">Confirm plan change</h3>
            <p className="text-sm text-zinc-500 mt-2">
              You&apos;re switching to the <strong>{plans?.find((p) => p.id === upgradeTarget)?.displayName}</strong> plan.
              Changes take effect immediately and will be reflected in your next invoice.
            </p>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setUpgradeTarget(null)} className="flex-1 py-2 rounded-xl border border-zinc-200 text-sm font-medium">
                Cancel
              </button>
              <button
                onClick={() => upgradeMutation.mutate(upgradeTarget)}
                disabled={upgradeMutation.isPending}
                className="flex-1 py-2 rounded-xl bg-zinc-900 text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {upgradeMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invoices */}
      <div>
        <h2 className="text-base font-semibold text-zinc-900 mb-4">Invoices</h2>
        {invLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-zinc-400" /></div>
        ) : !invoices?.length ? (
          <div className="text-center py-10 text-zinc-500">
            <FileText className="w-8 h-8 mx-auto mb-2 text-zinc-300" />
            No invoices yet.
          </div>
        ) : (
          <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Invoice</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-zinc-50 last:border-0">
                    <td className="px-4 py-3 font-mono text-zinc-700 text-xs">{inv.number}</td>
                    <td className="px-4 py-3 text-zinc-600">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-zinc-400" />
                        {new Date(inv.createdAt).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-medium text-zinc-900">
                      {inv.currency.toUpperCase()} {parseFloat(inv.amountDue).toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", INVOICE_STATUS[inv.status] ?? "bg-zinc-100 text-zinc-600")}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {inv.pdfUrl ? (
                        <a href={inv.pdfUrl} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900">
                          <Download className="w-3.5 h-3.5" /> PDF
                        </a>
                      ) : (
                        <CreditCard className="w-3.5 h-3.5 text-zinc-300" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
