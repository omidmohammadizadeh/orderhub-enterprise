"use client";

// Phase AP-8 — Stripe Connect onboarding entry point for a location.
//
// Shows a "Connect Stripe" button on first use → calls the backend's
// /v1/payments/connect/locations/:locationId/onboard endpoint → opens
// the Stripe-hosted onboarding URL in a new tab. After onboarding,
// Stripe's account.updated webhook flips chargesEnabled / payouts-
// Enabled on our StripeConnectAccount row; we poll the status
// endpoint periodically so the UI reflects the current state without
// the operator having to refresh.
//
// If the operator pasted a raw acct_… into the field below (legacy
// path) the button still works — it triggers proper Connect
// onboarding for that same account.

import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import { apiClient } from "@/lib/api/client";

interface Props {
  locationId: string | null;
  stripeAcct: string;
  setStripeAcct: (v: string) => void;
}

interface ConnectStatus {
  connected: boolean;
  stripeAccountId?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  onboardingComplete?: boolean;
}

export function StripeConnectControl({
  locationId,
  stripeAcct,
  setStripeAcct,
}: Props) {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll status on mount + every 5s while the page is open. Cheap
  // enough that we don't bother with sockets — onboarding events are
  // rare and the operator's whole reason for being on this screen is
  // to finish setup, so a tight poll is fine.
  useEffect(() => {
    if (!locationId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await apiClient.get<ConnectStatus>(
          `/v1/payments/connect/locations/${locationId}/status`,
        );
        if (!cancelled) setStatus(res.data);
      } catch {
        /* silent — first load before the row exists, etc. */
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [locationId]);

  const startOnboarding = async () => {
    if (!locationId) {
      setError(
        "Save the location first — onboarding needs to know which location to attach Stripe to.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.post<{ url: string; accountId: string }>(
        `/v1/payments/connect/locations/${locationId}/onboard`,
      );
      // Stash the acct_… on the form so a Save right after captures it
      // even before the webhook lands.
      if (res.data.accountId) setStripeAcct(res.data.accountId);
      // Open onboarding in a new tab. Operator finishes there;
      // Stripe redirects them back to /dashboard/locations?... where
      // the status polling will pick up the new chargesEnabled flag.
      window.open(res.data.url, "_blank", "noopener,noreferrer");
    } catch (err: any) {
      setError(
        err?.response?.data?.message ??
          err?.message ??
          "Couldn't start Stripe onboarding.",
      );
    } finally {
      setBusy(false);
    }
  };

  const isConnected = status?.connected && status?.chargesEnabled;
  const inProgress =
    status?.connected && !status?.chargesEnabled && !status?.onboardingComplete;

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3 space-y-2">
      {isConnected ? (
        <div className="flex items-center gap-2 text-xs">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <span className="font-semibold text-emerald-700">
            Connected
          </span>
          <span className="text-zinc-500 truncate">
            {status?.stripeAccountId}
          </span>
        </div>
      ) : inProgress ? (
        <div className="flex items-center gap-2 text-xs">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          <span className="font-semibold text-amber-700">
            Onboarding incomplete
          </span>
          <span className="text-zinc-500 truncate">
            {status?.stripeAccountId}
          </span>
        </div>
      ) : (
        <p className="text-xs text-zinc-600">
          Connect a Stripe account so card payments for this location
          land directly in the restaurant&apos;s Stripe balance, with
          your application fee taken automatically.
        </p>
      )}

      {!isConnected && (
        <button
          type="button"
          onClick={startOnboarding}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )}
          {inProgress ? "Resume Stripe onboarding" : "Connect Stripe"}
        </button>
      )}

      {error && (
        <p className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
