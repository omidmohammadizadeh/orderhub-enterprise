"use client";

// Phase AM — full-page-style modal wrapper around ProductForm.
//
// Reused from the menu editor so the operator can create or edit a
// product without losing their place in the menu. Same form as the
// Products tab, just framed inside a scrolling overlay.
//
// onSaved fires after the underlying form persists. The menu editor
// uses this to auto-attach a newly-created product to whichever
// category is active.

import { X } from "lucide-react";
import { ProductForm } from "./product-form";

interface Props {
  open: boolean;
  brandId: string;
  /** Provide a productId to open in edit mode; omit for create mode. */
  productId?: string;
  /** Fires after the form's save mutation succeeds. */
  onSaved: () => void;
  onCancel: () => void;
}

export function ProductEditorModal({
  open,
  brandId,
  productId,
  onSaved,
  onCancel,
}: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
      <div className="my-8 w-full max-w-5xl bg-white rounded-xl shadow-2xl">
        <div className="sticky top-0 z-10 bg-white border-b border-zinc-100 flex items-center justify-between px-6 py-4 rounded-t-xl">
          <h2 className="text-base font-semibold text-zinc-900">
            {productId ? "Edit product" : "Create product"}
          </h2>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-700"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          <ProductForm
            brandId={brandId}
            productId={productId}
            onCancel={onCancel}
            onSaved={onSaved}
          />
        </div>
      </div>
    </div>
  );
}
