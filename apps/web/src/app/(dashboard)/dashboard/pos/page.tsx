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
import { Search, ShoppingBag, Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { round2, type SelectedModifier, type ProductSku } from "@orderhub/shared";
import { ModifierSelectionModal } from "@/components/pos/modifier-selection-modal";
import {
  PosCartPanel,
  type CartLine,
  type PlaceOrderPayload,
  type PartialDraft,
} from "@/components/pos/pos-cart-panel";
import { DeliveryFeeModal } from "@/components/pos/delivery-fee-modal";
import { ChargeReaderModal } from "@/components/pos/charge-reader-modal";
import { PaymentLinkModal } from "@/components/pos/payment-link-modal";
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
  // Bumped after each placed order to force the cart panel to remount —
  // its customer/address/payment fields are internal state seeded from
  // initialDraft, so clearing `draft` alone doesn't wipe them.
  const [cartResetKey, setCartResetKey] = useState(0);
  const [search, setSearch] = useState("");
  const [submitFeedback, setSubmitFeedback] = useState<string | null>(null);
  // Phase AM — manager-side modals on the POS top bar.
  const [showFeeModal, setShowFeeModal] = useState(false);
  const [showPromosModal, setShowPromosModal] = useState(false);
  const [chargeOrder, setChargeOrder] = useState<{ id: string; amount: number } | null>(null);
  const [payLinkOrder, setPayLinkOrder] = useState<
    { id: string; amount: number; number: string; customerPhone?: string } | null
  >(null);
  // Phase AW-22 — Edit-mode. When set from ?editOrderId=, we replace
  // the create flow with a PATCH /:id/edit that swaps the order's
  // items + customer in place and triggers a reprint. The banner
  // makes it obvious to the operator they're editing, not building a
  // fresh ticket. Cart-draft persistence is disabled while editing
  // so the in-progress amendment doesn't pollute the next walk-in.
  const router = useRouter();
  const [editOrderId, setEditOrderId] = useState<string | null>(null);
  const [editOrderNumber, setEditOrderNumber] = useState<string | null>(null);
  const [editHydrated, setEditHydrated] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = new URLSearchParams(window.location.search).get("editOrderId");
    if (id) setEditOrderId(id);
  }, []);

  // Fetch + hydrate the order we're editing. Runs once when
  // editOrderId lands and ignores location persistence — the order
  // already pins its own brand + customer.
  useEffect(() => {
    if (!editOrderId || editHydrated) return;
    let cancelled = false;
    (async () => {
      try {
        const { data: order } = await apiClient.get<any>(
          `/v1/orders/${editOrderId}`,
        );
        if (cancelled) return;
        // Rehydrate cart lines straight off OrderItem rows.
        const lines: CartLine[] = (order.items ?? []).map((it: any) => ({
          id: it.id,
          menuItemId: it.menuItemId ?? "",
          displayName: it.name,
          unitPrice: Number(it.unitPrice),
          quantity: it.quantity,
          plu: it.sku ?? null,
          modifiers: (it.modifiers ?? []).map((m: any) => ({
            name: m.name,
            price: Number(m.price ?? 0),
          })),
          notes: it.notes ?? "",
        }));
        setCart(lines);
        setDraft({
          customerName: order.customerName ?? order.customerInfo?.name ?? "",
          customerPhone: order.customerPhone ?? order.customerInfo?.phone ?? "",
          fulfillmentType:
            order.fulfillmentType === "DELIVERY" ? "DELIVERY" : "PICKUP",
          addressLine1: order.deliveryAddress?.line1 ?? "",
          addressLine2: order.deliveryAddress?.line2 ?? "",
          city: order.deliveryAddress?.city ?? "",
          postcode: order.deliveryAddress?.postcode ?? "",
          notes: order.specialInstructions ?? "",
        });
        setEditOrderNumber(
          order.orderNumber ? `#${order.orderNumber}` : `#${order.id.slice(-6)}`,
        );
        setEditHydrated(true);
      } catch (err: any) {
        setSubmitFeedback(
          err?.response?.data?.message ?? err?.message ?? "Failed to load order",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editOrderId, editHydrated]);

  function exitEditMode() {
    setEditOrderId(null);
    setEditOrderNumber(null);
    setEditHydrated(false);
    setCart([]);
    setDraft({});
    router.replace("/dashboard/pos");
  }

  // ── Cart draft persistence ────────────────────────────────────────────────
  // Hydrate on mount (per location). Persist on every cart/draft change.
  // Edit-mode skips this entirely so the operator's amendment doesn't
  // bleed into the next walk-in.
  useEffect(() => {
    if (!selectedLocationId) return;
    if (editOrderId) return;
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
        // Phase AW — tag the order with the brand the active POS menu
        // is published under. Without this, Order.brandId stayed null
        // and every POS ticket fell back to location.brand (the "Order
        // Hub" tenant default) on the Orders board AND the printed
        // receipt. menuQuery.data is the menu we just walked the
        // operator through to build this basket, so its brandId is the
        // right one — no extra lookup needed.
        ...(brandId && { brandId }),
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
        marketingConsent: payload.marketingConsent,
      };

      // Phase AW-22 — edit branch: PATCH /v1/orders/:id/edit with a
      // narrower payload. Server enforces status / payment / source
      // constraints, replaces line items in a transaction, and
      // re-emits emitNewOrder so the printer reprints the full
      // updated ticket.
      if (editOrderId) {
        const editBody = {
          items: body.items,
          subtotal: body.subtotal,
          taxAmount: body.taxAmount,
          deliveryFee: body.deliveryFee,
          discount: body.discount,
          total: body.total,
          customerInfo: body.customerInfo,
          deliveryAddress: body.deliveryAddress,
          specialInstructions: body.specialInstructions,
        };
        await apiClient.patch(`/v1/orders/${editOrderId}/edit`, editBody);
        return { id: editOrderId, scheduled: false, edited: true };
      }

      const created = (await apiClient.post("/v1/orders", body)).data as {
        id: string;
      };

      // Accept every POS order on placement — including scheduled ones.
      // Scheduled orders fire the print pipeline straight away with the
      // scheduled date/time on the ticket, so the kitchen knows when
      // it's for, rather than being parked until their slot.
      //
      // EXCEPTION: an unpaid "Payment link" order must NOT be accepted here.
      // It belongs in the "Waiting for payment" tab and must not print until
      // the customer pays — the Stripe webhook then moves it to New, accepts
      // it, and prints the ticket. Accepting it now (client-side) is what made
      // it jump straight to New/Accepted before payment.
      const isUnpaidPaymentLink =
        (payload.paymentMethod === "PAYMENT_LINK" ||
          payload.paymentMethod === "QR_CODE" ||
          // Card terminal (S700 / WisePad 3) collects payment now — it must
          // wait in "Waiting for payment" until the reader charge settles, then
          // settleTerminalPi accepts + prints it. Accepting here is what jumped
          // it straight to Accepted + printed an unpaid ticket.
          payload.paymentMethod === "CARD_TERMINAL") &&
        payload.paymentStatus !== "PAID";
      if (!isUnpaidPaymentLink) {
        // Best-effort: if the location has auto-accept ON, the order is already
        // ACCEPTED server-side and this PATCH would 400 with "ACCEPTED →
        // ACCEPTED". That must NOT fail the placement (it would show an error
        // and skip the cart/payment reset), so swallow an already-accepted
        // response and only surface genuinely unexpected failures.
        try {
          await apiClient.patch(`/v1/orders/${created.id}/status`, {
            status: "ACCEPTED",
            note: "POS auto-accept",
          });
        } catch (err: any) {
          const msg = String(err?.response?.data?.message ?? "");
          if (!/ACCEPTED\s*(→|->|to)\s*ACCEPTED|already/i.test(msg)) {
            throw err;
          }
          // Already accepted (location auto-accept) — nothing to do.
        }
      }

      return {
        id: created.id,
        scheduled: payload.isScheduled,
        edited: false,
        paymentMethod: payload.paymentMethod,
        total: payload.total,
      };
    },
    onSuccess: (
      { id, scheduled, edited, paymentMethod, total },
      variables,
    ) => {
      // Card-terminal orders: pop the reader charge modal for the new order.
      if (!edited && paymentMethod === "CARD_TERMINAL" && id) {
        setChargeOrder({ id, amount: Number(total ?? 0) });
      }
      // Payment-link AND QR-code orders: pop the QR / copy-link modal for the
      // customer to pay remotely (order stays pending until the webhook flips
      // it). Same modal for both — it shows the QR prominently plus a copyable
      // link and the SMS option.
      if (
        !edited &&
        (paymentMethod === "PAYMENT_LINK" || paymentMethod === "QR_CODE") &&
        id
      ) {
        setPayLinkOrder({
          id,
          amount: Number(total ?? 0),
          number: `#${id.slice(-6)}`,
          customerPhone: variables?.customerPhone || undefined,
        });
      }
      setSubmitFeedback(
        edited
          ? `Order ${editOrderNumber ?? `#${id.slice(-6)}`} updated. Reprint queued.`
          : scheduled
            ? `Scheduled order placed (${id.slice(-6)}). Printed with its scheduled time.`
            : `Order placed (${id.slice(-6)}). Print job queued.`,
      );
      setCart([]);
      setDraft({});
      setCartResetKey((k) => k + 1); // wipe the panel's internal fields
      if (selectedLocationId) clearCartDraft(selectedLocationId);
      if (edited) {
        // Drop edit-mode and return to a fresh POS cart.
        setEditOrderId(null);
        setEditOrderNumber(null);
        setEditHydrated(false);
        router.replace("/dashboard/pos");
      }
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
      {editOrderId && (
        <div className="flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <div className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            <span>
              <strong>Editing order {editOrderNumber ?? ""}</strong> — adjust
              the cart, then tap Save changes. The kitchen ticket will
              reprint with the full updated order.
            </span>
          </div>
          <button
            type="button"
            onClick={exitEditMode}
            className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            <X className="h-3 w-3" /> Cancel edit
          </button>
        </div>
      )}
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
              key={cartResetKey}
              locationId={selectedLocationId}
              cart={cart}
              onRemoveLine={removeLine}
              onChangeQty={changeQty}
              onClearCart={clearCart}
              onPlaceOrder={async (p) => {
                await submitMutation.mutateAsync(p);
              }}
              submitting={submitMutation.isPending}
              submitButtonLabel={editOrderId ? "Save changes" : undefined}
              feedback={submitFeedback}
              initialDraft={draft}
              onDraftChange={setDraft}
            />
          </div>
        </div>
      )}

      {/* Incoming-call popup is now mounted globally in the dashboard layout
          (GlobalCallerIdPopup) so it shows on every screen, not just POS. */}

      {/* Stripe Terminal charge modal — opens after a "Card terminal" order
          is placed; charges it to the S700/WisePOS reader. */}
      {selectedLocationId && (
        <ChargeReaderModal
          open={!!chargeOrder}
          orderId={chargeOrder?.id ?? null}
          amount={chargeOrder?.amount ?? 0}
          locationId={selectedLocationId}
          onClose={() => setChargeOrder(null)}
        />
      )}

      {/* Payment Link modal — QR + copy link for the customer to pay
          remotely; the order auto-flips to Paid via the Stripe webhook. */}
      <PaymentLinkModal
        open={!!payLinkOrder}
        orderId={payLinkOrder?.id ?? null}
        orderNumber={payLinkOrder?.number ?? null}
        amount={payLinkOrder?.amount ?? 0}
        customerPhone={payLinkOrder?.customerPhone ?? null}
        onClose={() => setPayLinkOrder(null)}
      />

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
