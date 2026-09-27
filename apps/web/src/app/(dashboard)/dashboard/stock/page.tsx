"use client";

// Retail R1 — Stock & barcodes (shops only).
//
// Everything on this location's till, with each variant's barcode and the
// count on the shelf. Scanning into the search box finds a product; scanning
// one we don't have offers to add it. Managers import the whole catalogue
// from a spreadsheet; anyone on shift can count stock.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, Loader2, PackagePlus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";
import { retailClient } from "@/lib/api/retail.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useAuthStore } from "@/stores/auth.store";
import { isShopType } from "@/components/locations/business-type-picker";
import { StockProductCard } from "@/components/retail/stock-product-card";
import { ImportProductsModal } from "@/components/retail/import-products-modal";
import { NewProductModal } from "@/components/retail/new-product-modal";

const CATALOG_MANAGERS = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "MANAGER", "DARK_KITCHEN_MANAGER"];
const looksLikeBarcode = (s: string) => /^\d{6,14}$/.test(s.trim());

export default function StockPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const role = useAuthStore((s) => s.user?.role);
  const canManage = CATALOG_MANAGERS.includes(String(role));
  const { money } = useCurrency();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [newProduct, setNewProduct] = useState<{ barcode?: string } | null>(null);

  // Debounce typing; a scan (ends in Enter) searches at once.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const location = useQuery({
    queryKey: queryKeys.locationDetail(locationId ?? ""),
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
    staleTime: 60_000,
  });
  const isShop = isShopType(location.data?.businessType);

  const products = useQuery({
    queryKey: ["retail-products", locationId, q, lowOnly],
    queryFn: () => retailClient.products(locationId!, { q, low: lowOnly }),
    enabled: !!locationId && isShop,
    placeholderData: (prev) => prev,
  });
  const refresh = () => void products.refetch();

  if (!locationId) {
    return (
      <div className="grid h-full place-items-center p-8 text-center text-sm text-zinc-500">
        Select a location to manage its stock.
      </div>
    );
  }

  if (location.data && !isShop) {
    return (
      <div className="mx-auto max-w-md p-8 text-center text-sm text-zinc-600">
        <p className="font-semibold text-zinc-900">{location.data.name} is set up as a restaurant.</p>
        <p className="mt-1">
          Barcodes and stock counts are for shops. Change what this location sells under{" "}
          <Link href="/dashboard/locations" className="font-medium text-orange-600 hover:underline">
            Locations
          </Link>{" "}
          to Grocery or Retail.
        </p>
      </div>
    );
  }

  const list = products.data?.products ?? [];
  const unknownScan = q && looksLikeBarcode(q) && !products.isFetching && list.length === 0;

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-zinc-900">Stock & barcodes</h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            Everything on {location.data?.name ?? "this shop"}&apos;s till. Tap a count to set what&apos;s on the shelf.
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setNewProduct({})}>
              <PackagePlus className="mr-1.5 h-4 w-4" /> New product
            </Button>
            <Button size="sm" onClick={() => setImportOpen(true)}>
              <FileSpreadsheet className="mr-1.5 h-4 w-4" /> Import spreadsheet
            </Button>
          </div>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[14rem] flex-1">
          <span className="sr-only">Search products</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setQ(search.trim());
              }
            }}
            placeholder="Scan a barcode or search by name…"
            autoComplete="off"
            className="w-full rounded-lg border border-zinc-200 bg-white px-9 py-2 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          Low stock only
        </label>
      </div>

      {products.isLoading ? (
        <div className="grid place-items-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
        </div>
      ) : products.isError ? (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {(products.error as any)?.response?.data?.message ?? "Couldn't load products."}
        </p>
      ) : unknownScan ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-600">
          <p>
            No product with barcode <span className="font-mono">{q}</span>.
          </p>
          {canManage && (
            <Button className="mt-3" size="sm" onClick={() => setNewProduct({ barcode: q })}>
              <PackagePlus className="mr-1.5 h-4 w-4" /> Add it
            </Button>
          )}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-600">
          {q || lowOnly ? (
            "Nothing matches."
          ) : (
            <>
              <p className="font-semibold text-zinc-900">No products on this till yet.</p>
              <p className="mt-1">
                {canManage
                  ? "Import your product list from a spreadsheet — or add products one at a time by scanning them."
                  : "Ask a manager to import the product list."}
              </p>
            </>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((p) => (
            <StockProductCard
              key={p.id}
              product={p}
              locationId={locationId}
              canManage={canManage}
              money={money}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}

      {importOpen && (
        <ImportProductsModal locationId={locationId} onClose={() => setImportOpen(false)} onDone={refresh} />
      )}
      {newProduct && (
        <NewProductModal
          locationId={locationId}
          initialBarcode={newProduct.barcode}
          onClose={() => setNewProduct(null)}
          onDone={() => {
            setSearch("");
            setQ("");
            refresh();
          }}
        />
      )}
    </div>
  );
}
