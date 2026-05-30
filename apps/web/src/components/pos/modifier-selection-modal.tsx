"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  extractSizeKey,
  getModifierPrice,
  getModifierPlu,
  isModifierAvailable,
  calculateCartItem,
  buildCartItemName,
  type ProductSku,
  type SelectedModifier,
} from "@orderhub/shared";
import type { MenuItem } from "@/lib/api/menus.client";
import type { CatalogModifierGroup } from "@/lib/api/catalog.client";

// ── POS ModifierSelectionModal ──────────────────────────────────────────────
//
// Mirrors Base44's `ModifierSelectionModal` 1:1. Three flows fused into one
// component, switched on `item.hasMultipleSkus`:
//
//   1. Simple product — show its modifier groups, base price = item.basePrice.
//
//   2. Multi-SKU product — first force the operator to pick a SKU
//      (RadioGroup of productSkus[]). Once selected:
//        - basePrice = selectedSku.price
//        - active modifier groups = selectedSku.modifierGroups (NOT the
//          item's own groups — Base44 routes them through the SKU)
//        - the "size key" used for pricesBySize lookups is extracted from
//          the SKU's name via the shared regex helper.
//
//   3. After all selections, calculateCartItem() produces the unit price
//      including modifiers. The cart row stores that unit price; quantity
//      multiplication happens on the cart side.
//
// All pricing math lives in @orderhub/shared so an order priced here
// matches what the server records.

interface Props {
  item: MenuItem;
  /**
   * Brand-wide modifier group catalog. Required for multi-SKU products
   * because their per-SKU modifier groups are stored as plain ID
   * arrays in productSkus[].modifierGroups (not FK-linked through
   * ModifierGroupOnItem like flat-product groups), so the modal
   * needs to look them up against the brand catalog.
   * For flat products this prop is unused and can be empty.
   */
  allModifierGroups?: CatalogModifierGroup[];
  open: boolean;
  onClose: () => void;
  onAdd: (line: {
    menuItemId: string;
    displayName: string;
    unitPrice: number;
    quantity: number;
    plu?: string | null;
    modifiers: SelectedModifier[];
    selectedSku?: ProductSku | null;
    notes?: string;
  }) => void;
}

export function ModifierSelectionModal({
  item,
  allModifierGroups = [],
  open,
  onClose,
  onAdd,
}: Props) {
  const isMultiSku = !!item.hasMultipleSkus && (item.productSkus?.length ?? 0) > 0;

  const [selectedSku, setSelectedSku] = useState<ProductSku | null>(
    isMultiSku ? (item.productSkus?.[0] ?? null) : null,
  );
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");

  // Size key = "10" extracted from "10 inch", used for pricesBySize lookups.
  const sizeKey = useMemo(
    () => (selectedSku ? extractSizeKey(selectedSku.name) : null),
    [selectedSku],
  );

  // Active modifier groups, normalised to the modifierGroupLinks shape
  // the modal consumes ({ group: {…options[]} }):
  //
  //   - Flat product:   pulled from item.modifierGroupLinks (the
  //                     ModifierGroupOnItem FK join, already
  //                     populated by the API include).
  //   - Multi-SKU:      pulled from allModifierGroups (the brand
  //                     catalog) by SKU.modifierGroups[] id, because
  //                     SKU groups are NOT FK-attached — they live
  //                     in JSON. Without this lookup the modal saw
  //                     an empty group list for every pizza-style
  //                     product and skipped straight to "add to
  //                     cart" with no modifier picks.
  const activeGroups = useMemo(() => {
    if (isMultiSku && selectedSku) {
      const wanted = new Set(selectedSku.modifierGroups ?? []);
      return allModifierGroups
        .filter((g) => wanted.has(g.id))
        // Match the shape of MenuItem.modifierGroupLinks: { group }.
        // CatalogModifierGroup is structurally compatible with the
        // group field (id, name, selectionType, options[]).
        .map((g) => ({ group: g as any }));
    }
    return item.modifierGroupLinks ?? [];
  }, [
    item.modifierGroupLinks,
    isMultiSku,
    selectedSku,
    allModifierGroups,
  ]);

  // Flattened "selected modifiers with their group" view for pricing.
  const selectedModifiers = useMemo<SelectedModifier[]>(() => {
    const out: SelectedModifier[] = [];
    for (const link of activeGroups) {
      const picked = selections[link.group.id] ?? [];
      for (const optId of picked) {
        const opt = link.group.options.find((o: any) => o.id === optId);
        if (!opt) continue;
        const priceableModifier = {
          ...opt,
          priceAdjustment: opt.priceAdjustment,
        };
        out.push({
          id: opt.id,
          name: opt.name,
          groupId: link.group.id,
          groupName: link.group.name,
          price: getModifierPrice(priceableModifier, sizeKey),
          plu: getModifierPlu(priceableModifier as any, sizeKey),
        });
      }
    }
    return out;
  }, [activeGroups, selections, sizeKey]);

  const basePrice = selectedSku ? Number(selectedSku.price) : Number(item.basePrice);
  const breakdown = useMemo(
    () =>
      calculateCartItem({
        basePrice,
        modifiers: selectedModifiers,
        quantity,
      }),
    [basePrice, selectedModifiers, quantity],
  );

  if (!open) return null;

  const toggleSelection = (
    groupId: string,
    optionId: string,
    selectionType: "VARIANT" | "ADDON",
    maxSelections: number | null | undefined,
  ) => {
    setSelections((prev) => {
      const current = prev[groupId] ?? [];
      if (selectionType === "VARIANT") {
        return { ...prev, [groupId]: [optionId] };
      }
      // ADDON
      if (current.includes(optionId)) {
        return { ...prev, [groupId]: current.filter((id) => id !== optionId) };
      }
      const max = maxSelections ?? Infinity;
      if (current.length >= max) return prev; // capacity reached
      return { ...prev, [groupId]: [...current, optionId] };
    });
  };

  const canSubmit = activeGroups.every((link) => {
    const min = link.group.minSelections ?? 0;
    const picked = selections[link.group.id]?.length ?? 0;
    return picked >= min;
  });

  const handleSubmit = () => {
    const displayName = buildCartItemName({
      productName: item.name,
      selectedSku,
      modifiers: selectedModifiers,
      note: notes || null,
    });
    onAdd({
      menuItemId: item.id,
      displayName,
      unitPrice: breakdown.unitPrice,
      quantity,
      plu: selectedSku?.plu ?? item.plu ?? null,
      modifiers: selectedModifiers,
      selectedSku,
      notes: notes || undefined,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">{item.name}</h2>
            {item.description && (
              <p className="mt-0.5 text-xs text-zinc-500">{item.description}</p>
            )}
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-zinc-100">
            <X className="h-4 w-4 text-zinc-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {isMultiSku && (
            <Section title="Size">
              <div className="grid grid-cols-1 gap-2">
                {(item.productSkus ?? []).map((sku) => (
                  <label
                    key={sku.name}
                    className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 ${
                      selectedSku?.name === sku.name
                        ? "border-zinc-900 bg-zinc-50"
                        : "border-zinc-200 hover:border-zinc-300"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="sku"
                        checked={selectedSku?.name === sku.name}
                        onChange={() => {
                          setSelectedSku(sku);
                          setSelections({}); // reset, modifier groups differ per SKU
                        }}
                      />
                      <span className="text-sm font-medium text-zinc-900">{sku.name}</span>
                    </div>
                    <span className="text-sm text-zinc-700">£{Number(sku.price).toFixed(2)}</span>
                  </label>
                ))}
              </div>
            </Section>
          )}

          {activeGroups.map((link) => {
            const group = link.group;
            const selectionType = group.selectionType ?? "VARIANT";
            return (
              <Section
                key={group.id}
                title={group.name}
                meta={
                  selectionType === "VARIANT"
                    ? "Pick one"
                    : `Choose up to ${group.maxSelections ?? "any"}`
                }
              >
                <div className="grid grid-cols-1 gap-2">
                  {group.options
                    .filter((opt: any) => {
                      const m = {
                        ...opt,
                        priceAdjustment: opt.priceAdjustment,
                      };
                      return isModifierAvailable(m as any, sizeKey, { audience: "pos" });
                    })
                    .map((opt: any) => {
                      const m = { ...opt, priceAdjustment: opt.priceAdjustment };
                      const price = getModifierPrice(m as any, sizeKey);
                      const checked = (selections[group.id] ?? []).includes(opt.id);
                      return (
                        <label
                          key={opt.id}
                          className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 ${
                            checked ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type={selectionType === "VARIANT" ? "radio" : "checkbox"}
                              name={`group-${group.id}`}
                              checked={checked}
                              onChange={() =>
                                toggleSelection(
                                  group.id,
                                  opt.id,
                                  selectionType,
                                  group.maxSelections,
                                )
                              }
                            />
                            <span className="text-sm text-zinc-900">{opt.name}</span>
                          </div>
                          <span className="text-xs text-zinc-500">
                            {price > 0 ? `+£${price.toFixed(2)}` : ""}
                          </span>
                        </label>
                      );
                    })}
                </div>
              </Section>
            );
          })}

          <Section title="Notes (optional)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. no salt, extra crispy"
              rows={2}
              className="w-full resize-none rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </Section>

          <Section title="Quantity">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                className="h-9 w-9 rounded-lg border border-zinc-200 text-base hover:border-zinc-300"
              >
                −
              </button>
              <span className="min-w-[2ch] text-center text-base font-medium text-zinc-900">
                {quantity}
              </span>
              <button
                onClick={() => setQuantity((q) => q + 1)}
                className="h-9 w-9 rounded-lg border border-zinc-200 text-base hover:border-zinc-300"
              >
                +
              </button>
            </div>
          </Section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-4 bg-zinc-50">
          <div className="text-sm">
            <span className="text-zinc-500">Total</span>
            <span className="ml-2 text-base font-semibold text-zinc-900">
              £{breakdown.lineTotal.toFixed(2)}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              Add to cart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {title}
        </h3>
        {meta && <span className="text-xs text-zinc-400">{meta}</span>}
      </div>
      {children}
    </div>
  );
}
