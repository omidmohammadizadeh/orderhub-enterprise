"use client";

// Wallet — prepaid balance the shop spends on texts, AI phone calls and
// courier dispatch. Named plainly because it stopped being SMS-only.
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
  type WalletSummary,
} from "@/lib/api/wallet.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";

const TOPUP_PRESETS = [1000, 2000, 5000, 10000]; // £10 / £20 / £50 / £100 in pennies

function WalletInner() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const topupStatus = params.get("topup"); // success | cancel

  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const isAdmin = useAuthStore((s) => s.user)?.role === "PLATFORM_ADMIN";
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
          <h1 className="text-xl font-bold text-zinc-900">Wallet</h1>
          <p className="text-sm text-zinc-500">
            Prepaid balance for AI phone calls, payment links &amp; texts
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
              {/* Calls first: an empty wallet stops the phone being answered,
                  which is the expensive failure. Texts merely queue up. */}
              {wallet?.callsRemaining != null && (
                <p className="mt-1 text-sm font-medium text-zinc-700">
                  ≈ {wallet.callsRemaining.toLocaleString()} AI phone call
                  {wallet.callsRemaining === 1 ? "" : "s"} left ·{" "}
                  {wallet.voicePricePerCallMinor}p per answered call
                </p>
              )}
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
            Secure card payment via Stripe. Your card is kept on file so automatic
            top-up can use it later.
          </p>
        </div>
      </div>

      <AutoTopupCard wallet={wallet} locationId={locationId} />
      {isAdmin && <VoicePriceCard wallet={wallet} locationId={locationId} />}

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

/**
 * Automatic top-up.
 *
 * An empty wallet means the AI stops answering the phone — silently, at the
 * busiest hour, and the shop finds out on Monday from a customer. The backend
 * has had this since the wallet was built; nothing in the dashboard ever
 * called it, so every shop was one quiet evening away from that.
 */
function AutoTopupCard({
  wallet,
  locationId,
}: {
  wallet?: WalletSummary;
  locationId?: string | null;
}) {
  const qc = useQueryClient();
  const auto = wallet?.autoTopup;
  const [threshold, setThreshold] = useState<string>("");
  const [amount, setAmount] = useState<string>("");

  const save = useMutation({
    mutationFn: (input: {
      enabled: boolean;
      thresholdMinor?: number;
      amountMinor?: number;
    }) => walletClient.setAutoTopup(input, locationId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["wallet"] });
      setThreshold("");
      setAmount("");
    },
  });

  if (!wallet || !auto) return null;

  const pounds = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100) : undefined;
  };
  const thresholdMinor = threshold.trim() ? pounds(threshold) : auto.thresholdMinor;
  const amountMinor = amount.trim() ? pounds(amount) : auto.amountMinor;
  const dirty = threshold.trim() !== "" || amount.trim() !== "";

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Automatic top-up</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Refills the balance from your saved card so the phone keeps being
            answered out of hours.
          </p>
        </div>
        <button
          onClick={() =>
            save.mutate({
              enabled: !auto.enabled,
              thresholdMinor: auto.thresholdMinor,
              amountMinor: auto.amountMinor,
            })
          }
          disabled={save.isPending || (!auto.enabled && !auto.cardOnFile)}
          className={cn(
            "shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:opacity-50",
            auto.enabled
              ? "border border-zinc-300 text-zinc-700 hover:bg-zinc-50"
              : "bg-emerald-600 text-white hover:bg-emerald-700",
          )}
        >
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : auto.enabled ? (
            "Turn off"
          ) : (
            "Turn on"
          )}
        </button>
      </div>

      {/* No card, no auto top-up — say so instead of failing on the button. */}
      {!auto.cardOnFile && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          No card saved yet. Top up once above and the card is kept on file, then
          this can be switched on.
        </p>
      )}

      {/* A declined card is the quiet killer: everything looks fine until the
          phone stops being answered. It has to reach the screen. */}
      {auto.failedAt && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Last automatic top-up failed
          {auto.failureReason ? ` (${auto.failureReason})` : ""}. Top up by hand
          to save a working card, or the line stops when this balance runs out.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">
            Top up when the balance falls below (£)
          </label>
          <input
            type="number"
            min={0}
            step={1}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder={(auto.thresholdMinor / 100).toFixed(2)}
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">
            Add this much each time (£)
          </label>
          <input
            type="number"
            min={5}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={(auto.amountMinor / 100).toFixed(2)}
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() =>
            save.mutate({ enabled: auto.enabled, thresholdMinor, amountMinor })
          }
          disabled={save.isPending || !dirty}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          Save
        </button>
        <p className="text-xs text-zinc-500">
          {auto.enabled
            ? `On — refills ${formatGbp(auto.amountMinor)} whenever the balance drops below ${formatGbp(auto.thresholdMinor)}.`
            : "Off — the line stops being answered when the balance runs out."}
        </p>
      </div>
      {save.isError && (
        <p className="mt-2 text-xs text-red-600">
          {(save.error as any)?.response?.data?.message ??
            "Couldn’t save those settings."}
        </p>
      )}
    </div>
  );
}

/**
 * What this shop pays for an answered AI call. Platform admin only — a shop
 * reading its own price is fine, a shop setting it is not. Until now the
 * agreed founding rate lived in somebody's memory and a database update.
 */
function VoicePriceCard({
  wallet,
  locationId,
}: {
  wallet?: WalletSummary;
  locationId?: string | null;
}) {
  const qc = useQueryClient();
  const [price, setPrice] = useState<string>("");

  const save = useMutation({
    mutationFn: (pence: number | null) =>
      walletClient.setVoicePrice(pence, locationId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["wallet"] });
      setPrice("");
    },
  });

  if (!wallet) return null;

  return (
    <div className="mt-4 rounded-xl border border-dashed border-violet-300 bg-violet-50/50 p-5">
      <h2 className="text-sm font-semibold text-violet-900">
        Call price for this shop
        <span className="ml-2 rounded bg-violet-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-800">
          Admin
        </span>
      </h2>
      <p className="mt-0.5 text-xs text-violet-800">
        Currently {wallet.voicePricePerCallMinor}p per answered call. In PENCE —
        100 is £1. Leave blank and save to put them back on the standard rate.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="number"
          min={0}
          step={1}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder={String(wallet.voicePricePerCallMinor)}
          className="w-32 rounded-md border border-violet-300 px-3 py-2 text-sm"
        />
        <button
          onClick={() =>
            save.mutate(price.trim() === "" ? null : Math.round(Number(price)))
          }
          disabled={save.isPending}
          className="rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
        >
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Set price"
          )}
        </button>
      </div>
      {save.isError && (
        <p className="mt-2 text-xs text-red-600">
          {(save.error as any)?.response?.data?.message ??
            "Couldn’t set that price."}
        </p>
      )}
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
