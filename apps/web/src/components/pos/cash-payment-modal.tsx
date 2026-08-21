"use client";

// Settle an order in cash at the counter.
//
// Built for phone collection orders, which are placed as "pay on collection"
// because the customer isn't in the shop yet and cash-vs-card at that point is
// a guess. When they arrive, staff take the money here: enter what was handed
// over, the change is worked out, the order flips to PAID and the drawer pops.
//
// Quick-tender buttons sit above the keypad because that's what a counter
// actually needs — most cash is a round note, and "exact" is the single most
// common case of all. The keypad is there for the rest.
//
// The drawer only opens inside the tablet app (it's wired to the receipt
// printer's DK port), so on a desktop the payment still completes and the
// drawer failure is reported without blocking it — refusing to record money
// the shop has physically taken would be worse than a drawer that didn't pop.

import { useEffect, useMemo, useState } from "react";
import { Banknote, Delete, Loader2, X } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { openCashDrawerViaBridge } from "@/lib/printing/print-order";

/** Notes and coins a UK counter actually reaches for. */
const TENDER_PRESETS = [5, 10, 20, 50];

export function CashPaymentModal({
  open,
  orderId,
  locationId,
  amount,
  onClose,
  onPaid,
}: {
  open: boolean;
  orderId: string | null;
  locationId: string | null;
  /** What's owed, in pounds. */
  amount: number;
  onClose: () => void;
  onPaid?: () => void;
}) {
  // Held as a digit string in PENCE so the keypad behaves like a till: every
  // press shifts a digit in from the right. Parsing a decimal on each press
  // instead makes "1", "1.", "1.0" ambiguous and mishandles leading zeros.
  const [pence, setPence] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ change: number } | null>(null);

  const tendered = useMemo(() => Number(pence || "0") / 100, [pence]);
  const change = useMemo(
    () => Math.round((tendered - amount) * 100) / 100,
    [tendered, amount],
  );
  const short = tendered > 0 && tendered < amount;

  // Reset every time it opens, or when it is handed a different order.
  //
  // The component returns null while closed but stays MOUNTED, so `pence` and
  // `done` survived between openings: after settling one sale the next order
  // opened straight onto the previous one's "Paid in cash / Change due £0.00"
  // screen with no keypad, and the operator could not take the money. Fixed
  // here rather than with a `key` at the call site so the Orders-board drawer
  // gets the same repair.
  useEffect(() => {
    if (open) {
      setPence("");
      setDone(null);
      setSaving(false);
    }
  }, [open, orderId]);

  if (!open || !orderId) return null;

  const press = (d: string) => setPence((p) => (p + d).replace(/^0+/, "").slice(0, 7));
  const backspace = () => setPence((p) => p.slice(0, -1));
  const setPounds = (v: number) => setPence(String(Math.round(v * 100)));

  const settle = async (tenderedGbp: number) => {
    setSaving(true);
    try {
      await apiClient.patch(`/v1/orders/${orderId}/payment-status`, {
        paymentStatus: "PAID",
        paymentMethod: "CASH",
      });
      const due = Math.round((tenderedGbp - amount) * 100) / 100;
      setDone({ change: Math.max(0, due) });
      onPaid?.();
      // Deliberately after the order is marked paid, and deliberately not
      // awaited into the failure path: the money is recorded either way.
      if (locationId) {
        openCashDrawerViaBridge(locationId).catch((e: any) =>
          toast(e?.message ?? "Couldn't open the cash drawer", { icon: "⚠️" }),
        );
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't record the payment");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <Banknote className="h-4 w-4" /> Take cash payment
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        {done ? (
          <div className="space-y-4 p-6 text-center">
            <p className="text-sm font-medium text-emerald-700">Paid in cash</p>
            <div className="rounded-lg bg-zinc-900 px-4 py-5 text-white">
              <p className="text-xs uppercase tracking-wide text-zinc-400">
                Change due
              </p>
              <p className="text-4xl font-bold tabular-nums">
                £{done.change.toFixed(2)}
              </p>
            </div>
            <Button
              onClick={onClose}
              className="w-full bg-zinc-900 py-3 text-white hover:bg-zinc-800"
            >
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            <div className="text-center">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                Total due
              </p>
              <p className="text-3xl font-bold text-zinc-900">
                £{amount.toFixed(2)}
              </p>
            </div>

            <div>
              <div className="rounded-lg border border-zinc-200 px-3 py-2 text-right">
                <p className="text-[11px] text-zinc-500">Cash received</p>
                <p className="text-2xl font-semibold tabular-nums text-zinc-900">
                  £{tendered.toFixed(2)}
                </p>
              </div>
              <p
                className={`mt-1 text-center text-sm font-medium ${
                  short ? "text-red-600" : "text-emerald-700"
                }`}
              >
                {tendered === 0
                  ? " "
                  : short
                    ? `£${(amount - tendered).toFixed(2)} short`
                    : `Change £${change.toFixed(2)}`}
              </p>
            </div>

            {/* Quick tender — exact first, it's the most common by far. */}
            <div className="grid grid-cols-5 gap-1.5">
              <button
                onClick={() => setPounds(amount)}
                className="rounded-md border border-zinc-300 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50"
              >
                Exact
              </button>
              {TENDER_PRESETS.map((v) => (
                <button
                  key={v}
                  onClick={() => setPounds(v)}
                  className="rounded-md border border-zinc-300 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50"
                >
                  £{v}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0"].map((d) => (
                <button
                  key={d}
                  onClick={() => press(d)}
                  className="rounded-md border border-zinc-200 py-3 text-lg font-semibold text-zinc-900 hover:bg-zinc-50"
                >
                  {d}
                </button>
              ))}
              <button
                onClick={backspace}
                aria-label="Delete"
                className="grid place-items-center rounded-md border border-zinc-200 py-3 text-zinc-600 hover:bg-zinc-50"
              >
                <Delete className="h-5 w-5" />
              </button>
            </div>

            <Button
              onClick={() => settle(tendered)}
              disabled={saving || tendered < amount}
              className="w-full bg-emerald-600 py-3 text-white hover:bg-emerald-700"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                `Mark paid — £${(tendered || amount).toFixed(2)} received`
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
