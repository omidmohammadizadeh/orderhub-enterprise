"use client";

// Phase AW-30 — SaaS subscription page.
//
// One row per location. Platform admin sets the monthly amount → we
// mint a Stripe Customer + Price + Subscription and hand the merchant
// a Stripe Checkout link. Once active, the "Manage" button opens the
// Stripe Customer Portal where the merchant updates card details,
// views invoices, and downloads PDFs. We mirror Stripe's status so we
// can render pills without an extra round-trip.

import { useState, Suspense } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import {
  CreditCard,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  ExternalLink,
  RefreshCw,
  Receipt,
  Download,
  Plus,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";

interface MerchantSubscription {
  id: string;
  locationId: string;
  locationName: string | null;
  monthlyAmountPence: number;
  currency: string;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  defaultPaymentBrand: string | null;
  defaultPaymentLast4: string | null;
  lastInvoiceStatus: string | null;
  lastFailureMessage: string | null;
  stripeCustomerId: string | null;
}

interface Location {
  id: string;
  name: string;
}

// Who may set or cancel a plan on someone's behalf.
const ADMIN_ROLES = new Set(["PLATFORM_ADMIN", "TENANT_OWNER"]);

// Who may open this page at all. The API enforces the same list — this is so a
// pasted URL shows an honest message instead of an empty billing page that
// looks broken. Hiding the nav link alone never stopped anyone typing the path.
const BILLING_ROLES = new Set(["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER"]);

export default function SubscriptionPage() {
  return (
    <Suspense fallback={<div className="p-6 text-zinc-500">Loading…</div>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const sp = useSearchParams();
  const justFinishedCheckout = sp?.get("status") === "success";
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && ADMIN_ROLES.has(user.role as string);
  const mayView = !!user && BILLING_ROLES.has(user.role as string);
  const qc = useQueryClient();

  const subsQuery = useQuery<MerchantSubscription[]>({
    queryKey: ["merchant-subscriptions"],
    // Don't even ask when the role can't have it — a 403 in the console reads
    // like a bug to whoever is looking.
    enabled: mayView,
    queryFn: () =>
      apiClient.get("/v1/subscriptions").then((r) => r.data ?? []),
  });
  const locationsQuery = useQuery<Location[]>({
    queryKey: ["locations-for-subs"],
    enabled: mayView,
    queryFn: () =>
      apiClient
        .get("/v1/locations")
        .then((r) =>
          (r.data ?? []).map((l: any) => ({ id: l.id, name: l.name })),
        ),
  });

  const [setupLocationId, setSetupLocationId] = useState<string | null>(null);

  const subs = subsQuery.data ?? [];
  const locations = locationsQuery.data ?? [];
  const subscribedLocationIds = new Set(subs.map((s) => s.locationId));
  const unsubscribed = locations.filter(
    (l) => !subscribedLocationIds.has(l.id),
  );

  if (user && !mayView) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-2xl font-bold text-zinc-900">Subscription</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Billing is only available to owners and administrators. Ask an owner
          at your business if you need access.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Subscription</h1>
        <p className="text-sm text-zinc-500 mt-0.5">
          Monthly platform fee per location. Card on file, invoices, and
          automatic retries are managed by Stripe.
        </p>
      </div>

      {justFinishedCheckout && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          Payment method saved. Your subscription is now active. The first
          invoice will arrive in your inbox shortly.
        </div>
      )}

      {/* Active subscriptions */}
      <div className="bg-white border border-zinc-200 rounded-2xl p-6">
        <h2 className="font-medium text-zinc-900 mb-3">Active subscriptions</h2>
        {subsQuery.isLoading ? (
          <div className="py-8 grid place-items-center">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
          </div>
        ) : subs.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No subscriptions yet. Pick a location below to set one up.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {subs.map((s) => (
              <SubscriptionRow
                key={s.id}
                sub={s}
                isAdmin={isAdmin}
                onChanged={() =>
                  qc.invalidateQueries({ queryKey: ["merchant-subscriptions"] })
                }
              />
            ))}
          </ul>
        )}
      </div>

      {/* Set up new */}
      {isAdmin && unsubscribed.length > 0 && (
        <div className="bg-white border border-zinc-200 rounded-2xl p-6">
          <h2 className="font-medium text-zinc-900 mb-3">
            Locations without a subscription
          </h2>
          <ul className="divide-y divide-zinc-100">
            {unsubscribed.map((l) => (
              <li key={l.id} className="flex items-center gap-3 py-2.5">
                <CreditCard className="w-4 h-4 text-zinc-400" />
                <span className="flex-1 text-sm text-zinc-700">{l.name}</span>
                <button
                  onClick={() => setSetupLocationId(l.id)}
                  className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Set up
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Setup modal */}
      {setupLocationId && (
        <SetupModal
          locationId={setupLocationId}
          locationName={
            locations.find((l) => l.id === setupLocationId)?.name ?? ""
          }
          onClose={() => setSetupLocationId(null)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ["merchant-subscriptions"] });
            setSetupLocationId(null);
          }}
        />
      )}
    </div>
  );
}

function SubscriptionRow({
  sub,
  isAdmin,
  onChanged,
}: {
  sub: MerchantSubscription;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [showInvoices, setShowInvoices] = useState(false);

  const portalMutation = useMutation({
    mutationFn: () =>
      apiClient
        .post(`/v1/subscriptions/locations/${sub.locationId}/portal`)
        .then((r) => r.data as { url: string }),
    onSuccess: (data) => {
      if (data.url) window.open(data.url, "_blank");
    },
  });
  const restartMutation = useMutation({
    mutationFn: () =>
      apiClient
        .post(`/v1/subscriptions/locations/${sub.locationId}/restart-checkout`)
        .then((r) => r.data as { url: string }),
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
  });
  const cancelMutation = useMutation({
    mutationFn: () =>
      apiClient.delete(`/v1/subscriptions/locations/${sub.locationId}`),
    onSuccess: onChanged,
  });

  const monthly = (sub.monthlyAmountPence / 100).toFixed(2);
  const currencySym = sub.currency === "gbp" ? "£" : sub.currency.toUpperCase();
  const nextCharge = sub.currentPeriodEnd
    ? new Date(sub.currentPeriodEnd).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-zinc-100 grid place-items-center">
          <CreditCard className="w-4 h-4 text-zinc-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-zinc-900 truncate">
              {sub.locationName}
            </span>
            <StatusPill status={sub.status} />
            {sub.cancelAtPeriodEnd && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                Cancels at period end
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {currencySym}
            {monthly}/month
            {sub.defaultPaymentBrand && sub.defaultPaymentLast4 && (
              <>
                {" · "}
                <span className="capitalize">
                  {sub.defaultPaymentBrand}
                </span>{" "}
                ···· {sub.defaultPaymentLast4}
              </>
            )}
            {nextCharge && sub.status === "active" && (
              <> · Next charge {nextCharge}</>
            )}
          </div>
          {sub.status === "past_due" && sub.lastFailureMessage && (
            <p className="mt-1 text-xs text-red-700">
              {sub.lastFailureMessage}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {sub.status === "incomplete" || sub.status === "past_due" ? (
            <button
              onClick={() => restartMutation.mutate()}
              disabled={restartMutation.isPending}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {restartMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                "Add card"
              )}
            </button>
          ) : (
            <button
              onClick={() => portalMutation.mutate()}
              disabled={portalMutation.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              {portalMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <>
                  <ExternalLink className="w-3.5 h-3.5" />
                  Manage
                </>
              )}
            </button>
          )}
          <button
            onClick={() => setShowInvoices((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <Receipt className="w-3.5 h-3.5" />
            Invoices
          </button>
          {isAdmin && sub.status !== "canceled" && !sub.cancelAtPeriodEnd && (
            <button
              onClick={() => {
                if (confirm("Cancel at end of period? Service stays on until then."))
                  cancelMutation.mutate();
              }}
              className="text-xs text-zinc-400 hover:text-red-600 px-2"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      {showInvoices && (
        <InvoiceList locationId={sub.locationId} currency={sub.currency} />
      )}
    </li>
  );
}

function InvoiceList({
  locationId,
  currency,
}: {
  locationId: string;
  currency: string;
}) {
  const { data, isLoading } = useQuery<
    Array<{
      id: string;
      number: string | null;
      amountDue: number;
      status: string;
      createdAt: string;
      hostedInvoiceUrl: string | null;
      invoicePdf: string | null;
    }>
  >({
    queryKey: ["subscription-invoices", locationId],
    queryFn: () =>
      apiClient
        .get(`/v1/subscriptions/locations/${locationId}/invoices`)
        .then((r) => r.data ?? []),
  });
  const currencySym = currency === "gbp" ? "£" : currency.toUpperCase();

  if (isLoading)
    return (
      <div className="mt-3 ml-13 py-3">
        <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
      </div>
    );
  if (!data || data.length === 0)
    return (
      <p className="mt-3 ml-13 text-xs text-zinc-500">
        No invoices yet — the first one is generated at the end of this billing
        period.
      </p>
    );

  return (
    <ul className="mt-3 ml-13 divide-y divide-zinc-100 rounded-md border border-zinc-100">
      {data.map((inv) => (
        <li key={inv.id} className="flex items-center gap-3 px-3 py-2 text-xs">
          <span className="font-mono text-zinc-500 w-24">
            {inv.number ?? inv.id.slice(-10)}
          </span>
          <span className="text-zinc-700">
            {new Date(inv.createdAt).toLocaleDateString("en-GB")}
          </span>
          <span className="text-zinc-900 font-medium">
            {currencySym}
            {(inv.amountDue / 100).toFixed(2)}
          </span>
          <InvoiceStatusPill status={inv.status} />
          <span className="flex-1" />
          {inv.hostedInvoiceUrl && (
            <a
              href={inv.hostedInvoiceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-500 hover:text-zinc-900"
            >
              View
            </a>
          )}
          {inv.invoicePdf && (
            <a
              href={inv.invoicePdf}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-900"
            >
              <Download className="w-3 h-3" />
              PDF
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function SetupModal({
  locationId,
  locationName,
  onClose,
  onCreated,
}: {
  locationId: string;
  locationName: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [amount, setAmount] = useState("49.00");
  const [email, setEmail] = useState("");
  const setupMutation = useMutation({
    mutationFn: () =>
      apiClient
        .post(`/v1/subscriptions/locations/${locationId}/plan`, {
          monthlyAmountPence: Math.round(Number(amount) * 100),
          billingEmail: email || undefined,
        })
        .then((r) => r.data as { checkoutUrl?: string }),
    onSuccess: (data) => {
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        onCreated();
      }
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
      >
        <h3 className="text-base font-semibold text-zinc-900">
          Set up subscription — {locationName}
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          We&apos;ll create a Stripe Customer for this location and send you to
          a hosted checkout where the merchant enters their card.
        </p>

        <div className="mt-5 space-y-3">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Monthly amount (GBP)
            </label>
            <div className="mt-1 flex items-center rounded-md border border-zinc-200">
              <span className="px-3 text-zinc-500">£</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                type="number"
                min="1"
                step="0.01"
                className="w-full border-0 px-1 py-2 text-sm focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Billing email (optional)
            </label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="finance@merchant.com"
              className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-zinc-400">
              Stripe sends invoice receipts here. Leave blank to skip.
            </p>
          </div>
        </div>

        {setupMutation.isError && (
          <p className="mt-3 text-xs text-red-600">
            {(setupMutation.error as any)?.response?.data?.message ??
              "Couldn't create subscription."}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={() => setupMutation.mutate()}
            disabled={setupMutation.isPending || !amount}
            className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {setupMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <>
                <ExternalLink className="w-3.5 h-3.5" />
                Continue to Stripe
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<
    string,
    { label: string; cls: string; icon: React.ReactNode }
  > = {
    active: {
      label: "Active",
      cls: "bg-emerald-100 text-emerald-700",
      icon: <CheckCircle2 className="w-3 h-3" />,
    },
    trialing: {
      label: "Trialing",
      cls: "bg-sky-100 text-sky-700",
      icon: <RefreshCw className="w-3 h-3" />,
    },
    past_due: {
      label: "Payment failed",
      cls: "bg-red-100 text-red-700",
      icon: <AlertTriangle className="w-3 h-3" />,
    },
    unpaid: {
      label: "Unpaid",
      cls: "bg-red-100 text-red-700",
      icon: <AlertTriangle className="w-3 h-3" />,
    },
    canceled: {
      label: "Canceled",
      cls: "bg-zinc-100 text-zinc-500",
      icon: <XCircle className="w-3 h-3" />,
    },
    incomplete: {
      label: "Awaiting card",
      cls: "bg-amber-100 text-amber-700",
      icon: <AlertTriangle className="w-3 h-3" />,
    },
  };
  const meta = map[status] ?? {
    label: status,
    cls: "bg-zinc-100 text-zinc-700",
    icon: null,
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        meta.cls,
      )}
    >
      {meta.icon}
      {meta.label}
    </span>
  );
}

function InvoiceStatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    paid: "bg-emerald-100 text-emerald-700",
    open: "bg-amber-100 text-amber-700",
    uncollectible: "bg-red-100 text-red-700",
    void: "bg-zinc-100 text-zinc-500",
    draft: "bg-zinc-100 text-zinc-500",
  };
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        map[status] ?? "bg-zinc-100 text-zinc-700",
      )}
    >
      {status}
    </span>
  );
}
