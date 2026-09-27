"use client";

// Retail R3 — a product on a shop's storefront (GROCERY / RETAIL).
//
// Groceries are bought in quantity and in a hurry: the tile puts − qty + on
// the product itself, so filling a basket is tapping, not opening a sheet per
// item. Anything with a choice to make (sizes, colours) still opens the item
// sheet. Sold-out products stay visible but can't be added — a shopper looking
// for their usual milk should learn it's gone, not wonder where it went.

import { Minus, Plus } from "lucide-react";

export function ShopProductTile({
  name,
  imageUrl,
  price,
  wasPrice,
  fromPrice,
  soldOut,
  qty,
  simple,
  onInc,
  onDec,
  onOpen,
}: {
  name: string;
  imageUrl?: string | null;
  /** Already formatted in the shop's currency. */
  price: string;
  wasPrice?: string | null;
  /** Several sizes/colours — price shown as "from". */
  fromPrice?: boolean;
  soldOut: boolean;
  qty: number;
  /** Nothing to choose: − qty + right here. Otherwise tapping opens the sheet. */
  simple: boolean;
  onInc: () => void;
  onDec: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-xl border bg-white ${
        qty > 0 ? "border-zinc-900" : "border-zinc-200"
      } ${soldOut ? "opacity-60" : ""}`}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={soldOut}
        className="relative block aspect-square w-full bg-zinc-50 disabled:cursor-not-allowed"
        aria-label={`${name}${soldOut ? " — sold out" : ""}`}
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" loading="lazy" className="h-full w-full object-contain p-2" />
        ) : (
          <span className="grid h-full w-full place-items-center px-2 text-center text-xs font-medium text-zinc-400">
            {name}
          </span>
        )}
        {soldOut && (
          <span className="absolute left-2 top-2 rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            Sold out
          </span>
        )}
      </button>
      <div className="flex flex-1 flex-col gap-1 p-2.5">
        <p className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-5 text-zinc-900">{name}</p>
        <div className="mt-auto flex items-center justify-between gap-2">
          <p className="text-sm font-bold text-zinc-900">
            {fromPrice && <span className="mr-0.5 text-[11px] font-normal text-zinc-500">from</span>}
            {price}
            {wasPrice && (
              <span className="ml-1 text-[11px] font-normal text-zinc-400 line-through">{wasPrice}</span>
            )}
          </p>
          {soldOut ? null : simple && qty > 0 ? (
            <div className="flex items-center gap-1" role="group" aria-label={`Quantity of ${name}`}>
              <button
                type="button"
                onClick={onDec}
                aria-label={`One fewer ${name}`}
                className="grid h-8 w-8 place-items-center rounded-full border border-zinc-300 text-zinc-700 hover:bg-zinc-50"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="w-5 text-center text-sm font-semibold tabular-nums">{qty}</span>
              <button
                type="button"
                onClick={onInc}
                aria-label={`One more ${name}`}
                className="grid h-8 w-8 place-items-center rounded-full bg-zinc-900 text-white hover:bg-zinc-700"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={simple ? onInc : onOpen}
              aria-label={`Add ${name}`}
              className="grid h-8 w-8 place-items-center rounded-full bg-zinc-900 text-white hover:bg-zinc-700"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
