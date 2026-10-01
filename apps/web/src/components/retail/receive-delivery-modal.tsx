"use client";

// R2-lite — goods in. Scan everything off the delivery; each scan adds one
// (a case of 24 is "scan once, set 24"). Booked as one batch so a delivery is
// either fully in the books or not at all.
//
// Weighed products (loose veg, deli) are stocked in grams and usually have no
// barcode: they're found by name and received in kilograms.

import { useEffect, useMemo, useState } from "react";
import { formatWeight } from "@orderhub/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Minus, Plus, Truck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { findByBarcode, useBarcodeScanner } from "@/lib/pos/barcode-scanner";
import { retailClient, type BarcodeEntry } from "@/lib/api/retail.client";

interface Line {
  entry: BarcodeEntry;
  quantity: number;
}

export function ReceiveDeliveryModal({
  locationId,
  onClose,
  onDone,
}: {
  locationId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState("");
  const index = useQuery({
    queryKey: ["retail-barcodes", locationId],
    queryFn: () => retailClient.barcodes(locationId),
    staleTime: 60_000,
  });
  const byCode = useMemo(() => new Map((index.data ?? []).map((e) => [e.barcode, e])), [index.data]);
  // Weighed products with no barcode aren't in the scan index; find them by name.
  const products = useQuery({
    queryKey: ["retail-products", locationId, "receive"],
    queryFn: () => retailClient.products(locationId),
    staleTime: 60_000,
  });
  const pool = useMemo(() => {
    const inIndex = new Set((index.data ?? []).map((e) => e.variantId));
    const weighed: BarcodeEntry[] = [];
    for (const p of products.data?.products ?? []) {
      if (!p.sellBy) continue;
      for (const v of p.variants) {
        if (!v.isActive || inIndex.has(v.id)) continue;
        weighed.push({
          barcode: "",
          variantId: v.id,
          menuItemId: p.id,
          name: p.variants.length > 1 ? `${p.name} — ${v.name}` : p.name,
          productName: p.name,
          variantName: v.name,
          price: v.price ?? p.basePrice,
          sku: v.sku,
          sellBy: p.sellBy,
        });
      }
    }
    return [...(index.data ?? []), ...weighed];
  }, [index.data, products.data]);

  // A weighed line starts at 1 kg and steps in kilos; everything else in ones.
  const step = (entry: BarcodeEntry) => (entry.sellBy ? 1000 : 1);
  const add = (entry: BarcodeEntry, n = step(entry)) =>
    setLines((prev) => {
      const at = prev.findIndex((l) => l.entry.variantId === entry.variantId);
      if (at < 0) return [{ entry, quantity: n }, ...prev];
      const next = [...prev];
      next[at] = { ...next[at]!, quantity: next[at]!.quantity + n };
      return next;
    });
  const setQty = (variantId: string, quantity: number) =>
    setLines((prev) =>
      prev
        .map((l) => (l.entry.variantId === variantId ? { ...l, quantity } : l))
        .filter((l) => l.quantity > 0),
    );

  useBarcodeScanner(true, (code) => {
    const hit = findByBarcode(byCode, code);
    if (hit) add(hit);
    else toast.error(`${code} isn't a product here yet — add it first`);
  });

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return pool.filter((e) => e.name.toLowerCase().includes(t) || (!!e.barcode && e.barcode.includes(t))).slice(0, 6);
  }, [q, pool]);

  const units = lines.reduce((s, l) => s + (l.entry.sellBy ? 0 : l.quantity), 0);
  const grams = lines.reduce((s, l) => s + (l.entry.sellBy ? l.quantity : 0), 0);
  const save = useMutation({
    mutationFn: () =>
      retailClient.receive(locationId, {
        reference: reference.trim() || undefined,
        lines: lines.map((l) => ({ variantId: l.entry.variantId, quantity: l.quantity })),
      }),
    onSuccess: (r) => {
      toast.success(`Delivery booked across ${r.lines} product${r.lines === 1 ? "" : "s"}`);
      onDone();
      onClose();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? "Couldn't book the delivery"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Truck className="h-4 w-4" /> Receive a delivery
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Supplier / delivery note (optional)
            </span>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. Booker 4471"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2"
            />
          </label>
          <div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              // A scanner typing into this box ends with Enter.
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const hit = findByBarcode(byCode, q);
                if (hit) {
                  e.preventDefault();
                  add(hit);
                  setQ("");
                }
              }}
              placeholder="Scan each item — or search"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 focus:border-zinc-900 focus:outline-none"
            />
            {results.length > 0 && (
              <ul className="mt-1 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
                {results.map((e) => (
                  <li key={e.variantId}>
                    <button
                      type="button"
                      onClick={() => {
                        add(e);
                        setQ("");
                      }}
                      className="w-full px-3 py-2 text-left hover:bg-zinc-50"
                    >
                      {e.name}
                      {e.sellBy && <span className="ml-1 text-[11px] text-zinc-500">· by weight</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {lines.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-xs text-zinc-500">
              Scan the first item. Each scan adds one; change the number for a whole case.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
              {lines.map((l) => (
                <li key={l.entry.variantId} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate">{l.entry.name}</span>
                  {l.entry.sellBy ? (
                    <KiloInput
                      grams={l.quantity}
                      label={l.entry.name}
                      onChange={(g) => setQty(l.entry.variantId, g)}
                    />
                  ) : (
                    <>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`One fewer ${l.entry.name}`}
                        onClick={() => setQty(l.entry.variantId, l.quantity - 1)}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <input
                        value={l.quantity}
                        inputMode="numeric"
                        aria-label={`Quantity of ${l.entry.name}`}
                        onChange={(e) => setQty(l.entry.variantId, Number(e.target.value.replace(/\D/g, "")) || 0)}
                        className="w-14 rounded-md border border-zinc-200 px-2 py-1 text-center tabular-nums"
                      />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`One more ${l.entry.name}`}
                        onClick={() => setQty(l.entry.variantId, l.quantity + 1)}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="border-t border-zinc-200 p-4">
          <Button className="w-full" disabled={!units && !grams} loading={save.isPending} onClick={() => save.mutate()}>
            Book{" "}
            {[units ? `${units} item${units === 1 ? "" : "s"}` : "", grams ? formatWeight(grams) : ""]
              .filter(Boolean)
              .join(" and ")}{" "}
            into stock
          </Button>
        </footer>
      </div>
    </div>
  );
}

/** Kilograms in, grams stored; commits on blur so "1." can be typed. Empty or 0 removes the line. */
function KiloInput({ grams, label, onChange }: { grams: number; label: string; onChange: (grams: number) => void }) {
  const [text, setText] = useState(String(grams / 1000));
  useEffect(() => setText(String(grams / 1000)), [grams]);
  const commit = () => {
    const kg = Number(text.replace(",", "."));
    onChange(Number.isFinite(kg) && kg > 0 ? Math.round(kg * 1000) : 0);
  };
  return (
    <label className="flex items-center gap-1">
      <input
        value={text}
        inputMode="decimal"
        aria-label={`Kilograms of ${label}`}
        onChange={(e) => setText(e.target.value.replace(/[^0-9.,]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        className="w-16 rounded-md border border-zinc-200 px-2 py-1 text-right tabular-nums"
      />
      <span className="text-xs text-zinc-500">kg</span>
    </label>
  );
}
