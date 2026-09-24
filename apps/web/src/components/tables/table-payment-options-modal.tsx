"use client";

// Payment options for QR-at-table ordering, per location.
//
// Two ways to run it, and the difference is whether food can leave the
// kitchen before the money arrives:
//
//   PAY_LATER — a scanned round joins the table's tab and staff settle it
//               at the end. What every table did before this existed.
//   PAY_NOW   — the guest pays on their phone (Apple Pay / Google Pay /
//               card) first, and only a paid basket reaches the kitchen.
//               Each paid basket is its own ticket, stamped with the table.
//
// Owner-level, like the dine-in toggle itself: the API refuses
// settings.tableService writes from a MANAGER, so showing this to one
// would only collect 403s.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { CreditCard, Check, X, AlertTriangle } from "lucide-react";
import { usesTap } from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";

export type TableQrPaymentMode = "PAY_LATER" | "PAY_NOW";

const OPTIONS: Array<{
  value: TableQrPaymentMode;
  title: string;
  blurb: string;
  detail: string;
}> = [
  {
    value: "PAY_LATER",
    title: "Send to the kitchen without paying",
    blurb: "Guests order, you settle the table at the end.",
    detail:
      "Every scanned round joins the table's tab and goes straight to the kitchen. Staff take payment when the party asks for the bill, exactly as they do for a waiter round.",
  },
  {
    value: "PAY_NOW",
    title: "Take payment before the kitchen starts",
    blurb: "Apple Pay, Google Pay or card on the guest's phone.",
    detail:
      "Nothing is cooked until the money arrives. Each paid basket lands on the Orders board and the kitchen screen as its own ticket with the table number on it — the way Nando's runs it.",
  },
];

export function TablePaymentOptionsModal({
  locationId,
  settings,
  country,
  onClose,
}: {
  locationId: string;
  /** The whole Location.settings blob — both levels get spread on save. */
  settings: Record<string, any> | null | undefined;
  /** Decides whether cards at the table are even possible here. */
  country?: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const current: TableQrPaymentMode =
    (settings as any)?.tableService?.qrPayment === "PAY_NOW"
      ? "PAY_NOW"
      : "PAY_LATER";
  const [choice, setChoice] = useState<TableQrPaymentMode>(current);

  // Gulf shops are paid through Tap, which is hosted-redirect only — there
  // is no on-page wallet sheet to put on a diner's phone. Say so here
  // rather than letting an operator switch it on and discover it at a
  // table on a Friday night. The API refuses the checkout call too.
  const gulf = usesTap(country);

  // Escape closes, like every other dialog on a manager's keyboard expects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = useMutation({
    // The locations PATCH shallow-merges the TOP level of settings only, so
    // sending a bare `{ tableService: { qrPayment } }` would replace the
    // whole tableService object and wipe `enabled` and `areas` with it.
    // Spread both levels.
    mutationFn: (mode: TableQrPaymentMode) => {
      const all = (settings ?? {}) as Record<string, any>;
      const ts = (all.tableService ?? {}) as Record<string, any>;
      return locationsClient.update(locationId, {
        settings: { ...all, tableService: { ...ts, qrPayment: mode } },
      } as any);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["location", locationId] });
      qc.invalidateQueries({ queryKey: queryKeys.locationDetail(locationId) });
      toast.success("Payment option saved");
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't save"),
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="table-payment-options-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-3">
          <div>
            <h2
              id="table-payment-options-title"
              className="flex items-center gap-2 text-base font-semibold text-zinc-900"
            >
              <CreditCard className="h-4 w-4" /> Payment options
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              How guests pay when they scan a table QR code.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <fieldset className="space-y-3 p-5">
          <legend className="sr-only">QR ordering payment option</legend>
          {OPTIONS.map((opt) => {
            const disabled = opt.value === "PAY_NOW" && gulf;
            const active = choice === opt.value;
            return (
              <label
                key={opt.value}
                className={[
                  "flex cursor-pointer gap-3 rounded-lg border p-4 transition",
                  active
                    ? "border-zinc-900 bg-zinc-50"
                    : "border-zinc-200 hover:border-zinc-300",
                  disabled ? "cursor-not-allowed opacity-50" : "",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="qrPayment"
                  className="mt-1 h-4 w-4 accent-zinc-900"
                  value={opt.value}
                  checked={active}
                  disabled={disabled}
                  onChange={() => setChoice(opt.value)}
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-zinc-900">
                    {opt.title}
                    {opt.value === current && (
                      <span className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                        <Check className="h-3 w-3" /> Current
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs font-medium text-zinc-600">
                    {opt.blurb}
                  </span>
                  <span className="mt-2 block text-xs leading-relaxed text-zinc-500">
                    {opt.detail}
                  </span>
                </span>
              </label>
            );
          })}

          {gulf && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                Paying at the table isn&rsquo;t available in this country yet —
                card payments here go through Tap, which needs its own hosted
                page rather than the wallet sheet a guest&rsquo;s phone shows.
              </span>
            </p>
          )}

          {choice === "PAY_NOW" && !gulf && (
            <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-600">
              The money goes to this shop&rsquo;s own Stripe account, like every
              other card you take. If Stripe onboarding isn&rsquo;t finished,
              guests are told to order with a member of staff instead of being
              left on a dead payment screen.
            </p>
          )}
        </fieldset>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate(choice)}
            loading={save.isPending}
            disabled={choice === current}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
