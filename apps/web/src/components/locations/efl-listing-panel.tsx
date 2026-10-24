"use client";

// Locations → Brands → Eat For Less.
//
// A shop's own listing in the Eat For Less app. One listing per LOCATION,
// shown under whichever brand the shop picks, so this panel lives in each
// brand's grid and offers to switch the listing to that brand when it shows
// another one. Commission and approval are Eat For Less's: shown, not edited.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { PlatformLogo } from "@/components/ui/platform-logo";
import {
  EFL_CUISINES,
  eflClient,
  type EflDeliveryMode,
  type EflShopListing,
  type EflShopListingUpdate,
} from "@/lib/api/efl.client";

const DELIVERY_MODES: Array<{ value: EflDeliveryMode; title: string; hint: string }> = [
  { value: "OWN_DRIVERS", title: "Own drivers", hint: "Your drivers use the OrderHub driver app. Customers see them live." },
  { value: "COURIER", title: "Courier", hint: "Every order goes to a courier through Auto dispatch." },
  { value: "OWN_THEN_COURIER", title: "Own drivers, courier backup", hint: "A courier is booked only when no driver of yours is free." },
];

export function eflListingQueryKey(locationId: string) {
  return ["efl-listing", locationId] as const;
}

/** What the tile shows: one word for where the listing stands. */
export function eflTileStatus(
  listing: EflShopListing | undefined,
): "connected" | "pending" | "suspended" | "not_connected" {
  if (!listing?.listed) return "not_connected";
  if (listing.live) return "connected";
  if (listing.status === "SUSPENDED" || listing.hiddenReason) return "suspended";
  return "pending";
}

export function EflListingPanel({
  locationId,
  brandId,
  brandName,
}: {
  locationId: string;
  brandId: string;
  brandName: string;
}) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: eflListingQueryKey(locationId),
    queryFn: () => eflClient.getListing(locationId),
  });
  const listing = query.data;

  const [draft, setDraft] = useState<EflShopListingUpdate>({});
  useEffect(() => setDraft({}), [listing]);

  const save = useMutation({
    mutationFn: (patch: EflShopListingUpdate) => eflClient.updateListing(locationId, patch),
    onSuccess: (next) => {
      qc.setQueryData(eflListingQueryKey(locationId), next);
      toast.success("Eat For Less listing saved");
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? "Couldn't save the listing"),
  });

  if (query.isLoading || !listing) {
    return (
      <li className="flex items-center gap-2 rounded-xl border border-zinc-200 px-4 py-6 text-xs text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading Eat For Less…
      </li>
    );
  }

  const value = <K extends keyof EflShopListingUpdate>(k: K) =>
    (k in draft ? draft[k] : (listing as any)[k]) as EflShopListing[K & keyof EflShopListing];
  const set = (patch: EflShopListingUpdate) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = Object.keys(draft).length > 0;
  const showsOtherBrand = !!listing.brandId && listing.brandId !== brandId;
  const cuisines = (value("cuisines") ?? []) as string[];

  return (
    <li className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3">
        <div className="flex items-center gap-3">
          <PlatformLogo platform={"EAT_FOR_LESS" as any} size={44} />
          <div>
            <p className="text-sm font-semibold text-zinc-900">Eat For Less</p>
            <p className="text-[11px] text-zinc-500">
              Show this shop in the Eat For Less app. Orders arrive here like any other platform.
            </p>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-zinc-900">
          {listing.listed ? "Listed" : "Not listed"}
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={listing.listed}
            disabled={save.isPending}
            onChange={(e) =>
              save.mutate({ listed: e.target.checked, ...(listing.brandId ? {} : { brandId }) })
            }
          />
          <span
            aria-hidden="true"
            className="relative h-6 w-11 rounded-full bg-zinc-300 transition-colors peer-checked:bg-zinc-900 peer-focus-visible:ring-2 peer-focus-visible:ring-zinc-900/30 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5"
          />
        </label>
      </div>

      <StatusLine listing={listing} />

      {showsOtherBrand && (
        <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          <span>This shop is listed under another of your brands.</span>
          <button
            type="button"
            className="rounded-md bg-amber-900 px-2.5 py-1 font-semibold text-white hover:bg-amber-950"
            onClick={() => save.mutate({ brandId })}
          >
            Show {brandName} instead
          </button>
        </div>
      )}

      <div className="grid gap-4 px-4 py-4 sm:grid-cols-3">
        <Field label="Commission">
          <div className="flex h-10 items-center justify-between rounded-lg bg-zinc-100 px-3 text-sm">
            <span className="font-bold tabular-nums">{listing.commissionPercent}% per order</span>
            <span className="text-[10px] text-zinc-500">Set by Eat For Less</span>
          </div>
        </Field>
        <Toggle
          label="Delivery"
          checked={!!value("acceptsDelivery")}
          onChange={(v) => set({ acceptsDelivery: v })}
        />
        <Toggle
          label="Collection"
          checked={!!value("acceptsCollection")}
          onChange={(v) => set({ acceptsCollection: v })}
        />
      </div>

      <fieldset className="px-4">
        <legend className="mb-2 text-xs font-semibold text-zinc-700">Who delivers Eat For Less orders</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {DELIVERY_MODES.map((m) => {
            const on = value("deliveryMode") === m.value;
            return (
              <label
                key={m.value}
                className={
                  "cursor-pointer rounded-lg border-2 p-3 transition-colors " +
                  (on ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300")
                }
              >
                <input
                  type="radio"
                  name={`efl-delivery-${locationId}`}
                  className="sr-only"
                  checked={on}
                  onChange={() => set({ deliveryMode: m.value })}
                />
                <span className="block text-xs font-semibold text-zinc-900">{m.title}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">{m.hint}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
        <Field label="Description in the app" htmlFor={`efl-desc-${locationId}`}>
          <textarea
            id={`efl-desc-${locationId}`}
            rows={3}
            maxLength={400}
            value={(value("description") as string) ?? ""}
            onChange={(e) => set({ description: e.target.value || null })}
            placeholder="Stone-baked pizza and kebabs, made to order in Westerhope."
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </Field>
        <div className="grid gap-3">
          <Field label="Header photo (image URL)" htmlFor={`efl-hero-${locationId}`}>
            <input
              id={`efl-hero-${locationId}`}
              type="url"
              value={(value("heroImageUrl") as string) ?? ""}
              onChange={(e) => set({ heroImageUrl: e.target.value || null })}
              placeholder="https://…"
              className="h-10 w-full rounded-lg border border-zinc-300 px-3 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            />
          </Field>
          <Field label="Logo (image URL) — blank uses the brand logo" htmlFor={`efl-logo-${locationId}`}>
            <input
              id={`efl-logo-${locationId}`}
              type="url"
              value={(value("logoUrl") as string) ?? ""}
              onChange={(e) => set({ logoUrl: e.target.value || null })}
              placeholder="https://…"
              className="h-10 w-full rounded-lg border border-zinc-300 px-3 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            />
          </Field>
        </div>
      </div>

      <fieldset className="px-4">
        <legend className="mb-2 text-xs font-semibold text-zinc-700">Cuisines (up to 3 work best)</legend>
        <div className="flex flex-wrap gap-2">
          {EFL_CUISINES.map((c) => {
            const on = cuisines.includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  set({ cuisines: on ? cuisines.filter((x) => x !== c) : [...cuisines, c].slice(0, 8) })
                }
                className={
                  "min-h-8 rounded-full px-3 text-xs font-semibold transition-colors " +
                  (on ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200")
                }
              >
                {c}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 bg-zinc-50 px-4 py-3">
        <p className="text-[11px] text-zinc-500">
          Prices: the app uses your online menu. To charge different prices on Eat For Less, pick a price list
          for Eat For Less in Brand settings → Channels.
        </p>
        <div className="flex gap-2">
          {dirty && (
            <button
              type="button"
              onClick={() => setDraft({})}
              className="h-9 rounded-lg px-3 text-xs font-semibold text-zinc-600 hover:bg-zinc-100"
            >
              Discard
            </button>
          )}
          <button
            type="button"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate(draft)}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-4 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Save changes
          </button>
        </div>
      </div>
    </li>
  );
}

function StatusLine({ listing }: { listing: EflShopListing }) {
  let tone = "bg-zinc-50 text-zinc-600";
  let text = "Not listed. Switch it on to show this shop in the Eat For Less app.";
  if (listing.listed) {
    if (listing.live) {
      tone = "bg-lime-50 text-lime-900";
      text = "Live in the Eat For Less app.";
    } else if (listing.status === "SUSPENDED") {
      tone = "bg-red-50 text-red-800";
      text = "Paused by Eat For Less. Contact the Eat For Less team.";
    } else if (listing.hiddenReason === "HYGIENE") {
      tone = "bg-red-50 text-red-800";
      text = "Hidden: your food hygiene rating is below the minimum. It comes back automatically when it improves.";
    } else if (listing.hiddenReason) {
      tone = "bg-amber-50 text-amber-900";
      text = "Hidden from the app for now. It comes back automatically.";
    } else {
      tone = "bg-amber-50 text-amber-900";
      text = "Waiting for Eat For Less to approve this shop. We'll email you when it's live.";
    }
  }
  return (
    <p role="status" className={`mx-4 mt-3 rounded-lg px-3 py-2 text-[11px] font-medium ${tone}`}>
      {text}
    </p>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-semibold text-zinc-700">
        {label}
      </label>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer flex-col gap-1.5">
      <span className="text-xs font-semibold text-zinc-700">{label}</span>
      <span className="flex h-10 items-center justify-between rounded-lg border border-zinc-200 px-3 text-sm">
        {checked ? "On" : "Off"}
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          aria-hidden="true"
          className="relative h-5 w-9 rounded-full bg-zinc-300 transition-colors peer-checked:bg-zinc-900 peer-focus-visible:ring-2 peer-focus-visible:ring-zinc-900/30 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-4"
        />
      </span>
    </label>
  );
}
