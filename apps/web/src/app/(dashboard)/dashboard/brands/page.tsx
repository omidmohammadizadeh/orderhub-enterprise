"use client";

// Brands — the canonical home for a brand and its ordering channels.
//
// Brands own the things being configured here: Stripe Connect account,
// application fees, storefront identity, custom domain, country. Those all
// moved onto Brand in earlier phases, but the only way to reach them was the
// Locations edit modal — which is backwards for a franchise brand spanning
// five shops, since there's no single location that owns it and you could
// reach the same brand five different ways. A brand now has a page.
//
// The country filter is a correctness guard rather than tidiness: every
// channel needs credentials and a store id, so offering a UK brand a Careem
// connection invites a misconfiguration that only surfaces as a failed order.
// The available set comes from the shared catalog in @orderhub/shared.
//
// A connection is brand × location × platform (see the unique index on
// BrandPlatformConnection) — an Uber Eats store is a physical store — so each
// brand carries a location picker rather than dropping location entirely.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Globe, Loader2, Plus, Store } from "lucide-react";
import {
  brandsClient,
  locationsClient,
  type Brand,
  type Location,
} from "@/lib/api/locations.client";
import { BrandPlatformGrid } from "@/components/locations/brand-platform-grid";
import { PlatformLogo } from "@/components/ui/platform-logo";
import { channelsForCountry, CHANNEL_COUNTRIES } from "@orderhub/shared";

export default function BrandsPage() {
  const qc = useQueryClient();

  const brandsQuery = useQuery({
    queryKey: ["brands", "all"],
    queryFn: () => brandsClient.list(),
  });
  const locationsQuery = useQuery({
    queryKey: ["locations", "all"],
    queryFn: () => locationsClient.list(),
  });

  const brands = brandsQuery.data ?? [];
  const locations = locationsQuery.data ?? [];

  // The filter is page-level, but defaulting it to the country the tenant
  // actually trades in means the common single-country operator never has to
  // touch it. Falls back to GB only when there's nothing to go on.
  const [country, setCountry] = useState<string | null>(null);
  useEffect(() => {
    if (country !== null) return;
    const counts = new Map<string, number>();
    for (const c of [
      ...brands.map((b) => b.country),
      ...locations.map((l) => (l as any).country),
    ]) {
      const code = String(c ?? "").toUpperCase();
      if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    if (!counts.size) return;
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) setCountry(best[0]);
  }, [brands, locations, country]);

  const activeCountry = country ?? "GB";
  const channels = useMemo(() => channelsForCountry(activeCountry), [activeCountry]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-zinc-900">
            <Store className="h-6 w-6" /> Brands
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Every brand you trade under, and the ordering channels wired to
            each. Channels are filtered to the ones that actually operate in
            the selected country.
          </p>
        </div>
        <CountryPicker value={activeCountry} onChange={setCountry} />
      </div>

      <AvailableChannels country={activeCountry} channels={channels} />

      {brandsQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading brands…
        </div>
      )}

      {!brandsQuery.isLoading && brands.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-200 px-6 py-12 text-center">
          <p className="text-sm font-medium text-zinc-700">No brands yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-zinc-500">
            A brand is what your customers see — its own storefront, payout
            account and channel connections. Create one below to start wiring
            channels.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {brands.map((b) => (
          <BrandCard
            key={b.id}
            brand={b}
            locations={locations}
            country={activeCountry}
          />
        ))}
      </div>

      <CreateBrand
        locations={locations}
        onCreated={() => qc.invalidateQueries({ queryKey: ["brands"] })}
      />
    </div>
  );
}

function CountryPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2">
      <Globe className="h-4 w-4 text-zinc-400" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Country
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-sm font-medium text-zinc-900 focus:outline-none"
      >
        {CHANNEL_COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A glance at what's connectable here, before you expand any brand. */
function AvailableChannels({
  country,
  channels,
}: {
  country: string;
  channels: ReturnType<typeof channelsForCountry>;
}) {
  const name =
    CHANNEL_COUNTRIES.find((c) => c.code === country)?.name ?? country;
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Channels available in {name}
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {channels.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5"
            title={c.kind === "courier" ? "Delivery partner" : undefined}
          >
            <PlatformLogo platform={c.id} size={20} />
            <span className="text-xs font-medium text-zinc-800">{c.label}</span>
            {c.kind === "courier" && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
                Delivery
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BrandCard({
  brand,
  locations,
  country,
}: {
  brand: Brand;
  locations: Location[];
  country: string;
}) {
  const [open, setOpen] = useState(false);
  // A connection is brand × location × platform, so wiring a channel always
  // needs a location. Default to the brand's own primary location (the
  // ghost-kitchen case) and fall back to the first one the operator can see.
  const [locationId, setLocationId] = useState<string>(
    () => brand.primaryLocationId ?? locations[0]?.id ?? "",
  );
  useEffect(() => {
    if (!locationId && locations.length) {
      setLocationId(brand.primaryLocationId ?? locations[0]!.id);
    }
  }, [locations, locationId, brand.primaryLocationId]);

  const brandCountry = String(brand.country ?? "").toUpperCase();
  const mismatch = !!brandCountry && brandCountry !== country;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50"
      >
        {brand.logoUrl ? (
          <img src={brand.logoUrl} alt="" className="h-9 w-9 rounded object-cover" />
        ) : (
          <div className="grid h-9 w-9 place-items-center rounded bg-zinc-100 text-[11px] font-semibold text-zinc-500">
            {brand.name.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-900">
              {brand.name}
            </span>
            {brandCountry && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600">
                {brandCountry}
              </span>
            )}
            {brand.isSuspended && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                Suspended
              </span>
            )}
          </div>
          {brand.description && (
            <div className="truncate text-xs text-zinc-500">{brand.description}</div>
          )}
        </div>
        <span className="text-xs text-zinc-400">
          {(brand as any)._count?.platformConnections ?? 0} connected
        </span>
        <ChevronDown
          className={`h-4 w-4 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-zinc-200 p-4">
          {/* The filter is page-level by design, so a brand registered in
              another country can be on screen. Say so rather than silently
              offering channels it can't actually use. */}
          {mismatch && (
            <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {brand.name} is registered in {brandCountry}, but you&rsquo;re
              viewing {country} channels. Switch the country filter to see the
              channels this brand can actually connect.
            </p>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Location
            </span>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-zinc-400">
              Each channel is connected per shop — an Uber Eats store is a
              physical store.
            </span>
          </div>

          {locationId ? (
            <BrandPlatformGrid
              brand={brand}
              locationId={locationId}
              country={country}
            />
          ) : (
            <p className="text-sm text-zinc-500">
              Add a location before wiring channels.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CreateBrand({
  locations,
  onCreated,
}: {
  locations: Location[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [primaryLocationId, setPrimaryLocationId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      brandsClient.create({
        name,
        ...(primaryLocationId ? { primaryLocationId } : {}),
      } as any),
    onSuccess: () => {
      setName("");
      setError(null);
      onCreated();
    },
    onError: (err: any) => setError(err?.response?.data?.message ?? err.message),
  });

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Add a brand
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Crunchy Chikin"
          className="min-w-[200px] flex-1 rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        />
        <select
          value={primaryLocationId}
          onChange={(e) => setPrimaryLocationId(e.target.value)}
          className="rounded-md border border-zinc-200 px-2 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        >
          <option value="">Franchise parent (no single shop)</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              Virtual brand at {l.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => create.mutate()}
          disabled={create.isPending || !name.trim()}
          className="flex items-center gap-1.5 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {create.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add brand
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
