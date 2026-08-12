"use client";

// Step 1 of the till: who is this order for?
//
// The old POS opened straight onto the menu with the customer fields buried
// down the side of the cart, so the order type — the one decision that changes
// everything downstream, from whether an address is needed to how it can be
// paid — was a small toggle someone had to go looking for. Asking it first,
// in three large targets, is both faster on a touchscreen and harder to get
// wrong.
//
// What each type actually needs differs, and the form says so rather than
// demanding the same fields from everyone:
//
//   Walk-in    — nothing. They're at the counter; straight through to the menu.
//   Collection — a phone number, so the shop can ring them. A name is welcome
//                but never required; plenty of orders are taken faster without.
//   Delivery   — an address, always. A delivery order without one is a job the
//                driver can't do.
//
// Caller ID is untouched: it still fills the phone, name and last-used address
// through the same draft this screen reads and writes.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bike,
  ShoppingBag,
  Store,
  Phone,
  User,
  MapPin,
  ArrowRight,
  Loader2,
} from "lucide-react";
import {
  addressLookupClient,
  type AddressSuggestion,
} from "@/lib/api/pos.client";
import type { PartialDraft } from "./pos-cart-panel";
import { cn } from "@/lib/utils";

export type PosOrderType = "DELIVERY" | "COLLECTION" | "WALK_IN";

/** The draft's shape (fulfillmentType + walkIn) as one choice. */
export function orderTypeOf(draft: PartialDraft): PosOrderType | null {
  if (draft.walkIn) return "WALK_IN";
  if (draft.fulfillmentType === "DELIVERY") return "DELIVERY";
  if (draft.fulfillmentType === "PICKUP") return "COLLECTION";
  return null;
}

const TYPES: Array<{
  value: PosOrderType;
  label: string;
  hint: string;
  Icon: typeof Bike;
  accent: string;
}> = [
  {
    value: "DELIVERY",
    label: "Delivery",
    hint: "Driver takes it out",
    Icon: Bike,
    accent: "from-blue-500 to-blue-600",
  },
  {
    value: "COLLECTION",
    label: "Collection",
    hint: "Customer picks it up",
    Icon: ShoppingBag,
    accent: "from-violet-500 to-violet-600",
  },
  {
    value: "WALK_IN",
    label: "Walk-in",
    hint: "At the counter now",
    Icon: Store,
    accent: "from-emerald-500 to-emerald-600",
  },
];

export function PosStartScreen({
  draft,
  onDraftChange,
  onContinue,
  cartCount,
  tools,
}: {
  draft: PartialDraft;
  onDraftChange: (next: PartialDraft) => void;
  onContinue: () => void;
  /** Shown on the continue button when returning to a started order. */
  cartCount: number;
  /** Delivery fee, cash drawer, promos, service charge — kept on this step. */
  tools?: React.ReactNode;
}) {
  const type = orderTypeOf(draft);
  const set = (patch: Partial<PartialDraft>) =>
    onDraftChange({ ...draft, ...patch });

  const chooseType = (next: PosOrderType) =>
    set({
      walkIn: next === "WALK_IN",
      fulfillmentType: next === "DELIVERY" ? "DELIVERY" : "PICKUP",
    });

  // A delivery needs somewhere to go; collection needs a number to ring.
  // Walk-in needs nothing, which is the whole point of walk-in.
  const missing = useMemo(() => {
    if (type === "WALK_IN") return null;
    if (type === "COLLECTION") {
      return draft.customerPhone?.trim() ? null : "Add a phone number";
    }
    if (type === "DELIVERY") {
      if (!draft.customerPhone?.trim()) return "Add a phone number";
      if (!draft.addressLine1?.trim()) return "Add a delivery address";
      return null;
    }
    return "Choose an order type";
  }, [type, draft.customerPhone, draft.addressLine1]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 overflow-y-auto p-1 pb-28">
      {/* ── Order type ── */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {TYPES.map(({ value, label, hint, Icon, accent }) => {
          const active = type === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => chooseType(value)}
              aria-pressed={active}
              className={cn(
                "flex flex-col items-center gap-2 rounded-2xl border-2 px-3 py-5 transition-all sm:py-7",
                active
                  ? "border-zinc-900 bg-zinc-900 text-white shadow-lg"
                  : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50",
              )}
            >
              <span
                className={cn(
                  "flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br text-white sm:h-14 sm:w-14",
                  accent,
                )}
              >
                <Icon className="h-6 w-6 sm:h-7 sm:w-7" />
              </span>
              <span className="text-sm font-semibold sm:text-base">{label}</span>
              <span
                className={cn(
                  "text-[11px]",
                  active ? "text-zinc-300" : "text-zinc-400",
                )}
              >
                {hint}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Customer ── */}
      {type && type !== "WALK_IN" && (
        <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4">
          <Field label="Phone number" Icon={Phone} required>
            <input
              value={draft.customerPhone ?? ""}
              onChange={(e) => set({ customerPhone: e.target.value })}
              type="tel"
              inputMode="tel"
              autoFocus
              placeholder="07…"
              className="w-full rounded-lg border border-zinc-300 px-3 py-3 text-base outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
            />
          </Field>

          <Field
            label="Name"
            Icon={User}
            // Never required, on purpose — a collection order taken at speed
            // over the phone is a number and a basket, nothing more.
            hint="Optional"
          >
            <input
              value={draft.customerName ?? ""}
              onChange={(e) => set({ customerName: e.target.value })}
              placeholder="Customer name"
              className="w-full rounded-lg border border-zinc-300 px-3 py-3 text-base outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
            />
          </Field>

          {type === "DELIVERY" && (
            <AddressField draft={draft} set={set} />
          )}
        </div>
      )}

      {type === "WALK_IN" && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-5 text-center">
          <p className="text-sm font-medium text-emerald-800">
            Walk-in — no customer details needed.
          </p>
          <p className="mt-0.5 text-xs text-emerald-700">
            Straight to the menu.
          </p>
        </div>
      )}

      {/* ── Tools: delivery fee, cash drawer, promos, service charge ── */}
      {tools}

      {/* ── Continue ──
          Fixed to the bottom so it's under the thumb on a tablet, whatever
          the form above has grown to. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200 bg-white/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          {missing && (
            <span className="hidden text-xs text-zinc-500 sm:block">
              {missing}
            </span>
          )}
          <button
            type="button"
            onClick={onContinue}
            disabled={!!missing}
            className="ml-auto flex min-w-[12rem] items-center justify-center gap-2 rounded-xl bg-zinc-900 px-6 py-3.5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            {missing ?? (
              <>
                {cartCount > 0
                  ? `Back to order (${cartCount})`
                  : "Continue to menu"}
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  Icon,
  required,
  hint,
  children,
}: {
  label: string;
  Icon: typeof Phone;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-600">
        <Icon className="h-3.5 w-3.5 text-zinc-400" />
        {label}
        {required && <span className="text-red-500">*</span>}
        {hint && <span className="text-zinc-400">· {hint}</span>}
      </label>
      {children}
    </div>
  );
}

/**
 * Address with the same lookup the cart panel uses, so a postcode typed here
 * drives the delivery fee there — the fee logic stays in one place and this
 * screen only has to capture the address.
 */
function AddressField({
  draft,
  set,
}: {
  draft: PartialDraft;
  set: (patch: Partial<PartialDraft>) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddressSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [manual, setManual] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (manual || query.trim().length < 3) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      addressLookupClient
        .search(query, "gb", 5)
        .then((r) => !cancelled && setResults(r.suggestions ?? []))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setSearching(false));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, manual]);

  /** Mirrors the cart panel: only overwrite what the suggestion actually
   *  provides. The postcodes.io fallback returns an empty line1, and picking
   *  it must not wipe a building name someone has already typed. */
  const apply = (s: AddressSuggestion) =>
    set({
      ...(s.line1 ? { addressLine1: s.line1 } : {}),
      ...(s.line2 ? { addressLine2: s.line2 } : s.line1 ? { addressLine2: "" } : {}),
      ...(s.city ? { city: s.city } : {}),
      ...(s.postcode ? { postcode: s.postcode } : {}),
    });

  const pick = async (s: AddressSuggestion) => {
    apply(s);
    setQuery("");
    setResults([]);
    // Google returns only a label up front; the full address needs a second
    // call. Fill optimistically above so the field never goes blank, then
    // refine — exactly what the cart panel does.
    if (s.provider === "google") {
      try {
        const res = await addressLookupClient.details(s.id);
        if (res.suggestion) apply(res.suggestion);
      } catch {
        // Leave the optimistic fill; the manual fields are one tap away.
      }
    }
  };

  const chosen = draft.addressLine1?.trim();

  return (
    <Field label="Delivery address" Icon={MapPin} required>
      {chosen && !manual ? (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5">
          <div className="min-w-0 text-sm text-zinc-800">
            <div className="truncate">{draft.addressLine1}</div>
            <div className="truncate text-xs text-zinc-500">
              {[draft.addressLine2, draft.city, draft.postcode]
                .filter(Boolean)
                .join(", ")}
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              set({ addressLine1: "", addressLine2: "", city: "", postcode: "" })
            }
            className="flex-shrink-0 text-xs font-medium text-zinc-500 underline hover:text-zinc-900"
          >
            Change
          </button>
        </div>
      ) : (
        <div ref={boxRef} className="relative space-y-2">
          {!manual ? (
            <>
              <div className="relative">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Start typing a postcode or street…"
                  className="w-full rounded-lg border border-zinc-300 px-3 py-3 text-base outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
                />
                {searching && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-zinc-400" />
                )}
              </div>
              {results.length > 0 && (
                <div className="max-h-56 overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
                  {results.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => void pick(r)}
                      className="block w-full px-3 py-2.5 text-left text-sm hover:bg-zinc-50"
                    >
                      {r.label || r.line1}
                      {r.postcode && (
                        <span className="ml-1 text-xs text-zinc-400">
                          {r.postcode}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {/* Lookup fails, rural addresses don't exist in it, and the
                  phone is still ringing. Always leave a way through. */}
              <button
                type="button"
                onClick={() => setManual(true)}
                className="text-xs font-medium text-zinc-500 underline hover:text-zinc-900"
              >
                Enter the address manually
              </button>
            </>
          ) : (
            <div className="space-y-2">
              <input
                value={draft.addressLine1 ?? ""}
                onChange={(e) => set({ addressLine1: e.target.value })}
                placeholder="Address line 1"
                className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-zinc-900"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={draft.city ?? ""}
                  onChange={(e) => set({ city: e.target.value })}
                  placeholder="Town / city"
                  className="rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-zinc-900"
                />
                <input
                  value={draft.postcode ?? ""}
                  onChange={(e) =>
                    set({ postcode: e.target.value.toUpperCase() })
                  }
                  placeholder="Postcode"
                  className="rounded-lg border border-zinc-300 px-3 py-2.5 text-sm uppercase outline-none focus:border-zinc-900"
                />
              </div>
              <button
                type="button"
                onClick={() => setManual(false)}
                className="text-xs font-medium text-zinc-500 underline hover:text-zinc-900"
              >
                Search for an address instead
              </button>
            </div>
          )}
        </div>
      )}
      <p className="text-[11px] text-zinc-400">
        The postcode sets the delivery fee on the next step.
      </p>
    </Field>
  );
}
