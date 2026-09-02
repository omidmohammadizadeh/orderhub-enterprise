"use client";

// "Ask for the price at the till" — the amount prompt.
//
// For the thing a customer asks for that is not on the menu: a party tray, a
// one-off special, a replacement for an order that went wrong. The operator
// types what they are charging and it goes on as an ordinary line.
//
// Deliberately its own small dialog rather than an inline field: this is the
// one number on the ticket nobody can check afterwards, so it gets the
// operator's full attention and an explicit confirm.

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export function OpenPriceModal({
  open,
  itemName,
  money,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  itemName: string;
  /** Bound to the location's currency by the caller — never format here. */
  money: (n: number) => string;
  onCancel: () => void;
  onConfirm: (price: number) => void;
}) {
  const [raw, setRaw] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setRaw("");
      // A till is used at speed with one hand — the keyboard should already
      // be in the field.
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!open) return null;

  const value = Number(raw);
  // Zero is refused as well as blank: a £0.00 line is almost always a
  // mis-key, and giving something away should be a discount, which is
  // recorded, rather than a free item that is not.
  const valid = Number.isFinite(value) && value > 0;

  const submit = () => {
    if (valid) onConfirm(Math.round(value * 100) / 100);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 p-4">
          <h2 className="text-base font-semibold text-zinc-900">Price</h2>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label="Cancel"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4">
          <p className="mb-3 text-sm text-zinc-500">
            What are you charging for{" "}
            <span className="font-medium text-zinc-900">{itemName}</span>?
          </p>
          <input
            ref={inputRef}
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onCancel();
            }}
            placeholder="0.00"
            className="w-full rounded-lg border border-zinc-300 px-3 py-3 text-2xl font-semibold tabular-nums focus:border-zinc-900 focus:outline-none"
          />
          {valid && (
            <p className="mt-2 text-xs text-zinc-500">
              Adds as {money(Math.round(value * 100) / 100)}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={onCancel}
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
