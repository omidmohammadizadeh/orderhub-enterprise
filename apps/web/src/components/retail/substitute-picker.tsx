"use client";

// Retail R3 — choosing a substitute while picking.
//
// Scan the product you're putting in the bag instead (or search for it); its
// shelf price comes with it. The customer is never charged more than the item
// they ordered — the server takes the cheaper of the two — so the price shown
// here is informational.

import { useMemo, useState } from "react";
import { Repeat, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { findByBarcode, useBarcodeScanner } from "@/lib/pos/barcode-scanner";
import type { BarcodeEntry, PickSub } from "@/lib/api/retail.client";

export function SubstitutePicker({
  lineName,
  maxQty,
  index,
  money,
  onPick,
  onClose,
}: {
  lineName: string;
  /** How many of the ordered units are still unaccounted for. */
  maxQty: number;
  index: BarcodeEntry[];
  money: (n: number) => string;
  onPick: (sub: PickSub) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<BarcodeEntry | null>(null);
  const [qty, setQty] = useState(maxQty);
  const byCode = useMemo(() => new Map(index.map((e) => [e.barcode, e])), [index]);

  useBarcodeScanner(true, (code) => {
    const hit = findByBarcode(byCode, code);
    if (hit) setChosen(hit);
    else setQ(code);
  });

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return index
      .filter((e) => e.name.toLowerCase().includes(t) || e.barcode.includes(t))
      .slice(0, 8);
  }, [q, index]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Repeat className="h-4 w-4" /> Substitute for {lineName}
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-3 p-4 text-sm">
          {chosen ? (
            <div className="rounded-lg border border-zinc-900 p-3">
              <p className="font-semibold text-zinc-900">{chosen.name}</p>
              <p className="text-xs text-zinc-500">
                Shelf price {money(chosen.price)} — the customer never pays more than for {lineName}.
              </p>
              <button type="button" onClick={() => setChosen(null)} className="mt-1 text-xs font-medium text-orange-600">
                Choose another
              </button>
            </div>
          ) : (
            <>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Scan the substitute, or search"
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 focus:border-zinc-900 focus:outline-none"
              />
              <ul className="max-h-60 divide-y divide-zinc-100 overflow-y-auto">
                {results.map((e) => (
                  <li key={e.variantId}>
                    <button
                      type="button"
                      onClick={() => setChosen(e)}
                      className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left hover:bg-zinc-50"
                    >
                      <span className="truncate">{e.name}</span>
                      <span className="text-xs text-zinc-500">{money(e.price)}</span>
                    </button>
                  </li>
                ))}
                {q.trim() && results.length === 0 && (
                  <li className="py-3 text-center text-xs text-zinc-500">No product matches.</li>
                )}
              </ul>
            </>
          )}
          {maxQty > 1 && (
            <label className="flex items-center justify-between gap-3">
              <span className="text-xs text-zinc-600">How many are substituted?</span>
              <select
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                className="rounded-lg border border-zinc-200 px-2 py-1"
              >
                {Array.from({ length: maxQty }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <footer className="border-t border-zinc-200 p-4">
          <Button
            className="w-full"
            disabled={!chosen}
            onClick={() =>
              chosen &&
              onPick({
                variantId: chosen.variantId,
                menuItemId: chosen.menuItemId,
                name: chosen.name,
                qty,
                unitPrice: chosen.price,
              })
            }
          >
            Use as substitute
          </Button>
        </footer>
      </div>
    </div>
  );
}
