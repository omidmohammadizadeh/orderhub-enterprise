"use client";

// Retail — choosing how much of a loose product to buy online.
//
// The shopper picks an amount from the shop's steps (500 g, 1 kg…). What they
// pay is an estimate: the picker weighs it and anything that comes in light
// is refunded; heavier costs nothing more. Saying so up front is the point —
// nobody likes a surprise on a weighed line.

import { useEffect, useState } from "react";
import { Minus, Plus, Scale, X } from "lucide-react";
import { formatWeight, onlineWeightOptions, priceForWeight, sellByLabel, type SellBy } from "@orderhub/shared";

export function WeightSheet({
  name,
  pricePerUnit,
  sellBy,
  percentageOff,
  money,
  onAdd,
  onClose,
}: {
  name: string;
  /** Per kg / per 100 g, before any item promo. */
  pricePerUnit: number;
  sellBy: SellBy;
  percentageOff?: number;
  money: (n: number) => string;
  onAdd: (grams: number, unitPrice: number, quantity: number) => void;
  onClose: () => void;
}) {
  const options = onlineWeightOptions(sellBy);
  const [grams, setGrams] = useState(options[Math.min(1, options.length - 1)]!);
  const [qty, setQty] = useState(1);
  // Same promo arithmetic the checkout re-prices with.
  const base = priceForWeight(pricePerUnit, sellBy, grams);
  const unit = percentageOff ? Math.round(base * (1 - percentageOff / 100) * 100) / 100 : base;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="weight-sheet-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="weight-sheet-title" className="text-lg font-bold text-zinc-900">
              {name}
            </h2>
            <p className="text-sm text-zinc-500">
              {money(pricePerUnit)}
              {sellByLabel(sellBy)}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">How much?</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="How much">
          {options.map((g) => {
            const on = g === grams;
            return (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setGrams(g)}
                className={`min-h-11 rounded-lg border px-2 text-sm font-semibold tabular-nums ${
                  on ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 text-zinc-800 hover:border-zinc-400"
                }`}
              >
                {formatWeight(g)}
              </button>
            );
          })}
        </div>

        <p className="mt-3 flex gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900">
          <Scale className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Weighed when we pick it. If it comes in lighter we refund the difference; heavier costs you nothing extra.
          </span>
        </p>

        <div className="mt-4 flex items-center gap-3">
          <div className="flex items-center rounded-lg border border-zinc-200">
            <button
              type="button"
              aria-label="One fewer"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="grid h-11 w-11 place-items-center text-zinc-700"
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-6 text-center text-sm font-semibold tabular-nums" aria-live="polite">
              {qty}
            </span>
            <button
              type="button"
              aria-label="One more"
              onClick={() => setQty((q) => Math.min(20, q + 1))}
              className="grid h-11 w-11 place-items-center text-zinc-700"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => onAdd(grams, unit, qty)}
            className="h-11 flex-1 rounded-lg bg-orange-500 text-sm font-semibold text-white hover:bg-orange-600"
          >
            Add {qty > 1 ? `${qty} × ` : ""}
            {formatWeight(grams)} · {money(unit * qty)}
          </button>
        </div>
      </div>
    </div>
  );
}
