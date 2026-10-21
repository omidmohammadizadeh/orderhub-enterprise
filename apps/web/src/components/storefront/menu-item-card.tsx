"use client";

// One menu item, the same shape on a phone and a laptop: name, two lines of
// description and the price on the left, the photo on the right with a quick
// "+" sitting on its corner. That is the layout every delivery app has taught
// customers to scan, so nobody has to learn ours.
//
// Two targets, never nested: the card itself opens the item sheet (photo,
// full description, options), and the "+" is a sibling button laid over the
// photo. A button inside a button is invalid HTML and a screen reader reads
// it as one control, so the "+" is positioned, not nested.

import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { MenuItem } from "@/lib/api/menus.client";
import { displayPrice } from "@/lib/menu/display-price";
import { cn } from "@/lib/utils";
import { FoodPlaceholder } from "./food-placeholder";

type Promo = { percentageOff: number; campaignName: string };

type Stepper = { qty: number; onInc: () => void; onDec: () => void };

type MenuItemCardProps = {
  item: MenuItem;
  /** Bound to THIS store's currency by the page — never format money here. */
  money: (n: number | string | null | undefined) => string;
  promo: Promo | null;
  bogoTrigger?: boolean;
  showImage?: boolean;
  /** Category name — picks the placeholder graphic when the dish name is silent. */
  categoryName?: string;
  /** Tapping the card: see the item before adding. */
  onOpen: () => void;
  /** The "+": add straight away, or open the sheet when there are options. */
  onQuickAdd: () => void;
  /** Items with nothing to choose show −/qty/+ once one is in the basket. */
  stepper?: Stepper | null;
  /** Shop paused: browsing only. */
  disabled?: boolean;
};

const PRESS = "transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";

export const MenuItemCard = ({
  item,
  money,
  promo,
  bogoTrigger,
  showImage = true,
  categoryName,
  onOpen,
  onQuickAdd,
  stepper,
  disabled,
}: MenuItemCardProps) => {
  const { amount: base, from: fromSize } = displayPrice(item as any);
  const hasPromo = !!promo && promo.percentageOff > 0;
  const price = hasPromo
    ? Math.round(base * (1 - promo.percentageOff / 100) * 100) / 100
    : base;
  // A dead image URL is as common as a missing one; fall back to the drawing.
  const [imgFailed, setImgFailed] = useState(false);
  const soldOut = !!item.outOfStock;
  const canAdd = !soldOut && !disabled;
  const qty = stepper?.qty ?? 0;

  return (
    <article
      className={cn(
        "group relative rounded-2xl border border-sf-border bg-sf-surface",
        "transition-[border-color,box-shadow] duration-150 hover:border-sf-border-strong hover:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.18)]",
        soldOut && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={soldOut || disabled}
        aria-label={`${item.name}, ${fromSize ? "from " : ""}${money(price)}${soldOut ? ", sold out" : ""}`}
        className={cn(
          "flex w-full items-stretch gap-3 rounded-2xl p-3 text-left sm:p-4",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sf-bg",
          "disabled:cursor-default",
          PRESS,
          !showImage && canAdd && "pr-16",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="text-[15px] font-semibold leading-snug text-sf-text [overflow-wrap:anywhere] [text-wrap:pretty]">
            {item.name}
          </h3>
          {item.description && (
            <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-sf-muted [overflow-wrap:anywhere]">
              {item.description}
            </p>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-2">
            {fromSize && (
              <span className="text-[12px] font-medium text-sf-muted">From</span>
            )}
            <span
              className={cn(
                "text-[15px] font-semibold tabular-nums",
                hasPromo ? "text-sf-promo" : "text-sf-text",
              )}
            >
              {money(price)}
            </span>
            {hasPromo && (
              <>
                <span className="text-[13px] tabular-nums text-sf-muted line-through">
                  {money(base)}
                </span>
                <Badge tone="promo">-{promo.percentageOff}%</Badge>
              </>
            )}
            {bogoTrigger && !hasPromo && <Badge tone="bogo">Buy 1 get 1 free</Badge>}
            {soldOut && <Badge tone="muted">Sold out</Badge>}
          </div>
        </div>

        {showImage && (
          <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl bg-sf-raised sm:h-28 sm:w-28">
            {item.imageUrl && !imgFailed ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.imageUrl}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => setImgFailed(true)}
                className="h-full w-full object-cover"
              />
            ) : (
              <FoodPlaceholder
                name={item.name}
                hint={categoryName}
                className="h-full w-full"
              />
            )}
            {/* Hairline so a white plate on a white card still has an edge. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-black/5"
            />
          </div>
        )}
      </button>

      {canAdd && (
        <div
          className={cn(
            "absolute",
            showImage
              ? "bottom-1 right-1 sm:bottom-2 sm:right-2"
              : "right-2 top-1/2 -translate-y-1/2",
          )}
        >
          {stepper && qty > 0 ? (
            <div className="flex items-center rounded-full bg-sf-surface shadow-[0_2px_10px_-2px_rgba(0,0,0,0.25)] ring-1 ring-sf-border">
              <RoundButton label={`Remove one ${item.name}`} onClick={stepper.onDec} tone="plain">
                <Minus className="h-4 w-4" aria-hidden />
              </RoundButton>
              <span
                className="min-w-[1.25rem] text-center text-sm font-semibold tabular-nums text-sf-text"
                aria-live="polite"
              >
                {qty}
              </span>
              <RoundButton label={`Add another ${item.name}`} onClick={stepper.onInc} tone="solid">
                <Plus className="h-4 w-4" aria-hidden />
              </RoundButton>
            </div>
          ) : (
            <RoundButton
              label={`Add ${item.name}`}
              onClick={stepper ? stepper.onInc : onQuickAdd}
              tone="solid"
            >
              <Plus className="h-5 w-5" aria-hidden />
            </RoundButton>
          )}
        </div>
      )}
    </article>
  );
};

/** 44px hit area around a smaller visual circle. */
const RoundButton = ({
  label,
  onClick,
  tone,
  children,
}: {
  label: string;
  onClick: () => void;
  tone: "solid" | "plain";
  children: React.ReactNode;
}) => (
  <button
    type="button"
    aria-label={label}
    onClick={onClick}
    className={cn(
      "group/btn grid h-11 w-11 place-items-center rounded-full focus-visible:outline-none",
      PRESS,
    )}
  >
    <span
      className={cn(
        "grid h-9 w-9 place-items-center rounded-full transition-colors duration-150",
        "group-focus-visible/btn:ring-2 group-focus-visible/btn:ring-sf-accent group-focus-visible/btn:ring-offset-2 group-focus-visible/btn:ring-offset-sf-surface",
        tone === "solid"
          ? "bg-sf-cta text-white shadow-[0_2px_8px_-2px_rgba(0,0,0,0.35)] group-hover/btn:brightness-110"
          : "text-sf-text group-hover/btn:bg-sf-raised",
      )}
    >
      {children}
    </span>
  </button>
);

const Badge = ({
  tone,
  children,
}: {
  tone: "promo" | "bogo" | "muted";
  children: React.ReactNode;
}) => (
  <span
    className={cn(
      "rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-none",
      tone === "promo" && "bg-red-600 text-white",
      tone === "bogo" && "bg-pink-600 text-white",
      tone === "muted" && "bg-sf-raised text-sf-muted",
    )}
  >
    {children}
  </span>
);

/** Placeholder card while the menu loads — same footprint, no layout jump. */
export const MenuItemCardSkeleton = () => (
  <div
    aria-hidden
    className="flex items-stretch gap-3 rounded-2xl border border-sf-border bg-sf-surface p-3 sm:p-4"
  >
    <div className="flex flex-1 flex-col gap-2 py-0.5">
      <div className="sf-skeleton h-4 w-3/5 rounded" />
      <div className="sf-skeleton h-3 w-full rounded" />
      <div className="sf-skeleton h-3 w-4/5 rounded" />
      <div className="sf-skeleton mt-auto h-4 w-16 rounded" />
    </div>
    <div className="sf-skeleton h-24 w-24 shrink-0 rounded-xl sm:h-28 sm:w-28" />
  </div>
);
