"use client";

// The basket on every page: a bag button with a count, and a drawer listing
// what's in it with steppers and the way to checkout.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ShoppingBag, X } from "lucide-react";
import { formatModifierPath } from "@orderhub/shared";
import { useEflHref } from "../efl-base-context";
import { FOCUS } from "../efl-styles";
import { money } from "../feed/shop-card";
import { basketCount, basketSubtotal, rehydrateBasket, useBasket, type BasketLine } from "./basket";
import { Stepper } from "./item-dialog";

export function useBasketReady(): void {
  useEffect(() => rehydrateBasket(), []);
}

/** "Large · Garlic mayo, Extra cheese ×2" */
export function lineDetail(line: BasketLine): string {
  const counts = new Map<string, number>();
  for (const m of line.modifiers) {
    const label = formatModifierPath(m);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const mods = [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
  return [line.sku?.name, mods.join(", "), line.notes ? `“${line.notes}”` : null].filter(Boolean).join(" · ");
}

export function BasketButton({ className = "" }: { className?: string }) {
  useBasketReady();
  const lines = useBasket((s) => s.lines);
  const count = basketCount(lines);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={count ? `Basket, ${count} item${count === 1 ? "" : "s"}` : "Basket, empty"}
        className={`efl-press relative flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full ${
          count ? "bg-[#0B0B0B] px-4 text-white" : "w-11 hover:bg-[#F3F3F3]"
        } ${FOCUS} ${className}`}
      >
        <ShoppingBag aria-hidden="true" className="h-[22px] w-[22px]" />
        {count ? <span className="text-[15px] font-extrabold tabular-nums">{count}</span> : null}
      </button>
      <BasketDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function BasketDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const href = useEflHref();
  const { shop, lines, setQuantity } = useBasket();
  const subtotal = basketSubtotal(lines);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="efl-basket-h"
      className="m-0 ml-auto h-[100dvh] max-h-none w-full max-w-[440px] bg-white p-0 text-[#0B0B0B] backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-[#E2E2E2] px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="efl-basket-h" className="m-0 text-[22px] font-extrabold tracking-[-0.02em]">
              Your basket
            </h2>
            {shop ? <p className="m-0 truncate text-sm text-[#5E5E5E]">{shop.name}{shop.area ? ` · ${shop.area}` : ""}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close basket"
            className={`efl-press flex h-11 w-11 items-center justify-center rounded-full hover:bg-[#F3F3F3] ${FOCUS}`}
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>

        {lines.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <ShoppingBag aria-hidden="true" className="h-10 w-10 text-[#B5B5B5]" />
            <p className="m-0 text-lg font-extrabold">Your basket is empty</p>
            <p className="m-0 text-[15px] text-[#5E5E5E]">Add something tasty from a shop near you.</p>
          </div>
        ) : (
          <>
            <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
              {lines.map((l) => (
                <li key={l.key} className="flex gap-3 border-b border-[#F0F0F0] px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-[15px] font-bold">{l.name}</p>
                    {lineDetail(l) ? <p className="m-0 mt-0.5 text-sm leading-snug text-[#5E5E5E]">{lineDetail(l)}</p> : null}
                    <p className="m-0 mt-1 text-[15px] font-semibold tabular-nums">{money(l.unitPrice * l.quantity)}</p>
                  </div>
                  <div className="self-center">
                    <Stepper size="sm" min={0} value={l.quantity} label={`Quantity of ${l.name}`} onChange={(n) => setQuantity(l.key, n)} />
                  </div>
                </li>
              ))}
            </ul>
            <div className="border-t border-[#E2E2E2] px-5 pb-[max(16px,env(safe-area-inset-bottom))] pt-4">
              <div className="mb-3 flex items-baseline justify-between">
                <span className="text-[15px] font-semibold">Subtotal</span>
                <span className="text-lg font-extrabold tabular-nums">{money(subtotal)}</span>
              </div>
              <Link
                href={href("/checkout")}
                onClick={onClose}
                className={`efl-press flex min-h-[52px] w-full items-center justify-center rounded-full bg-[#0B0B0B] text-[15px] font-extrabold text-white ${FOCUS}`}
              >
                Go to checkout
              </Link>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
