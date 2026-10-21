"use client";

// Card payment while the till is offline.
//
// Our Stripe reader charge is driven from the server, so with no connection
// the till cannot charge a card itself. What a shop CAN do is take the card on
// its own card machine — one with its own SIM, or a machine in its offline
// mode — and tell the till it went through. This modal is that confirmation:
// the order only counts as paid once the operator says the machine showed
// APPROVED, and until then it waits in "Waiting for payment" exactly as an
// unpaid card order does online.

import { useEffect, useState } from "react";
import { CreditCard, Loader2, WifiOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";

export function OfflineCardModal({
  open,
  amount,
  reference,
  onApproved,
  onPayCash,
  onCancelSale,
  onClose,
}: {
  open: boolean;
  /** What's owed, in the location's currency. */
  amount: number;
  /** The offline ticket reference, e.g. "OFF-7F3A". */
  reference: string;
  onApproved: () => Promise<void>;
  onPayCash: () => void;
  onCancelSale: () => Promise<void>;
  onClose: () => void;
}) {
  const { money } = useCurrency();
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(null);
      setError(null);
    }
  }, [open, reference]);

  if (!open) return null;

  const run = async (kind: "approve" | "cancel", fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong — try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="offline-card-title"
      className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4"
    >
      <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2
            id="offline-card-title"
            className="flex items-center gap-2 text-base font-semibold text-zinc-900"
          >
            <CreditCard className="h-4 w-4" /> Card payment (offline)
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="text-center">
            <p className="text-xs uppercase tracking-wide text-zinc-500">Key into your card machine</p>
            <p className="mt-1 text-4xl font-bold tabular-nums text-zinc-900">{money(amount)}</p>
            <p className="mt-1 text-xs text-zinc-500">Order {reference}</p>
          </div>

          <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            This till is offline, so it can&apos;t charge the card itself. Only tap
            Approved once your card machine shows APPROVED.
          </p>

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
              {error}
            </p>
          )}

          <Button
            className="h-12 w-full text-base"
            disabled={busy !== null}
            onClick={() => run("approve", onApproved)}
          >
            {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Approved on the machine"}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={busy !== null} onClick={onPayCash}>
              Pay cash instead
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => run("cancel", onCancelSale)}
            >
              {busy === "cancel" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Cancel sale"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
