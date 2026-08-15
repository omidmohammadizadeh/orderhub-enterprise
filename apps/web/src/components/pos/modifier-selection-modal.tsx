"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  extractSizeKey,
  calculateCartItem,
  buildCartItemName,
  buildModifierTree,
  collectSelectedModifiers,
  findUnmetRequirements,
  toggleModifierSelection,
  indexGroups,
  type ModifierTreeNode,
  type NestableGroup,
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
  /**
   * How this is dressed.
   *   "modal" — the till dialog: compact header, Cancel + Add to cart.
   *   "sheet" — the storefront on a phone: full-bleed photo, description and
   *             options beneath it, one sticky Add button priced live.
   * Only the chrome differs; sizes, modifiers, pricing and validation are the
   * same code either way, which is the point — a second copy of the pricing
   * maths is how a storefront and a till start disagreeing about a total.
   */
  presentation?: "modal" | "sheet";
  /** Drawn fallback for an item with no usable photo (storefront only). */
  heroFallback?: React.ReactNode;
}

export function ModifierSelectionModal({
  item,
  allModifierGroups = [],
  presentation = "modal",
  heroFallback,
  open,
  onClose,
  onAdd,
}: Props) {
  const isSheet = presentation === "sheet";
  // Sheet only: has the hero scrolled out of the way? Drives the compact
  // header, the way a native app hands the title over as the photo leaves.
  const [scrolledPastHero, setScrolledPastHero] = useState(false);
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

  // Every group the picker can reach by id, nested ones included. The API
  // returns nested groups in the same brand catalogue (they hang off an
  // option, so they never appear in the item's own group links).
  const groupsById = useMemo(
    () =>
      indexGroups(
        activeGroups.map((l) => l.group as NestableGroup),
        allModifierGroups as unknown as NestableGroup[],
      ),
    [activeGroups, allModifierGroups],
  );

  // The tree only descends into options that are actually selected, so
  // "Choose Side" appears the moment "Make It a Meal" is ticked and the whole
  // branch — including its £3.99 — disappears again when it's unticked.
  const nodes = useMemo(
    () =>
      buildModifierTree({
        rootGroups: activeGroups.map((l) => l.group as NestableGroup),
        groupsById,
        selections,
        sizeKey,
        audience: isSheet ? "customer" : "pos",
      }),
    [activeGroups, groupsById, selections, sizeKey, isSheet],
  );

  // Flat list, every level included — the cart, the server's line total, the
  // kitchen ticket and station routing all consume this same array.
  const selectedModifiers = useMemo<SelectedModifier[]>(
    () => collectSelectedModifiers(nodes),
    [nodes],
  );

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

  // Keyed by the whole branch, not by group id: the same "Dip" group can hang
  // off both Fries and Waffle Fries, and keyed by id alone one tick would
  // answer for both.
  const toggle = (node: ModifierTreeNode, optionId: string) => {
    setSelections((prev) =>
      toggleModifierSelection(prev, {
        key: node.key,
        optionId,
        selectionType: node.group.selectionType ?? "VARIANT",
        maxSelections: node.group.maxSelections,
        minSelections: node.group.minSelections,
      }),
    );
  };

  // A nested group is only a question once its parent option is chosen, which
  // the tree already encodes — an unselected option has no children.
  const unmet = findUnmetRequirements(nodes);
  const canSubmit = unmet.length === 0;

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
    <div
      className={
        isSheet
          ? "fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
          : "fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      }
    >
      <div
        className={
          isSheet
            ? "relative flex h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:rounded-2xl"
            : "flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        }
      >
        {isSheet && (
          /* Appears only once the photo has scrolled away, so the customer
             always has the dish name and a way out without it covering the
             food while they're still looking at it. */
          <div
            className={`pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-3 border-b px-4 py-3 transition-opacity duration-200 ${
              scrolledPastHero
                ? "border-zinc-200 bg-white/95 opacity-100 backdrop-blur"
                : "border-transparent opacity-0"
            }`}
          >
            <button
              onClick={onClose}
              aria-label="Close"
              className="pointer-events-auto grid h-8 w-8 flex-shrink-0 place-items-center rounded-full text-zinc-900"
            >
              <X className="h-5 w-5" />
            </button>
            <span className="truncate text-[15px] font-semibold text-zinc-900">
              {item.name}
            </span>
          </div>
        )}

        {!isSheet && (
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
        )}

        {/* Body. On the sheet the photo lives INSIDE this scroller rather
            than above it, so it travels up with the options the way a native
            app does — a pinned image with content sliding under it is the
            tell that something is a website. */}
        <div
          onScroll={
            isSheet
              ? (e) =>
                  setScrolledPastHero(
                    (e.target as HTMLDivElement).scrollTop > 140,
                  )
              : undefined
          }
          className={
            isSheet
              ? "flex-1 overflow-y-auto"
              : "flex-1 overflow-y-auto px-5 py-4 space-y-5"
          }
        >
          {isSheet && (
            <>
              <div className="relative aspect-[4/3] w-full overflow-hidden bg-zinc-100">
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  heroFallback ?? <div className="h-full w-full bg-zinc-100" />
                )}
                {/* Floats on the photo and scrolls away with it; the sticky
                    bar above takes over from there. */}
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className={`absolute left-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-white/90 text-zinc-900 shadow-md backdrop-blur transition-opacity ${
                    scrolledPastHero ? "opacity-0" : "opacity-100"
                  }`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-5 pt-4">
                <h2 className="text-xl font-bold leading-tight text-zinc-900">
                  {item.name}
                </h2>
                <p className="mt-1 text-lg font-bold text-zinc-900">
                  £{Number(basePrice).toFixed(2)}
                </p>
                {item.description && (
                  <p className="mt-2 text-[14px] leading-relaxed text-zinc-500">
                    {item.description}
                  </p>
                )}
              </div>
            </>
          )}

          <div className={isSheet ? "space-y-6 px-5 pb-6 pt-6" : ""}>

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

          {nodes.map((node) => (
            <GroupNode key={node.key} node={node} onToggle={toggle} />
          ))}

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
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-4 bg-zinc-50">
          {isSheet ? (
            /* One button, priced live. The customer never has to work out what
               tapping Add will cost — the number on the button is the number
               that lands in the basket. */
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full rounded-xl bg-zinc-900 px-4 py-3.5 text-[15px] font-semibold text-white active:opacity-90 disabled:opacity-40"
            >
              {canSubmit
                ? `Add ${quantity} for £${breakdown.lineTotal.toFixed(2)}`
                : // Name the question that's still open. With a meal deal the
                  // outstanding choice can be three levels down the page, and
                  // "choose the required options" doesn't say which.
                  `Choose ${unmet[0]?.groupName ?? "the required options"}`}
            </button>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One modifier group and, beneath any option the customer has chosen, the
 * groups that option opens.
 *
 * Nested groups render inline and indented rather than as a pushed panel: the
 * running total stays on screen the whole way down, which is what stops a
 * "Make It a Meal" costing more than the customer expected.
 */
function GroupNode({
  node,
  onToggle,
}: {
  node: ModifierTreeNode;
  onToggle: (node: ModifierTreeNode, optionId: string) => void;
}) {
  const selectionType = node.group.selectionType ?? "VARIANT";
  const min = node.group.minSelections ?? 0;
  const nested = node.depth > 0;

  return (
    <div
      className={
        nested
          ? "mt-2 border-l-2 border-zinc-200 pl-3"
          : ""
      }
    >
      <Section
        title={node.group.name}
        meta={
          selectionType === "VARIANT"
            ? min > 0
              ? "Pick one"
              : "Pick one (optional)"
            : `Choose up to ${node.group.maxSelections ?? "any"}`
        }
      >
        <div className="grid grid-cols-1 gap-2">
          {node.options.map((entry) => (
            <div key={entry.option.id}>
              <label
                className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 ${
                  entry.selected
                    ? "border-zinc-900 bg-zinc-50"
                    : "border-zinc-200 hover:border-zinc-300"
                }`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type={selectionType === "VARIANT" ? "radio" : "checkbox"}
                    // Radio grouping must use the branch key, not the group
                    // id — the same group can be open twice under different
                    // parents, and a shared name would link the two.
                    name={`group-${node.key}`}
                    checked={entry.selected}
                    onChange={() => onToggle(node, entry.option.id)}
                  />
                  <span className="text-sm text-zinc-900">{entry.option.name}</span>
                </div>
                <span className="text-xs text-zinc-500">
                  {entry.price > 0 ? `+£${entry.price.toFixed(2)}` : ""}
                </span>
              </label>

              {entry.children.length > 0 && (
                <div className="mt-1 pl-3">
                  {entry.children.map((child) => (
                    <GroupNode key={child.key} node={child} onToggle={onToggle} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>
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
