"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPin } from "lucide-react";
import { postcodeRequiredFor, zoneMode, areaZoneNames } from "@orderhub/shared";
import { useCurrency } from "@/hooks/use-currency";
import {
  addressLookupClient,
  deliveryZonesClient,
  type AddressSuggestion,
  type DeliveryZone,
} from "@/lib/api/pos.client";


const sameArea = (a: string, b: string) =>
  a.trim().toLowerCase().replace(/\s+/g, " ") ===
  b.trim().toLowerCase().replace(/\s+/g, " ");

function Field({
  label,
  Icon,
  required,
  children,
}: {
  label: string;
  Icon: typeof MapPin;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-600">
        <Icon className="h-3.5 w-3.5 text-zinc-400" />
        {label}
        {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}

export interface DeliveryAddressValue {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postcode?: string;
  area?: string;
}

/**
 * The delivery address, searched the way the till searches it.
 *
 * Lifted out of the POS start screen so the order card's collection→delivery
 * switch uses the SAME field rather than a second, thinner copy. A duplicate
 * would drift — this codebase has already paid for that with four copies of
 * "are we still waiting to be paid" — and the two places would quietly
 * disagree about what counts as a valid address.
 *
 * locationId is a prop, not the location switcher: the switch is acting on ONE
 * order, whose shop may not be the one the operator happens to be looking at.
 */
export function DeliveryAddressField({
  draft,
  set,
  locationId,
  label = "Delivery address",
}: {
  draft: DeliveryAddressValue;
  set: (patch: Partial<DeliveryAddressValue>) => void;
  locationId?: string | null;
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddressSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
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
    <Field label={label} Icon={MapPin} required>
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

