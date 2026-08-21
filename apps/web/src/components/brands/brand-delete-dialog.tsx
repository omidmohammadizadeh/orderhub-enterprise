"use client";

// Brand removal confirmation — carried over verbatim from the Brands side
// drawer, wording intact. Removing a brand takes its menus and storefront with
// it, so this is never a one-tap action.

import { AlertTriangle, Loader2 } from "lucide-react";
import type { Brand } from "@/lib/api/locations.client";

export function BrandDeleteDialog({
  brand,
  pending,
  onCancel,
  onConfirm,
}: {
  brand: Brand;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-red-50 p-2">
            <AlertTriangle className="h-4 w-4 text-red-600" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900">
              Remove {brand.name}?
            </h3>
            <p className="mt-1.5 text-xs text-zinc-600">
              This brand and its menus will no longer appear anywhere in the
              system, including the POS and its storefront.
            </p>
            <p className="mt-1.5 text-xs text-zinc-500">
              Past orders are kept, so your reports and history stay correct. If
              the brand is still connected to a marketplace, disconnect that
              channel first.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {pending && <Loader2 className="h-3 w-3 animate-spin" />}
            Remove brand
          </button>
        </div>
      </div>
    </div>
  );
}
