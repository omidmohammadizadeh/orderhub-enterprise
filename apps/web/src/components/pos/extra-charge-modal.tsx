"use client";

// "Extra charge" — pricing something that isn't on the menu.
//
// A customer asks for a birthday cake, a delivery to the next village, a
// crate of drinks for a party. There is no menu row for it and there should
// not be: a menu row is a thing customers browse, and a £0.00 tile that staff
// are meant to overtype is one mis-tap from a free order online.
//
// So it lives at the till instead. The operator types what they agreed with
// the customer and it goes on the cart as a line like any other — priced,
// printed, taxed and reported the same way.

import { useEffect, useRef, useState } from "react";
import { X, CirclePlus } from "lucide-react";

export function ExtraChargeModal({
  open,
  money,
  onClose,
  onAdd,
}: {
  open: boolean;
  /** Formats in the location's own currency — never assume pounds. */
  money: (n: number) => string;
  onClose: () => void;
  onAdd: (charge: { amount: number; description: string }) => void;
}) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setAmount("");
    setDescription("");
    // Focus the amount so a till with a keyboard can type straight into it.
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const value = Number(amount);
  // A zero or negative charge is a mistake, not a discount — discounts have
  // their own path, and letting one through here would silently reduce a bill
  // with nothing on the ticket to explain it.
  const valid = Number.isFinite(value) && value > 0;

  const submit = () => {
    if (!valid) return;
    onAdd({
      amount: Math.round(value * 100) / 100,
      description: description.trim(),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <CirclePlus className="h-4 w-4" /> Extra charge
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <p className="text-sm text-zinc-500">
            For something the customer asked for that isn&apos;t on the menu.
            It goes on this order only — nothing is added to the menu and
            customers never see it.
          </p>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600">
              Amount
            </label>
            <input
              ref={inputRef}
              // decimal, not number: a numeric keypad on the tablet, and no
              // scroll-wheel nudging the price while the operator reads it.
              inputMode="decimal"
              value={amount}
              onChange={(e) =>
                setAmount(e.target.value.replace(/[^\d.]/g, "").slice(0, 8))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="0.00"
              className="w-full rounded-lg border border-zinc-300 px-3 py-3 text-2xl font-semibold tabular-nums focus:border-zinc-900 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600">
              What is it for? <span className="text-zinc-400">(optional)</span>
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 60))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="e.g. birthday cake, long-distance delivery"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-zinc-400">
              Prints on the kitchen ticket and the receipt, so the customer and
              the kitchen both know what they are paying for.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-zinc-100 p-5">
          <span className="text-sm text-zinc-500">
            {valid ? money(Math.round(value * 100) / 100) : "—"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!valid}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
            >
              Add to order
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
