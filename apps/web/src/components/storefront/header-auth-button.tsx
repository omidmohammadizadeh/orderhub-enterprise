"use client";

// Phase AP-AUTH increment 2b — persistent storefront header button.
//
// Two states, mutually exclusive:
//
//   1. Signed out → a person icon ("Sign in" beside it from sm up). Opens the
//      same LoginModal that the Place Order flow uses. A person, not an arrow:
//      an arrow reads as "go" or "leave", a person reads as "your account".
//
//   2. Signed in  → avatar (Google photo or initials). Opens a menu with
//      My orders, Rewards and Sign out.
//
// Both are 44px tall — the header is the one control a thumb reaches for
// while the page is still loading.

import { useEffect, useId, useRef, useState } from "react";
import { Heart, LogOut, Receipt, UserRound } from "lucide-react";
import type { Customer } from "../../hooks/use-customer-auth";
import { cn } from "@/lib/utils";

interface Props {
  customer: Customer | null;
  onSignInClick: () => void;
  onLogout: () => void;
  myOrdersHref?: string;
  rewardsHref?: string;
}

const RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sf-surface";

export function HeaderAuthButton({
  customer,
  onSignInClick,
  onLogout,
  myOrdersHref,
  rewardsHref,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  // Outside click and Escape close it; opening moves focus into the menu so
  // a keyboard user lands on "My orders", not back at the top of the page.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [],
        );
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "ArrowDown" ? at + 1 : at - 1;
        items[(next + items.length) % items.length]?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!customer) {
    return (
      <button
        type="button"
        onClick={onSignInClick}
        className={cn(
          "inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-full px-2.5 text-sm font-semibold text-sf-text",
          "transition-[background-color,transform] duration-150 hover:bg-sf-raised active:scale-[0.96] motion-reduce:transition-none sm:px-3.5",
          RING,
        )}
      >
        <UserRound className="h-5 w-5" aria-hidden />
        <span className="sr-only sm:not-sr-only">Sign in</span>
      </button>
    );
  }

  const initials =
    `${customer.firstName?.charAt(0) ?? ""}${customer.lastName?.charAt(0) ?? ""}`
      .toUpperCase()
      .slice(0, 2) || "?";

  const itemClass =
    "flex min-h-[44px] w-full items-center gap-3 px-4 text-left text-sm text-sf-text hover:bg-sf-raised focus-visible:bg-sf-raised focus-visible:outline-none";

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account: ${customer.firstName}`}
        className={cn(
          "grid h-11 w-11 place-items-center rounded-full transition-transform duration-150 active:scale-[0.96] motion-reduce:transition-none",
          RING,
        )}
      >
        {customer.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={customer.avatarUrl}
            alt=""
            className="h-9 w-9 rounded-full object-cover ring-1 ring-sf-border"
          />
        ) : (
          <span className="grid h-9 w-9 place-items-center rounded-full bg-sf-cta text-xs font-bold text-white">
            {initials}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-full z-50 mt-2 w-60 origin-top-right animate-fade-in overflow-hidden rounded-2xl border border-sf-border bg-sf-surface py-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.35)] motion-reduce:animate-none"
        >
          <div className="border-b border-sf-border px-4 py-3">
            <p className="truncate text-sm font-semibold text-sf-text">
              {customer.firstName} {customer.lastName}
            </p>
            {customer.email && (
              <p className="truncate text-xs text-sf-muted">{customer.email}</p>
            )}
          </div>
          {myOrdersHref && (
            <a role="menuitem" href={myOrdersHref} className={itemClass} onClick={() => setOpen(false)}>
              <Receipt className="h-4 w-4 text-sf-muted" aria-hidden />
              My orders
            </a>
          )}
          {rewardsHref && (
            <a role="menuitem" href={rewardsHref} className={itemClass} onClick={() => setOpen(false)}>
              <Heart className="h-4 w-4 text-sf-muted" aria-hidden />
              Rewards
            </a>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className={cn(itemClass, "border-t border-sf-border")}
          >
            <LogOut className="h-4 w-4 text-sf-muted" aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
