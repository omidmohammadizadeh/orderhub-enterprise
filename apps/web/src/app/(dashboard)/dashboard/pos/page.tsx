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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** How long a caller stays worth re-applying after a location switch. */
const CALLER_FILL_TTL_MS = 2 * 60_000;
import { useCurrency } from "@/hooks/use-currency";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Search,
  ShoppingBag,
  Pencil,
  X,
  SlidersHorizontal,
  ChevronLeft,
  Paintbrush,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  round2,
  toOrderLineModifier,
  categoryItemAllowsFulfillment,
  type SelectedModifier,
  type ProductSku,
} from "@orderhub/shared";
import { ModifierSelectionModal } from "@/components/pos/modifier-selection-modal";
import {
  PosCartPanel,
  type CartLine,
  type PlaceOrderPayload,
  type PartialDraft,
} from "@/components/pos/pos-cart-panel";
import { PosStartScreen } from "@/components/pos/pos-start-screen";
import {
  fillOrderFromCaller,
  PENDING_FILL_KEY,
  type CallerIdFill,
} from "@/components/pos/caller-id-popup";
import { TileColoursModal } from "@/components/pos/tile-colours-modal";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";
import {
  resolveTileColour,
  tileColoursFromSettings,
  tileSizeFromSettings,
  TILE_SIZES,
  type TileColours,
  type TileSize,
} from "@/lib/pos/tile-colours";
import { DeliveryFeeModal } from "@/components/pos/delivery-fee-modal";
import { CashPaymentModal } from "@/components/pos/cash-payment-modal";
import { ChargeReaderModal } from "@/components/pos/charge-reader-modal";
import { PaymentLinkModal } from "@/components/pos/payment-link-modal";
import { PromosModal } from "@/components/pos/promos-modal";
// Phase AP follow-up (AP-NAV-1): Direct online ordering moved to its
// own sidebar entry (/dashboard/direct-ordering). The modal import and
// button below are gone; the settings page itself still uses
// DirectOrderingSettings (re-exported from this file).
import {
  Truck,
  Tag,
  Percent,
  Ban,
  KeyRound,
  Banknote,
  CirclePlus,
} from "lucide-react";
import { ExtraChargeModal } from "@/components/pos/extra-charge-modal";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { usePendingCallerStore } from "@/stores/pending-caller.store";
import { useAuthStore } from "@/stores/auth.store";
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
import { SplitBillModal } from "@/components/pos/split-bill-modal";
import { ServiceChargeModal } from "@/components/pos/service-charge-modal";
import { VoidItemModal } from "@/components/pos/void-item-modal";
import { ManagerPinModal } from "@/components/pos/manager-pin-modal";
import {
  printOrderViaBridge,
  openCashDrawerViaBridge,
} from "@/lib/printing/print-order";
import { hasNativeBridge } from "@/lib/printing/bridge";
import { formatDisplayPrice } from "@/lib/menu/display-price";
import { isAwaitingOurPayment } from "@/lib/orders/awaiting-payment";

interface PersistedCart {
  cart: CartLine[];
  draft: PartialDraft;
}

export default function PosPage() {
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money } = useCurrency();
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
  // Unsent-basket persistence scope. This USED to be the location alone,
  // which meant every table shared one draft — open TABEL 2 and TABEL 1's
  // items were sitting in it. Each table needs its own, and takeaway keeps
  // the plain location key so existing drafts survive.
  const cartScopeKey = tableId
    ? `${selectedLocationId}:table:${tableId}`
    : String(selectedLocationId);
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

  // Caller ID → the order being started.
  //
  // The popup's "Start order" used to dispatch only at PosCartPanel, which is
  // the SECOND step. The operator sees the start screen first — order type,
  // phone, name, address — and that screen reads this draft, so the fill
  // landed somewhere nobody was looking and the fields stayed empty.
  //
  // Bumped after each placed order to force the cart panel to remount —
  // its customer/address/payment fields are internal state seeded from
  // initialDraft, so clearing `draft` alone doesn't wipe them.
  const [cartResetKey, setCartResetKey] = useState(0);

  /** The last caller applied, so cart hydration can put it back. */
  const appliedCallerRef = useRef<{ fill: CallerIdFill; at: number } | null>(
    null,
  );

  // Filling the draft covers both: the start screen renders from it, and the
  // cart panel is seeded from it as initialDraft.
  useEffect(() => {
    const apply = (d: CallerIdFill | null | undefined) => {
      if (!d?.phone) return;
      setDraft((prev) => ({
        ...prev,
        callerId: d.phone,
        customerPhone: d.phone,
        // Only overwrite a name we actually know. A saved customer gets
        // theirs; an unknown caller leaves the field for the operator.
        ...(d.name ? { customerName: d.name } : {}),
        ...(d.address
          ? {
              addressLine1: d.address.line1,
              addressLine2: d.address.line2 ?? "",
              city: d.address.city ?? "",
              postcode: d.address.postcode ?? "",
            }
          : {}),
        // Someone on the phone is not a counter customer.
        walkIn: false,
        // Suggest, never override. If the operator has already chosen a type
        // their choice stands; otherwise a known address means delivery, and
        // anyone else starts as collection with just their number.
        fulfillmentType:
          prev.fulfillmentType ?? (d.address ? "DELIVERY" : "PICKUP"),
      }));
    };

    // Seeding is not enough on its own. PosCartPanel copies the draft into
    // its own customer/address fields when it mounts, so a caller arriving
    // while the operator is already on the cart updated `draft` and changed
    // nothing on screen. Remounting it re-reads the draft we just filled.
    const applyAndReseed = (d: CallerIdFill | null | undefined) => {
      if (!d?.phone) return;
      apply(d);
      setCartResetKey((k) => k + 1);
      // Remember it. Cart hydration below re-runs whenever the location
      // changes and resets the draft — and "Start order" changes the location
      // on its way here, so the fill lands and is wiped a moment later. This
      // is what hydration re-applies from.
      appliedCallerRef.current = { fill: d, at: Date.now() };
    };

    const onFill = (e: Event) =>
      applyAndReseed((e as CustomEvent).detail as CallerIdFill);
    window.addEventListener("pos:callerid-fill", onFill);

    // Stashed by the popup when "Start order" was tapped from another screen
    // (the Orders tab) and we navigated here.
    try {
      const raw = sessionStorage.getItem(PENDING_FILL_KEY);
      if (raw) {
        sessionStorage.removeItem(PENDING_FILL_KEY);
        applyAndReseed(JSON.parse(raw) as CallerIdFill);
      }
    } catch {
      /* a caller is not worth breaking the till over */
    }

    return () => window.removeEventListener("pos:callerid-fill", onFill);
  }, []);

  // The caller carried over from another screen. Keyed on the VALUE, not on
  // this page's mount: "Start order" also switches the selected location, and
  // if that remounts POS, a mount-only read has already consumed the caller
  // and the second mount comes up empty — which is why the number only ever
  // arrived when the operator was already sitting on POS.
  const pendingCaller = usePendingCallerStore((st) => st.pending);
  const clearPendingCaller = usePendingCallerStore((st) => st.setPendingCaller);
  useEffect(() => {
    if (!pendingCaller?.phone) return;
    fillOrderFromCaller(pendingCaller);
    clearPendingCaller(null);
  }, [pendingCaller, clearPendingCaller]);
  /**
   * Which half of the till we're on.
   *
   * "start" asks the one question that changes everything downstream — who is
   * this order for — before a single item is tapped. "menu" is the existing
   * menu + cart layout, unchanged.
   *
   * A dine-in tab and an order being edited both skip it: the table already
   * says who it's for, and an edited order was answered when it was placed.
   */
  const [step, setStep] = useState<"start" | "menu">("start");
  /** The cart is a sheet over the menu at every size — see the render. */
  const [cartOpen, setCartOpen] = useState(false);
  /** Phone only — the header tools live in a bottom sheet. */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** Summary for the phone bottom bar. Modifier prices are included so the
   *  figure matches what the cart panel shows a tap later — a bar that says
   *  £9.50 opening onto a £12.00 basket reads as a bug. */
  const cartCount = cart.reduce((n, l) => n + l.quantity, 0);
  const cartSubtotal = cart.reduce(
    (sum, l) =>
      sum +
      l.quantity *
        (l.unitPrice + l.modifiers.reduce((m, mod) => m + mod.price, 0)),
    0,
  );
  const [search, setSearch] = useState("");
  const [submitFeedback, setSubmitFeedback] = useState<string | null>(null);
  // ── Cash drawer (no sale) ────────────────────────────────────────────────
  // The drawer is wired to the receipt printer's DK port, not to the tablet,
  // so opening it is a paperless print job down the same bridge.
  const [drawerBusy, setDrawerBusy] = useState(false);
  const openDrawer = async () => {
    if (!selectedLocationId) return;
    setDrawerBusy(true);
    try {
      const name = await openCashDrawerViaBridge(selectedLocationId);
      setSubmitFeedback(`Cash drawer opened at ${name}.`);
    } catch (err: any) {
      setSubmitFeedback(err?.message ?? "Couldn't open the cash drawer.");
    } finally {
      setDrawerBusy(false);
      window.setTimeout(() => setSubmitFeedback(null), 6000);
    }
  };
  // Phase AM — manager-side modals on the POS top bar.
  const [showFeeModal, setShowFeeModal] = useState(false);
  const [showPromosModal, setShowPromosModal] = useState(false);
  const [showExtraCharge, setShowExtraCharge] = useState(false);
  const [showServiceCharge, setShowServiceCharge] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  // The PIN authorises removing charges, so only supervisory roles see or
  // set it. Same list the API's @Roles(...POS_MANAGER) enforces — the button
  // is a convenience, the server is the actual gate.
  const posRole = useAuthStore((st) => st.user?.role);
  const canManagePin = [
    "PLATFORM_ADMIN",
    "TENANT_OWNER",
    "OWNER",
    "MANAGER",
    "DARK_KITCHEN_MANAGER",
  ].includes(String(posRole));
  const [chargeOrder, setChargeOrder] = useState<{ id: string; amount: number } | null>(null);
  // Walk-in cash keypad. Held separately from chargeOrder so a card charge and
  // a cash settle can never share a modal state and pop the wrong one.
  const [cashOrder, setCashOrder] = useState<{ id: string; amount: number } | null>(null);
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
        // Remount the cart panel. It copies fulfillmentType, the address and
        // the customer out of initialDraft when it MOUNTS, defaulting to
        // PICKUP — and this hydration is a fetch, so the panel is already on
        // screen by the time the order arrives. Editing a delivery therefore
        // opened the collection cart, with the address nowhere and the driver
        // options missing. Same reason a caller fill has to bump this.
        setCartResetKey((k) => k + 1);
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
    const persisted = loadCartDraft<PersistedCart>(cartScopeKey);
    if (persisted) {
      setCart(persisted.cart ?? []);
      setDraft(persisted.draft ?? {});
    } else {
      setCart([]);
      setDraft({});
    }
    // Put the caller back on top. This effect is keyed on the location, and
    // answering a call switches to the ringing shop — so it fires immediately
    // after the fill and would otherwise erase the number the operator is
    // holding the phone to their ear about. Time-boxed so yesterday's caller
    // never reappears on tomorrow's first order.
    const recent = appliedCallerRef.current;
    if (recent && Date.now() - recent.at < CALLER_FILL_TTL_MS) {
      fillOrderFromCaller(recent.fill);
    }
  }, [cartScopeKey]);

  useEffect(() => {
    if (!selectedLocationId) return;
    saveCartDraft<PersistedCart>(cartScopeKey, { cart, draft });
  }, [cartScopeKey, cart, draft]);

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
  const brandGroups = (allGroupsQuery.data ??
    cachedMenu?.modifierGroups ??
    []) as NonNullable<typeof allGroupsQuery.data>;
  // Fold in the groups the menu's sizes actually reference. The brand
  // catalogue above misses any group belonging to a different brand, which
  // left multi-SKU sizes with no modifiers at all in the till while online
  // ordering showed them. Rides along on the menu payload, so it survives
  // the offline cache too.
  const allGroups = useMemo(() => {
    const skuGroups = ((menuData as any)?.skuModifierGroups ?? []) as typeof brandGroups;
    // Phase BN — groups opened by choosing an option ("Make It a Meal" asking
    // for a side and a drink). Same reason as the SKU groups above: they can't
    // be reached from the item's own group links, so they ride along on the
    // menu payload and get merged in by id here. Without this the till showed
    // the meal option and opened nothing.
    const nestedGroups = ((menuData as any)?.nestedModifierGroups ??
      []) as typeof brandGroups;
    if (skuGroups.length === 0 && nestedGroups.length === 0) return brandGroups;
    const byId = new Map<string, (typeof brandGroups)[number]>();
    for (const g of brandGroups) byId.set(g.id, g);
    for (const g of [...skuGroups, ...nestedGroups]) {
      if (!byId.has(g.id)) byId.set(g.id, g);
    }
    return Array.from(byId.values());
  }, [brandGroups, menuData]);

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
  // No fall-back to the first category: null means "no category chosen yet",
  // which is what puts the category tiles on screen. Falling back to
  // categories[0] would drop staff straight into Grilled Meats and leave every
  // other category behind a horizontal scroll.
  const activeCategory = useMemo(
    () => categories.find((c) => c.id === activeCategoryId) ?? null,
    [categories, activeCategoryId],
  );

  // Searching looks across the WHOLE menu, not just the open category. With a
  // category step in front of the items, a search scoped to one category would
  // find nothing until you had already guessed where the item lived — which is
  // the opposite of what someone types a search for. Each hit carries its own
  // category so its tile colour still resolves.
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const out: Array<{ item: MenuItem; categoryId: string; categoryName: string }> = [];
    for (const c of categories) {
      for (const link of c.items ?? []) {
        const it = link.item;
        if (!it || !it.isAvailable) continue;
        // Search reaches the whole menu, so it has to honour the same rule as
        // the grid — otherwise the one route around it is the search box
        if (!categoryItemAllowsFulfillment(c, it, draft.fulfillmentType)) continue;
        if (
          it.name.toLowerCase().includes(q) ||
          (it.description ?? "").toLowerCase().includes(q)
        ) {
          out.push({ item: it, categoryId: c.id, categoryName: c.name });
        }
      }
    }
    return out;
  }, [categories, search, draft.fulfillmentType]);

  const products: MenuItem[] = useMemo(() => {
    if (!activeCategory) return [];
    return (activeCategory.items ?? [])
      .map((link) => link.item)
      .filter((it) => it && it.isAvailable)
      // Products the shop does not sell this way. The service mode is chosen
      // on the step before the menu, so this is settled by the time anyone
      // sees a tile.
      .filter((it) =>
        categoryItemAllowsFulfillment(activeCategory, it, draft.fulfillmentType),
      );
  }, [activeCategory, draft.fulfillmentType]);

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
        // Counter trade — tagged so walk-in revenue can be reported apart
        // from phone and online orders.
        ...(payload.isWalkIn ? { isWalkIn: true } : {}),
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
      // EXCEPTION: anything WE are still collecting for must not be accepted
      // here — payment link, QR, card terminal, walk-in cash. It belongs in
      // "Waiting for payment" until the money lands, at which point the server
      // accepts it and prints with the correct paid status.
      //
      // A brand-new order is always PENDING, which is what the shared
      // predicate keys off.
      const holdForPayment = isAwaitingOurPayment({
        status: "PENDING",
        paymentMethod: payload.paymentMethod,
        paymentStatus: payload.paymentStatus,
        isWalkIn: payload.isWalkIn,
      });
      const isUnpaidWalkInCash =
        payload.isWalkIn === true &&
        payload.paymentMethod === "CASH" &&
        payload.paymentStatus !== "PAID";
      if (!holdForPayment) {
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
        walkInCash: isUnpaidWalkInCash,
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
        walkInCash,
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
        setCartOpen(false);
        if (selectedLocationId) clearCartDraft(cartScopeKey);
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
        setStep("start");
      setCartOpen(false); // don't leave the sheet open over an empty cart
        if (selectedLocationId) clearCartDraft(cartScopeKey);
        window.setTimeout(() => setSubmitFeedback(null), 6000);
        return;
      }
      // Card-terminal orders: pop the reader charge modal for the new order.
      if (!edited && paymentMethod === "CARD_TERMINAL" && id) {
        setChargeOrder({ id, amount: Number(total ?? 0) });
      }
      // Walk-in cash: take the money now. The order is deliberately still
      // PENDING and unprinted; settling in this modal flips it to PAID, which
      // re-fires accept + print server-side with the band reading CASH PAID.
      if (!edited && walkInCash && id) {
        setCashOrder({ id, amount: Number(total ?? 0) });
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
      setStep("start");
      setCartOpen(false); // don't leave the sheet open over an empty cart // next order starts by asking who it's for
      if (selectedLocationId) clearCartDraft(cartScopeKey);
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
  const [splitOpen, setSplitOpen] = useState(false);
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
    if (!window.confirm(`${money(tabTotal)} received in cash?`)) return;
    setSettlingCash(true);
    try {
      // Settle through the split-payment endpoint, not payment-status +
      // a status PATCH. The PATCH was being REJECTED — the forward-only
      // ladder refuses ACCEPTED → COMPLETED ("Invalid status transition")
      // — so the table freed but the order sat on the board as Accepted
      // for ever. The payments path marks it PAID, writes COMPLETED
      // directly (it is allowed to bypass the ladder), frees the table and
      // emits to the board, all server-side in one call.
      await tablesClient.addPayment(tabOrderId, {
        amount: Number(tabTotal.toFixed(2)),
        method: "CASH",
        note: "Tab settled — cash",
      });
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
        // The server closes the tab now: settling a card payment on an
        // order with a tableId fires order.settled_in_full, which writes
        // COMPLETED (bypassing the forward-only ladder), frees the table
        // and pushes the change to the board. We used to attempt a status
        // PATCH here that the ladder ALWAYS rejected, so the order stayed
        // Accepted — the comment even admitted it might fail. Just report
        // and go back to the floor.
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
        modifiers: line.modifiers.map(toOrderLineModifier),
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

  /**
   * The header tools, defined once and rendered twice — as a button row from
   * md up, and as a bottom sheet on a phone. Declaring them as data rather
   * than duplicating five buttons is what stops the phone quietly losing one
   * the next time somebody adds a sixth.
   */
  // A table tab and an order being edited both already know who they're for.
  useEffect(() => {
    if (tableId || editOrderId) setStep("menu");
  }, [tableId, editOrderId]);

  // ── Tile colours ──────────────────────────────────────────────────────
  // Held per location, so the same menu is the same colours on every till in
  // the shop. Read once with the location and written back merged, because
  // the API shallow-merges `settings` — sending { pos: { tileColours } } alone
  // would wipe every other pos setting the shop has.
  const [coloursOpen, setColoursOpen] = useState(false);
  const locationQuery = useQuery({
    queryKey: queryKeys.locationDetail(selectedLocationId ?? ""),
    queryFn: () => locationsClient.get(selectedLocationId!),
    enabled: !!selectedLocationId,
    staleTime: 60_000,
  });
  const tileColours = useMemo(
    () => tileColoursFromSettings((locationQuery.data as any)?.settings),
    [locationQuery.data],
  );
  const tileSize = useMemo(
    () => tileSizeFromSettings((locationQuery.data as any)?.settings),
    [locationQuery.data],
  );
  const sizing = TILE_SIZES[tileSize];
  const saveColours = useMutation({
    mutationFn: async ({
      colours: next,
      size,
    }: {
      colours: TileColours;
      size: TileSize;
    }) => {
      const settings = ((locationQuery.data as any)?.settings ?? {}) as Record<
        string,
        unknown
      >;
      return locationsClient.update(selectedLocationId!, {
        settings: {
          ...settings,
          pos: {
            ...((settings.pos as object) ?? {}),
            tileColours: next,
            tileSize: size,
          },
        },
      } as any);
    },
    onSuccess: () => {
      setColoursOpen(false);
      void locationQuery.refetch();
    },
  });

  /** Categories + their items, for the colour picker. */
  const colourableCategories = useMemo(
    () =>
      categories.map((c: any) => ({
        id: c.id,
        name: c.name,
        items: (c.items ?? [])
          .map((l: any) => l.item)
          .filter(Boolean)
          .map((i: any) => ({ id: i.id, name: i.name })),
      })),
    [categories],
  );

  /** Reminds staff which kind of order they're building, once past step 1. */
  const orderTypeLabel =
    draft.walkIn
      ? "Walk-in"
      : draft.fulfillmentType === "DELIVERY"
        ? "Delivery"
        : draft.fulfillmentType === "PICKUP"
          ? "Collection"
          : null;

  // `show` is REQUIRED, and typed that way deliberately: the array is filtered
  // on it below, so an entry that omits it is dropped silently — the button is
  // simply never there, with nothing to debug. That cost a round trip once.
  const posTools: Array<{
    key: string;
    label: string;
    title: string;
    icon: React.ComponentType<{ className?: string }>;
    onClick: () => void;
    disabled?: boolean;
    show: boolean;
  }> = [
    {
      key: "tile-colours",
      label: "Tile colours",
      title: "Colour-code the menu tiles",
      icon: Paintbrush,
      onClick: () => setColoursOpen(true),
      disabled: !selectedLocationId,
      // Required: the array is filtered by `show` below, so an entry without
      // it is silently dropped rather than rendered.
      show: true,
    },
    {
      key: "drawer",
      // Always listed (not gated on the bridge) so staff can find it; on a
      // desktop browser it explains that the drawer opens through the
      // printer, which only the tablet app can reach.
      label: drawerBusy ? "Opening…" : "Open cash drawer",
      title: "Pop the cash drawer (no sale)",
      icon: Banknote,
      onClick: openDrawer,
      disabled: !selectedLocationId || drawerBusy,
      show: true,
    },
    {
      key: "fee",
      label: "Delivery fee",
      title: "Configure delivery zones & fees for this location",
      icon: Truck,
      onClick: () => setShowFeeModal(true),
      disabled: !selectedLocationId,
      // Nothing is delivered from a table — hide it in dine-in.
      show: !tableId,
    },
    {
      key: "pin",
      label: "Manager PIN",
      title: "Set the PIN that authorises voids and comps",
      icon: KeyRound,
      onClick: () => setPinOpen(true),
      disabled: !selectedLocationId,
      show: canManagePin,
    },
    {
      key: "service",
      label: "Service charge",
      title: "Add a service charge automatically to bills",
      icon: Percent,
      onClick: () => setShowServiceCharge(true),
      disabled: !selectedLocationId,
      show: true,
    },
    {
      key: "extra-charge",
      label: "Extra charge",
      title: "Price something that isn't on the menu",
      icon: CirclePlus,
      onClick: () => setShowExtraCharge(true),
      disabled: !selectedLocationId,
      show: true,
    },
    {
      key: "promos",
      label: "Promos",
      title: "Set up quick-discount promos for this location",
      icon: Tag,
      onClick: () => setShowPromosModal(true),
      disabled: !selectedLocationId,
      show: true,
    },
  ].filter((t) => t.show);

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
      {/* Table Tabs — dine-in banner + settle.
          Phone: the sentence gets its own line and the settle buttons sit in
          a wrapping row beneath it. Side by side, the text was squeezed into
          a ~90px column reading one word per line while Pay & close hung off
          the right edge. */}
      {tableId && (
        <div className="mb-2 flex flex-col gap-2 rounded-md bg-indigo-50 px-3 py-2 text-sm text-indigo-900 md:flex-row md:items-center md:justify-between">
          <span>
            <b>Dine-in · {tableName ?? "Table"}</b>
            {tabOrderId
              ? ` — running tab: ${tabItemCount} item${
                  tabItemCount === 1 ? "" : "s"
                }, ${money(tabTotal)}. Add items and “Send to kitchen”.`
              : currentTable?.status === "OCCUPIED"
                ? // Seated but nothing sent yet. Say so explicitly: the
                  // bill/settle actions need a real tab, and "new tab"
                  // alone left staff wondering where the buttons went.
                  " — seated, but no tab open yet. Send a round to start the bill."
                : " — add items and “Send to kitchen” to open the tab."}
          </span>
          <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:flex-nowrap">
          {tabOrderId && !payChoiceOpen && (
            <button
              onClick={() => setVoidOpen(true)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
              title="Void or comp a line (manager PIN)"
            >
              <Ban className="h-3.5 w-3.5" /> Void
            </button>
          )}
          {tabOrderId && !payChoiceOpen && (
            <button
              onClick={async () => {
                try {
                  // Tablets print through the Bluetooth bridge (the server
                  // print-job path only feeds the desktop print agent), so
                  // print locally when we're inside the tablet app and fall
                  // back to a server job on desktop.
                  const ord = (
                    await apiClient.get(`/v1/orders/${tabOrderId}`)
                  ).data;
                  if (hasNativeBridge()) {
                    await printOrderViaBridge(ord, { billMode: true });
                    setSubmitFeedback("Bill printed.");
                  } else {
                    const r = await tablesClient.printBill(tabOrderId);
                    setSubmitFeedback(
                      r.printed
                        ? "Bill sent to the receipt printer."
                        : "No receipt printer set for this location.",
                    );
                  }
                } catch (err: any) {
                  setSubmitFeedback(
                    err?.message ?? "Couldn't print the bill",
                  );
                }
                window.setTimeout(() => setSubmitFeedback(null), 5000);
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
                  onClick={() => {
                    setPayChoiceOpen(false);
                    setSplitOpen(true);
                  }}
                  disabled={settlingCash}
                  className="rounded-md border border-indigo-300 bg-white px-3 py-1 text-xs font-semibold text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
                >
                  ⑂ Split
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
                className="shrink-0 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                Pay &amp; close · {money(tabTotal)}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Top bar.
          These five are settings, not per-order actions — you touch them
          once a shift, if that. On a phone they were squeezing the title
          into a one-word-per-line column and still running off the right
          edge, so below md they collapse behind a single button and the
          screen goes to the products instead. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate text-lg font-semibold text-zinc-900">
            {/* Back to the order-type / customer step. The cart survives, so a
                phone customer switching collection → delivery mid-order
                doesn't lose their basket. Hidden on a dine-in tab and while
                editing, neither of which has a start step to go back to. */}
            {step === "menu" && !tableId && !editOrderId && (
              <button
                type="button"
                onClick={() => setStep("start")}
                aria-label="Back to order details"
                className="-ml-1 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            {tableId ? `POS · ${tableName ?? "Table"}` : "POS"}
            {step === "menu" && orderTypeLabel && (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                {orderTypeLabel}
              </span>
            )}
          </h1>
          {/* The subtitle is orientation, not information — on a phone the
              vertical space is worth more than the sentence. */}
          <p className="hidden text-sm text-zinc-500 md:block">
            {tableId
              ? "Dine-in tab — items you add are sent to the kitchen."
              : "Walk-in, phone & scheduled orders"}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setToolsOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 md:hidden"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" /> Tools
        </button>

        <div className="hidden items-center gap-2 md:flex">
          {posTools.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={t.onClick}
              disabled={t.disabled}
              title={t.title}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50"
            >
              <t.icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Phone: the same tools as a bottom sheet. */}
      {toolsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/40 md:hidden"
          onClick={() => setToolsOpen(false)}
        >
          <div
            className="w-full rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-900">Tools</h2>
              <button
                type="button"
                onClick={() => setToolsOpen(false)}
                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {posTools.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => {
                    setToolsOpen(false);
                    t.onClick();
                  }}
                  disabled={t.disabled}
                  className="inline-flex items-center gap-2.5 rounded-lg border border-zinc-200 px-3 py-3 text-left text-sm font-medium text-zinc-700 disabled:opacity-50"
                >
                  <t.icon className="h-4 w-4 shrink-0 text-zinc-500" />
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

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
      ) : step === "start" ? (
        <PosStartScreen
          draft={draft}
          onDraftChange={setDraft}
          onContinue={() => setStep("menu")}
          cartCount={cartCount}
        />
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-3 overflow-hidden md:grid-cols-12">
          {/* Left — menu.
              One column on a phone: a 5/12 cart beside a 7/12 menu works out
              at ~156px each on a 375px screen, which is narrower than a
              single product tile. Below md the cart becomes a full-screen
              step instead (see the bottom bar). */}
          <div className="flex flex-col gap-3 overflow-hidden md:col-span-12">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search the whole menu…"
                  className="w-full rounded-lg border border-zinc-200 bg-white px-9 py-2 text-sm focus:border-zinc-900 focus:outline-none"
                />
              </div>
            </div>

            {/* Where in the menu we are. Only once a category is open — the
                category grid is its own signpost. */}
            {activeCategory && !search.trim() && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveCategoryId(null)}
                  className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white font-medium text-zinc-700 hover:border-zinc-300 ${sizing.chip}`}
                >
                  <ChevronLeft className="h-4 w-4" />
                  All categories
                </button>
                <span className="truncate text-sm font-semibold text-zinc-900">
                  {activeCategory.name}
                </span>
              </div>
            )}

            {/* Extra bottom padding on a phone so the last row of products
                isn't sitting under the fixed cart bar. */}
            <div className="flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 pb-24">
              {search.trim() ? (
                // Searching jumps straight to items, wherever they live.
                searchResults.length === 0 ? (
                  <div className="py-12 text-center">
                    <Search className="mx-auto mb-2 h-7 w-7 text-zinc-300" />
                    <p className="text-sm text-zinc-400">
                      Nothing on the menu matches &ldquo;{search.trim()}&rdquo;.
                    </p>
                  </div>
                ) : (
                  <div className={`grid gap-2 ${sizing.grid}`}>
                    {searchResults.map((hit) => (
                      <ProductCard
                        key={`${hit.categoryId}:${hit.item.id}`}
                        product={hit.item}
                        colour={resolveTileColour(
                          tileColours,
                          hit.item.id,
                          hit.categoryId,
                        )}
                        onClick={() => onProductClick(hit.item)}
                        sizing={sizing}
                      />
                    ))}
                  </div>
                )
              ) : !activeCategory ? (
                // Step one: pick a category. Every category is on screen at
                // once instead of hidden behind a horizontal scroll, which is
                // what made the old strip slow to work during a rush.
                categories.length === 0 ? (
                  <div className="py-12 text-center">
                    <ShoppingBag className="mx-auto mb-2 h-7 w-7 text-zinc-300" />
                    <p className="text-sm text-zinc-400">This menu has no categories.</p>
                  </div>
                ) : (
                  <div className={`grid gap-2 ${sizing.grid}`}>
                    {categories.map((cat) => {
                      // Counted the same way the grid filters, or a category
                      // advertises items it will not then show.
                      const count = (cat.items ?? []).filter(
                        (l: any) =>
                          l.item &&
                          l.item.isAvailable &&
                          categoryItemAllowsFulfillment(
                            cat,
                            l.item,
                            draft.fulfillmentType,
                          ),
                      ).length;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => setActiveCategoryId(cat.id)}
                          className={`flex flex-col items-center justify-center gap-1 rounded-xl border border-zinc-200 bg-white text-center transition-colors hover:border-zinc-900 hover:bg-zinc-50 ${sizing.pad}`}
                          style={{ minHeight: "5.5rem" }}
                        >
                          <span
                            className={`font-semibold leading-tight text-zinc-900 ${sizing.name}`}
                          >
                            {cat.name}
                          </span>
                          <span className={`text-zinc-400 ${sizing.price}`}>
                            {count} item{count === 1 ? "" : "s"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )
              ) : products.length === 0 ? (
                <div className="py-12 text-center">
                  <ShoppingBag className="mx-auto mb-2 h-7 w-7 text-zinc-300" />
                  <p className="text-sm text-zinc-400">No items in this category.</p>
                </div>
              ) : (
                <div className={`grid gap-2 ${sizing.grid}`}>
                  {products.map((product) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      colour={resolveTileColour(
                        tileColours,
                        product.id,
                        activeCategoryId,
                      )}
                      onClick={() => onProductClick(product)}
                      sizing={sizing}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* The cart is a sheet at every size now, not a side column.
              Half the screen sat on a cart that is empty for the first half of
              every order, while the menu — the thing staff are actually
              tapping — was squeezed into the other half. Kiosk-style: the menu
              gets the room, and the cart is one tap away. */}
          <div
            className={`flex-col overflow-hidden ${
              cartOpen
                ? "fixed inset-0 z-50 flex bg-white p-3 md:inset-y-0 md:left-auto md:right-0 md:w-[26rem] md:border-l md:border-zinc-200 md:shadow-2xl"
                : "hidden"
            }`}
          >
            <button
              type="button"
              onClick={() => setCartOpen(false)}
              className="mb-2 inline-flex w-fit items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700"
            >
              <X className="h-4 w-4" />
              Back to menu
            </button>
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

          {/* Phone-only bar: what's in the cart, and the way to it.
              Sits above the iOS home indicator via safe-area padding, and
              only exists while the cart sheet is closed so it can't cover
              the Place order button underneath it. */}
          {!cartOpen && (
            <div className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={() => setCartOpen(true)}
                className="flex w-full items-center justify-between rounded-lg bg-zinc-900 px-4 py-3 text-sm font-semibold text-white"
              >
                <span className="inline-flex items-center gap-2">
                  <ShoppingBag className="h-4 w-4" />
                  {cartCount} {cartCount === 1 ? "item" : "items"}
                </span>
                <span>{money(cartSubtotal)}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Incoming-call popup is now mounted globally in the dashboard layout
          (GlobalCallerIdPopup) so it shows on every screen, not just POS. */}

      <TileColoursModal
        open={coloursOpen}
        categories={colourableCategories}
        initial={tileColours}
        initialSize={tileSize}
        saving={saveColours.isPending}
        onSave={(colours, size) => saveColours.mutate({ colours, size })}
        onClose={() => setColoursOpen(false)}
      />

      {pinOpen && selectedLocationId && canManagePin && (
        <ManagerPinModal
          locationId={selectedLocationId}
          onClose={() => setPinOpen(false)}
        />
      )}

      {showServiceCharge && selectedLocationId && (
        <ServiceChargeModal
          locationId={selectedLocationId}
          onClose={() => setShowServiceCharge(false)}
        />
      )}

      {voidOpen && tabOrderId && selectedLocationId && (
        <VoidItemModal
          orderId={tabOrderId}
          locationId={selectedLocationId}
          onClose={() => setVoidOpen(false)}
          onChanged={() => {
            // Totals moved — refresh the tab so the banner and Pay & close
            // show the reduced figure straight away.
            void tabOrderQuery.refetch();
          }}
        />
      )}

      {/* Table Tabs — split the bill across several part-payments. The
          server settles + frees the table once they cover the total. */}
      {splitOpen && tabOrderId && (
        <SplitBillModal
          orderId={tabOrderId}
          tableName={tableName}
          locationId={selectedLocationId ?? undefined}
          onClose={() => setSplitOpen(false)}
          onSettled={() => {
            setSplitOpen(false);
            setSubmitFeedback(
              `${tableName ?? "Table"} settled and cleared.`,
            );
            router.push("/dashboard/tables");
          }}
        />
      )}

      {/* Walk-in cash keypad — opens after a walk-in cash order is placed.
          The order is intentionally PENDING and unprinted until this settles:
          the server holds the accept gate, and marking it PAID re-opens it so
          the ticket prints CASH PAID rather than CASH NOT PAID. */}
      <CashPaymentModal
        open={!!cashOrder}
        orderId={cashOrder?.id ?? null}
        locationId={selectedLocationId ?? null}
        amount={cashOrder?.amount ?? 0}
        onClose={() => {
          // Closing WITHOUT taking the money leaves the order PENDING and
          // unprinted on purpose — it is genuinely unpaid, and the Orders
          // board still offers "Take cash". Say so rather than letting it
          // look like the order vanished.
          const pending = cashOrder;
          setCashOrder(null);
          if (pending) {
            setSubmitFeedback(
              "Order saved but not paid — take the cash from the Orders board to print the ticket.",
            );
            window.setTimeout(() => setSubmitFeedback(null), 8000);
          }
        }}
        onPaid={() => {
          // No cache to invalidate here — this page is the till, not the
          // board, and the board has its own socket subscription.
          setCashOrder(null);
          setSubmitFeedback("Cash taken — ticket printing.");
          window.setTimeout(() => setSubmitFeedback(null), 4000);
        }}
      />

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
      <ExtraChargeModal
        open={showExtraCharge}
        money={money}
        onClose={() => setShowExtraCharge(false)}
        onAdd={({ amount, description }) =>
          addToCart({
            // No menuItemId: there is no menu row behind this, and the
            // create-order DTO takes it as optional — the POS already sends
            // `line.menuItemId || undefined`. KDS station routing matches on
            // that id, so an extra charge routes nowhere in particular, which
            // is right: it is money, not something the kitchen makes.
            menuItemId: "",
            displayName: description
              ? `Extra charge - ${description}`
              : "Extra charge",
            unitPrice: amount,
            quantity: 1,
            plu: null,
            modifiers: [],
            selectedSku: null,
          })
        }
      />

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
          // One question per screen: staff and customers at a till are
          // completing a task, not browsing. The storefront stays on scroll.
          flow="stepped"
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
  colour,
  sizing,
}: {
  product: MenuItem;
  onClick: () => void;
  /** Category colour, or the item's own override. Null = the plain tile. */
  colour?: { bg: string; border: string; fg?: string } | null;
  /** Padding and text steps for the shop's chosen tile size. */
  sizing: { pad: string; name: string; price: string };
}) {
  // The strong shades carry their own text colour. The tile's usual near-black
  // on a dark navy is a label nobody can read across a counter, which would
  // make the colours actively worse than none.
  const onDark = !!colour?.fg;
  return (
    <button
      type="button"
      onClick={onClick}
      // Inline rather than a class: the palette is data the shop chose, not
      // something Tailwind can know about at build time.
      style={
        colour
          ? {
              backgroundColor: colour.bg,
              borderColor: colour.border,
              color: colour.fg,
            }
          : undefined
      }
      className={`flex flex-col items-start gap-1 rounded-lg border border-zinc-200 bg-white text-left transition-colors hover:border-zinc-900 hover:shadow-sm disabled:opacity-50 ${sizing.pad}`}
      disabled={product.outOfStock}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span
          className={`font-medium leading-snug line-clamp-2 ${sizing.name} ${
            onDark ? "" : "text-zinc-900"
          }`}
        >
          {product.name}
        </span>
        {product.outOfStock && (
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600">
            OOS
          </span>
        )}
      </div>
      <span
        className={`mt-0.5 ${sizing.price} ${onDark ? "opacity-90" : "text-zinc-500"}`}
      >
        {formatDisplayPrice(product as any)}
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
