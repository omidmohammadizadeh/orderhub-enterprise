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

import { useEffect, useMemo, useState } from "react";
import {
  Bike,
  ShoppingBag,
  Store,
  Phone,
  User,
  MapPin,
  ArrowRight,
  Loader2,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  addressLookupClient,
  deliveryZonesClient,
  type AddressSuggestion,
  type DeliveryZone,
} from "@/lib/api/pos.client";
import {
  zoneMode,
  areaZoneNames,
  normaliseAreaName,
  postcodeRequiredFor,
} from "@orderhub/shared";
import { useCurrency } from "@/hooks/use-currency";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

/** Same community, allowing for spelling and the Arabic article. */
const sameArea = (a: string, b: string) =>
  normaliseAreaName(a) === normaliseAreaName(b);
import type { PartialDraft } from "./pos-cart-panel";
import { cn } from "@/lib/utils";
import { apiClient } from "@/lib/api/client";

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
}: {
  draft: PartialDraft;
  onDraftChange: (next: PartialDraft) => void;
  onContinue: () => void;
  /** Shown on the continue button when returning to a started order. */
  cartCount: number;
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

          {/* Recognise the number as it is typed, the same way an incoming
              call is recognised. Offered, never applied on its own. */}
          <KnownCustomer
            phone={draft.customerPhone ?? ""}
            onUse={(m, address) =>
              set({
                customerName: m.name,
                ...(address
                  ? {
                      addressLine1: address.line1,
                      addressLine2: address.line2 ?? "",
                      city: address.city ?? "",
                      postcode: address.postcode ?? "",
                    }
                  : {}),
              })
            }
          />

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
 * Address with the same lookup the cart panel uses, so what's typed here drives
 * the delivery fee there — the fee logic stays in one place and this screen
 * only has to capture the address.
 *
 * Which fields it asks for follows the shop. A UK shop wants a postcode; a
 * Dubai shop wants the community, because that is what its zones price on and
 * its customers have no postcode to give.
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
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { country } = useCurrency();
  const needsPostcode = postcodeRequiredFor(country);
  const zonesQuery = useQuery<DeliveryZone[]>({
    queryKey: ["delivery-zones", locationId],
    queryFn: () => deliveryZonesClient.list(locationId!),
    enabled: !!locationId,
    staleTime: 60_000,
  });
  const zones = zonesQuery.data ?? [];
  const byArea = zoneMode(zones as any) === "AREA";
  const areas = areaZoneNames(zones as any);

  useEffect(() => {
    if (query.trim().length < 3) {
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
  }, [query]);

  /** Mirrors the cart panel: only overwrite what the suggestion actually
   *  provides. The postcodes.io fallback returns an empty line1, and picking
   *  it must not wipe a building name someone has already typed. */
  const apply = (s: AddressSuggestion) =>
    set({
      ...(s.line1 ? { addressLine1: s.line1 } : {}),
      ...(s.line2 ? { addressLine2: s.line2 } : s.line1 ? { addressLine2: "" } : {}),
      ...(s.city ? { city: s.city } : {}),
      ...(s.postcode ? { postcode: s.postcode } : {}),
      // Preselect the community when the lookup named one this shop serves.
      // Exact match only — a neighbouring area we happen to know the name of
      // is not the same as one we've agreed to deliver to.
      ...(s.area && areas.some((a) => sameArea(a, s.area!))
        ? { area: areas.find((a) => sameArea(a, s.area!)) }
        : {}),
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

  return (
    <Field label="Delivery address" Icon={MapPin} required>
      {/* Search first — one tap fills the four fields below. */}
      <div className="relative">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a postcode or street…"
          className="w-full rounded-lg border border-zinc-300 px-3 py-3 text-base outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
        />
        {searching && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-zinc-400" />
        )}
        {results.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-lg">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => void pick(r)}
                className="block w-full px-3 py-2.5 text-left text-sm hover:bg-zinc-50"
              >
                {r.label || r.line1}
                {r.postcode && (
                  <span className="ml-1 text-xs text-zinc-400">{r.postcode}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ...and the parts stay visible and editable.
          A lookup result is a starting point, not the answer: it never knows
          the flat number, it misses new builds, and caller ID fills these in
          from the customer's last order. Hiding them behind a "change" button
          made the one field a driver actually needs — which flat — the
          hardest to reach. */}
      <div className="mt-2 grid grid-cols-3 gap-2">
        <input
          value={draft.addressLine2 ?? ""}
          onChange={(e) => set({ addressLine2: e.target.value })}
          placeholder="Flat / house no."
          aria-label="Flat or house number"
          className="col-span-1 rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-zinc-900"
        />
        <input
          value={draft.addressLine1 ?? ""}
          onChange={(e) => set({ addressLine1: e.target.value })}
          placeholder="Address line"
          aria-label="Address line"
          className="col-span-2 rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-zinc-900"
        />
        <input
          value={draft.city ?? ""}
          onChange={(e) => set({ city: e.target.value })}
          placeholder={needsPostcode ? "City" : "City / emirate"}
          aria-label="City"
          className={
            needsPostcode
              ? "col-span-2 rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-zinc-900"
              : "col-span-3 rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-zinc-900"
          }
        />
        {needsPostcode && (
          <input
            value={draft.postcode ?? ""}
            onChange={(e) => set({ postcode: e.target.value.toUpperCase() })}
            placeholder="Postcode"
            aria-label="Postcode"
            className="col-span-1 rounded-lg border border-zinc-300 px-3 py-2.5 text-sm uppercase outline-none focus:border-zinc-900"
          />
        )}
        {byArea && (
          <select
            value={draft.area ?? ""}
            onChange={(e) => set({ area: e.target.value })}
            aria-label="Delivery area"
            className="col-span-3 rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-zinc-900"
          >
            <option value="">Choose delivery area…</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="text-[11px] text-zinc-400">
        {byArea
          ? "The area sets the delivery fee on the next step."
          : "The postcode sets the delivery fee on the next step."}
      </p>
    </Field>
  );
}

/**
 * Recognise a returning customer from a typed phone number.
 *
 * The landline popup already does this when a call comes IN — same endpoint,
 * same tenant-scoped match against the last year of orders. A number typed at
 * the counter is the same question asked a different way, so it gets the same
 * answer rather than making staff re-key a regular's address.
 *
 * Never fills anything on its own. It offers what it found and waits to be
 * tapped: silently rewriting a name or address under someone mid-order is how
 * an order goes to last month's address.
 */
function KnownCustomer({
  phone,
  onUse,
}: {
  phone: string;
  onUse: (m: LookupMatch, address: LookupMatch["addresses"][number] | null) => void;
}) {
  const [match, setMatch] = useState<LookupMatch | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, "");
  useEffect(() => {
    // A UK mobile is 11 digits; below 7 every regular in the shop matches and
    // the card would flicker through wrong people as the number is typed.
    if (digits.length < 7) {
      setMatch(null);
      return;
    }
    let live = true;
    // Debounced: one request when typing pauses, not one per keystroke.
    const t = setTimeout(() => {
      apiClient
        .get<LookupMatch | null>("/v1/customers/lookup", { params: { phone: digits } })
        .then((r) => {
          if (live) setMatch(r.data ?? null);
        })
        // A failed lookup is not an error worth showing: the operator can
        // always type the details, which is what they did before this existed.
        .catch(() => {
          if (live) setMatch(null);
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [digits]);

  if (!match || dismissed === digits) return null;
  const firstName = (match.name ?? "").split(" ")[0] || "this customer";

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-900">
            <User className="h-3.5 w-3.5" />
            {match.name}
          </p>
          <p className="text-[11px] text-emerald-700">
            {match.orders} previous order{match.orders === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(digits)}
          className="rounded p-1 text-emerald-700/60 hover:bg-emerald-100 hover:text-emerald-900"
          title="Not this customer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 space-y-1.5">
        {match.addresses.map((a, i) => (
          <button
            key={`${a.line1}-${a.postcode ?? i}`}
            type="button"
            onClick={() => onUse(match, a)}
            className="block w-full rounded-lg border border-emerald-200 bg-white px-3 py-2 text-left text-xs hover:border-emerald-400"
          >
            <span className="font-medium text-zinc-900">{a.line1}</span>
            {(a.city || a.postcode) && (
              <span className="block text-zinc-500">
                {[a.city, a.postcode].filter(Boolean).join(", ")}
              </span>
            )}
          </button>
        ))}
        {/* Collection orders need the name, not an address — and a delivery
            customer ordering to a new address still wants their name filled. */}
        <button
          type="button"
          onClick={() => onUse(match, null)}
          className="block w-full rounded-lg border border-emerald-200 bg-white px-3 py-2 text-left text-xs font-medium text-emerald-800 hover:border-emerald-400"
        >
          Use {firstName}&rsquo;s name only
        </button>
      </div>
    </div>
  );
}

interface LookupMatch {
  name: string;
  orders: number;
  email: string | null;
  addresses: Array<{
    line1: string;
    line2: string | null;
    city: string | null;
    postcode: string | null;
  }>;
}
