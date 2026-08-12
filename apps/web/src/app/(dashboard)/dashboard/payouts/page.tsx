"use client";

// "Where's my money, and which bank does it go to?"
//
// The Payments page answers an accountant's questions — ledger, fees, daily
// reconciliation. This one answers the owner's: what has Stripe paid me, what
// is on its way, and how do I change the account it lands in. It is deliberately
// a separate page with a plain name, because that is what someone hunts for.
//
// Bank details are not edited here. Our Connect accounts are Express, so the
// owner is sent to Stripe's own dashboard through a one-time link — no account
// number ever passes through OrderHub.

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Banknote,
  Building2,
  ExternalLink,
  Loader2,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import toast from "react-hot-toast";
import { payoutsClient, type PayoutRow } from "@/lib/api/payouts.client";
import { cn } from "@/lib/utils";

const STATUS: Record<string, { label: string; className: string }> = {
  PAID: { label: "Paid", className: "text-emerald-700 bg-emerald-100" },
  IN_TRANSIT: { label: "On its way", className: "text-blue-700 bg-blue-100" },
  PENDING: { label: "Pending", className: "text-amber-700 bg-amber-100" },
  FAILED: { label: "Failed", className: "text-red-700 bg-red-100" },
  CANCELLED: { label: "Cancelled", className: "text-zinc-600 bg-zinc-100" },
};

const money = (n: number, ccy = "gbp") =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy.toUpperCase(),
  }).format(n);

const day = (d: string) =>
  new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export default function PayoutsPage() {
  const [accountId, setAccountId] = useState<string | undefined>();
  // Which payout is showing its breakdown. One at a time — this is a
  // "what made up THIS one" question, not a comparison.
  const [openPayout, setOpenPayout] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["payouts", accountId ?? "all"],
    queryFn: () => payoutsClient.list(accountId),
  });

  const accounts = listQuery.data?.accounts ?? [];
  // The balance is per-account, so it only means something once one is chosen
  // (or when there is only one to choose).
  const balanceAccountId = accountId ?? (accounts.length === 1 ? accounts[0]!.id : undefined);

  const balanceQuery = useQuery({
    queryKey: ["payout-balance", balanceAccountId],
    queryFn: () => payoutsClient.balance(balanceAccountId),
    enabled: !!balanceAccountId,
  });

  const dashboard = useMutation({
    mutationFn: () => payoutsClient.dashboardLink(balanceAccountId),
    onSuccess: ({ url, kind, message }) => {
      if (kind === "EXTERNAL") {
        // Their own Stripe account. Not a failure — don't dress it as one.
        toast(message ?? "Opening Stripe.", { icon: "🔗", duration: 6000 });
      }
      if (kind === "ONBOARDING") {
        // This account never finished Stripe setup, so there's no dashboard to
        // open yet. Say so before the tab appears, or the owner lands on a
        // form they weren't expecting.
        toast("Finishing Stripe setup first — add your bank details there.", {
          icon: "🏦",
        });
      } else if (kind === "ACCOUNT_UPDATE") {
        // No Stripe dashboard on this account, so they get the hosted update
        // form. It edits bank details but has no statements, hence the
        // narrower promise than the button makes.
        toast("Opening your Stripe details form to update bank details.", {
          icon: "🏦",
        });
      }
      // Single-use link — open it straight away rather than rendering it.
      window.open(url, "_blank", "noopener,noreferrer");
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ?? "Couldn't open your Stripe dashboard",
      ),
  });

  const payouts = listQuery.data?.payouts ?? [];
  const balance = balanceQuery.data;
  // A Standard account belongs to the merchant, not to us — say so plainly
  // rather than letting them find out by pressing a button that can't work.
  const ownStripe =
    accounts.find((a) => a.id === balanceAccountId)?.dashboardType === "full";

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Payouts</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Money Stripe has sent to your bank, and where it lands.
          </p>
        </div>
        <button
          onClick={() => dashboard.mutate()}
          disabled={dashboard.isPending || !balanceAccountId}
          className="flex flex-shrink-0 items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {dashboard.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Building2 className="h-4 w-4" />
          )}
          {/* Once we know it's the merchant's own Stripe, promise less: this
              button can only send them to the sign-in page. */}
          {ownStripe ? "Open Stripe" : "Bank details & statements"}
        </button>
      </div>

      {/* Account picker — only earns its space with more than one shop. */}
      {accounts.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setAccountId(undefined)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium",
              !accountId
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 text-zinc-700 hover:bg-zinc-50",
            )}
          >
            All
          </button>
          {accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => setAccountId(a.id)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium",
                accountId === a.id
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 text-zinc-700 hover:bg-zinc-50",
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {/* Balance. Hidden entirely on "All" — summing several shops' balances
          into one number would be a figure that matches nothing. */}
      {balanceAccountId &&
        (balance?.unavailableReason ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              Balance unavailable right now — {balance.unavailableReason} Your
              payout history below is unaffected.
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              {
                label: "On its way to your bank",
                value: balance?.inTransit,
                hint: balance?.nextPayout?.arrivalDate
                  ? `Arrives ${day(balance.nextPayout.arrivalDate)}`
                  : undefined,
                accent: "text-blue-700",
              },
              {
                label: "Available",
                value: balance?.available,
                hint: "Ready for the next payout",
                accent: "text-emerald-700",
              },
              {
                label: "Pending",
                value: balance?.pending,
                hint: "Still clearing at Stripe",
                accent: "text-zinc-900",
              },
            ].map((c) => (
              <div
                key={c.label}
                className="rounded-xl border border-zinc-200 bg-white p-4"
              >
                <div className="text-xs text-zinc-500">{c.label}</div>
                <div className={cn("mt-1 text-2xl font-bold tabular-nums", c.accent)}>
                  {balanceQuery.isLoading || c.value == null ? (
                    <span className="text-zinc-300">—</span>
                  ) : (
                    money(c.value, balance?.currency)
                  )}
                </div>
                {c.hint && (
                  <div className="mt-0.5 text-[11px] text-zinc-400">{c.hint}</div>
                )}
              </div>
            ))}
          </div>
        ))}

      {/* History */}
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-4">
          <Banknote className="h-5 w-5 text-purple-500" />
          <h2 className="font-medium text-zinc-900">Payout history</h2>
        </div>

        {listQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          </div>
        ) : !accounts.length ? (
          <EmptyState
            title="No payout account set up yet"
            body="Once this location finishes Stripe onboarding, payouts will appear here."
          />
        ) : !payouts.length ? (
          <EmptyState
            title="No payouts yet"
            body="Stripe pays out on a schedule once you start taking card payments. The first one will show here automatically."
          />
        ) : (
          <div className="divide-y divide-zinc-50">
            {payouts.map((p) => (
              <PayoutLine
                key={p.id}
                p={p}
                showAccount={!accountId && accounts.length > 1}
                expanded={openPayout === p.stripePayoutId}
                onToggle={() =>
                  setOpenPayout(
                    openPayout === p.stripePayoutId ? null : p.stripePayoutId,
                  )
                }
              />
            ))}
          </div>
        )}
      </div>

      <p className="flex items-center gap-1.5 px-1 text-xs text-zinc-400">
        <ExternalLink className="h-3 w-3" />
        {ownStripe
          ? "This location uses its own Stripe account — sign in there to change its bank details."
          : "Bank details are held and verified by Stripe, not by OrderHub."}
      </p>
    </div>
  );
}

function PayoutLine({
  p,
  showAccount,
  expanded,
  onToggle,
}: {
  p: PayoutRow;
  showAccount: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const s = STATUS[p.status] ?? {
    label: p.status,
    className: "bg-zinc-100 text-zinc-600",
  };
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-zinc-50"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={cn(
              "h-4 w-4 flex-shrink-0 text-zinc-400 transition-transform",
              expanded && "rotate-90",
            )}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold tabular-nums text-zinc-900">
              {money(parseFloat(p.amount), p.currency)}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
              {showAccount && p.accountLabel && (
                <span className="font-medium text-zinc-600">{p.accountLabel}</span>
              )}
              <span>
                {p.arrivalDate
                  ? `${p.status === "PAID" ? "Paid" : "Arrives"} ${day(p.arrivalDate)}`
                  : day(p.createdAt)}
              </span>
            </div>
          </div>
        </div>
        <span
          className={cn(
            "flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
            s.className,
          )}
        >
          {s.label}
        </span>
      </button>
      {expanded && (
        <PayoutBreakdownPanel payoutId={p.stripePayoutId} accountId={p.accountId} />
      )}
    </div>
  );
}

/**
 * What this payout was made of. Fetched on expand rather than up front —
 * it's a Stripe round-trip per payout, and most rows are never opened.
 */
function PayoutBreakdownPanel({
  payoutId,
  accountId,
}: {
  payoutId: string;
  accountId: string | null;
}) {
  const q = useQuery({
    queryKey: ["payout-breakdown", payoutId],
    queryFn: () => payoutsClient.breakdown(payoutId, accountId ?? undefined),
  });

  if (q.isLoading) {
    return (
      <div className="flex justify-center border-t border-zinc-100 bg-zinc-50/60 py-6">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="border-t border-zinc-100 bg-zinc-50/60 px-5 py-4 text-xs text-zinc-500">
        Couldn&apos;t load this payout&apos;s breakdown.
      </div>
    );
  }

  const b = q.data;
  const ccy = b.currency;
  // Deductions are already negative from Stripe, so they render with their own
  // sign and the column still adds up to the payout.
  const rows: Array<{ label: string; value: number; muted?: boolean }> = [
    { label: `Sales${b.orderCount ? ` (${b.orderCount} orders)` : ""}`, value: b.sales },
    { label: "Refunds", value: b.refunds },
    { label: "Card processing (Stripe)", value: b.stripeFees },
    { label: "OrderHub commission", value: b.commission },
  ];
  if (b.other) rows.push({ label: "Other adjustments", value: b.other, muted: true });

  const orderLines = b.lines.filter((l) => l.order);

  return (
    <div className="space-y-3 border-t border-zinc-100 bg-zinc-50/60 px-5 py-4">
      <div className="space-y-1">
        {rows
          .filter((r) => r.value !== 0)
          .map((r) => (
            <div key={r.label} className="flex justify-between text-xs">
              <span className={r.muted ? "text-zinc-400" : "text-zinc-600"}>
                {r.label}
              </span>
              <span
                className={cn(
                  "tabular-nums",
                  r.value < 0 ? "text-red-600" : "text-zinc-700",
                )}
              >
                {money(r.value, ccy)}
              </span>
            </div>
          ))}
        <div className="flex justify-between border-t border-zinc-200 pt-1 text-xs font-semibold">
          <span className="text-zinc-800">Paid to your bank</span>
          <span className="tabular-nums text-zinc-900">{money(b.total, ccy)}</span>
        </div>
      </div>

      {b.truncated && (
        <p className="text-[11px] text-amber-700">
          Showing the first 100 transactions — the lines below don&apos;t add up
          to the total above.
        </p>
      )}

      {orderLines.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            Orders in this payout
          </p>
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {orderLines.map((l) => (
              <div key={l.id} className="flex justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-zinc-600">
                  {l.order?.reference ?? "Order"}
                  {l.order?.customerName ? ` · ${l.order.customerName}` : ""}
                </span>
                <span className="flex-shrink-0 tabular-nums text-zinc-700">
                  {money(l.gross, l.currency)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {orderLines.length === 0 && b.lines.length > 0 && (
        <p className="text-[11px] text-zinc-400">
          We couldn&apos;t match these transactions to orders in OrderHub — they
          may predate the integration.
        </p>
      )}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium text-zinc-700">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-500">{body}</p>
    </div>
  );
}
