"use client";

// Locations → Brands → Eat For Less → Getting paid.
//
// Customers pay Eat For Less; the shop's share of each order goes to its own
// payout account on Eat For Less's Stripe and lands in its bank every Monday.
// Stripe's own form collects the bank details and ID — this section only
// opens it and shows where the shop has got to.

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { eflClient, type EflPayoutSetup } from "@/lib/api/efl.client";

const payoutsKey = (locationId: string) => ["efl-payouts", locationId] as const;

const COPY: Record<EflPayoutSetup["status"], { tone: string; text: string }> = {
  NOT_STARTED: {
    tone: "bg-amber-50 text-amber-800",
    text: "Not set up. Eat For Less can't send this shop any money, so it can't take orders yet.",
  },
  IN_PROGRESS: {
    tone: "bg-amber-50 text-amber-800",
    text: "Started but not finished. Stripe still needs a few details before it can pay this shop.",
  },
  READY: {
    tone: "bg-emerald-50 text-emerald-800",
    text: "Ready. This shop's share of every order is paid into its bank each Monday.",
  },
};

export function EflPayoutsSection({ locationId }: { locationId: string }) {
  const qc = useQueryClient();
  const headingId = `efl-payouts-heading-${locationId}`;
  const query = useQuery({ queryKey: payoutsKey(locationId), queryFn: () => eflClient.payouts(locationId) });

  // Back from Stripe's form (?efl=payouts): ask again rather than show the
  // status from before the shop filled it in.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("efl") === "payouts") {
      void qc.invalidateQueries({ queryKey: payoutsKey(locationId) });
    }
  }, [qc, locationId]);

  const open = (fn: () => Promise<{ url: string }>, failure: string) => ({
    mutationFn: fn,
    onSuccess: ({ url }: { url: string }) => window.location.assign(url),
    onError: (err: any) => toast.error(err?.response?.data?.message ?? failure),
  });
  const start = useMutation(open(() => eflClient.startPayouts(locationId), "Couldn't open payout setup"));
  const dashboard = useMutation(open(() => eflClient.payoutsDashboard(locationId), "Couldn't open the payouts dashboard"));

  const setup = query.data;
  // Before Eat For Less's own Stripe is switched on, shops are still paid
  // through their OrderHub Stripe and there is nothing to set up here.
  if (query.isLoading || !setup?.configured) return null;
  const copy = COPY[setup.status];
  const busy = start.isPending || dashboard.isPending;

  return (
    <section aria-labelledby={headingId} className="border-t border-zinc-100 px-4 py-4">
      <h3 id={headingId} className="text-sm font-semibold text-zinc-900">
        Getting paid
      </h3>
      <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${copy.tone}`} role="status">
        {copy.text}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {setup.status !== "READY" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => start.mutate()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-zinc-900 px-4 text-xs font-semibold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {start.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {setup.status === "NOT_STARTED" ? "Set up payouts" : "Finish payout setup"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => dashboard.mutate()}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-zinc-300 px-4 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {dashboard.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            See payouts and bank details
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">
        Opens Stripe, which handles the bank details and ID checks. Eat For Less never sees them.
      </p>
    </section>
  );
}
