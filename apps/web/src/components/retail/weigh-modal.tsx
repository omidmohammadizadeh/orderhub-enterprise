"use client";

// Weigh a loose product at the till: the cashier reads the scale and types the
// weight (kg for per-kg products, grams for per-100 g deli lines). The price
// follows as they type. Labels printed by a shop scale skip this entirely —
// scanning one rings up the price or weight baked into its barcode.

import { useEffect, useMemo, useState } from "react";
import { Delete, Scale, X } from "lucide-react";
import {
  formatWeight,
  isValidWeight,
  MAX_WEIGHT_GRAMS,
  priceForWeight,
  sellByLabel,
  type SellBy,
} from "@orderhub/shared";

export function WeighModal({
  name,
  pricePerUnit,
  sellBy,
  money,
  onAdd,
  onClose,
}: {
  name: string;
  pricePerUnit: number;
  sellBy: SellBy;
  money: (n: number) => string;
  onAdd: (grams: number) => void;
  onClose: () => void;
}) {
  // Per-kg produce is read off the scale in kg, deli counters in grams.
  const inKg = sellBy === "KG";
  const [entry, setEntry] = useState("");
  const grams = useMemo(() => {
    const n = Number(entry);
    if (!entry || !Number.isFinite(n)) return 0;
    return Math.round(inKg ? n * 1000 : n);
  }, [entry, inKg]);
  const valid = isValidWeight(grams);
  const price = valid ? priceForWeight(pricePerUnit, sellBy, grams) : 0;

  const press = (k: string) =>
    setEntry((cur) => {
      if (k === "⌫") return cur.slice(0, -1);
      if (k === ".") return !inKg || cur.includes(".") ? cur : (cur || "0") + ".";
      const next = cur === "0" ? k : cur + k;
      // At most 3 decimals of a kilo (a gram); nothing past the scale's range.
      if (inKg && /\.\d{4}$/.test(next)) return cur;
      const g = inKg ? Number(next) * 1000 : Number(next);
      return g > MAX_WEIGHT_GRAMS ? cur : next;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter" && valid) onAdd(grams);
      else if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "." || e.key === ",") press(".");
      else if (e.key === "Backspace") press("⌫");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, grams, onAdd, onClose]);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", inKg ? "." : "00", "0", "⌫"];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="weigh-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Scale className="h-5 w-5 text-emerald-600" aria-hidden />
            <div>
              <h2 id="weigh-title" className="text-base font-semibold text-zinc-900">
                {name}
              </h2>
              <p className="text-xs text-zinc-500">
                {money(pricePerUnit)}
                {sellByLabel(sellBy)} — read the scale
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 pt-4">
          <div className="flex items-baseline justify-between rounded-xl bg-zinc-950 px-4 py-3 text-white" aria-live="polite">
            <span className="text-3xl font-semibold tabular-nums">
              {entry || "0"}
              <span className="ml-1 text-base font-normal text-zinc-400">{inKg ? "kg" : "g"}</span>
            </span>
            <span className="text-xl font-semibold tabular-nums text-emerald-400">{valid ? money(price) : "—"}</span>
          </div>
          <p className="mt-1.5 h-4 text-[11px] text-zinc-500">
            {grams > 0 && !valid ? "Too light to sell" : valid ? formatWeight(grams) : ""}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 px-5 py-3">
          {keys.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                press(k === "00" ? "0" : k);
                if (k === "00") press("0");
              }}
              aria-label={k === "⌫" ? "Delete" : k}
              className="flex h-14 items-center justify-center rounded-xl border border-zinc-200 text-xl font-semibold text-zinc-900 hover:bg-zinc-50 active:bg-zinc-100"
            >
              {k === "⌫" ? <Delete className="h-5 w-5" aria-hidden /> : k}
            </button>
          ))}
        </div>

        <div className="px-5 pb-5">
          <button
            type="button"
            disabled={!valid}
            onClick={() => onAdd(grams)}
            className="h-12 w-full rounded-xl bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            {valid ? `Add ${formatWeight(grams)} · ${money(price)}` : "Enter the weight"}
          </button>
        </div>
      </div>
    </div>
  );
}
