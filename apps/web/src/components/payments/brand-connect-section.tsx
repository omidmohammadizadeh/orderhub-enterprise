"use client";

// Phase AW-30 — embedded Stripe Connect onboarding + management.
//
// One card per brand. Status pills show charges/payouts/onboarding.
// "Continue setup" opens an embedded ConnectAccountOnboarding panel
// inline so the merchant fills the form without leaving the dashboard.
// "Manage payouts" opens ConnectAccountManagement + Payouts so they
// can change bank details or check the payout schedule afterwards.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Loader2, RefreshCw, CreditCard } from "lucide-react";
import {
  ConnectAccountOnboarding,
  ConnectAccountManagement,
  ConnectPayouts,
  ConnectNotificationBanner,
  ConnectComponentsProvider,
} from "@stripe/react-connect-js";
import { loadConnectAndInitialize } from "@stripe/connect-js";
import { apiClient } from "@/lib/api/client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

interface BrandConnectRow {
  brandId: string;
  name: string;
  logoUrl: string | null;
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
  applicationFee: {
    mode: string | null;
    fixedAmount: string | number | null;
    percentage: string | number | null;
  };
}

const STRIPE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";

type PanelMode = "onboarding" | "management";

export function BrandConnectSection() {
  const qc = useQueryClient();
  // Phase AW-30 — scope the brand list to the location picker in the
  // sidebar. When "All locations" is selected (null) we show every
  // brand with direct online ordering enabled; when one location is
  // pinned we show only the brands tied to that location.
  const locationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );
  const brandsQuery = useQuery({
    queryKey: ["brand-connect", locationId],
    queryFn: () =>
      apiClient
        .get("/v1/payments/connect/brands", {
          params: locationId ? { locationId } : undefined,
        })
        .then((r) => r.data as BrandConnectRow[]),
  });

  const [openPanel, setOpenPanel] = useState<{
    brandId: string;
    mode: PanelMode;
  } | null>(null);

  const brands = brandsQuery.data ?? [];

  if (!STRIPE_PUBLISHABLE_KEY) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <strong>NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</strong> isn&apos;t set
        on this environment. Add it to the web service&apos;s env
        variables and redeploy to enable embedded onboarding.
      </div>
    );
  }

  return (
    <div className="bg-white border border-zinc-200 rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-medium text-zinc-900">Brand payouts</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            Each brand has its own Stripe Connect account. Merchants
            complete onboarding or change their bank details right here.
          </p>
        </div>
      </div>

      {brandsQuery.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
        </div>
      ) : brands.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {locationId
            ? "No brands with online ordering enabled at this location. Switch to All locations or enable a brand's online ordering from Locations → Brands."
            : "No brands with online ordering enabled yet. Create one from Locations → Brands first."}
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {brands.map((b) => (
            <li key={b.brandId} className="py-3">
              <BrandRow
                row={b}
                isOpen={openPanel?.brandId === b.brandId}
                openMode={openPanel?.mode}
                onOpen={(mode) => setOpenPanel({ brandId: b.brandId, mode })}
                onClose={() => setOpenPanel(null)}
                onRefreshed={() =>
                  qc.invalidateQueries({ queryKey: ["brand-connect"] })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BrandRow({
  row,
  isOpen,
  openMode,
  onOpen,
  onClose,
  onRefreshed,
}: {
  row: BrandConnectRow;
  isOpen: boolean;
  openMode: PanelMode | undefined;
  onOpen: (mode: PanelMode) => void;
  onClose: () => void;
  onRefreshed: () => void;
}) {
  const refreshMutation = useMutation({
    mutationFn: () =>
      apiClient
        .post(`/v1/payments/connect/brands/${row.brandId}/refresh`)
        .then((r) => r.data),
    onSuccess: onRefreshed,
  });

  return (
    <>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg border border-zinc-100 bg-zinc-50 grid place-items-center overflow-hidden">
          {row.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={row.logoUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <CreditCard className="w-4 h-4 text-zinc-400" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-zinc-900 truncate">{row.name}</span>
            <StatusPill ok={row.chargesEnabled} label="Charges" />
            <StatusPill ok={row.payoutsEnabled} label="Payouts" />
            <StatusPill ok={row.onboardingComplete} label="Onboarded" />
          </div>
          <div className="mt-0.5 text-xs text-zinc-500 truncate">
            {row.stripeAccountId
              ? `Account ${row.stripeAccountId}`
              : "No Stripe account yet"}
          </div>
        </div>
        <button
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
          title="Refresh status"
          className="text-zinc-400 hover:text-zinc-700 disabled:opacity-40"
        >
          {refreshMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
        </button>
        {row.onboardingComplete ? (
          <button
            onClick={() =>
              isOpen && openMode === "management"
                ? onClose()
                : onOpen("management")
            }
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            {isOpen && openMode === "management"
              ? "Close"
              : "Manage payouts"}
          </button>
        ) : (
          <button
            onClick={() =>
              isOpen && openMode === "onboarding"
                ? onClose()
                : onOpen("onboarding")
            }
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
          >
            {isOpen && openMode === "onboarding"
              ? "Close"
              : row.stripeAccountId
                ? "Continue setup"
                : "Start onboarding"}
          </button>
        )}
      </div>

      {isOpen && (
        <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <EmbeddedPanel
            brandId={row.brandId}
            mode={openMode!}
            onExit={() => {
              refreshMutation.mutate();
              onClose();
            }}
          />
        </div>
      )}
    </>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        ok ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"
      }`}
    >
      {ok ? (
        <CheckCircle2 className="w-3 h-3" />
      ) : (
        <XCircle className="w-3 h-3" />
      )}
      {label}
    </span>
  );
}

function EmbeddedPanel({
  brandId,
  mode,
  onExit,
}: {
  brandId: string;
  mode: PanelMode;
  onExit: () => void;
}) {
  const endpoint =
    mode === "onboarding" ? "onboarding-session" : "management-session";

  // Each brand × mode gets its own ConnectInstance, but we have to
  // memoise so React doesn't re-init on every render — Stripe charges
  // a network round-trip for every init.
  const stripeConnect = useMemo(() => {
    return loadConnectAndInitialize({
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      fetchClientSecret: async () => {
        const res = await apiClient.post(
          `/v1/payments/connect/brands/${brandId}/${endpoint}`,
        );
        return (res.data as { clientSecret: string }).clientSecret;
      },
      appearance: {
        overlays: "dialog",
        variables: {
          colorPrimary: "#18181b",
          colorBackground: "#ffffff",
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          borderRadius: "8px",
        },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, endpoint]);

  return (
    <ConnectComponentsProvider connectInstance={stripeConnect}>
      <div className="space-y-2">
        <ConnectNotificationBanner />
        {mode === "onboarding" ? (
          <ConnectAccountOnboarding onExit={onExit} />
        ) : (
          <>
            <ConnectAccountManagement />
            <ConnectPayouts />
          </>
        )}
      </div>
    </ConnectComponentsProvider>
  );
}

export type { BrandConnectRow };
