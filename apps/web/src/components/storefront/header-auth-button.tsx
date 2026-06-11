"use client";

// Phase AP-AUTH increment 2b — persistent storefront header button.
//
// Two states, mutually exclusive:
//
//   1. Signed out → "Sign in" button. Opens the same LoginModal that
//      the Place Order flow uses, so the experience is consistent.
//
//   2. Signed in  → avatar (Google photo or initials) + first name +
//      caret. Clicking opens a small dropdown with "My orders" and
//      "Sign out".
//
// Sized to sit next to the cart pill without crowding it on mobile
// (320px viewport). The first-name + caret is hidden below sm so a
// signed-in customer only sees the avatar.

import { useState, useRef, useEffect } from "react";
import { LogIn, LogOut, ChevronDown, ShoppingBag } from "lucide-react";
import type { Customer } from "../../hooks/use-customer-auth";

interface Props {
  customer: Customer | null;
  onSignInClick: () => void;
  onLogout: () => void;
  /** Optional My-Orders link target — wired in increment 2c. */
  myOrdersHref?: string;
}

export function HeaderAuthButton({
  customer,
  onSignInClick,
  onLogout,
  myOrdersHref,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown on outside-click. Cheap enough not to need
  // a portal or library here.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!customer) {
    return (
      <button
        onClick={onSignInClick}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
      >
        <LogIn className="h-4 w-4" />
        <span className="hidden sm:inline">Sign in</span>
      </button>
    );
  }

  const initials =
    `${customer.firstName.charAt(0) ?? ""}${customer.lastName.charAt(0) ?? ""}`
      .toUpperCase()
      .slice(0, 2) || "?";

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((s) => !s)}
        className="inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
      >
        {customer.avatarUrl ? (
          <img
            src={customer.avatarUrl}
            alt=""
            className="h-6 w-6 rounded-full object-cover"
          />
        ) : (
          <span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">
            {initials}
          </span>
        )}
        <span className="hidden sm:inline">{customer.firstName}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-zinc-100 bg-white shadow-xl">
          <div className="border-b border-zinc-100 px-3 py-2">
            <p className="truncate text-xs font-semibold text-zinc-900">
              {customer.firstName} {customer.lastName}
            </p>
            <p className="truncate text-[10px] text-zinc-500">{customer.email}</p>
          </div>
          {myOrdersHref && (
            <a
              href={myOrdersHref}
              className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
              onClick={() => setOpen(false)}
            >
              <ShoppingBag className="h-4 w-4 text-zinc-400" />
              My orders
            </a>
          )}
          <button
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
          >
            <LogOut className="h-4 w-4 text-zinc-400" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
