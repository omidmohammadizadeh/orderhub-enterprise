"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Package2, ImageIcon, Settings2, Trash2 } from "lucide-react";
import { productsClient } from "@/lib/api/catalog.client";
import { menuAvailabilityClient } from "@/lib/api/menu-availability.client";
import { Button } from "@/components/ui/button";
import { CatalogEmptyState } from "./empty-state";
import { ProductForm } from "./product-form";

interface Props {
  brandId: string;
  /** Phase AP — when set, query the location-scoped product list so
   *  sibling locations stay siloed. */
  locationId?: string;
  search: string;
}

export function ProductsTab({ brandId, locationId, search }: Props) {
  const qc = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Query key includes locationId so switching locations triggers a
  // fresh fetch rather than reusing the previous location's cache.
  const listQueryKey = locationId
    ? ["catalog", "products", "location", locationId]
    : ["catalog", "products", brandId];

  const { data: products = [], isLoading } = useQuery({
    queryKey: listQueryKey,
    queryFn: () =>
      locationId
        ? productsClient.listForLocation(locationId)
        : productsClient.list(brandId),
    enabled: !!(locationId || brandId),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => productsClient.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: listQueryKey }),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => productsClient.toggleAvailability(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: listQueryKey }),
  });

  // Phase BA — with a location selected, the availability switch is
  // LOCATION-SCOPED: it writes an "ALL"-channel snooze for this location
  // only, so 86ing here never affects a sibling location. The global
  // MenuItem.isAvailable master switch stays visible ("Disabled — all
  // locations") and still restores globally on click.
  const locationSnoozesKey = ["location-item-snoozes", locationId];
  const { data: locationSnoozes } = useQuery({
    queryKey: locationSnoozesKey,
    queryFn: () => menuAvailabilityClient.locationItemSnoozes(locationId!),
    enabled: !!locationId,
  });
  const snoozedHere = useMemo(
    () => new Set(locationSnoozes?.itemIds ?? []),
    [locationSnoozes],
  );

  const locationToggleMutation = useMutation({
    mutationFn: async (args: { id: string; snoozed: boolean }) =>
      args.snoozed
        ? menuAvailabilityClient.unsnooze(args.id, "ALL", locationId!)
        : menuAvailabilityClient.snooze(args.id, {
            channel: "ALL",
            duration: "indefinite",
            locationId: locationId!,
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: locationSnoozesKey });
      qc.invalidateQueries({ queryKey: ["menu-availability"] });
    },
  });

  const filtered = useMemo(
    () =>
      products.filter((p) => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (
          p.name.toLowerCase().includes(q) ||
          (p.plu ?? "").toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q)
        );
      }),
    [products, search],
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-zinc-100 animate-pulse" />
        ))}
      </div>
    );
  }

  if (isCreating || editingId) {
    return (
      <ProductForm
        brandId={brandId}
        locationId={locationId}
        productId={editingId ?? undefined}
        onCancel={() => {
          setIsCreating(false);
          setEditingId(null);
        }}
        onSaved={() => {
          setIsCreating(false);
          setEditingId(null);
          qc.invalidateQueries({ queryKey: listQueryKey });
        }}
      />
    );
  }

  if (products.length === 0) {
    return (
      <CatalogEmptyState
        icon={Package2}
        title="No products yet"
        description="Start your catalog by creating products. Each product needs an image (1064×768) and a base price."
        ctaLabel="Create product"
        onCta={() => setIsCreating(true)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => setIsCreating(true)}
          className="bg-orange-500 hover:bg-orange-600 text-white"
        >
          <Plus className="h-4 w-4 mr-1.5" />
          Create product
        </Button>
      </div>

      <div className="rounded-xl border border-zinc-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Name</th>
              <th className="text-left font-medium px-4 py-2.5">PLU</th>
              <th className="text-right font-medium px-4 py-2.5">Price</th>
              <th className="text-center font-medium px-4 py-2.5">Status</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filtered.map((p) => (
              <tr key={p.id} className="hover:bg-zinc-50">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    {p.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.imageUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-9 w-12 rounded object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="h-9 w-12 rounded bg-zinc-100 flex-shrink-0 flex items-center justify-center">
                        <ImageIcon className="h-4 w-4 text-zinc-300" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="font-medium text-zinc-900 truncate">{p.name}</p>
                      {p.description && (
                        <p className="text-xs text-zinc-400 truncate">
                          {p.description}
                        </p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-600">
                  {p.plu ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  £{Number(p.basePrice).toFixed(2)}
                </td>
                <td className="px-4 py-2.5 text-center">
                  {(() => {
                    const offHere = !!locationId && snoozedHere.has(p.id);
                    const label = !p.isAvailable
                      ? locationId
                        ? "Disabled — all locations"
                        : "Unavailable"
                      : offHere
                        ? "Off at this location"
                        : "Available";
                    const on = p.isAvailable && !offHere;
                    return (
                      <button
                        onClick={() =>
                          !p.isAvailable || !locationId
                            ? toggleMutation.mutate(p.id)
                            : locationToggleMutation.mutate({
                                id: p.id,
                                snoozed: offHere,
                              })
                        }
                        disabled={
                          toggleMutation.isPending ||
                          locationToggleMutation.isPending
                        }
                        title={
                          locationId
                            ? on
                              ? "Turn off at this location only"
                              : offHere
                                ? "Turn back on at this location"
                                : "Re-enable at all locations"
                            : "Toggle availability (all locations)"
                        }
                        className="inline-flex items-center gap-1.5 text-xs"
                      >
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${
                            on
                              ? "bg-emerald-500"
                              : offHere
                                ? "bg-amber-400"
                                : "bg-zinc-300"
                          }`}
                        />
                        <span
                          className={
                            on
                              ? "text-emerald-700"
                              : offHere
                                ? "text-amber-700"
                                : "text-zinc-400"
                          }
                        >
                          {label}
                        </span>
                      </button>
                    );
                  })()}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingId(p.id)}
                      className="h-7 px-2"
                      title="Edit"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete "${p.name}"? It will be removed from every menu and category.`,
                          )
                        ) {
                          deleteMutation.mutate(p.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      className="h-7 px-2 text-zinc-400 hover:text-red-600"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-zinc-400">
                  No products match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
