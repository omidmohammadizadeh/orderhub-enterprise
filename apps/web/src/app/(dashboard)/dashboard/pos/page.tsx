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
import { useRouter, useSearchParams } from "next/navigation";
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
import {
  cacheMenu,
  getCachedMenu,
  enqueueOrder,
  newLocalId,
} from "@/lib/pos/idb-storage";
import { startSyncWorker } from "@/lib/pos/sync-worker";
import { useOnlineStatus, useSyncQueue } from "@/lib/pos/use-online-status";
import { tablesClient } from "@/lib/api/tables.client";

interface PersistedCart {
  cart: CartLine[];
  draft: PartialDraft;
}

export default function PosPage() {
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );

  // Phase AN — offline: connectivity, the offline order queue, and the cached
  // menu fallback. The sync worker drains queued orders on reconnect.
  const online = useOnlineStatus();
  const { pending: pendingSync, retry: retrySync } = useSyncQueue();
  const [cachedMenu, setCachedMenu] = useState<{
    menu: any;
    modifierGroups?: any;
  } | null>(null);
  useEffect(() => startSyncWorker(), []);

  // ── Table Tabs (dine-in) — active only when opened from the Tables floor
  // (?tableId=…). Everything below is guarded on tableId, so ordinary takeaway
  // POS is completely unaffected.
  const searchParams = useSearchParams();
  const tableId = searchParams.get("tableId");
  const tableName = searchParams.get("tableName");
  const tableQuery = useQuery({
    queryKey: ["pos-table", tableId, selectedLocationId],
    queryFn: () => tablesClient.list(selectedLocationId!),
    enabled: !!tableId && !!selectedLocationId,
    refetchInterval: 10_000,
  });
  const currentTable =
    (tableQuery.data ?? []).find((t) => t.id === tableId) ?? null;
  const tabOrderId = currentTable?.currentOrderId ?? null;
  const tabOrderQuery = useQuery({
    queryKey: ["pos-tab-order", tabOrderId],
    queryFn: () =>
      apiClient.get(`/v1/orders/${tabOrderId}`).then((r) => r.data),
    enabled: !!tabOrderId,
    refetchInterval: 10_000,
  });
  const tabTotal = Number((tabOrderQuery.data as any)?.total ?? 0);
  const tabItemCount = ((tabOrderQuery.data as any)?.items ?? []).reduce(
    (s: number, i: any) => s + (i.quantity ?? 0),
    0,
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
  // Table Tabs — true while the charge modal is settling a tab (so its close
  // handler completes the order + frees the table when paid).
  const [closingTab, setClosingTab] = useState(false);
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

  // Offline fallback: use the last menu cached in IndexedDB when the network
  // read fails, so the POS still renders items/prices/86-state offline.
  const menuData = (menuQuery.data ??
    cachedMenu?.menu) as typeof menuQuery.data;
  const brandId = (menuData as any)?.brandId as string | undefined;
  const allGroupsQuery = useQuery({
    queryKey: ["pos-all-modifier-groups", brandId],
    queryFn: () => modifierGroupsClient.list(brandId!),
    enabled: !!brandId,
    staleTime: 60_000,
  });
  const allGroups = (allGroupsQuery.data ??
    cachedMenu?.modifierGroups ??
    []) as NonNullable<typeof allGroupsQuery.data>;

  // Mirror the live menu + modifier catalog to IndexedDB whenever they load.
  useEffect(() => {
    if (selectedLocationId && menuQuery.data) {
      void cacheMenu(selectedLocationId, menuQuery.data, allGroupsQuery.data);
    }
  }, [selectedLocationId, menuQuery.data, allGroupsQuery.data]);

  // Pull the cached menu when the server can't be reached (offline / errored).
  useEffect(() => {
    if (!selectedLocationId || menuQuery.data) return;
    if (online && !menuQuery.isError) return; // still trying online
    void getCachedMenu(selectedLocationId).then((c) => {
      if (c) setCachedMenu(c);
    });
  }, [selectedLocationId, menuQuery.data, menuQuery.isError, online]);

  const categories = menuData?.categories ?? [];
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

      // Stable id used as the server idempotencyKey (retry-safe: the unique
      // index de-dupes) and as the local queue id when offline.
      const localId = newLocalId();

      const body = {
        locationId: selectedLocationId,
        idempotencyKey: localId,
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
          // KDS station routing (category/item rules) matches on this.
          menuItemId: line.menuItemId || undefined,
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

      // ── Table Tabs (dine-in): send this round to the kitchen ──
      // First send creates + links the tab order (fired to the kitchen via
      // auto-accept); later sends append a round (fires only the new items).
      // Payment is taken at the end via "Pay & close", not per round.
      if (tableId) {
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          throw new Error("Reconnect to use table service.");
        }
        if (tabOrderId) {
          await apiClient.post(`/v1/orders/${tabOrderId}/rounds`, {
            items: body.items,
          });
          return {
            id: tabOrderId,
            scheduled: false,
            edited: false,
            paymentMethod: "CASH",
            total: tabTotal,
            offline: false,
            dineIn: "round" as const,
          };
        }
        const created = (
          await apiClient.post("/v1/orders", {
            ...body,
            fulfillmentType: "DINE_IN",
            tableId,
            paymentMethod: "CASH",
            paymentStatus: "PENDING",
            // Board, KDS and chits identify a tab by its table — fall back
            // to the table name when no guest name was typed.
            customerInfo: {
              ...body.customerInfo,
              name:
                (body.customerInfo?.name ?? "").trim() ||
                (tableName ?? "Table"),
            },
          })
        ).data as { id: string };
        await tablesClient.linkOrder(tableId, created.id).catch(() => {});
        try {
          await apiClient.patch(`/v1/orders/${created.id}/status`, {
            status: "ACCEPTED",
            note: "Dine-in tab",
          });
        } catch (err: any) {
          const msg = String(err?.response?.data?.message ?? "");
          if (!/ACCEPTED\s*(→|->|to)\s*ACCEPTED|already/i.test(msg)) throw err;
        }
        return {
          id: created.id,
          scheduled: false,
          edited: false,
          paymentMethod: "CASH",
          total: Number(payload.total ?? 0),
          offline: false,
          dineIn: "first" as const,
        };
      }

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
        return {
          id: editOrderId,
          scheduled: false,
          edited: true,
          paymentMethod: payload.paymentMethod,
          total: payload.total,
          offline: false,
          dineIn: null,
        };
      }

      // Offline: queue the order locally and sync on reconnect. Cash (and
      // externally-settled) only — card/online need connectivity to authorise.
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (
          payload.paymentMethod !== "CASH" &&
          payload.paymentMethod !== "EXTERNAL"
        ) {
          throw new Error(
            "You're offline — only cash orders can be taken. Reconnect to take card or online payments.",
          );
        }
        // Never let a stalled IndexedDB spin "Place order" forever — cap it.
        await Promise.race([
          enqueueOrder({
            localId,
            locationId: selectedLocationId,
            body,
            total: Number(payload.total ?? 0),
            customerName: payload.customerName || "Walk-in",
          }),
          new Promise((_, reject) =>
            window.setTimeout(
              () =>
                reject(
                  new Error("Couldn't save the order on this device — try again."),
                ),
              5000,
            ),
          ),
        ]);
        return {
          id: localId,
          scheduled: payload.isScheduled,
          edited: false,
          paymentMethod: payload.paymentMethod,
          total: payload.total,
          offline: true,
          dineIn: null,
        };
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
        offline: false,
        dineIn: null,
      };
    },
    onSuccess: (
      {
        id,
        scheduled,
        edited,
        paymentMethod,
        total,
        offline: wasOffline,
        dineIn,
      },
      variables,
    ) => {
      // Dine-in tab: this round went to the kitchen. No charge now (pay at the
      // end via "Pay & close"); just reset the cart and refresh the tab.
      if (dineIn) {
        setSubmitFeedback(
          dineIn === "first"
            ? `Tab opened for ${tableName ?? "table"} — sent to kitchen.`
            : `Added to ${tableName ?? "table"} tab.`,
        );
        setCart([]);
        setDraft({});
        setCartResetKey((k) => k + 1);
        if (selectedLocationId) clearCartDraft(selectedLocationId);
        void tableQuery.refetch();
        void tabOrderQuery.refetch();
        window.setTimeout(() => setSubmitFeedback(null), 4000);
        return;
      }
      // Offline: the order is saved locally and will sync on reconnect. No
      // charge/pay-link modals (cash only), just confirm + reset.
      if (wasOffline) {
        setSubmitFeedback(
          `Saved offline (${id.slice(-6)}). It'll sync automatically when you're back online.`,
        );
        setCart([]);
        setDraft({});
        setCartResetKey((k) => k + 1);
        if (selectedLocationId) clearCartDraft(selectedLocationId);
        window.setTimeout(() => setSubmitFeedback(null), 6000);
        return;
      }
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

  // ── Table Tabs: settle & close ────────────────────────────────────────────
  // "Pay & close" opens a cash-or-card choice: card runs the existing
  // terminal flow (ChargeReaderModal); cash marks the tab PAID directly
  // (same manual fallback the Orders board uses) and frees the table.
  const [payChoiceOpen, setPayChoiceOpen] = useState(false);
  const [settlingCash, setSettlingCash] = useState(false);
  const payAndCloseTab = () => {
    if (!tabOrderId) return;
    setPayChoiceOpen(true);
  };
  const settleCard = () => {
    if (!tabOrderId) return;
    setPayChoiceOpen(false);
    setClosingTab(true);
    setChargeOrder({ id: tabOrderId, amount: tabTotal });
  };
  const settleCash = async () => {
    if (!tabOrderId || !tableId || settlingCash) return;
    if (!window.confirm(`£${tabTotal.toFixed(2)} received in cash?`)) return;
    setSettlingCash(true);
    try {
      await apiClient.patch(`/v1/orders/${tabOrderId}/payment-status`, {
        paymentStatus: "PAID",
        paymentMethod: "CASH",
      });
      await apiClient
        .patch(`/v1/orders/${tabOrderId}/status`, {
          status: "COMPLETED",
          note: "Tab settled — cash",
        })
        .catch(() => {});
      await tablesClient.free(tableId).catch(() => {});
      setPayChoiceOpen(false);
      setSubmitFeedback(`${tableName ?? "Table"} settled (cash) and cleared.`);
      router.push("/dashboard/tables");
    } catch (err: any) {
      setSubmitFeedback(
        err?.response?.data?.message ?? "Cash settle failed — try again",
      );
    } finally {
      setSettlingCash(false);
    }
  };
  const handleChargeClose = async () => {
    setChargeOrder(null);
    if (!closingTab || !tabOrderId || !tableId) return;
    setClosingTab(false);
    try {
      const ord = (await apiClient.get(`/v1/orders/${tabOrderId}`)).data as any;
      if (ord?.paymentStatus === "PAID") {
        // Best-effort complete (transition may be rejected — the free is what
        // matters), then free the table and return to the floor.
        await apiClient
          .patch(`/v1/orders/${tabOrderId}/status`, {
            status: "COMPLETED",
            note: "Tab settled",
          })
          .catch(() => {});
        await tablesClient.free(tableId).catch(() => {});
        setSubmitFeedback(`${tableName ?? "Table"} settled and cleared.`);
        router.push("/dashboard/tables");
      }
    } catch {
      /* leave the tab open if we couldn't confirm payment */
    }
  };

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
      {/* Table Tabs — dine-in banner + settle */}
      {tableId && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <span>
            <b>Dine-in · {tableName ?? "Table"}</b>
            {tabOrderId
              ? ` — running tab: ${tabItemCount} item${
                  tabItemCount === 1 ? "" : "s"
                }, £${tabTotal.toFixed(2)}. Add items and “Send to kitchen”.`
              : " — add items and “Send to kitchen” to open the tab."}
          </span>
          {tabOrderId && !payChoiceOpen && (
            <button
              onClick={async () => {
                try {
                  const r = await tablesClient.printBill(tabOrderId);
                  setSubmitFeedback(
                    r.printed
                      ? "Bill printed."
                      : "No receipt printer set for this location.",
                  );
                } catch {
                  setSubmitFeedback("Couldn't print the bill");
                }
                window.setTimeout(() => setSubmitFeedback(null), 4000);
              }}
              className="shrink-0 rounded-md border border-indigo-300 bg-white px-3 py-1 text-xs font-semibold text-indigo-900 hover:bg-indigo-100"
            >
              🧾 Print bill
            </button>
          )}
          {tabOrderId &&
            (payChoiceOpen ? (
              <span className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={settleCash}
                  disabled={settlingCash}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  💷 Cash
                </button>
                <button
                  onClick={settleCard}
                  disabled={settlingCash}
                  className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  💳 Card
                </button>
                <button
                  onClick={() => setPayChoiceOpen(false)}
                  disabled={settlingCash}
                  className="rounded-md border border-indigo-200 bg-white px-2 py-1 text-xs font-medium text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={payAndCloseTab}
                className="shrink-0 rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                Pay &amp; close · £{tabTotal.toFixed(2)}
              </button>
            ))}
        </div>
      )}
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">
            {tableId ? `POS · ${tableName ?? "Table"}` : "POS"}
          </h1>
          <p className="text-sm text-zinc-500">
            {tableId
              ? "Dine-in tab — items you add are sent to the kitchen."
              : "Walk-in, phone & scheduled orders"}
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

      {(!online || pendingSync > 0) && (
        <div
          className={`mb-2 flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm ${
            !online
              ? "bg-amber-50 text-amber-800"
              : "bg-blue-50 text-blue-800"
          }`}
        >
          <span>
            {!online
              ? "Offline — cash orders are saved on this device and sync automatically when you reconnect."
              : `${pendingSync} offline order${pendingSync === 1 ? "" : "s"} waiting to sync…`}
          </span>
          {pendingSync > 0 && (
            <button
              onClick={retrySync}
              className="shrink-0 rounded border border-current/40 px-2 py-0.5 text-xs font-medium"
            >
              Retry now
            </button>
          )}
        </div>
      )}

      {!selectedLocationId ? (
        <EmptyState text="Select a location to start taking orders." />
      ) : menuQuery.isLoading && !menuData ? (
        <EmptyState text="Loading menu…" />
      ) : !menuData ? (
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
              dineIn={
                tableId
                  ? {
                      tableName: tableName ?? "Table",
                      tabItemCount,
                      tabTotal,
                    }
                  : null
              }
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
          onClose={handleChargeClose}
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
          allModifierGroups={allGroups}
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
