"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers2 } from "lucide-react";
import { productsClient } from "@/lib/api/catalog.client";
import { CatalogEmptyState } from "./empty-state";
import { VariantsEditor } from "./variants-editor";

interface Props {
  brandId: string;
  /** Phase AP — variants are just multi-SKU products; the list must
   *  match what the Products tab shows for this location, otherwise
   *  the operator sees SKU products from sibling shops. */
  locationId?: string | null;
  search: string;
}

// Variants are simply products with hasMultipleSkus = true. The tab lists
// the multi-SKU products visible AT THIS LOCATION (Phase AP location-
// scoped lookup), plus an affordance to "promote" a flat product into
// a multi-SKU one. The editor (VariantsEditor) handles the productSkus[]
// JSON shape and per-platform pricing overrides.
export function VariantsTab({ brandId, locationId, search }: Props) {
  const [editingProductId, setEditingProductId] = useState<string | null>(null);

  const scopeKey = locationId ? `loc:${locationId}` : `brand:${brandId}`;
  const { data: products = [], isLoading } = useQuery({
    queryKey: ["catalog", "products", scopeKey],
    queryFn: () =>
      locationId
        ? productsClient.listForLocation(locationId)
        : productsClient.list(brandId),
    enabled: !!brandId || !!locationId,
  });

  const multiSku = useMemo(
    () => products.filter((p) => p.hasMultipleSkus),
    [products],
  );
  const filtered = useMemo(() => {
    if (!search.trim()) return multiSku;
    const q = search.toLowerCase();
    return multiSku.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.plu ?? "").toLowerCase().includes(q),
    );
  }, [multiSku, search]);

  if (isLoading)
    return (
      <div className="space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-zinc-100 animate-pulse" />
        ))}
      </div>
    );

  if (editingProductId) {
    return (
      <VariantsEditor
        productId={editingProductId}
        onClose={() => setEditingProductId(null)}
      />
    );
  }

  if (multiSku.length === 0)
    return (
      <CatalogEmptyState
        icon={Layers2}
        title="No variant products yet"
        description="A variant product holds multiple SKUs (sizes), each with its own PLU and price. Common for pizzas, drinks, and combo meals. Promote any product to multi-SKU from its edit screen."
        ctaLabel="Open Products tab"
        onCta={() => {
          const url = new URL(window.location.href);
          url.searchParams.set("tab", "products");
          window.location.assign(url);
        }}
      />
    );

  return (
    <div className="rounded-xl border border-zinc-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-zinc-500">
          <tr>
            <th className="text-left font-medium px-4 py-2.5">Product</th>
            <th className="text-center font-medium px-4 py-2.5">SKUs</th>
            <th className="text-left font-medium px-4 py-2.5">Price range</th>
            <th className="w-32" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {filtered.map((p) => {
            const skus = Array.isArray(p.productSkus) ? p.productSkus : [];
            const prices = skus.map((s) => Number(s.price)).filter(Number.isFinite);
            const min = prices.length ? Math.min(...prices) : 0;
            const max = prices.length ? Math.max(...prices) : 0;
            return (
              <tr key={p.id} className="hover:bg-zinc-50">
                <td className="px-4 py-2.5 font-medium text-zinc-900">{p.name}</td>
                <td className="px-4 py-2.5 text-center tabular-nums">
                  {skus.length}
                </td>
                <td className="px-4 py-2.5 tabular-nums">
                  £{min.toFixed(2)} – £{max.toFixed(2)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => setEditingProductId(p.id)}
                    className="text-xs font-medium text-orange-600 hover:text-orange-700"
                  >
                    Edit variants →
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
