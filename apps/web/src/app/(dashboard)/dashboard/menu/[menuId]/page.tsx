"use client";

// Phase AM — Menu editor (Base44-style).
//
// Layout:
//   ┌────────────────────────────────────────────────────────────────┐
//   │ ← Back to Menus    Menu Name                Preview Menu       │
//   ├──────────────┬─────────────────────────────────────────────────┤
//   │ Categories   │ <Active category name>     [search] [+ Add prod]│
//   │ + Add cat'y  │                                                  │
//   │ ⠿ Bowls (3)  │  ┌────────┐ ┌────────┐ ┌────────┐                │
//   │ ⠿ Meal Deals │  │ Card 1 │ │ Card 2 │ │ Card 3 │                │
//   │ ⠿ Drinks     │  └────────┘ └────────┘ └────────┘                │
//   │ ⠿ Platters   │                                                  │
//   └──────────────┴─────────────────────────────────────────────────┘
//
// Reordering:
//   - Categories drag-reorder via HTML5 native dnd → POST .../categories/reorder
//   - Products inside a category drag-reorder → PATCH .../items/reorder
//
// Product attach pattern:
//   - "+ Add product" opens AttachModal pulling from the brand catalog
//     (same search modal Products tab uses). Done → POST attach to the
//     active category. Picking a product that's already in the category
//     is a no-op (we diff against the current list before issuing calls).
//   - Inline "Create new product" still lives on the Products tab — no
//     duplicate forms here.

import { useState, useMemo, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Plus,
  Pencil,
  Check,
  Trash2,
  GripVertical,
  Eye,
  Search,
  Settings,
  Tag,
  SlidersHorizontal,
  Percent,
  Camera,
  ArrowDownAZ,
} from "lucide-react";
import { MenuSettingsDrawer } from "@/components/menu/menu-settings-drawer";
import { VariantsManagerModal } from "@/components/menu/variants-manager-modal";
import { ProductVariantPricingModal } from "@/components/menu/product-variant-pricing-modal";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { menusClient } from "@/lib/api/menus.client";
import { productsClient } from "@/lib/api/catalog.client";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";
import { AttachModal } from "@/components/products/attach-modal";
import { ProductEditorModal } from "@/components/products/product-editor-modal";
import { formatDisplayPrice } from "@/lib/menu/display-price";
import { ChannelPricingModal } from "@/components/menu/channel-pricing-modal";
import { GeneratePhotosModal } from "@/components/menu/generate-photos-modal";

/**
 * How names are compared when sorting a category A-Z.
 *
 * `sensitivity: "base"` is what actually delivers "everything starting with
 * the same letter sits together": a case-sensitive sort puts "chips" after
 * "Zinger", which is not what anyone means by alphabetical. `numeric` keeps
 * "6 Wings" before "12 Wings" instead of ordering them as text.
 */
const NAME_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export default function MenuEditorPage() {
  const { menuId } = useParams<{ menuId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === "PLATFORM_ADMIN";

  // ── Queries ─────────────────────────────────────────────────────────
  const { data: menu, isLoading } = useQuery({
    queryKey: ["menu", menuId],
    queryFn: () => menusClient.getMenu(menuId),
  });

  // We accept either a user-assigned brandId or fall back to the menu's
  // own brand once it loads (Platform Admins). The catalog list below
  // needs a brandId.
  const brandId = user?.brandId ?? (menu as any)?.brandId ?? "";

  const { data: catalogProducts = [] } = useQuery({
    queryKey: ["catalog", "products", brandId],
    queryFn: () => productsClient.list(brandId),
    enabled: !!brandId,
  });

  // ── Local state ────────────────────────────────────────────────────
  const [activeCatId, setActiveCatId] = useState<string | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  // Inline category rename.
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [editCatName, setEditCatName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Phase AZ — pricing variants manager + per-product channel pricing.
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [channelPricingOpen, setChannelPricingOpen] = useState(false);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [pricingTarget, setPricingTarget] = useState<any | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  // Phase AM — in-place product editor. `null` = closed. `"new"` opens
  // a blank form (Create New flow). Any other string opens edit mode
  // for that product id.
  const [productEditorTarget, setProductEditorTarget] = useState<
    null | "new" | string
  >(null);

  // Drag-drop bookkeeping. We keep the index of the row being dragged
  // and call the reorder API in onDragEnd. No library needed.
  const draggingCatIdx = useRef<number | null>(null);
  const draggingProdIdx = useRef<number | null>(null);

  // ── Pick first category by default once data loads ─────────────────
  const categories = (menu?.categories ?? []) as any[];
  const effectiveCatId =
    activeCatId ?? categories[0]?.id ?? null;
  // Which brands this menu prices for — read from the PRODUCTS' brand tags,
  // not the menu's own brandId.
  //
  // A menu row carries a brand for ownership reasons; it says nothing about
  // who sells the food on it. Grill Stop — Pelton is a "pizza yoyo-test" menu
  // holding "monster burgerzz-pelton" products, and seeding from the menu gave
  // a second brand group with no product in this menu to price. Tag the
  // products and the groups follow: one brand, one group; three brands, three.
  const menuBrandIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of categories) {
      for (const link of (c as any).items ?? []) {
        const it = link?.item;
        if (it?.brandId) ids.add(it.brandId);
        for (const b of it?.brandIds ?? []) if (b) ids.add(b);
      }
    }
    return [...ids];
  }, [menu, categories]);

  const activeCat = useMemo(
    () => categories.find((c) => c.id === effectiveCatId) ?? null,
    [categories, effectiveCatId],
  );

  // ── Mutations ──────────────────────────────────────────────────────
  const addCatMutation = useMutation({
    mutationFn: (name: string) => menusClient.createCategory(menuId, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      setAddingCategory(false);
      setNewCatName("");
    },
  });
  const deleteCatMutation = useMutation({
    mutationFn: (catId: string) => menusClient.deleteCategory(catId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menu", menuId] }),
  });
  const renameCatMutation = useMutation({
    mutationFn: ({ catId, name }: { catId: string; name: string }) =>
      menusClient.updateCategory(catId, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      setEditingCatId(null);
      setEditCatName("");
    },
  });
  const reorderCatMutation = useMutation({
    mutationFn: (order: { items: { id: string; sortOrder: number }[] }) =>
      menusClient.reorderCategories(menuId, order),
    // Optimistic update — apply the new order to the local cache
    // immediately so the sidebar reflects the drop without waiting for
    // the API + refetch round-trip. Roll back on error.
    onMutate: async (order) => {
      await qc.cancelQueries({ queryKey: ["menu", menuId] });
      const prev = qc.getQueryData<any>(["menu", menuId]);
      qc.setQueryData<any>(["menu", menuId], (old: any) => {
        if (!old) return old;
        const byId = new Map(order.items.map((i) => [i.id, i.sortOrder]));
        const sorted = [...old.categories].sort(
          (a, b) =>
            (byId.get(a.id) ?? a.sortOrder) -
            (byId.get(b.id) ?? b.sortOrder),
        );
        return { ...old, categories: sorted };
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["menu", menuId], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["menu", menuId] }),
  });

  const attachItemMutation = useMutation({
    mutationFn: ({ catId, itemId }: { catId: string; itemId: string }) =>
      menusClient.addItemToCategory(catId, { itemId }),
  });
  const detachItemMutation = useMutation({
    mutationFn: ({ catId, itemId }: { catId: string; itemId: string }) =>
      menusClient.removeItemFromCategory(catId, itemId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menu", menuId] }),
  });
  const reorderItemsMutation = useMutation({
    mutationFn: ({
      catId,
      order,
    }: {
      catId: string;
      order: { itemId: string; sortOrder: number }[];
    }) => menusClient.reorderItemsInCategory(catId, order),
    onMutate: async ({ catId, order }) => {
      await qc.cancelQueries({ queryKey: ["menu", menuId] });
      const prev = qc.getQueryData<any>(["menu", menuId]);
      qc.setQueryData<any>(["menu", menuId], (old: any) => {
        if (!old) return old;
        const byId = new Map(order.map((i) => [i.itemId, i.sortOrder]));
        const cats = old.categories.map((c: any) => {
          if (c.id !== catId) return c;
          const sorted = [...c.items].sort(
            (a, b) =>
              (byId.get(a.itemId) ?? a.sortOrder) -
              (byId.get(b.itemId) ?? b.sortOrder),
          );
          return { ...c, items: sorted };
        });
        return { ...old, categories: cats };
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["menu", menuId], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["menu", menuId] }),
  });

  const publishMutation = useMutation({
    mutationFn: () => menusClient.publishMenu(menuId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["menu", menuId] }),
  });

  // ── Helpers ────────────────────────────────────────────────────────
  const handleAttachConfirm = async (selectedIds: string[]) => {
    if (!activeCat) return;
    const currentIds = (activeCat.items ?? []).map((l: any) => l.itemId);
    const toAttach = selectedIds.filter((id) => !currentIds.includes(id));
    const toDetach = currentIds.filter(
      (id: string) => !selectedIds.includes(id),
    );
    await Promise.all([
      ...toAttach.map((itemId) =>
        attachItemMutation.mutateAsync({ catId: activeCat.id, itemId }),
      ),
      ...toDetach.map((itemId: string) =>
        detachItemMutation.mutateAsync({ catId: activeCat.id, itemId }),
      ),
    ]);
    qc.invalidateQueries({ queryKey: ["menu", menuId] });
    setShowAddProductModal(false);
  };

  // ── Loading / empty states ─────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="h-12 bg-zinc-100 rounded animate-pulse" />
        <div className="h-96 bg-zinc-100 rounded animate-pulse" />
      </div>
    );
  }
  if (!menu) {
    return (
      <div className="text-center py-12 text-zinc-500">
        Menu not found.{" "}
        <Link href="/dashboard/menu" className="text-orange-600 underline">
          Back to menus
        </Link>
      </div>
    );
  }

  // ── Filtered products in the active category ───────────────────────
  const products = ((activeCat?.items ?? []) as any[]).map((link: any) => ({
    ...link.item,
    sortOrder: link.sortOrder,
    linkId: link.itemId,
  }));
  const filteredProducts = productSearch.trim()
    ? products.filter(
        (p) =>
          p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
          (p.plu ?? p.sku ?? "")
            .toLowerCase()
            .includes(productSearch.toLowerCase()),
      )
    : products;

  return (
    <div className="-mx-6 -my-6 h-[calc(100vh-4rem)] flex flex-col">
      {/* ── Top bar ───────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3.5">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push("/dashboard/menu")}
            className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Menus
          </button>
          <h1 className="text-xl font-bold text-zinc-900 tracking-tight uppercase">
            {menu.name}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setVariantsOpen(true)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Pricing variants
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setChannelPricingOpen(true)}
          >
            <Percent className="h-4 w-4" />
            Channels pricing
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="h-4 w-4" />
            Settings
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={() =>
              window.open(`/menu/${menuId}/preview`, "_blank")
            }
          >
            <Eye className="h-4 w-4" />
            Preview Menu
          </Button>
          {menu.status !== "PUBLISHED" && (
            <Button
              size="sm"
              className="h-9 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={() => publishMutation.mutate()}
            >
              Publish
            </Button>
          )}
        </div>
      </div>

      {/* Phase AP — menu Settings drawer. Edit name/description/menuType
          + hero/banner/logo images here. Categories, products, modifier
          groups remain in the sidebar + main panel. */}
      <VariantsManagerModal
        open={variantsOpen}
        menuId={menuId}
        variants={(menu as any)?.pricingVariants ?? []}
        brandIds={menuBrandIds}
        onClose={() => setVariantsOpen(false)}
      />
      <GeneratePhotosModal
        open={photosOpen && isAdmin}
        menuId={menuId}
        category={
          activeCat
            ? {
                id: activeCat.id,
                name: activeCat.name,
                count: (activeCat.items ?? []).length,
              }
            : null
        }
        onClose={() => setPhotosOpen(false)}
      />
      <ChannelPricingModal
        open={channelPricingOpen}
        menuId={menuId}
        menuName={(menu as any)?.name ?? "this menu"}
        brandId={(menu as any)?.brandId ?? menuBrandIds[0] ?? ""}
        onClose={() => setChannelPricingOpen(false)}
      />
      <ProductVariantPricingModal
        open={pricingTarget !== null}
        menuId={menuId}
        product={pricingTarget}
        variants={(menu as any)?.pricingVariants ?? []}
        onClose={() => setPricingTarget(null)}
      />

      {settingsOpen && (
        <MenuSettingsDrawer
          menu={menu as any}
          canGenerate={isAdmin}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* ── Body: sidebar + main ─────────────────────────────── */}
      <div className="flex-1 flex min-h-0">
        {/* ── Categories sidebar ─────────────────────────────── */}
        <aside className="w-72 flex-shrink-0 border-r border-zinc-200 bg-white p-5 overflow-y-auto">
          <h2 className="text-base font-bold text-zinc-900 mb-3">Categories</h2>

          {addingCategory ? (
            <div className="flex gap-1.5 mb-3">
              <Input
                autoFocus
                placeholder="Category name"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newCatName.trim()) {
                    addCatMutation.mutate(newCatName.trim());
                  }
                  if (e.key === "Escape") {
                    setAddingCategory(false);
                    setNewCatName("");
                  }
                }}
                className="h-9 text-sm"
              />
              <Button
                size="sm"
                onClick={() => addCatMutation.mutate(newCatName.trim())}
                disabled={!newCatName.trim() || addCatMutation.isPending}
                className="h-9 bg-orange-500 hover:bg-orange-600 text-white"
              >
                Save
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddingCategory(true)}
              className="w-full h-10 mb-3 border-dashed border-zinc-300 text-zinc-600 hover:text-zinc-900"
            >
              <Plus className="h-4 w-4 mr-1.5" />
              Add category
            </Button>
          )}

          <ul className="space-y-1">
            {categories.map((cat: any, idx: number) => (
              <li
                key={cat.id}
                draggable
                onDragStart={() => {
                  draggingCatIdx.current = idx;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  const from = draggingCatIdx.current;
                  if (from == null || from === idx) return;
                  // Build new order array, then push to server.
                  const next = [...categories];
                  const [moved] = next.splice(from, 1);
                  next.splice(idx, 0, moved);
                  reorderCatMutation.mutate({
                    items: next.map((c, i) => ({ id: c.id, sortOrder: i })),
                  });
                  draggingCatIdx.current = null;
                }}
                className={cn(
                  "group flex items-center gap-1 rounded-md cursor-pointer transition-colors",
                  effectiveCatId === cat.id
                    ? "bg-orange-50 border-l-2 border-orange-500"
                    : "hover:bg-zinc-50 border-l-2 border-transparent",
                )}
                onClick={() => setActiveCatId(cat.id)}
              >
                <span className="cursor-grab text-zinc-300 hover:text-zinc-600 px-1.5 py-2.5">
                  <GripVertical className="h-3.5 w-3.5" />
                </span>
                {editingCatId === cat.id ? (
                  <input
                    autoFocus
                    value={editCatName}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditCatName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && editCatName.trim()) {
                        renameCatMutation.mutate({ catId: cat.id, name: editCatName.trim() });
                      } else if (e.key === "Escape") {
                        setEditingCatId(null);
                      }
                    }}
                    onBlur={() => {
                      if (editCatName.trim() && editCatName.trim() !== cat.name) {
                        renameCatMutation.mutate({ catId: cat.id, name: editCatName.trim() });
                      } else {
                        setEditingCatId(null);
                      }
                    }}
                    className="flex-1 min-w-0 my-1.5 rounded border border-orange-300 px-2 py-1 text-sm font-medium text-zinc-800 focus:outline-none focus:ring-1 focus:ring-orange-400"
                  />
                ) : (
                  <span className="flex-1 py-2.5 text-sm font-medium text-zinc-800 truncate">
                    {cat.name}
                  </span>
                )}
                {editingCatId === cat.id ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (editCatName.trim()) {
                        renameCatMutation.mutate({ catId: cat.id, name: editCatName.trim() });
                      }
                    }}
                    className="px-2 py-2 text-emerald-500 hover:text-emerald-700"
                    title="Save name"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingCatId(cat.id);
                      setEditCatName(cat.name);
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity px-2 py-2 text-zinc-300 hover:text-zinc-700"
                    title="Rename category"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      confirm(`Delete category "${cat.name}"?`)
                    )
                      deleteCatMutation.mutate(cat.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity px-2 py-2 text-zinc-300 hover:text-red-600"
                  title="Delete category"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
            {categories.length === 0 && (
              <li className="text-xs text-zinc-400 italic px-2 py-3">
                No categories yet. Click &quot;Add category&quot; above.
              </li>
            )}
          </ul>
        </aside>

        {/* ── Main: active category products ───────────────────── */}
        <main className="flex-1 overflow-y-auto bg-zinc-50 p-6">
          {!activeCat ? (
            <div className="text-center py-16 text-sm text-zinc-400">
              Add a category from the sidebar to start building your menu.
            </div>
          ) : (
            <>
              {/* Category header + search + Add product */}
              <div className="flex items-center gap-3 mb-5">
                <h2 className="text-xl font-bold text-zinc-900 flex-shrink-0">
                  {activeCat.name}
                </h2>
                <div className="relative flex-1 max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <Input
                    placeholder="Search products..."
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    className="pl-9 h-9 text-sm bg-white"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAddProductModal(true)}
                  className="h-9"
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  Add Existing
                </Button>
                {/* Sort this category A-Z.
                    Confirmed first because it overwrites an order the
                    operator may have spent time dragging into place, and the
                    only way back is to drag it all again. */}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    products.length < 2 || reorderItemsMutation.isPending
                  }
                  onClick={() => {
                    if (
                      !confirm(
                        `Sort the ${products.length} products in "${activeCat.name}" A-Z? This replaces their current order.`,
                      )
                    ) {
                      return;
                    }
                    // Sorts every product in the category, not just the ones
                    // matching the search box — numbering only the visible
                    // ones would push the rest to the end.
                    const sorted = [...products].sort((a: any, b: any) =>
                      NAME_COLLATOR.compare(a.name ?? "", b.name ?? ""),
                    );
                    reorderItemsMutation.mutate({
                      catId: activeCat.id,
                      order: sorted.map((p: any, i: number) => ({
                        itemId: p.linkId,
                        sortOrder: i,
                      })),
                    });
                  }}
                  className="h-9"
                  title="Put this category's products in alphabetical order"
                >
                  <ArrowDownAZ className="h-4 w-4 mr-1.5" />
                  A-Z
                </Button>
                {/* Admin only while this is being trialled: it spends real
                    money per photo and replaces customer-facing images, so
                    it isn't something to leave in front of every operator
                    yet. The endpoint is @Roles("PLATFORM_ADMIN") regardless —
                    this only stops the button appearing. */}
                {isAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPhotosOpen(true)}
                    className="h-9"
                    title="Generate AI photos for the items in this category"
                  >
                    <Camera className="h-4 w-4 mr-1.5" />
                    Generate photos
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => setProductEditorTarget("new")}
                  className="h-9 bg-zinc-900 hover:bg-zinc-800 text-white"
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  Create New
                </Button>
              </div>

              {/* Product cards grid */}
              {filteredProducts.length === 0 ? (
                <Card className="p-12 text-center">
                  <p className="text-sm text-zinc-400 italic mb-3">
                    {products.length === 0
                      ? `No products in "${activeCat.name}" yet.`
                      : "No products match your search."}
                  </p>
                  {products.length === 0 && (
                    <Button
                      size="sm"
                      onClick={() => setShowAddProductModal(true)}
                      className="bg-zinc-900 hover:bg-zinc-800 text-white"
                    >
                      <Plus className="h-4 w-4 mr-1.5" />
                      Add first product
                    </Button>
                  )}
                </Card>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredProducts.map((p: any, idx: number) => {
                    // How many groups this product will actually ask about.
                    //
                    // Which place they attach depends on whether it has
                    // sizes, and the two are NOT additive: the multi-SKU
                    // picker reads `selectedSku.modifierGroups` and ignores
                    // the product's own links entirely. So a sized product
                    // counts what its SKUs offer — counting both showed 2 on
                    // a pizza that asks one question, because the item link
                    // and the SKU list pointed at different rows.
                    //
                    // (An item-level link on a sized product is therefore
                    // dead weight at order time — worth surfacing separately,
                    // but it is not something to count here.)
                    const skuGroupIds = new Set<string>();
                    for (const sku of p.productSkus ?? []) {
                      for (const gid of sku?.modifierGroups ?? []) {
                        if (typeof gid === "string" && gid) skuGroupIds.add(gid);
                      }
                    }
                    const modCount = skuGroupIds.size
                      ? skuGroupIds.size
                      : (p.modifierGroupLinks?.length ??
                        p._count?.modifierGroupLinks ??
                        0);
                    return (
                      <Card
                        key={p.id}
                        draggable
                        onDragStart={() => {
                          draggingProdIdx.current = idx;
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          const from = draggingProdIdx.current;
                          if (from == null || from === idx) return;
                          const next = [...filteredProducts];
                          const [moved] = next.splice(from, 1);
                          next.splice(idx, 0, moved);
                          reorderItemsMutation.mutate({
                            catId: activeCat.id,
                            order: next.map((row: any, i: number) => ({
                              itemId: row.id,
                              sortOrder: i,
                            })),
                          });
                          draggingProdIdx.current = null;
                        }}
                        className="group relative p-4 bg-white cursor-move hover:shadow-md transition-shadow"
                      >
                        <div className="absolute top-3 right-3 flex items-center gap-1">
                          <button
                            onClick={() => setPricingTarget(p)}
                            className="p-1 text-zinc-300 hover:text-violet-600"
                            title="Channel pricing"
                          >
                            <Tag className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => setProductEditorTarget(p.id)}
                            className="p-1 text-zinc-300 hover:text-zinc-900"
                            title="Edit product"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              if (
                                confirm(
                                  `Remove "${p.name}" from this category?\n\nThe product itself stays in the catalog.`,
                                )
                              ) {
                                detachItemMutation.mutate({
                                  catId: activeCat.id,
                                  itemId: p.id,
                                });
                              }
                            }}
                            className="p-1 text-zinc-300 hover:text-red-600"
                            title="Remove from category"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="absolute left-0 top-0 bottom-0 w-8 grid place-items-center text-zinc-200 group-hover:text-zinc-400 transition-colors">
                          <GripVertical className="h-4 w-4" />
                        </div>
                        <div className="pl-3 pr-12">
                          <h3 className="font-bold text-zinc-900 text-base leading-tight mb-1">
                            {p.name}
                          </h3>
                          {p.description && (
                            <p className="text-sm text-zinc-600 leading-snug line-clamp-3">
                              {p.description}
                            </p>
                          )}
                          <div className="mt-3 flex items-end justify-between gap-2">
                            <span className="text-lg font-bold text-orange-500">
                              {formatDisplayPrice(p as any)}
                            </span>
                            {modCount > 0 && (
                              <span className="text-xs text-zinc-500">
                                {modCount} modifier group
                                {modCount === 1 ? "" : "s"}
                              </span>
                            )}
                          </div>
                          {(p.plu || p.sku) && (
                            <p className="mt-2 text-[10px] font-mono text-zinc-400 truncate">
                              {p.plu ?? p.sku}
                            </p>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* In-place product editor — wraps the same ProductForm the
          Products tab uses. When "new" we also auto-attach the
          freshly-saved product to the active category. */}
      <ProductEditorModal
        open={productEditorTarget !== null}
        brandId={brandId}
        menuId={menuId}
        locationId={(menu as any)?.locationId ?? undefined}
        productId={
          productEditorTarget && productEditorTarget !== "new"
            ? productEditorTarget
            : undefined
        }
        onCancel={() => setProductEditorTarget(null)}
        onSaved={async () => {
          // The form already invalidated ["catalog", "products"]. Pull
          // the fresh list, find the most recently created product (by
          // createdAt desc) and attach it to the active category if we
          // were in create mode. For edit mode we just close.
          if (productEditorTarget === "new" && activeCat) {
            const all = await productsClient.list(brandId);
            const newest = [...all].sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )[0];
            const currentIds = ((activeCat.items ?? []) as any[]).map(
              (l) => l.itemId,
            );
            if (newest && !currentIds.includes(newest.id)) {
              await attachItemMutation.mutateAsync({
                catId: activeCat.id,
                itemId: newest.id,
              });
            }
          }
          qc.invalidateQueries({ queryKey: ["menu", menuId] });
          qc.invalidateQueries({
            queryKey: ["catalog", "products", brandId],
          });
          setProductEditorTarget(null);
        }}
      />

      {/* Add product modal — same AttachModal the Products tab uses */}
      <AttachModal
        open={showAddProductModal}
        title={`Add products to ${activeCat?.name ?? ""}`}
        rows={catalogProducts.map((p) => ({
          id: p.id,
          name: p.name,
          subtitle: (p.plu ?? p.sku ?? "") as string,
          meta: formatDisplayPrice(p as any),
        }))}
        initiallyAttachedIds={(activeCat?.items ?? []).map(
          (l: any) => l.itemId,
        )}
        onConfirm={handleAttachConfirm}
        onCancel={() => setShowAddProductModal(false)}
        searchPlaceholder="Search by name or PLU…"
      />
    </div>
  );
}
