"use client";

// The basket, out of the header and where a thumb or an eye already is.
//
//   • Phone / tablet (< 1024px): a bar pinned to the bottom, above the tab bar,
//     that slides up with the first item and nudges on every add after. It is
//     gone while the basket is empty — an empty "View basket" is a button that
//     leads nowhere.
//   • Desktop (≥ 1024px): a sticky panel beside the menu, so the basket is
//     visible the whole time and the bar never appears.
//
// Both only OPEN the checkout panel the page already has. Nothing here prices,
// stores or submits anything: the lines, totals and actions all come in as
// props from the page that owns the cart.

import { useEffect, useRef } from "react";
import { Minus, Plus, ShoppingBag } from "lucide-react";
import { cn } from "@/lib/utils";

export type BasketLineView = {
  id: string;
  name: string;
  detail?: string | null;
  quantity: number;
  lineTotal: string;
};

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const itemsLabel = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

type BasketBarProps = {
  count: number;
  total: string;
  label: string;
  onOpen: () => void;
  /** Shown with an empty basket — a claimable reward is an order on its own. */
  idleLabel?: string | null;
};

export const BasketBar = ({ count, total, label, onOpen, idleLabel }: BasketBarProps) => {
  const idle = count === 0 && !!idleLabel;
  const visible = count > 0 || idle;
  const bumpRef = useRef<HTMLDivElement | null>(null);
  const lastCount = useRef(count);

  // A small bounce whenever something is added — the confirmation that the
  // tap worked, without a toast covering the menu. The Web Animations API is
  // interruptible: a fast second tap restarts it rather than queueing.
  useEffect(() => {
    const grew = count > lastCount.current && lastCount.current > 0;
    lastCount.current = count;
    if (!grew || reducedMotion()) return;
    bumpRef.current?.animate(
      [
        { transform: "scale(1)" },
        { transform: "translateY(-4px) scale(1.03)" },
        { transform: "scale(0.99)" },
        { transform: "scale(1)" },
      ],
      { duration: 380, easing: "cubic-bezier(.3,.7,.4,1)" },
    );
  }, [count]);

  return (
    <>
      {/* Keeps the last menu row clear of the bar once it is showing. */}
      {visible && <div aria-hidden className="h-20 lg:hidden" />}
      <div
        className={cn(
          "fixed inset-x-0 z-40 px-3 lg:hidden",
          // Above the mobile tab bar (md:hidden); at md the tab bar is gone.
          "bottom-[calc(4.25rem+env(safe-area-inset-bottom)+0.5rem)] md:bottom-[calc(env(safe-area-inset-bottom)+1rem)]",
          "transition-[transform,opacity] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
          visible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-[calc(100%+6rem)] opacity-0",
        )}
        aria-hidden={!visible}
      >
        <div ref={bumpRef} className="mx-auto max-w-xl">
          <button
            type="button"
            onClick={onOpen}
            tabIndex={visible ? 0 : -1}
            aria-label={idle ? (idleLabel ?? label) : `${label}, ${itemsLabel(count)}, ${total}`}
            className={cn(
              "flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-sf-cta px-4 text-white",
              "shadow-[0_10px_30px_-10px_rgba(0,0,0,0.45)]",
              "transition-transform duration-150 active:scale-[0.98] motion-reduce:transition-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-sf-cta",
            )}
          >
            {idle ? (
              <span className="flex-1 text-center text-[15px] font-semibold">{idleLabel}</span>
            ) : (
              <>
                <span className="grid h-7 min-w-7 place-items-center rounded-md bg-white/20 px-1.5 text-sm font-bold tabular-nums">
                  {count}
                </span>
                <span className="flex-1 text-left text-[15px] font-semibold">{label}</span>
                <span className="text-[15px] font-semibold tabular-nums">{total}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
};

type BasketPanelProps = {
  title: string;
  lines: BasketLineView[];
  count: number;
  subtotal: string;
  ctaLabel: string;
  onCta: () => void;
  onInc?: (id: string) => void;
  onDec?: (id: string) => void;
  /** Under the total — e.g. "Delivery and offers are worked out at checkout". */
  footnote?: string;
  ctaDisabled?: boolean;
  /** Offered while empty, e.g. claiming a loyalty reward with no other items. */
  emptyAction?: { label: string; onClick: () => void } | null;
};

export const BasketPanel = ({
  title,
  lines,
  count,
  subtotal,
  ctaLabel,
  onCta,
  onInc,
  onDec,
  footnote,
  ctaDisabled,
  emptyAction,
}: BasketPanelProps) => {
  const empty = count === 0;
  return (
    <aside
      aria-label="Basket"
      className="sticky top-20 mt-6 hidden max-h-[calc(100vh-6rem)] flex-col self-start overflow-hidden rounded-2xl border border-sf-border bg-sf-surface lg:flex"
    >
      <h2 className="border-b border-sf-border px-5 py-4 text-base font-semibold text-sf-text">
        {title}
      </h2>

      {empty ? (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-sf-raised text-sf-muted">
            <ShoppingBag className="h-5 w-5" aria-hidden />
          </span>
          <p className="mt-3 text-sm font-semibold text-sf-text">Your basket is empty</p>
          <p className="mt-1 text-[13px] text-sf-muted">
            Add something from the menu to get started.
          </p>
          {emptyAction && (
            <button
              type="button"
              onClick={emptyAction.onClick}
              className="mt-4 inline-flex min-h-[44px] items-center rounded-full border border-sf-border px-4 text-sm font-semibold text-sf-text hover:bg-sf-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent"
            >
              {emptyAction.label}
            </button>
          )}
        </div>
      ) : (
        <>
          {lines.length > 0 && (
            <ul className="min-h-0 flex-1 divide-y divide-sf-border overflow-y-auto px-5">
              {lines.map((l) => (
                <li key={l.id} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-sf-text [overflow-wrap:anywhere]">
                      {l.name}
                    </p>
                    {l.detail && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-sf-muted">{l.detail}</p>
                    )}
                    <p className="mt-1 text-[13px] font-medium tabular-nums text-sf-text">
                      {l.lineTotal}
                    </p>
                  </div>
                  {onInc && onDec && (
                    <div className="-mr-2 flex items-center">
                      <PanelStep label={`Remove one ${l.name}`} onClick={() => onDec(l.id)}>
                        <Minus className="h-3.5 w-3.5" aria-hidden />
                      </PanelStep>
                      <span className="w-5 text-center text-sm font-semibold tabular-nums text-sf-text">
                        {l.quantity}
                      </span>
                      <PanelStep label={`Add another ${l.name}`} onClick={() => onInc(l.id)}>
                        <Plus className="h-3.5 w-3.5" aria-hidden />
                      </PanelStep>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-sf-border px-5 py-4">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-sf-muted">
                Subtotal · {itemsLabel(count)}
              </span>
              <span className="font-semibold tabular-nums text-sf-text">{subtotal}</span>
            </div>
            {footnote && <p className="mt-1 text-xs text-sf-muted">{footnote}</p>}
            <button
              type="button"
              onClick={onCta}
              disabled={ctaDisabled}
              className={cn(
                "mt-4 flex min-h-[48px] w-full items-center justify-center rounded-xl bg-sf-cta px-4 text-[15px] font-semibold text-white",
                "transition-[transform,filter] duration-150 hover:brightness-110 active:scale-[0.98] motion-reduce:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sf-surface",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100",
              )}
            >
              {ctaLabel}
            </button>
          </div>
        </>
      )}
    </aside>
  );
};

const PanelStep = ({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    aria-label={label}
    onClick={onClick}
    className="group/step grid h-11 w-11 place-items-center rounded-full focus-visible:outline-none"
  >
    <span className="grid h-8 w-8 place-items-center rounded-full border border-sf-border text-sf-text transition-colors group-hover/step:bg-sf-raised group-focus-visible/step:ring-2 group-focus-visible/step:ring-sf-accent">
      {children}
    </span>
  </button>
);
