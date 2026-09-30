"use client";

// Retail R1 — add one product from the shop floor: scan it, name it, price
// it, count it. Goes through the same import path as a spreadsheet row, so a
// product added here and one imported later with the same barcode are the
// same product.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { PackagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retailClient } from "@/lib/api/retail.client";

export function NewProductModal({
  locationId,
  initialBarcode,
  onClose,
  onDone,
}: {
  locationId: string;
  initialBarcode?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [barcode, setBarcode] = useState(initialBarcode ?? "");
  const [category, setCategory] = useState("");
  const [stock, setStock] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const r = await retailClient.importRows(locationId, [
        {
          Name: name.trim(),
          Price: price,
          Barcode: barcode.trim(),
          Category: category.trim(),
          Stock: stock,
        },
      ]);
      if (r.errors.length) throw new Error(r.errors[0]!.message);
      return r;
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  const valid = name.trim() && price.trim() && Number.isFinite(Number(price)) && Number(price) >= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <form
        className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <PackagePlus className="h-4 w-4" /> New product
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-3 p-4 text-sm">
          <Field label="Barcode">
            <input
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
              autoFocus={!initialBarcode}
              placeholder="Scan it"
              inputMode="numeric"
              autoComplete="off"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 font-mono"
            />
          </Field>
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus={!!initialBarcode}
              placeholder="e.g. Coca-Cola 330ml"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price">
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
                inputMode="decimal"
                placeholder="1.25"
                className="w-full rounded-lg border border-zinc-200 px-3 py-2"
              />
            </Field>
            <Field label="In stock">
              <input
                value={stock}
                onChange={(e) => setStock(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                placeholder="0"
                className="w-full rounded-lg border border-zinc-200 px-3 py-2"
              />
            </Field>
          </div>
          <Field label="Category">
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Products"
              className="w-full rounded-lg border border-zinc-200 px-3 py-2"
            />
          </Field>
          {save.isError && (
            <p className="text-xs text-red-600">
              {(save.error as any)?.response?.data?.message ?? (save.error as Error).message}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-zinc-200 p-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid} loading={save.isPending}>
            Add product
          </Button>
        </footer>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
      {children}
    </label>
  );
}
