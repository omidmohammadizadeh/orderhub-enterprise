"use client";

// Phase AM — POS page: 2-column layout.
// Left: category tabs + product grid + search.
// Right: PosCartPanel (customer, address, timing, discounts, promo, payment).
//
// The page itself owns:
//   • cart line state (with localStorage persistence per location)
//   • menu fetch + active category
//   • the product → ModifierSelectionModal handoff
//   • order-submit mutation that hands the panel's PlaceOrderPayload off
//     to the API
//
// The cart panel owns everything else (customer/address/timing/discount/
// promo/payment) so the page stays a thin orchestration layer.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Search, ShoppingBag } from "lucide-react";
import { round2, type SelectedModifier, type ProductSku } from "@orderhub/shared";
import { LocationSelector } from "@/components/dashboard/location-selector";
import { ModifierSelectionModal } from "@/components/pos/modifier-selection-modal";
import {
  PosCartPanel,
  type CartLine,
  type PlaceOrderPayload,
  type PartialDraft,
} from "@/components/pos/pos-cart-panel";
import { DeliveryFeeModal } from "@/components/pos/delivery-fee-modal";
import { PromosModal } from "@/components/pos/promos-modal";
// Phase AP follow-up (AP-NAV-1): Direct online ordering moved to its
// own sidebar entry (/dashboard/direct-ordering). The modal import and
// button below are gone; the settings page itself still uses
// DirectOrderingSettings (re-exported from this file).
import { Truck, Tag } from "lucide-react";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { menusClient, type MenuItem } from "@/lib/api/menus.client";
import { modifierGroupsClient } from "@/lib/api/catalog.client";
import { apiClient } from "@/lib/api/client";
import {
  saveCartDraft,
  loadCartDraft,
  clearCartDraft,
} from "@/lib/pos/cart-storage";

interface PersistedCart {
  cart: CartLine[];
  draft: PartialDraft;
}

export default function PosPage() {
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [modalItem, setModalItem] = useState<MenuItem | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [draft, setDraft] = useState<PartialDraft>({});
  const [search, setSearch] = useState("");
  const [submitFeedback, setSubmitFeedback] = useState<string | null>(null);
  // Phase AM — manager-side modals on the POS top bar.
  const [showFeeModal, setShowFeeModal] = useState(false);
  const [showPromosModal, setShowPromosModal] = useState(false);

  // ── Cart draft persistence ────────────────────────────────────────────────
  // Hydrate on mount (per location). Persist on every cart/draft change.
  useEffect(() => {
    if (!selectedLocationId) return;
    const persisted = loadCartDraft<PersistedCart>(selectedLocationId);
    if (persisted) {
      setCart(persisted.cart ?? []);
      setDraft(persisted.draft ?? {});
    } else {
      setCart([]);
      setDraft({});
    }
  }, [selectedLocationId]);

  useEffect(() => {
    if (!selectedLocationId) return;
    saveCartDraft<PersistedCart>(selectedLocationId, { cart, draft });
  }, [selectedLocationId, cart, draft]);

  // ── Menu fetch ────────────────────────────────────────────────────────────
  const menuQuery = useQuery({
    queryKey: ["pos-menu", selectedLocationId],
    queryFn: () => menusClient.getActiveMenuForLocation(selectedLocationId!),
    enabled: !!selectedLocationId,
    staleTime: 60_000,
  });

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

  // ── Submit ────────────────────────────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: async (payload: PlaceOrderPayload) => {
      if (!selectedLocationId) throw new Error("Select a location first");

      const body = {
        locationId: selectedLocationId,
        orderSource: "POS" as const,
        fulfillmentType: payload.fulfillmentType,
        customerInfo: {
          name: payload.customerName,
          phone: payload.customerPhone || undefined,
        },
        deliveryAddress: payload.address,
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
        subtotal: payload.subtotal,
        taxAmount: 0,
        deliveryFee: payload.deliveryFee,
        discount: payload.discountAmount,
        total: payload.total,
        specialInstructions: payload.notes,
        scheduledFor: payload.scheduledFor,
        // ── Phase AM new fields ──
        callerId: payload.callerId,
        preparationMinutes: payload.preparationMinutes || undefined,
        discountType: payload.discountType ?? undefined,
        promoCode: payload.promoCode,
        paymentMethod: payload.paymentMethod,
        paymentStatus: payload.paymentStatus,
        isScheduled: payload.isScheduled,
      };

      const created = (await apiClient.post("/v1/orders", body)).data as {
        id: string;
      };

      // Scheduled orders stay at PENDING — they show up in the Scheduled
      // section of the Orders board and only transition to ACCEPTED (which
      // fires the print pipeline) when the operator clicks "Start preparing
      // now". For immediate orders we auto-accept here so the kitchen sees
      // the ticket straight away.
      if (!payload.isScheduled) {
        await apiClient.patch(`/v1/orders/${created.id}/status`, {
          status: "ACCEPTED",
          note: "POS auto-accept",
        });
      }

      return { id: created.id, scheduled: payload.isScheduled };
    },
    onSuccess: ({ id, scheduled }) => {
      setSubmitFeedback(
        scheduled
          ? `Scheduled order saved (${id.slice(-6)}). It will appear in Scheduled.`
          : `Order placed (${id.slice(-6)}). Print job queued.`,
      );
      setCart([]);
      setDraft({});
      if (selectedLocationId) clearCartDraft(selectedLocationId);
      window.setTimeout(() => setSubmitFeedback(null), 5000);
    },
    onError: (err: any) => {
      setSubmitFeedback(
        err?.response?.data?.message ?? err?.message ?? "Failed to submit order",
      );
      window.setTimeout(() => setSubmitFeedback(null), 6000);
    },
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  const onProductClick = (item: MenuItem) => {
    const hasMods = (item.modifierGroupLinks?.length ?? 0) > 0;
    if (hasMods || item.hasMultipleSkus) {
      setModalItem(item);
      return;
    }
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

  const addToCart = (line: {
    menuItemId: string;
    displayName: string;
    unitPrice: number;
    quantity: number;
    plu?: string | null;
    modifiers: SelectedModifier[];
    selectedSku?: ProductSku | null;
    notes?: string;
  }) => {
    setCart((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).slice(2),
        menuItemId: line.menuItemId,
        displayName: line.displayName,
        unitPrice: line.unitPrice,
        quantity: line.quantity,
        plu: line.plu ?? null,
        modifiers: line.modifiers.map((m) => ({ name: m.name, price: m.price })),
        notes: line.notes,
      },
    ]);
  };

  const removeLine = useCallback((id: string) => {
    setCart((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const changeQty = useCallback((id: string, qty: number) => {
    setCart((prev) =>
      prev.map((l) => (l.id === id ? { ...l, quantity: qty } : l)),
    );
  }, []);

  const clearCart = useCallback(() => setCart([]), []);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-3">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">POS</h1>
          <p className="text-sm text-zinc-500">
            Walk-in, phone &amp; scheduled orders
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowFeeModal(true)}
            disabled={!selectedLocationId}
            title="Configure delivery zones & fees for this location"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50"
          >
            <Truck className="h-3.5 w-3.5" /> Delivery fee
          </button>
          <button
            type="button"
            onClick={() => setShowPromosModal(true)}
            disabled={!selectedLocationId}
            title="Set up quick-discount promos for this location"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50"
          >
            <Tag className="h-3.5 w-3.5" /> Promos
          </button>
          <LocationSelector />
        </div>
      </div>

      {!selectedLocationId ? (
        <EmptyState text="Select a location to start taking orders." />
      ) : menuQuery.isLoading ? (
        <EmptyState text="Loading menu…" />
      ) : !menuQuery.data ? (
        <EmptyState text="No active menu found for this location. Create one in Menu Manager." />
      ) : (
        <div className="grid flex-1 grid-cols-12 gap-3 overflow-hidden">
          {/* Left — menu */}
          <div className="col-span-7 flex flex-col gap-3 overflow-hidden lg:col-span-8">
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
                  type="button"
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
                <div className="py-12 text-center">
                  <ShoppingBag className="mx-auto mb-2 h-7 w-7 text-zinc-300" />
                  <p className="text-sm text-zinc-400">No items in this category.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
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

          {/* Right — cart panel */}
          <div className="col-span-5 lg:col-span-4 flex flex-col overflow-hidden">
            <PosCartPanel
              locationId={selectedLocationId}
              cart={cart}
              onRemoveLine={removeLine}
              onChangeQty={changeQty}
              onClearCart={clearCart}
              onPlaceOrder={async (p) => {
                await submitMutation.mutateAsync(p);
              }}
              submitting={submitMutation.isPending}
              feedback={submitFeedback}
              initialDraft={draft}
              onDraftChange={setDraft}
            />
          </div>
        </div>
      )}

      {showFeeModal && selectedLocationId && (
        <DeliveryFeeModal
          locationId={selectedLocationId}
          onClose={() => setShowFeeModal(false)}
        />
      )}
      {showPromosModal && selectedLocationId && (
        <PromosModal
          locationId={selectedLocationId}
          onClose={() => setShowPromosModal(false)}
        />
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
      type="button"
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

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-sm text-zinc-400">
      {text}
    </div>
  );
}
