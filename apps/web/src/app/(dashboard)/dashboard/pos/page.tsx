"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Trash2, Loader2, ShoppingBag, Search } from "lucide-react";
import { round2, type SelectedModifier, type ProductSku } from "@orderhub/shared";
import { LocationSelector } from "@/components/dashboard/location-selector";
import { ModifierSelectionModal } from "@/components/pos/modifier-selection-modal";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { menusClient, type MenuItem } from "@/lib/api/menus.client";
import { modifierGroupsClient } from "@/lib/api/catalog.client";
import { apiClient } from "@/lib/api/client";

// ── POS page ────────────────────────────────────────────────────────────────
//
// Single-page POS that mirrors Base44's flow with our new menu shape.
// Layout:
//
//   ┌─────────────────┬──────────────────┐
//   │  Category tabs  │                  │
//   ├─────────────────┤      Cart        │
//   │                 │                  │
//   │  Product grid   │      Customer    │
//   │                 │                  │
//   │                 │      Submit      │
//   └─────────────────┴──────────────────┘
//
// Tapping a product opens ModifierSelectionModal (handles multi-SKU,
// pricesBySize, addons-with-min/max). Submit sends the cart to
// POST /v1/orders with status=ACCEPTED so the existing PrinterJob
// pipeline picks it up and emits the websocket event the Orders board
// is listening for.

interface CartLine {
  id: string; // client-only random id, lets us delete duplicates
  menuItemId: string;
  displayName: string;
  unitPrice: number;
  quantity: number;
  plu?: string | null;
  modifiers: SelectedModifier[];
  selectedSku?: ProductSku | null;
  notes?: string;
}

const FAR_FUTURE = (mins: number) =>
  new Date(Date.now() + mins * 60_000).toISOString();

export default function PosPage() {
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [modalItem, setModalItem] = useState<MenuItem | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [fulfillmentType, setFulfillmentType] = useState<"DELIVERY" | "PICKUP">(
    "PICKUP",
  );
  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "CARD_TERMINAL">(
    "CASH",
  );
  const [search, setSearch] = useState("");
  const [submitFeedback, setSubmitFeedback] = useState<string | null>(null);

  const menuQuery = useQuery({
    queryKey: ["pos-menu", selectedLocationId],
    queryFn: () => menusClient.getActiveMenuForLocation(selectedLocationId!),
    enabled: !!selectedLocationId,
    staleTime: 60_000,
  });

  // Phase AM — multi-SKU products store their per-SKU modifier groups
  // as plain ID arrays inside productSkus[].modifierGroups. Those IDs
  // are NOT FK-linked through ModifierGroupOnItem, so they don't ride
  // along with item.modifierGroupLinks. To render them in the POS
  // modal we fetch the brand's full modifier-group catalog (groups +
  // options) and pass it in. The modal then resolves SKU group IDs
  // against this list for multi-SKU items, and falls back to the
  // item's own modifierGroupLinks for flat products.
  const brandId = (menuQuery.data as any)?.brandId as string | undefined;
  const allGroupsQuery = useQuery({
    queryKey: ["pos-all-modifier-groups", brandId],
    queryFn: () => modifierGroupsClient.list(brandId!),
    enabled: !!brandId,
    staleTime: 60_000,
  });

  const categories = menuQuery.data?.categories ?? [];
  const activeCategory = useMemo(
    () => categories.find((c) => c.id === activeCategoryId) ?? categories[0] ?? null,
    [categories, activeCategoryId],
  );

  const products: MenuItem[] = useMemo(() => {
    if (!activeCategory) return [];
    const items = (activeCategory.items ?? [])
      .map((link) => link.item)
      .filter((it) => it && it.isAvailable);
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        (it.description ?? "").toLowerCase().includes(q),
    );
  }, [activeCategory, search]);

  const subtotal = useMemo(
    () => round2(cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0)),
    [cart],
  );

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!selectedLocationId) throw new Error("Select a location first");
      if (cart.length === 0) throw new Error("Cart is empty");

      // Step 1: create the order (lands at PENDING by default).
      const body = {
        locationId: selectedLocationId,
        orderSource: "POS" as const,
        fulfillmentType,
        customerInfo: {
          name: customerName || "Walk-in",
          phone: customerPhone || undefined,
        },
        items: cart.map((line) => ({
          name: line.displayName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          totalPrice: round2(line.unitPrice * line.quantity),
          notes: line.notes,
          sku: line.plu ?? undefined,
          modifiers: line.modifiers.map((m) => ({
            name: m.name,
            price: m.price,
            quantity: 1,
          })),
        })),
        subtotal,
        taxAmount: 0,
        deliveryFee: 0,
        discount: 0,
        total: subtotal,
        specialInstructions: undefined,
        scheduledFor: FAR_FUTURE(20),
      };
      const created = (await apiClient.post("/v1/orders", body)).data as {
        id: string;
      };

      // Step 2: immediately accept so PrinterJob + WS fire. Mirrors the
      // Base44 POS where staff-created orders skip the New column.
      await apiClient.patch(`/v1/orders/${created.id}/status`, {
        status: "ACCEPTED",
        note: "POS auto-accept",
      });

      return created;
    },
    onSuccess: (order) => {
      setSubmitFeedback(`Order placed (${order.id.slice(-6)}). Print job queued.`);
      setCart([]);
      setCustomerName("");
      setCustomerPhone("");
      window.setTimeout(() => setSubmitFeedback(null), 5000);
    },
    onError: (err: any) => {
      setSubmitFeedback(
        err?.response?.data?.message ?? err?.message ?? "Failed to submit order",
      );
      window.setTimeout(() => setSubmitFeedback(null), 5000);
    },
  });

  const onProductClick = (item: MenuItem) => {
    // Multi-SKU products always need the modal (size picker + SKU-
    // attached groups). Flat products need it only if they carry FK-
    // linked modifier groups.
    const hasMods = (item.modifierGroupLinks?.length ?? 0) > 0;
    if (hasMods || item.hasMultipleSkus) {
      setModalItem(item);
      return;
    }
    // Simple add — no modifiers, no SKU.
    addToCart({
      menuItemId: item.id,
      displayName: item.name,
      unitPrice: Number(item.basePrice),
      quantity: 1,
      plu: item.plu ?? null,
      modifiers: [],
      selectedSku: null,
    });
  };

  const addToCart = (line: Omit<CartLine, "id">) => {
    setCart((prev) => [
      ...prev,
      { ...line, id: Math.random().toString(36).slice(2) },
    ]);
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-3">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">POS</h1>
          <p className="text-sm text-zinc-500">
            Walk-in &amp; phone orders — auto-accepted &amp; printed
          </p>
        </div>
        <LocationSelector />
      </div>

      {!selectedLocationId ? (
        <EmptyState text="Select a location to start taking orders." />
      ) : menuQuery.isLoading ? (
        <EmptyState text="Loading menu…" />
      ) : !menuQuery.data ? (
        <EmptyState
          text="No active menu found for this location. Create one in Menu Manager."
        />
      ) : (
        <div className="grid flex-1 grid-cols-12 gap-3 overflow-hidden">
          {/* Left — menu */}
          <div className="col-span-8 flex flex-col gap-3 overflow-hidden">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search items in this category…"
                  className="w-full rounded-lg border border-zinc-200 bg-white px-9 py-2 text-sm focus:border-zinc-900 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex gap-2 overflow-x-auto pb-1">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategoryId(cat.id)}
                  className={`flex-shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium ${
                    activeCategory?.id === cat.id
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3">
              {products.length === 0 ? (
                <p className="py-12 text-center text-sm text-zinc-400">
                  No items in this category.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                  {products.map((product) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      onClick={() => onProductClick(product)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right — cart */}
          <div className="col-span-4 flex flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white">
            <div className="border-b border-zinc-200 px-4 py-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-900">
                  Current order
                </h2>
                <span className="text-xs text-zinc-400">
                  {cart.length} item{cart.length !== 1 ? "s" : ""}
                </span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-2">
              {cart.length === 0 ? (
                <div className="py-12 text-center">
                  <ShoppingBag className="mx-auto mb-2 h-8 w-8 text-zinc-300" />
                  <p className="text-sm text-zinc-400">Cart is empty</p>
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {cart.map((line) => (
                    <li
                      key={line.id}
                      className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-50"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-zinc-900 leading-snug">
                          {line.displayName}
                        </p>
                        <p className="mt-0.5 text-[10px] text-zinc-500">
                          {line.quantity} × £{line.unitPrice.toFixed(2)} = £
                          {(line.quantity * line.unitPrice).toFixed(2)}
                        </p>
                      </div>
                      <button
                        onClick={() =>
                          setCart((prev) => prev.filter((l) => l.id !== line.id))
                        }
                        className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t border-zinc-200 px-4 py-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Customer name"
                  className="rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                />
                <input
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="Phone"
                  className="rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <Toggle
                  options={[
                    { value: "PICKUP", label: "Collection" },
                    { value: "DELIVERY", label: "Delivery" },
                  ]}
                  value={fulfillmentType}
                  onChange={(v) =>
                    setFulfillmentType(v as "PICKUP" | "DELIVERY")
                  }
                />
                <Toggle
                  options={[
                    { value: "CASH", label: "Cash" },
                    { value: "CARD_TERMINAL", label: "Card" },
                  ]}
                  value={paymentMethod}
                  onChange={(v) =>
                    setPaymentMethod(v as "CASH" | "CARD_TERMINAL")
                  }
                />
              </div>

              <div className="flex items-center justify-between border-t border-zinc-100 pt-2 text-sm">
                <span className="text-zinc-500">Total</span>
                <span className="font-semibold text-zinc-900">
                  £{subtotal.toFixed(2)}
                </span>
              </div>

              <button
                onClick={() => submitMutation.mutate()}
                disabled={cart.length === 0 || submitMutation.isPending}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {submitMutation.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                Place order
              </button>

              {submitFeedback && (
                <p className="text-center text-xs text-zinc-600">
                  {submitFeedback}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {modalItem && (
        <ModifierSelectionModal
          item={modalItem}
          allModifierGroups={allGroupsQuery.data ?? []}
          open={!!modalItem}
          onClose={() => setModalItem(null)}
          onAdd={(line) => addToCart(line)}
        />
      )}
    </div>
  );
}

function ProductCard({
  product,
  onClick,
}: {
  product: MenuItem;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-1 rounded-lg border border-zinc-200 bg-white p-3 text-left transition-colors hover:border-zinc-900 hover:shadow-sm disabled:opacity-50"
      disabled={product.outOfStock}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span className="text-xs font-medium text-zinc-900 leading-snug line-clamp-2">
          {product.name}
        </span>
        {product.outOfStock && (
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600">
            OOS
          </span>
        )}
      </div>
      <span className="mt-0.5 text-xs text-zinc-500">
        £{Number(product.basePrice).toFixed(2)}
      </span>
    </button>
  );
}

function Toggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-zinc-200 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-sm px-1 py-1 ${
            value === o.value
              ? "bg-zinc-900 text-white"
              : "text-zinc-600 hover:bg-zinc-50"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-sm text-zinc-400">
      {text}
    </div>
  );
}
