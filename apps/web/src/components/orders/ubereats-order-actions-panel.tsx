"use client";

// Uber Eats order adjustments — operator actions on a live Uber order:
//   • Adjust price (amount + reason) — awaits the customer's confirmation
//   • Update ready time (preset minutes)
//   • Report an item out of stock — Uber asks the customer to pick a
//     replacement / remove / cancel (resolve fulfillment issues)
// Every call surfaces its result as a toast and a row on the Logs page with
// Uber's HTTP acknowledgment.

import { useState } from "react";
import { currencySymbol } from "@orderhub/shared";
import { useMutation } from "@tanstack/react-query";
import {
  Loader2,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Clock,
  PackageX,
} from "lucide-react";
import toast from "react-hot-toast";
import { apiClient } from "@/lib/api/client";

// Uber's adjust-price reason enum (see Adjust Order Price docs).
const PRICE_REASONS: Array<{ value: string; label: string }> = [
  { value: "REQUESTED_ADD_ONS", label: "Customer requested an add-on" },
  { value: "BIGGER_SIZE", label: "Bigger size" },
  { value: "NEW_ITEM_ADDED", label: "New item added" },
  { value: "ITEM_SOLD_OUT", label: "Item sold out" },
  { value: "REMOVED_ITEM", label: "Item removed" },
  { value: "ADD_ON_UNAVAILABLE", label: "Add-on unavailable" },
  { value: "OTHER", label: "Other (explain below)" },
];

const READY_TIME_PRESETS = [10, 15, 20, 30];

export function UberEatsOrderActionsPanel({
  orderId,
  currency,
}: {
  orderId: string;
  /** The ORDER's currency, passed by the drawer — this panel never sees the
   *  order itself, and the board may be showing several locations at once. */
  currency?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Adjust-price form state.
  const [amount, setAmount] = useState("1.00");
  const [reason, setReason] = useState(PRICE_REASONS[0]!.value);
  const [customReason, setCustomReason] = useState("");

  const err = (label: string) => (e: any) =>
    toast.error(
      `${label} failed: ${e?.response?.data?.message ?? e?.message ?? "error"}`,
    );
  const okToast = (label: string, data: any) => {
    const http = data?.uberHttpStatus ?? data?.prep?.uberHttpStatus;
    toast.success(`${label} → Uber ${http ? `${http} OK` : "OK"} (see Logs)`);
  };

  const adjustPrice = useMutation({
    mutationFn: async () => {
      setBusy("adjust");
      const pounds = Number(amount);
      if (!Number.isFinite(pounds) || pounds === 0) {
        throw new Error("Enter an amount (use a negative value to reduce)");
      }
      if (reason === "OTHER" && !customReason.trim()) {
        throw new Error("A custom reason is required for 'Other'");
      }
      const res = await apiClient.post(
        `/v1/integrations/ubereats/order/${orderId}/adjust-price`,
        {
          amountPounds: pounds,
          taxRate: "20",
          reason,
          ...(reason === "OTHER" ? { customReason: customReason.trim() } : {}),
        },
      );
      return res.data;
    },
    onSuccess: (data) => okToast("Price adjustment sent to customer", data),
    onError: err("Adjust price"),
    onSettled: () => setBusy(null),
  });

  const readyTime = useMutation({
    mutationFn: async (minutes: number) => {
      setBusy(`ready-${minutes}`);
      const res = await apiClient.post(
        `/v1/integrations/ubereats/order/${orderId}/ready-time`,
        { minutesFromNow: minutes },
      );
      return { data: res.data, minutes };
    },
    onSuccess: ({ data, minutes }) =>
      okToast(`Ready time set to +${minutes} min`, data),
    onError: err("Update ready time"),
    onSettled: () => setBusy(null),
  });

  const reportOutOfStock = useMutation({
    mutationFn: async () => {
      setBusy("resolve");
      const res = await apiClient.post(
        `/v1/integrations/ubereats/order/${orderId}/resolve-fulfillment-issues`,
        {},
      );
      return res.data;
    },
    onSuccess: (data) =>
      okToast("Item reported — customer will be asked to choose", data),
    onError: err("Report out of stock"),
    onSettled: () => setBusy(null),
  });

  const anyBusy = busy !== null;

  return (
    <div className="border-b border-zinc-100 px-5 py-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-700"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Order adjustments
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          {/* ── Adjust price ─────────────────────────────── */}
          <div className="rounded-xl border border-zinc-200 bg-white p-3">
            <p className="mb-2 text-xs font-semibold text-zinc-800">
              Adjust price
            </p>
            <div className="flex items-center gap-2">
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-zinc-500">
                  {currencySymbol(currency)}
                </span>
                <input
                  type="number"
                  step="0.50"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-24 rounded-lg border border-zinc-300 bg-white py-1.5 pl-5 pr-2 text-xs focus:border-zinc-900 focus:outline-none"
                />
              </div>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
              >
                {PRICE_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            {reason === "OTHER" && (
              <input
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Explain the price change for the customer"
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
              />
            )}
            <p className="mt-1.5 text-[10px] text-zinc-400">
              Use a negative amount to reduce the price. The customer confirms
              the change on Uber.
            </p>
            <button
              onClick={() => adjustPrice.mutate()}
              disabled={anyBusy}
              className="mt-2 flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy === "adjust" && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              Send price change
            </button>
          </div>

          {/* ── Update ready time ────────────────────────── */}
          <div className="rounded-xl border border-zinc-200 bg-white p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
              <Clock className="h-3.5 w-3.5 text-zinc-400" />
              Update ready time
            </p>
            <div className="flex flex-wrap gap-1.5">
              {READY_TIME_PRESETS.map((m) => (
                <button
                  key={m}
                  onClick={() => readyTime.mutate(m)}
                  disabled={anyBusy}
                  className="flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-900 disabled:opacity-50"
                >
                  {busy === `ready-${m}` && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                  +{m} min
                </button>
              ))}
            </div>
          </div>

          {/* ── Report out of stock ──────────────────────── */}
          <div className="rounded-xl border border-zinc-200 bg-white p-3">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
              <PackageX className="h-3.5 w-3.5 text-zinc-400" />
              Item out of stock
            </p>
            <p className="mb-2 text-[10px] text-zinc-400">
              Asks the customer to pick a replacement, remove the item, or
              cancel. Their choice updates this order automatically.
            </p>
            <button
              onClick={() => reportOutOfStock.mutate()}
              disabled={anyBusy}
              className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              {busy === "resolve" && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              Report item unavailable
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
