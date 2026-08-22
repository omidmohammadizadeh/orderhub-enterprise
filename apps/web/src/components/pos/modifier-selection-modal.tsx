"use client";

import { useMemo, useState } from "react";
import { useCurrency } from "@/hooks/use-currency";
import { X } from "lucide-react";
import {
  extractSizeKey,
  calculateCartItem,
  buildCartItemName,
  buildModifierTree,
  collectSelectedModifiers,
  findUnmetRequirements,
  flattenModifierSteps,
  isStepSatisfied,
  shouldAutoAdvance,
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
  /**
   * "scroll" shows every group at once (the storefront: browsing).
   * "stepped" asks one at a time with Back/Next (till, kiosk, table service:
   * a task). Stepping only engages from the second question onward — a single
   * group is faster as a plain list.
   */
  flow?: "scroll" | "stepped";
  /** Drawn fallback for an item with no usable photo (storefront only). */
  heroFallback?: React.ReactNode;
}

export function ModifierSelectionModal({
  item,
  allModifierGroups = [],
  presentation = "modal",
  flow = "scroll",
  heroFallback,
  open,
  onClose,
  onAdd,
}: Props) {
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money } = useCurrency();
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
  // Which question the stepped picker is on. Deliberately NOT clamped here —
  // the step list grows and shrinks as nested groups open and close, so the
  // index is clamped at render against the current length instead.
  const [stepIndex, setStepIndex] = useState(0);

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

  // ── Stepped picker ────────────────────────────────────────────────────
  //
  // One question per screen for the till, the kiosk and table service.
  // Scrolling is a browsing pattern; taking an order is a task, and a
  // required group three screens down a scroller is a required group that
  // gets missed.
  //
  // Both views render the SAME tree and write the same branch-keyed
  // selections, so a choice made in one is a choice made in the other and
  // the price can never diverge between them.
  const groupSteps = flattenModifierSteps(nodes);
  // A single question is faster as a plain list: a wizard would turn one tap
  // into three. Stepping earns its keep from the second question onward.
  const questionCount = groupSteps.length + (isMultiSku ? 1 : 0);
  const stepped = flow === "stepped" && questionCount >= 2;

  // size? → one per group → review. Rebuilt every render because ticking
  // "Make It a Meal" inserts its side and drink questions right here.
  const steps: Array<
    { kind: "size" } | { kind: "group"; node: ModifierTreeNode } | { kind: "review" }
  > = stepped
    ? [
        ...(isMultiSku ? [{ kind: "size" as const }] : []),
        ...groupSteps.map((node) => ({ kind: "group" as const, node })),
        { kind: "review" as const },
      ]
    : [];
  // Clamp rather than remember: going back and unticking a meal deletes the
  // three questions underneath it, and a held index would point past the end.
  const at = stepped ? Math.min(stepIndex, steps.length - 1) : 0;
  const current = steps[at];
  const isLast = at === steps.length - 1;

  // Next is blocked only by THIS question. The Add button still answers for
  // the whole order — see canSubmit — so a group skipped by going straight to
  // review can't slip through.
  const stepBlocked =
    current?.kind === "group" ? !isStepSatisfied(current.node) : false;

  const goNext = () => setStepIndex(Math.min(at + 1, steps.length - 1));
  const goBack = () => setStepIndex(Math.max(at - 1, 0));

  // Choosing on a pick-exactly-one group moves on by itself. Making the
  // operator confirm a choice the system already knows is final is the
  // difference between a picker that feels fast and one that feels like
  // paperwork. Multi-select waits: only the operator knows when they're done.
  const toggleStepped = (node: ModifierTreeNode, optionId: string) => {
    toggle(node, optionId);
    if (stepped && shouldAutoAdvance(node)) goNext();
  };

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
                  {money(Number(basePrice))}
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

          {stepped ? (
            <SteppedBody
              money={money}
              step={current!}
              index={at}
              total={steps.length}
              item={item}
              selectedSku={selectedSku}
              productSkus={item.productSkus ?? []}
              onPickSku={(sku) => {
                setSelectedSku(sku);
                // Groups differ per size, so the answers below are no longer
                // about the same question.
                setSelections({});
                goNext();
              }}
              onToggle={toggleStepped}
              selectedModifiers={selectedModifiers}
              quantity={quantity}
              setQuantity={setQuantity}
              notes={notes}
              setNotes={setNotes}
              lineTotal={breakdown.lineTotal}
            />
          ) : (
          <>
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
                    <span className="text-sm text-zinc-700">{money(Number(sku.price))}</span>
                  </label>
                ))}
              </div>
            </Section>
          )}

          {nodes.map((node) => (
            <GroupNode key={node.key} node={node} onToggle={toggle} money={money} />
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
          </>
          )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-4 bg-zinc-50">
          {stepped ? (
            /* Back is always available; forward is gated by THIS question.
               The running total sits between them so nobody discovers what a
               meal deal costs only after adding it. */
            <>
              <button
                onClick={at === 0 ? onClose : goBack}
                className="rounded-xl border border-zinc-200 px-5 py-3 text-[15px] font-medium text-zinc-700 active:bg-zinc-100"
              >
                {at === 0 ? "Cancel" : "Back"}
              </button>
              <div className="text-center">
                <div className="text-[11px] uppercase tracking-wide text-zinc-400">
                  Step {at + 1} of {steps.length}
                </div>
                <div className="text-base font-semibold text-zinc-900">
                  {money(breakdown.lineTotal)}
                </div>
              </div>
              {isLast ? (
                <button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="rounded-xl bg-zinc-900 px-6 py-3 text-[15px] font-semibold text-white active:opacity-90 disabled:opacity-40"
                >
                  {canSubmit
                    ? `Add ${quantity}`
                    : `Choose ${unmet[0]?.groupName ?? "options"}`}
                </button>
              ) : (
                <button
                  onClick={goNext}
                  disabled={stepBlocked}
                  className="rounded-xl bg-zinc-900 px-6 py-3 text-[15px] font-semibold text-white active:opacity-90 disabled:opacity-40"
                >
                  {stepBlocked && current?.kind === "group"
                    ? `Choose ${current.node.group.name}`
                    : "Next"}
                </button>
              )}
            </>
          ) : isSheet ? (
            /* One button, priced live. The customer never has to work out what
               tapping Add will cost — the number on the button is the number
               that lands in the basket. */
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full rounded-xl bg-zinc-900 px-4 py-3.5 text-[15px] font-semibold text-white active:opacity-90 disabled:opacity-40"
            >
              {canSubmit
                ? `Add ${quantity} for ${money(breakdown.lineTotal)}`
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
                  {money(breakdown.lineTotal)}
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
  money,
}: {
  node: ModifierTreeNode;
  onToggle: (node: ModifierTreeNode, optionId: string) => void;
  /** Bound to the location's currency by the parent — never format here. */
  money: (n: number | string | null | undefined) => string;
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
                  {entry.price > 0 ? `+${money(entry.price)}` : ""}
                </span>
              </label>

              {entry.children.length > 0 && (
                <div className="mt-1 pl-3">
                  {entry.children.map((child) => (
                    <GroupNode key={child.key} node={child} onToggle={onToggle} money={money} />
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


/**
 * One question, filling the screen.
 *
 * Deliberately reuses GroupNode so a step renders exactly what the scrolling
 * view renders for the same group — prices, per-size availability and nested
 * indentation included. Two renderers for one group is how the till and the
 * storefront end up disagreeing about what something costs.
 */
function SteppedBody({
  money,
  step,
  index,
  total,
  item,
  selectedSku,
  productSkus,
  onPickSku,
  onToggle,
  selectedModifiers,
  quantity,
  setQuantity,
  notes,
  setNotes,
  lineTotal,
}: {
  money: (n: number | string | null | undefined) => string;
  step: { kind: "size" } | { kind: "group"; node: ModifierTreeNode } | { kind: "review" };
  index: number;
  total: number;
  item: { name: string };
  selectedSku: ProductSku | null;
  productSkus: ProductSku[];
  onPickSku: (sku: ProductSku) => void;
  onToggle: (node: ModifierTreeNode, optionId: string) => void;
  selectedModifiers: SelectedModifier[];
  quantity: number;
  setQuantity: (fn: (q: number) => number) => void;
  notes: string;
  setNotes: (v: string) => void;
  lineTotal: number;
}) {
  return (
    <div className="space-y-4">
      {/* Where the operator is, and in what. A bare list of options with no
          heading is disorienting when the screen changes under you. */}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
          {item.name} · {index + 1} of {total}
        </div>
        <h3 className="mt-0.5 text-lg font-semibold text-zinc-900">
          {step.kind === "size"
            ? "Choose a size"
            : step.kind === "group"
              ? step.node.group.name
              : "Anything else?"}
        </h3>
        {step.kind === "group" && step.node.ancestorNames.length > 0 && (
          /* "Make It a Meal › Fries" — without it, a dip question three
             levels down looks like it belongs to the burger. */
          <p className="mt-0.5 text-xs text-zinc-500">
            {step.node.ancestorNames.join(" › ")}
          </p>
        )}
      </div>

      {step.kind === "size" && (
        <div className="grid grid-cols-1 gap-2">
          {productSkus.map((sku) => (
            <button
              key={sku.name}
              onClick={() => onPickSku(sku)}
              className={`flex items-center justify-between rounded-xl border px-4 py-4 text-left active:bg-zinc-50 ${
                selectedSku?.name === sku.name
                  ? "border-zinc-900 bg-zinc-50"
                  : "border-zinc-200"
              }`}
            >
              <span className="text-[15px] font-medium text-zinc-900">
                {sku.name}
              </span>
              <span className="text-[15px] text-zinc-700">
                {money(Number(sku.price))}
              </span>
            </button>
          ))}
        </div>
      )}

      {step.kind === "group" && (
        <GroupNode node={step.node} onToggle={onToggle} money={money} />
      )}

      {step.kind === "review" && (
        <div className="space-y-4">
          {/* Everything chosen, before it goes in. On a meal deal the
              operator has answered four questions across four screens and
              can no longer see any of them. */}
          {selectedModifiers.length > 0 && (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                Chosen
              </div>
              <ul className="mt-1.5 space-y-1">
                {selectedModifiers.map((m, i) => (
                  <li
                    key={`${m.groupId}-${m.id}-${i}`}
                    className="flex justify-between text-sm text-zinc-700"
                  >
                    <span style={{ paddingLeft: (m.depth ?? 0) * 12 }}>
                      {(m.depth ?? 0) > 0 ? "↳ " : ""}
                      {m.name}
                    </span>
                    {m.price > 0 && <span>+{money(m.price)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              Quantity
            </div>
            <div className="mt-1.5 flex items-center gap-4">
              <button
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                className="h-12 w-12 rounded-xl border border-zinc-200 text-xl active:bg-zinc-100"
              >
                −
              </button>
              <span className="min-w-[2ch] text-center text-xl font-semibold text-zinc-900">
                {quantity}
              </span>
              <button
                onClick={() => setQuantity((q) => q + 1)}
                className="h-12 w-12 rounded-xl border border-zinc-200 text-xl active:bg-zinc-100"
              >
                +
              </button>
              <span className="ml-auto text-lg font-semibold text-zinc-900">
                {money(lineTotal)}
              </span>
            </div>
          </div>

          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              Notes (optional)
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. no salt, extra crispy"
              rows={2}
              className="mt-1.5 w-full resize-none rounded-xl border border-zinc-200 px-3 py-2 text-[15px] focus:border-zinc-900 focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
