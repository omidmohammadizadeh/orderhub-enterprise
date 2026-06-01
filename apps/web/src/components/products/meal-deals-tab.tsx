"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, UtensilsCrossed } from "lucide-react";
import { mealDealsClient } from "@/lib/api/catalog.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { CatalogEmptyState } from "./empty-state";

interface Props {
  brandId: string;
  /** Phase AP — only show meal deals available at this location. */
  locationId?: string | null;
  search: string;
}

// Phase AL — basic UI on the new MealDeal model. Phase AP — list is
// scoped to the selected location (MealDeal.locationIds[] empty means
// "available at every location of this brand", non-empty means the
// explicit list).
export function MealDealsTab({ brandId, locationId, search }: Props) {
  const qc = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");

  const scopeKey = locationId ? `loc:${locationId}` : `brand:${brandId}`;
  const { data: deals = [], isLoading } = useQuery({
    queryKey: ["catalog", "meal-deals", scopeKey],
    queryFn: () =>
      locationId
        ? mealDealsClient.listForLocation(locationId)
        : mealDealsClient.list(brandId),
    enabled: !!brandId || !!locationId,
  });

  const filtered = useMemo(
    () =>
      deals.filter((d) =>
        search.trim()
          ? d.name.toLowerCase().includes(search.toLowerCase())
          : true,
      ),
    [deals, search],
  );

  const createMutation = useMutation({
    mutationFn: () =>
      mealDealsClient.create(brandId, {
        name: name.trim(),
        price: price ? Number(price) : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog", "meal-deals", scopeKey] });
      setIsCreating(false);
      setName("");
      setPrice("");
    },
  });

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
        description="A meal deal bundles multiple products at a fixed price (e.g. burger + fries + drink for £8.99). Foundation only for now — full section editor lands in the next iteration."
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
          <div className="flex gap-2">
            <Input
              autoFocus
              placeholder="e.g. Family Feast"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 h-9 text-sm"
            />
            <Input
              placeholder="Price (£)"
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-32 h-9 text-sm"
            />
            <Button
              size="sm"
              onClick={() => createMutation.mutate()}
              disabled={!name.trim() || createMutation.isPending}
              className="bg-orange-500 hover:bg-orange-600 text-white"
            >
              Create
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setIsCreating(false);
                setName("");
                setPrice("");
              }}
            >
              Cancel
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Sections (pick X from Y), per-platform pricing, and product
            linking come in a follow-up.
          </p>
        </Card>
      )}

      <div className="rounded-xl border border-zinc-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Name</th>
              <th className="text-right font-medium px-4 py-2.5">Price</th>
              <th className="text-center font-medium px-4 py-2.5">Available</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filtered.map((d) => (
              <tr key={d.id} className="hover:bg-zinc-50">
                <td className="px-4 py-2.5 font-medium text-zinc-900">{d.name}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {d.price != null ? `£${Number(d.price).toFixed(2)}` : "—"}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      d.isAvailable ? "bg-emerald-500" : "bg-zinc-300"
                    }`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
