"use client";

// Phase AL — Master Catalog (Products section).
//
// This page is the single source of truth for everything sold:
//   - Products (MenuItem)        — base products with image + price + taxes
//   - Modifiers (ModifierOption) — image optional, supports prices-by-size
//   - Modifier Groups            — no image, holds a list of modifiers
//   - Variants                   — multi-SKU products (pizza-style)
//   - Meal Deals                 — bundled products at a fixed price
//   - Upsell Groups              — "you might also like" suggestions
//
// The Menu section (/dashboard/menu) ATTACHES items from this catalog into
// per-location menus. It must NOT create duplicate products.
//
// Tabs use a query-string param (?tab=products) so deep links work and
// state survives a refresh.

import { Suspense, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search, Plus, Layers } from "lucide-react";
import { brandsClient } from "@/lib/api/menus.client";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ProductsTab } from "@/components/products/products-tab";
import { ModifierGroupsTab } from "@/components/products/modifier-groups-tab";
import { ModifiersTab } from "@/components/products/modifiers-tab";
import { VariantsTab } from "@/components/products/variants-tab";
import { MealDealsTab } from "@/components/products/meal-deals-tab";
import { UpsellGroupsTab } from "@/components/products/upsell-groups-tab";

const TABS = [
  { key: "products", label: "Products" },
  { key: "modifiers", label: "Modifiers" },
  { key: "modifier-groups", label: "Modifier Groups" },
  { key: "variants", label: "Variants" },
  { key: "meal-deals", label: "Meal Deals" },
  { key: "upsell-groups", label: "Upsell Groups" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function ProductsPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const user = useAuthStore((s) => s.user);

  const activeTab = (searchParams.get("tab") as TabKey) || "products";
  const [search, setSearch] = useState("");
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);

  const setTab = (tab: TabKey) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", tab);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const { data: brands = [], isLoading: brandsLoading } = useQuery({
    queryKey: ["brands"],
    queryFn: () => brandsClient.list(),
  });

  const brandId = selectedBrandId ?? user?.brandId ?? brands[0]?.id ?? "";

  if (brandsLoading) {
    return (
      <div className="space-y-3">
        <div className="h-10 w-48 rounded-lg bg-zinc-100 animate-pulse" />
        <div className="h-12 rounded-lg bg-zinc-100 animate-pulse" />
        <div className="h-64 rounded-lg bg-zinc-100 animate-pulse" />
      </div>
    );
  }

  if (!brandId) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Layers className="h-10 w-10 text-zinc-300 mb-4" />
        <p className="font-medium text-zinc-600">No brand to manage</p>
        <p className="text-sm text-zinc-400 mt-1 mb-5">
          Create a brand first to start building your catalog.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Header ────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Products</h1>
          <p className="text-sm text-zinc-500">
            Master catalog — everything you sell, in one place. Menus pull from here.
          </p>
        </div>
      </div>

      {/* ── Brand selector pills (only if >1 brand) ───────────── */}
      {brands.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            Brand
          </span>
          {brands.map((b) => (
            <button
              key={b.id}
              onClick={() => setSelectedBrandId(b.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                brandId === b.id
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300",
              )}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <div className="border-b border-zinc-200">
        <div className="flex gap-1 overflow-x-auto -mb-px">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors",
                activeTab === t.key
                  ? "border-orange-500 text-zinc-900"
                  : "border-transparent text-zinc-500 hover:text-zinc-700",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Toolbar ───────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
          <Input
            placeholder={`Search ${TABS.find((t) => t.key === activeTab)?.label.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>
      </div>

      {/* ── Tab content ──────────────────────────────────────── */}
      <div>
        {activeTab === "products" && <ProductsTab brandId={brandId} search={search} />}
        {activeTab === "modifiers" && <ModifiersTab brandId={brandId} search={search} />}
        {activeTab === "modifier-groups" && (
          <ModifierGroupsTab brandId={brandId} search={search} />
        )}
        {activeTab === "variants" && <VariantsTab brandId={brandId} search={search} />}
        {activeTab === "meal-deals" && <MealDealsTab brandId={brandId} search={search} />}
        {activeTab === "upsell-groups" && (
          <UpsellGroupsTab brandId={brandId} search={search} />
        )}
      </div>
    </div>
  );
}

export default function ProductsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3">
          <div className="h-10 w-48 rounded-lg bg-zinc-100 animate-pulse" />
          <div className="h-64 rounded-lg bg-zinc-100 animate-pulse" />
        </div>
      }
    >
      <ProductsPageInner />
    </Suspense>
  );
}
