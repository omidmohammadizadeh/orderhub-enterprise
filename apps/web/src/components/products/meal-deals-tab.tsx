"use client";
import { useMemo, useState } from "react";
import { useCurrency } from "@/hooks/use-currency";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, UtensilsCrossed } from "lucide-react";
import { mealDealsClient } from "@/lib/api/catalog.client";
import { brandsClient } from "@/lib/api/locations.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { CatalogEmptyState } from "./empty-state";
import { MealDealEditor } from "./meal-deal-editor";

interface Props {
  brandId: string;
  /** Phase AP — only show meal deals available at this location. */
  locationId?: string | null;
  search: string;
}

// Meal deals for the selected location, across EVERY brand that trades from
// it. The brand matters more here than anywhere else in Products: a deal is
// published with its brand's Deliveroo menu and nowhere else, so it is chosen
// explicitly when the deal is created and shown on every row — the page's own
// `brandId` is just the account's first brand, which on a multi-brand shop is
// usually not the one the operator means.
export function MealDealsTab({ brandId, locationId, search }: Props) {
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money, symbol } = useCurrency();
  const qc = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [newBrandId, setNewBrandId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const scopeKey = locationId ? `loc:${locationId}` : `brand:${brandId}`;
  const listKey = ["catalog", "meal-deals", scopeKey];
  const { data: deals = [], isLoading } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      locationId
        ? mealDealsClient.listForLocation(locationId)
        : mealDealsClient.list(brandId),
    enabled: !!brandId || !!locationId,
  });

  // The brands trading from this kitchen — the same list (and cache) the
  // Menu page uses, so "which brand" means the same thing on both.
  const { data: brands = [] } = useQuery({
    queryKey: ["brands", "at-location", locationId ?? "all"],
    queryFn: () => brandsClient.list(locationId ?? undefined),
  });
  // One brand here: nothing to choose. Several: the operator must pick.
  const createBrandId = brands.length === 1 ? brands[0]!.id : newBrandId;

  const filtered = useMemo(
    () =>
      deals.filter((d) =>
        search.trim()
          ? d.name.toLowerCase().includes(search.toLowerCase())
          : true,
      ),
    [deals, search],
  );

  const resetCreate = () => {
    setIsCreating(false);
    setName("");
    setPrice("");
    setNewBrandId("");
  };

  const createMutation = useMutation({
    mutationFn: () =>
      mealDealsClient.create(createBrandId, {
        name: name.trim(),
        price: price ? Number(price) : null,
        // Made here, for this shop — the rest of Products is location-scoped
        // the same way. Without it a deal was brand-wide and went out on the
        // next Deliveroo publish of ANY store of the brand.
        ...(locationId ? { locationIds: [locationId] } : {}),
      }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: listKey });
      resetCreate();
      // A deal is only a name and a price until it has sections — go
      // straight to them rather than leaving an empty deal in the list.
      setEditingId(created.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => mealDealsClient.remove(id),
    onSuccess: (_res, id) => {
      if (editingId === id) setEditingId(null);
      qc.invalidateQueries({ queryKey: listKey });
    },
  });

  const editing = deals.find((d) => d.id === editingId) ?? null;
  const brandName = (d: (typeof deals)[number]) =>
    d.brand?.name ?? brands.find((b) => b.id === d.brandId)?.name ?? "—";

  if (isLoading)
    return (
      <div className="space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-zinc-100 animate-pulse" />
        ))}
      </div>
    );

  if (deals.length === 0 && !isCreating)
    return (
      <CatalogEmptyState
        icon={UtensilsCrossed}
        title="No meal deals yet"
        description="A meal deal bundles products at a fixed price (e.g. burger + fries + drink for £8.99). Set out what the customer picks in each section, and it publishes to Deliveroo as a bundle."
        ctaLabel="Create meal deal"
        onCta={() => setIsCreating(true)}
      />
    );

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => setIsCreating(true)}
          className="bg-orange-500 hover:bg-orange-600 text-white"
        >
          <Plus className="h-4 w-4 mr-1.5" />
          Create meal deal
        </Button>
      </div>

      {isCreating && (
        <Card className="p-4 border-orange-200 bg-orange-50">
          <p className="text-sm font-medium text-zinc-800 mb-3">New meal deal</p>
          <div className="flex flex-wrap gap-2">
            {brands.length > 1 && (
              <select
                value={newBrandId}
                onChange={(e) => setNewBrandId(e.target.value)}
                aria-label="Brand"
                className="h-9 min-w-44 flex-1 rounded-md border border-zinc-200 bg-white px-2.5 text-sm text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500 sm:flex-none"
              >
                <option value="">Choose brand…</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
            <Input
              autoFocus
              placeholder="e.g. Family Feast"
              aria-label="Deal name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 min-w-48 flex-1 text-sm"
            />
            <Input
              placeholder={`Price (${symbol.trim()})`}
              aria-label="Price"
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="h-9 w-32 text-sm"
            />
            <Button
              size="sm"
              onClick={() => createMutation.mutate()}
              disabled={!name.trim() || !createBrandId || createMutation.isPending}
              className="bg-orange-500 hover:bg-orange-600 text-white"
            >
              Create
            </Button>
            <Button size="sm" variant="outline" onClick={resetCreate}>
              Cancel
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            {brands.length > 1
              ? "Pick the brand whose Deliveroo menu this deal belongs on — it only publishes with that brand’s menu. "
              : ""}
            Next you&rsquo;ll set out the sections — what the customer picks.
          </p>
        </Card>
      )}

      {editing && (
        <MealDealEditor
          key={editing.id}
          deal={editing}
          onClose={() => setEditingId(null)}
          invalidateKey={listKey}
          locationId={locationId}
        />
      )}

      <div className="rounded-xl border border-zinc-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Name</th>
              <th className="text-left font-medium px-4 py-2.5">Brand</th>
              <th className="text-left font-medium px-4 py-2.5">Sections</th>
              <th className="text-right font-medium px-4 py-2.5">Price</th>
              <th className="text-center font-medium px-4 py-2.5">Available</th>
              <th className="px-4 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filtered.map((d) => (
              <tr key={d.id} className={d.id === editingId ? "bg-orange-50" : "hover:bg-zinc-50"}>
                <td className="px-4 py-2.5 font-medium text-zinc-900">
                  <button
                    type="button"
                    onClick={() => setEditingId(d.id)}
                    className="text-left hover:text-orange-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500 rounded"
                  >
                    {d.name}
                  </button>
                </td>
                <td className="px-4 py-2.5 text-zinc-600">{brandName(d)}</td>
                <td className="px-4 py-2.5 text-zinc-500">
                  {d.sections?.length
                    ? d.sections.map((s) => s.name).filter(Boolean).join(" · ") ||
                      `${d.sections.length} section${d.sections.length === 1 ? "" : "s"}`
                    : <span className="text-amber-700">No sections yet</span>}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {d.price != null ? `${money(Number(d.price))}` : "—"}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      d.isAvailable ? "bg-emerald-500" : "bg-zinc-300"
                    }`}
                    aria-label={d.isAvailable ? "Available" : "Not available"}
                    role="img"
                  />
                </td>
                <td className="px-2 py-2.5">
                  <div className="flex items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingId(d.id)}
                      className="h-7 px-2 text-zinc-400 hover:text-zinc-900"
                      title="Edit"
                      aria-label={`Edit ${d.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete "${d.name}"?\n\nIt comes off Deliveroo the next time ${brandName(d)}'s menu is published.`,
                          )
                        ) {
                          deleteMutation.mutate(d.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      className="h-7 px-2 text-zinc-400 hover:text-red-600"
                      title="Delete"
                      aria-label={`Delete ${d.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleteMutation.isError && (
        <p role="alert" className="text-xs text-red-600">
          Couldn&rsquo;t delete that deal. Please try again.
        </p>
      )}
    </div>
  );
}
