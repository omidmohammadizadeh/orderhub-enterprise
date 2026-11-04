"use client";

// Choosing an item: size, every modifier group (nested ones open under the
// option that unlocks them), a note, quantity, and a live price. Selection and
// pricing use the same shared functions as the app and the server's
// re-pricing (packages/shared), so the price shown is the price charged.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Minus, Plus, X } from "lucide-react";
import {
  adjustModifierQuantity,
  buildModifierTree,
  calculateCartItem,
  collectSelectedModifiers,
  extractSizeKey,
  findUnmetRequirements,
  indexGroups,
  toggleModifierSelection,
  type ModifierTreeNode,
  type NestableGroup,
} from "@orderhub/shared";
import type { EflPublicMenuItem, EflPublicModifierGroup } from "@/lib/api/efl.client";
import { money } from "../feed/shop-card";
import { FOCUS } from "../efl-styles";
import { useBasket, type BasketShop } from "./basket";

type Sku = NonNullable<EflPublicMenuItem["productSkus"]>[number];

/**
 * Groups that apply to an item. A multi-size product takes its groups from
 * the chosen SIZE (bare ids, resolved against the brand catalogue); a flat
 * product from its own links. A link whose group can't be found is dropped,
 * never shown empty: an empty required group would block the order.
 */
function activeGroups(item: EflPublicMenuItem, sku: Sku | null, catalogue: EflPublicModifierGroup[]): EflPublicModifierGroup[] {
  const byId = new Map(catalogue.map((g) => [g.id, g]));
  const visible = (g: EflPublicModifierGroup | undefined): g is EflPublicModifierGroup => !!g && g.visibleToCustomers !== false;
  if (sku && sku.modifierGroups?.length) return sku.modifierGroups.map((id) => byId.get(id)).filter(visible);
  return (item.modifierGroupLinks ?? []).map((l) => l.group ?? byId.get(l.groupId)).filter(visible);
}

function ruleText(min: number, max: number | null | undefined, variant: boolean): string {
  if (variant) return min > 0 ? "Pick 1" : "Optional · pick 1";
  if (max && min > 0) return min === max ? `Pick ${min}` : `Pick ${min}–${max}`;
  if (max) return `Optional · up to ${max}`;
  return min > 0 ? `Pick at least ${min}` : "Optional";
}

export function Stepper({
  value,
  onChange,
  min = 1,
  label,
  size = "md",
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  label: string;
  size?: "sm" | "md";
}) {
  const btn = size === "sm" ? "h-8 w-8" : "h-11 w-11";
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1 rounded-full bg-[#F3F3F3] p-1">
      <button
        type="button"
        aria-label={value <= 1 && min === 0 ? "Remove" : "One fewer"}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        className={`efl-press flex ${btn} items-center justify-center rounded-full bg-white disabled:opacity-40 ${FOCUS}`}
      >
        <Minus aria-hidden="true" className="h-4 w-4" />
      </button>
      <span aria-live="polite" className="min-w-[2ch] text-center text-[15px] font-extrabold tabular-nums">
        {value}
      </span>
      <button
        type="button"
        aria-label="One more"
        disabled={value >= 99}
        onClick={() => onChange(value + 1)}
        className={`efl-press flex ${btn} items-center justify-center rounded-full bg-white disabled:opacity-40 ${FOCUS}`}
      >
        <Plus aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

function Mark({ on, variant }: { on: boolean; variant: boolean }) {
  if (variant) {
    return (
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${on ? "border-[#0B0B0B]" : "border-[#B5B5B5]"}`}
      >
        {on ? <span className="h-3 w-3 rounded-full bg-[#0B0B0B]" /> : null}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 ${
        on ? "border-[#0B0B0B] bg-[#0B0B0B]" : "border-[#B5B5B5]"
      }`}
    >
      {on ? <Check className="h-4 w-4 text-[#D4FF3F]" strokeWidth={3.5} /> : null}
    </span>
  );
}

function Groups({
  nodes,
  onToggle,
  onStep,
  flagged,
}: {
  nodes: ModifierTreeNode[];
  onToggle: (node: ModifierTreeNode, optionId: string) => void;
  onStep: (node: ModifierTreeNode, optionId: string, delta: number) => void;
  flagged: string | null;
}) {
  return (
    <>
      {nodes.map((node) => {
        const variant = (node.group.selectionType ?? "VARIANT") === "VARIANT";
        const min = node.group.minSelections ?? 0;
        const picked = node.options.reduce((n, o) => n + o.quantity, 0);
        const nested = node.depth > 0;
        const done = picked >= min;
        const headingId = `grp-${node.key}`;
        return (
          <fieldset
            key={node.key}
            id={`group-${node.key}`}
            aria-labelledby={headingId}
            className={`m-0 min-w-0 border-0 p-0 ${nested ? "ml-2 mt-1 border-l-2 border-[#E2E2E2] pl-4" : "border-t border-[#E2E2E2] pt-5"}`}
          >
            <div className="flex items-start gap-3 pb-2">
              <div className="min-w-0 flex-1">
                <h3 id={headingId} className={`m-0 font-extrabold ${nested ? "text-[15px]" : "text-lg"}`}>
                  {node.group.name}
                </h3>
                <p className="m-0 text-sm text-[#5E5E5E]">{ruleText(min, node.group.maxSelections, variant)}</p>
              </div>
              {min > 0 ? (
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${
                    done ? "bg-[#D4FF3F] text-[#0B0B0B]" : flagged === node.key ? "bg-[#0B0B0B] text-[#D4FF3F]" : "bg-[#F3F3F3]"
                  }`}
                >
                  {done ? "Done" : "Required"}
                </span>
              ) : null}
            </div>
            <ul className="m-0 list-none p-0">
              {node.options.map((entry) => {
                const dup = !!node.group.allowDuplicateSelections && !variant;
                return (
                  <li key={entry.option.id}>
                    <div className="flex min-h-[56px] items-center gap-3 border-b border-[#F0F0F0]">
                      <button
                        type="button"
                        role={variant ? "radio" : "checkbox"}
                        aria-checked={entry.selected}
                        onClick={() => onToggle(node, entry.option.id)}
                        className={`efl-press flex min-h-[56px] min-w-0 flex-1 items-center gap-3 rounded-lg text-left ${FOCUS}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] font-semibold">{entry.option.name}</span>
                          {entry.price > 0 ? <span className="block text-sm text-[#5E5E5E]">+{money(entry.price)}</span> : null}
                        </span>
                        {dup && entry.quantity > 0 ? null : <Mark on={entry.selected} variant={variant} />}
                      </button>
                      {dup && entry.quantity > 0 ? (
                        <Stepper
                          size="sm"
                          min={0}
                          label={`How many ${entry.option.name}`}
                          value={entry.quantity}
                          onChange={(n) => onStep(node, entry.option.id, n - entry.quantity)}
                        />
                      ) : null}
                    </div>
                    {entry.selected && entry.children.length > 0 ? (
                      <Groups nodes={entry.children} onToggle={onToggle} onStep={onStep} flagged={flagged} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </>
  );
}

export type ItemDialogTarget = { item: EflPublicMenuItem; shop: BasketShop; catalogue: EflPublicModifierGroup[]; orderable: boolean };

export function ItemDialog({ target, onClose }: { target: ItemDialogTarget | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (target && !d.open) d.showModal();
    if (!target && d.open) d.close();
  }, [target]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={target?.item.name ?? "Item"}
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-[24px] bg-white p-0 text-[#0B0B0B] backdrop:bg-black/50 sm:m-auto sm:max-h-[88vh] sm:w-[560px] sm:rounded-[24px]"
    >
      {target ? <ItemBody key={target.item.id} target={target} onClose={onClose} /> : null}
    </dialog>
  );
}

function ItemBody({ target, onClose }: { target: ItemDialogTarget; onClose: () => void }) {
  const { item, shop, catalogue, orderable } = target;
  const add = useBasket((s) => s.add);
  const replaceWith = useBasket((s) => s.replaceWith);
  const skus = item.productSkus ?? [];
  const multiSku = skus.length > 1;
  const [sku, setSku] = useState<Sku | null>(skus[0] ?? null);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");
  const [flagged, setFlagged] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const sizeKey = sku ? extractSizeKey(sku.name) : null;
  const roots = useMemo(() => activeGroups(item, sku, catalogue), [item, sku, catalogue]);
  const groupsById = useMemo(
    () => indexGroups(roots as unknown as NestableGroup[], catalogue as unknown as NestableGroup[]),
    [roots, catalogue],
  );
  const nodes = useMemo(
    () => buildModifierTree({ rootGroups: roots as unknown as NestableGroup[], groupsById, selections, sizeKey, audience: "customer" }),
    [roots, groupsById, selections, sizeKey],
  );
  const selected = useMemo(() => collectSelectedModifiers(nodes), [nodes]);
  const unmet = useMemo(() => findUnmetRequirements(nodes), [nodes]);
  const base = sku ? Number(sku.price) : Number(item.basePrice) || 0;
  const price = calculateCartItem({ basePrice: base, modifiers: selected, quantity: qty });

  const onToggle = (node: ModifierTreeNode, optionId: string) =>
    setSelections((prev) =>
      toggleModifierSelection(prev, {
        key: node.key,
        optionId,
        selectionType: node.group.selectionType ?? "VARIANT",
        maxSelections: node.group.maxSelections,
        minSelections: node.group.minSelections,
        allowDuplicates: node.group.allowDuplicateSelections,
      }),
    );
  const onStep = (node: ModifierTreeNode, optionId: string, delta: number) =>
    setSelections((prev) => adjustModifierQuantity(prev, { key: node.key, optionId, delta, maxSelections: node.group.maxSelections }));

  const line = () => ({
    menuItemId: item.id,
    name: item.name,
    imageUrl: item.imageUrl ?? null,
    unitPrice: price.unitPrice,
    quantity: qty,
    modifiers: selected,
    sku: sku ? { name: sku.name, plu: sku.plu } : null,
    notes: notes.trim() || undefined,
  });

  const submit = () => {
    if (unmet.length > 0) {
      // Point at the first unanswered question rather than just refusing.
      const first = unmet[0]!;
      setFlagged(first.key);
      document.getElementById(`group-${first.key}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (add(shop, line())) onClose();
    else setConfirmReplace(true);
  };

  return (
    <div className="flex max-h-[92dvh] flex-col sm:max-h-[88vh]">
      <div className="relative shrink-0">
        {item.imageUrl ? (
          <div className="aspect-[16/9] w-full overflow-hidden bg-[#F3F3F3]">
            {/* eslint-disable-next-line @next/next/no-img-element -- menu images live on any host */}
            <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className="h-14" />
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={`efl-press absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-md ${FOCUS}`}
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6">
        <h2 className="m-0 pt-4 text-[26px] font-extrabold leading-tight tracking-[-0.02em]">{item.name}</h2>
        {item.description ? <p className="m-0 mt-1.5 text-[15px] leading-relaxed text-[#5E5E5E]">{item.description}</p> : null}
        <p className="m-0 mt-3 rounded-xl bg-[#F3F3F3] px-3 py-2 text-sm text-[#5E5E5E]">
          {item.allergens?.length ? `Allergens: ${item.allergens.join(", ")}` : "Allergies? Ask the shop before you order."}
        </p>

        <div className="mt-5 flex flex-col gap-5">
          {multiSku ? (
            <fieldset aria-labelledby="size-h" className="m-0 min-w-0 border-0 border-t border-[#E2E2E2] p-0 pt-5">
              <div className="flex items-start gap-3 pb-2">
                <div className="flex-1">
                  <h3 id="size-h" className="m-0 text-lg font-extrabold">
                    Choose a size
                  </h3>
                  <p className="m-0 text-sm text-[#5E5E5E]">Pick 1</p>
                </div>
                <span className="rounded-full bg-[#D4FF3F] px-2.5 py-1 text-xs font-bold">Done</span>
              </div>
              <ul className="m-0 list-none p-0">
                {skus.map((s) => (
                  <li key={s.plu}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={sku?.plu === s.plu}
                      onClick={() => {
                        setSku(s);
                        // Each size has its own groups; old picks may not apply.
                        setSelections({});
                      }}
                      className={`efl-press flex min-h-[56px] w-full items-center gap-3 border-b border-[#F0F0F0] text-left ${FOCUS}`}
                    >
                      <span className="flex-1">
                        <span className="block text-[15px] font-semibold">{s.name}</span>
                        <span className="block text-sm text-[#5E5E5E]">{money(Number(s.price))}</span>
                      </span>
                      <Mark on={sku?.plu === s.plu} variant />
                    </button>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}

          <Groups nodes={nodes} onToggle={onToggle} onStep={onStep} flagged={flagged} />

          <div className="border-t border-[#E2E2E2] pt-5">
            <label htmlFor="item-note" className="text-lg font-extrabold">
              Note for the shop
            </label>
            <input
              id="item-note"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. no onions, well done"
              maxLength={140}
              autoComplete="off"
              className={`mt-2 min-h-[48px] w-full rounded-xl border border-[#E2E2E2] px-4 text-base ${FOCUS}`}
            />
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-[#E2E2E2] bg-white px-5 pb-[max(16px,env(safe-area-inset-bottom))] pt-4">
        {confirmReplace ? (
          <div role="alertdialog" aria-labelledby="replace-h" className="flex flex-col gap-3">
            <p id="replace-h" className="m-0 text-[15px] font-semibold">
              Your basket has food from another shop. Start a new basket with this instead?
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmReplace(false)}
                className={`efl-press min-h-[48px] flex-1 rounded-full border border-[#0B0B0B] font-bold ${FOCUS}`}
              >
                Keep my basket
              </button>
              <button
                type="button"
                onClick={() => {
                  replaceWith(shop, line());
                  onClose();
                }}
                className={`efl-press min-h-[48px] flex-1 rounded-full bg-[#0B0B0B] font-bold text-white ${FOCUS}`}
              >
                New basket
              </button>
            </div>
          </div>
        ) : orderable ? (
          <div className="flex items-center gap-3">
            <Stepper value={qty} onChange={setQty} label="Quantity" />
            <button
              type="button"
              onClick={submit}
              className={`efl-press flex min-h-[52px] flex-1 items-center justify-between gap-3 rounded-full bg-[#0B0B0B] px-5 text-[15px] font-extrabold text-white ${FOCUS}`}
            >
              <span>Add to basket</span>
              <span className="tabular-nums">{money(price.lineTotal)}</span>
            </button>
          </div>
        ) : (
          <p className="m-0 rounded-xl bg-[#F3F3F3] px-4 py-3 text-center text-[15px] font-semibold">
            {item.isAvailable === false || item.outOfStock ? "Sold out right now" : "This shop is closed right now"}
          </p>
        )}
      </div>
    </div>
  );
}
