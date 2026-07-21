"use client";

// SMS Wallet — prepaid balance for sending payment links & marketing texts.
// Clients top up by card (Stripe Checkout); every SMS debits the balance per
// Twilio segment. This page shows the balance, a top-up panel, and a statement.

import { useState, Suspense } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import {
  Wallet as WalletIcon,
  Plus,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
} from "lucide-react";
import {
  walletClient,
  formatGbp,
  type WalletTransaction,
} from "@/lib/api/wallet.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { cn } from "@/lib/utils";

const TOPUP_PRESETS = [1000, 2000, 5000, 10000]; // £10 / £20 / £50 / £100 in pennies

function WalletInner() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const topupStatus = params.get("topup"); // success | cancel

  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const [selected, setSelected] = useState<number>(2000);
  const [custom, setCustom] = useState<string>("");

  const { data: wallet, isLoading } = useQuery({
    queryKey: ["wallet", locationId],
    queryFn: () => walletClient.get(locationId),
    // Poll briefly after a successful top-up so the credited balance shows up
    // once the Stripe webhook lands (a few seconds).
    refetchInterval: topupStatus === "success" ? 4000 : false,
  });

  const { data: txns } = useQuery({
    queryKey: ["wallet-transactions", locationId],
    queryFn: () => walletClient.transactions(50, locationId),
  });

  const topup = useMutation({
    mutationFn: (amountMinor: number) => walletClient.topup(amountMinor, locationId),
    onSuccess: ({ url }) => {
      window.location.href = url; // to Stripe Checkout
    },
  });

  const amountMinor = (() => {
    if (custom.trim()) {
      const pounds = parseFloat(custom);
      return Number.isFinite(pounds) ? Math.round(pounds * 100) : 0;
    }
    return selected;
  })();

  const rate = wallet?.pricePerSegmentMinor ?? 10;
  const approxTexts = wallet ? Math.floor(wallet.balanceMinor / rate) : 0;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
          <WalletIcon className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-zinc-900">SMS Wallet</h1>
          <p className="text-sm text-zinc-500">
            Prepaid balance for payment links & marketing texts
          </p>
        </div>
      </div>

      {topupStatus === "success" && (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="h-4 w-4" />
          Payment received — your balance updates within a few seconds.
        </div>
      )}
      {topupStatus === "cancel" && (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4" />
          Top-up cancelled — no charge was made.
        </div>
      )}

      {/* Balance + top-up */}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {/* Balance card */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Current balance
            </span>
            <button
              onClick={() => {
                qc.invalidateQueries({ queryKey: ["wallet"] });
                qc.invalidateQueries({ queryKey: ["wallet-transactions"] });
              }}
              className="text-zinc-400 hover:text-zinc-700"
              aria-label="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          {isLoading ? (
            <Loader2 className="mt-3 h-6 w-6 animate-spin text-zinc-300" />
          ) : (
            <>
              <div
                className={cn(
                  "mt-1 text-4xl font-bold",
                  wallet && wallet.lowBalance ? "text-amber-600" : "text-zinc-900",
                )}
              >
                {formatGbp(wallet?.balanceMinor ?? 0)}
              </div>
              <p className="mt-1 text-sm text-zinc-500">
                ≈ {approxTexts.toLocaleString()} texts left · {rate}p per message
                segment
              </p>
              {wallet?.lowBalance && (
                <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-amber-600">
                  <AlertTriangle className="h-4 w-4" /> Low balance — top up to keep
                  sending
                </p>
              )}
              {wallet && !wallet.smsConfigured && (
                <p className="mt-2 text-xs text-zinc-400">
                  Note: SMS sending isn’t switched on for your account yet.
                </p>
              )}
            </>
          )}
        </div>

        {/* Top-up card */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Add funds
          </span>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {TOPUP_PRESETS.map((amt) => (
              <button
                key={amt}
                onClick={() => {
                  setSelected(amt);
                  setCustom("");
                }}
                className={cn(
                  "rounded-lg border py-2 text-sm font-semibold transition",
                  !custom.trim() && selected === amt
                    ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                    : "border-zinc-200 text-zinc-700 hover:border-zinc-300",
                )}
              >
                {formatGbp(amt)}
              </button>
            ))}
          </div>
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-zinc-500">
              Or a custom amount (£)
            </label>
            <input
              type="number"
              min={5}
              step={1}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="e.g. 30"
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={() => topup.mutate(amountMinor)}
            disabled={topup.isPending || amountMinor < 500}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {topup.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Top up {formatGbp(amountMinor || 0)}
          </button>
          {amountMinor > 0 && amountMinor < 500 && (
            <p className="mt-1.5 text-xs text-red-600">Minimum top-up is £5.</p>
          )}
          {topup.isError && (
            <p className="mt-1.5 text-xs text-red-600">
              {(topup.error as any)?.response?.data?.message ??
                "Couldn’t start the top-up."}
            </p>
          )}
          <p className="mt-2 text-[11px] text-zinc-400">
            Secure card payment via Stripe. Funds are added to your SMS balance.
          </p>
        </div>
      </div>

      {/* Statement */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold text-zinc-900">Recent activity</h2>
        <div className="mt-2 overflow-hidden rounded-xl border border-zinc-200 bg-white">
          {!txns?.length ? (
            <p className="px-4 py-8 text-center text-sm text-zinc-400">
              No transactions yet. Top up to get started.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {txns.map((t) => (
                <TxnRow key={t.id} t={t} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function TxnRow({ t }: { t: WalletTransaction }) {
  const isCredit = t.amountMinor >= 0;
  const date = new Date(t.createdAt).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <li className="flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full",
            isCredit ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500",
          )}
        >
          {isCredit ? (
            <ArrowUpRight className="h-4 w-4" />
          ) : (
            <ArrowDownRight className="h-4 w-4" />
          )}
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-800">
            {t.description ?? (isCredit ? "Top-up" : "SMS")}
          </p>
          <p className="text-xs text-zinc-400">{date}</p>
        </div>
      </div>
      <div className="text-right">
        <p
          className={cn(
            "text-sm font-semibold",
            isCredit ? "text-emerald-700" : "text-zinc-700",
          )}
        >
          {isCredit ? "+" : ""}
          {formatGbp(t.amountMinor)}
        </p>
        <p className="text-xs text-zinc-400">bal {formatGbp(t.balanceAfterMinor)}</p>
      </div>
    </li>
  );
}

export default function WalletPage() {
  return (
    <Suspense fallback={null}>
      <WalletInner />
    </Suspense>
  );
}
