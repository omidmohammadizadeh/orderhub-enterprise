"use client";

// Phase AP — Customer-facing direct online ordering storefront.
//
// Layout matches the user-provided reference (Order Hub POS style):
//
//   top nav  — logo / name / Cart button
//   hero      — banner image (from menu.bannerImage or directConfig.heroImageUrl)
//   header    — overlapping card with name + address + delivery/pickup pills +
//               schedule button
//   search    — full-width input
//   strip     — All + category chips (sticky horizontal scroll)
//   grid      — product cards with image + name + description + price + Add
//
// Behaviours:
//   • Tapping a product with modifier groups opens the same
//     ModifierSelectionModal the POS uses
//   • Cart button slides a right-side panel in, like the POS cart
//   • Delivery fee auto-applies by matching the delivery postcode against
//     the location's configured zones (longest prefix wins)
//   • Schedule modal lets the customer pick "ASAP" or a specific time
//     slot up to directConfig.scheduleMaxDaysAhead days ahead
//   • directConfig toggles hide/disable the order types + payment
//     methods the operator turned off

import { useEffect, useMemo, useRef, useState, useReducer } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import axios from "axios";
import { LoginModal } from "@/components/storefront/login-modal";
import { HeaderAuthButton } from "@/components/storefront/header-auth-button";
import { useCustomerAuth } from "@/hooks/use-customer-auth";
import {
  ShoppingBag,
  Plus,
  Minus,
  X,
  Clock,
  MapPin,
  Calendar,
  Search,
  Loader2,
  CheckCircle,
  Bike,
  Menu as MenuIcon,
  ChevronRight,
  Info,
  Receipt,
  Hourglass,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ModifierSelectionModal,
} from "@/components/pos/modifier-selection-modal";
import type {
  MenuItem,
  MenuCategory,
} from "@/lib/api/menus.client";
import type { SelectedModifier, ProductSku } from "@orderhub/shared";

// ── Types ──────────────────────────────────────────────────────────────────

interface Storefront {
  location: {
    id: string;
    name: string;
    slug: string;
    phone?: string;
    about?: string | null;
    logoUrl?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    postcode?: string | null;
    country?: string | null;
    address?: { line1?: string; city?: string; postcode?: string } | null;
    openingHours: any;
    deliveryConfig?: { deliveryFeeFixed?: number; minimumOrder?: number };
    busyMode?: boolean;
    currentPrepTime?: number;
  };
  brand: { id: string; name: string; logoUrl?: string | null };
  menu:
    | {
        id: string;
        bannerImage?: string | null;
        heroImage?: string | null;
        categories: MenuCategory[];
      }
    | null;
  isOpen: boolean;
  // Phase AW-15 — operator-pushed pause/busy state. When `closed` is
  // set the storefront renders a banner + disables Add/Checkout
  // (customers can still browse). `busy` adds extra prep time to the
  // visible advertised ETA without blocking checkout.
  closed?: {
    brandName: string;
    resumeAt: string | null;
    reason: string | null;
  } | null;
  busy?: {
    brandName: string;
    resumeAt: string | null;
    reason: string | null;
    extraPrepTime: number | null;
  } | null;
  // Phase AP fix #4 — brand-wide modifier-group catalog so the
  // storefront's modifier modal can resolve per-SKU group IDs the
  // same way POS does for multi-SKU products.
  brandModifierGroups?: any[];
  directConfig?: {
    deliveryPrepMinutes: number;
    collectionPrepMinutes: number;
    acceptsCash: boolean;
    acceptsCard: boolean;
    acceptsDelivery: boolean;
    acceptsCollection: boolean;
    scheduleMaxDaysAhead: number;
    scheduleSlotMinutes: number;
    minOrderForDelivery: string | number | null;
    heroImageUrl: string | null;
  };
  deliveryZones?: Array<{
    postcodePrefix: string;
    fee: string | number;
    minOrderValue: string | number | null;
  }>;
}

interface CartLine {
  id: string;
  menuItemId: string;
  displayName: string;
  unitPrice: number;
  quantity: number;
  modifiers: SelectedModifier[];
  selectedSku?: ProductSku | null;
  notes?: string;
  plu?: string | null;
  // Phase AW-19 — BOGO freebie marker. Holds the id of the trigger
  // cart line this freebie mirrors. Internal-only — never sent to the
  // backend so the kitchen ticket doesn't carry the synthetic link.
  bogoOf?: string;
  // Phase AW-19 — FREE_ITEM gift marker (campaign id). Internal-only.
  freeItemOf?: string;
}

type CartAction =
  | { type: "ADD"; line: Omit<CartLine, "id"> }
  | { type: "INCREMENT"; id: string }
  | { type: "DECREMENT"; id: string }
  | { type: "REMOVE"; id: string }
  | { type: "CLEAR" };

function cartReducer(state: CartLine[], action: CartAction): CartLine[] {
  switch (action.type) {
    case "ADD":
      return [
        ...state,
        { ...action.line, id: Math.random().toString(36).slice(2) },
      ];
    case "INCREMENT":
      return state.map((l) =>
        l.id === action.id ? { ...l, quantity: l.quantity + 1 } : l,
      );
    case "DECREMENT":
      return state
        .map((l) => (l.id === action.id ? { ...l, quantity: l.quantity - 1 } : l))
        .filter((l) => l.quantity > 0);
    case "REMOVE":
      return state.filter((l) => l.id !== action.id);
    case "CLEAR":
      return [];
    default:
      return state;
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

// ── Page ───────────────────────────────────────────────────────────────────

export default function OrderPage() {
  const { slug } = useParams<{ slug: string }>();
  // Phase AW — brand context. /brand/<slug> redirects here with
  // ?brand=<id>; we forward that to the API so the storefront returns
  // the brand's identity (name, logo, address, about, Stripe Connect)
  // instead of the underlying physical location's. Read once at mount
  // so the React Query key stays stable across renders.
  const brandId = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("brand");
  }, []);
  const [cart, dispatch] = useReducer(cartReducer, []);
  const [cartOpen, setCartOpen] = useState(false);

  // Phase AP-5 — "Order again" hand-off from My Orders.
  //
  // My Orders writes the previous order's items to
  // sessionStorage.orderhub.reorder.{slug} and navigates here with
  // ?reorder=1. We dispatch one ADD per line, then delete the key so
  // a refresh of the storefront doesn't re-fill the cart, and finally
  // scrub the ?reorder=1 query so the URL bar looks tidy.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("reorder")) return;
    const key = `orderhub.reorder.${slug}`;
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return;
    try {
      const stash = JSON.parse(raw) as {
        items: Array<{
          menuItemId: string;
          displayName: string;
          unitPrice: number;
          quantity: number;
          modifiers: Array<{ name: string; price: number; quantity?: number }>;
          notes?: string;
        }>;
      };
      for (const it of stash.items) {
        dispatch({
          type: "ADD",
          line: {
            menuItemId: it.menuItemId,
            displayName: it.displayName,
            unitPrice: it.unitPrice,
            quantity: it.quantity,
            // Reorder modifiers persist as name + price; we don't
            // bother re-linking them to the live menu's groups (the
            // shape of a customer's basket is already tolerant of
            // synthetic ids), so synthesise stable-ish ids and put
            // them in a single "reorder" group bucket.
            modifiers: it.modifiers.map((m, idx) => ({
              id: `reorder-${idx}-${m.name}`,
              groupId: "reorder",
              groupName: "Reorder",
              name: m.name,
              price: m.price,
              quantity: m.quantity ?? 1,
            })),
            notes: it.notes,
            selectedSku: null,
          },
        });
      }
      // Open the cart so the customer sees the re-filled basket
      // immediately — no hunting for the bag icon.
      setCartOpen(true);
    } catch {
      /* corrupt stash — ignore */
    } finally {
      window.sessionStorage.removeItem(key);
      // Drop the ?reorder=1 from the URL.
      const url = new URL(window.location.href);
      url.searchParams.delete("reorder");
      window.history.replaceState(null, "", url.toString());
    }
    // Intentionally only run on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  const [search, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [fulfillmentType, setFulfillmentType] = useState<"PICKUP" | "DELIVERY">(
    "PICKUP",
  );
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null); // ISO
  const [modalItem, setModalItem] = useState<MenuItem | null>(null);
  const [confirmedOrderId, setConfirmedOrderId] = useState<string | null>(null);

  // Phase AP-8 — Stripe Checkout success URL bounces the customer back to
  // /order/[slug]/confirmation which redirects here with ?confirmedOrderId
  // in the query string. Pick it up on mount so the order-tracking screen
  // shows automatically instead of the empty cart.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("confirmedOrderId");
    // Phase AW — preserve the ?brand=<id> pin across the
    // confirmation/canceled cleanup. Stripping it dropped the
    // customer back onto the location-default storefront ("pizza uno
    // pelton") when they tapped Back to menu. Build the rewrite from
    // the current pathname + just the brand query, never bringing
    // confirmedOrderId / canceledOrderId along for the ride.
    const rewriteUrl = () => {
      const brand = sp.get("brand");
      return brand
        ? `${window.location.pathname}?brand=${encodeURIComponent(brand)}`
        : window.location.pathname;
    };
    if (id) {
      setConfirmedOrderId(id);
      window.history.replaceState({}, "", rewriteUrl());
      return;
    }
    if (sp.has("canceledOrderId")) {
      window.history.replaceState({}, "", rewriteUrl());
    }
  }, []);
  const [infoOpen, setInfoOpen] = useState(false); // Phase AP — About modal

  // Phase AP-AUTH — auth-gate state for the storefront. Friendly
  // flavour: the menu and cart are browsable freely; the modal only
  // opens when an unauthenticated customer clicks "Place order". State
  // is declared up here; the auth hook + post-login pre-fill effect
  // run further down (after `customerName` / `customerPhone` /
  // `checkout` exist, which they need to reference).
  const [loginOpen, setLoginOpen] = useState(false);
  const [pendingPlaceOrder, setPendingPlaceOrder] = useState(false);

  // Cart panel form state
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [addrFlat, setAddrFlat] = useState(""); // Phase AP fix #3 — house/flat number
  const [addrLine1, setAddrLine1] = useState("");
  const [addrCity, setAddrCity] = useState("");
  const [addrPostcode, setAddrPostcode] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "CARD">("CASH");
  const [notes, setNotes] = useState("");
  // Phase AP fix #1 — promo code redemption from the storefront cart.
  const [promoCode, setPromoCode] = useState("");
  const [promoApplied, setPromoApplied] = useState<{
    code: string;
    discountAmount: number;
    freeDelivery: boolean;
  } | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  // Phase AP fix #2 — postcode lookup results in the cart.
  const [postcodeSuggestions, setPostcodeSuggestions] = useState<
    Array<{
      id: string;
      label: string;
      line1: string;
      line2?: string;
      city?: string;
      postcode?: string;
    }>
  >([]);
  const [postcodeLookupNote, setPostcodeLookupNote] = useState<string | null>(null);
  const [postcodeLookupLoading, setPostcodeLookupLoading] = useState(false);

  const storefrontQuery = useQuery<Storefront>({
    queryKey: ["storefront", slug, brandId],
    queryFn: () =>
      axios
        .get(`${API_BASE}/v1/ordering/store/${slug}`, {
          params: brandId ? { brand: brandId } : undefined,
        })
        .then((r) => r.data),
  });

  const storefront = storefrontQuery.data;

  // ── Derived data ─────────────────────────────────────────────────────────

  const cfg = storefront?.directConfig;
  const heroImage =
    storefront?.menu?.bannerImage ??
    storefront?.menu?.heroImage ??
    cfg?.heroImageUrl ??
    null;
  const prepMins =
    fulfillmentType === "DELIVERY"
      ? cfg?.deliveryPrepMinutes ?? 45
      : cfg?.collectionPrepMinutes ?? 20;

  // Auto-derived delivery fee — longest matching postcode prefix wins.
  const matchedZone = useMemo(() => {
    if (fulfillmentType !== "DELIVERY") return null;
    const pc = addrPostcode.toUpperCase().replace(/\s+/g, "");
    if (!pc || !storefront?.deliveryZones?.length) return null;
    let best: { prefix: string; fee: number; minOrder: number | null } | null =
      null;
    for (const z of storefront.deliveryZones) {
      const zp = z.postcodePrefix.toUpperCase().replace(/\s+/g, "");
      if (pc.startsWith(zp)) {
        if (!best || zp.length > best.prefix.length) {
          best = {
            prefix: zp,
            fee: Number(z.fee),
            minOrder: z.minOrderValue != null ? Number(z.minOrderValue) : null,
          };
        }
      }
    }
    return best;
  }, [fulfillmentType, addrPostcode, storefront?.deliveryZones]);

  const subtotal = cart.reduce(
    (sum, l) =>
      sum +
      (l.unitPrice + l.modifiers.reduce((m, x) => m + x.price, 0)) * l.quantity,
    0,
  );
  // Phase AP fix #1 — promo code: FREE_DELIVERY zeroes the fee,
  // FIXED/PERCENTAGE produce a discountAmount that comes off subtotal.
  const promoDiscount = promoApplied?.discountAmount ?? 0;
  const freeDelivery = promoApplied?.freeDelivery === true;
  const rawDeliveryFee = matchedZone?.fee ?? 0;
  const deliveryFee = freeDelivery ? 0 : rawDeliveryFee;

  // Phase AW-19 — auto-apply the storefront's matched marketing
  // campaign. Server returns the eligible campaign in
  // storefront.campaign; we apply it as a discount line on the cart
  // when the subtotal clears its minOrder (if set). Re-resolves
  // server-side at checkout so a tampered total can't cheat.
  const storeCampaign = (storefront as any)?.campaign ?? null;
  // Phase AW-19 — per-item promo map from PERCENT_OFF_ITEMS campaigns.
  // Keyed by itemId → { percentageOff, campaignName }. Drives the
  // strikethrough badge on ProductCard and the discounted unitPrice
  // applied when the item lands in the cart.
  const itemPromos: Record<
    string,
    { percentageOff: number; campaignId: string; campaignName: string }
  > = (storefront as any)?.itemPromos ?? {};
  // Phase AW-19 — BOGO: trigger items get a "Buy 1, get 1 free"
  // badge on the menu. When a trigger is in the cart, the first
  // reward item is auto-added at £0 by the effect below.
  const bogo: {
    campaignId: string;
    campaignName: string;
    triggerItemIds: string[];
  } | null = (storefront as any)?.bogo ?? null;
  const bogoTriggerSet = useMemo(
    () => new Set(bogo?.triggerItemIds ?? []),
    [bogo],
  );
  // Flat itemId → MenuItem index for BOGO freebie name/plu lookup.
  const itemsById = useMemo(() => {
    const out: Record<string, MenuItem> = {};
    for (const cat of (storefront as any)?.menu?.categories ?? []) {
      for (const link of cat.items ?? []) {
        if (link.item) out[link.item.id] = link.item;
      }
    }
    return out;
  }, [storefront]);
  // Server resolves excludedItemIds against the menu it's actually
  // serving, with a category-name fallback for republished menus.
  // We use the server list as-is; the client used to walk the menu
  // tree itself, but category ids drift across menu publishes so
  // that approach silently failed for some campaigns.
  const excludedItemIdSet = useMemo(() => {
    const ids: string[] =
      (storefront as any)?.freeItem?.excludedItemIds ?? [];
    return new Set(ids);
  }, [storefront]);
  // Phase AW-19 — FREE_ITEM campaign + chosen freebie state. The
  // gift unlocks when (subtotal of non-excluded items) ≥ minOrder.
  // When the operator pools more than one option, the customer
  // picks; otherwise the single option auto-locks in.
  const freeItem: {
    campaignId: string;
    campaignName: string;
    minOrder: number;
    freeItemIds: string[];
    excludedCategoryIds: string[];
  } | null = (storefront as any)?.freeItem ?? null;
  const [chosenFreeItemId, setChosenFreeItemId] = useState<string | null>(null);
  // Only auto-lock when there's a single option. With multiple
  // options the customer must actively pick — no silent default.
  // We still re-sync if the operator removes the previously chosen
  // item from the pool.
  useEffect(() => {
    if (!freeItem) {
      if (chosenFreeItemId !== null) setChosenFreeItemId(null);
      return;
    }
    if (freeItem.freeItemIds.length === 1) {
      const only = freeItem.freeItemIds[0] ?? null;
      if (chosenFreeItemId !== only) setChosenFreeItemId(only);
      return;
    }
    if (
      chosenFreeItemId &&
      !freeItem.freeItemIds.includes(chosenFreeItemId)
    ) {
      setChosenFreeItemId(null);
    }
  }, [freeItem, chosenFreeItemId]);
  // BOGO auto-mirror:
  //   For every paid trigger line, ensure there's a matching free
  //   copy that mirrors its modifiers + SKU at £0. The freebie is
  //   tracked by bogoOf = trigger line id; when the trigger goes,
  //   its mirror goes too. Modifier prices are zeroed so the cart
  //   total math (unitPrice + sum(modifiers)) stays at 0 for the
  //   freebie.
  useEffect(() => {
    if (!bogo) return;
    const triggerLines = cart.filter(
      (l) =>
        bogoTriggerSet.has(l.menuItemId) && l.unitPrice > 0 && !l.bogoOf,
    );
    const freebies = cart.filter((l) => l.bogoOf);
    const triggerIds = new Set(triggerLines.map((l) => l.id));
    // Drop orphaned freebies first so we don't double-process.
    for (const f of freebies) {
      if (!triggerIds.has(f.bogoOf!)) {
        dispatch({ type: "REMOVE", id: f.id });
      }
    }
    // Add freebies for any trigger that doesn't have one yet.
    for (const t of triggerLines) {
      if (freebies.some((f) => f.bogoOf === t.id)) continue;
      dispatch({
        type: "ADD",
        line: {
          menuItemId: t.menuItemId,
          displayName: `${t.displayName} (Free — Buy 1 Get 1)`,
          unitPrice: 0,
          quantity: 1,
          // Mirror modifier list but zero the prices so totals stay 0.
          modifiers: t.modifiers.map((m) => ({ ...m, price: 0 })),
          selectedSku: t.selectedSku ?? null,
          notes: "",
          plu: t.plu ?? null,
          bogoOf: t.id,
        },
      });
    }
  }, [cart, bogo, bogoTriggerSet]);

  // Phase AW-19 — eligible spend for FREE_ITEM unlock = subtotal of
  // all paid lines whose item category is NOT in the exclusion set.
  // Free lines (BOGO mirrors, free-item gifts) are skipped so they
  // can't bootstrap their own threshold.
  const eligibleSubtotal = useMemo(() => {
    if (!freeItem) return 0;
    return cart.reduce((sum, l) => {
      if (l.unitPrice === 0) return sum;
      if (excludedItemIdSet.has(l.menuItemId)) return sum;
      return (
        sum +
        (l.unitPrice + l.modifiers.reduce((m, x) => m + x.price, 0)) *
          l.quantity
      );
    }, 0);
  }, [cart, freeItem, excludedItemIdSet]);
  // Gift line auto-management: when eligible and a chosen freebie
  // is set, add it at £0; when no longer eligible OR the choice
  // changes, remove the existing gift first. Marker = freeItemOf
  // on the cart line.
  useEffect(() => {
    if (!freeItem) return;
    const giftLine = cart.find((l) => (l as any).freeItemOf);
    const eligible = eligibleSubtotal >= freeItem.minOrder;
    if (!eligible || !chosenFreeItemId) {
      if (giftLine) dispatch({ type: "REMOVE", id: giftLine.id });
      return;
    }
    // Wrong item picked → swap.
    if (giftLine && giftLine.menuItemId !== chosenFreeItemId) {
      dispatch({ type: "REMOVE", id: giftLine.id });
      return; // next render will add the right one
    }
    if (!giftLine) {
      const item = itemsById[chosenFreeItemId];
      if (!item) return;
      dispatch({
        type: "ADD",
        line: {
          menuItemId: item.id,
          displayName: `${item.name} (Free gift)`,
          unitPrice: 0,
          quantity: 1,
          modifiers: [],
          selectedSku: null,
          notes: "",
          plu: item.plu ?? null,
          freeItemOf: freeItem.campaignId,
        } as any,
      });
    }
  }, [cart, freeItem, eligibleSubtotal, chosenFreeItemId, itemsById]);
  const campaignClears =
    storeCampaign &&
    (storeCampaign.minOrder == null ||
      subtotal >= Number(storeCampaign.minOrder));
  const campaignDiscount = !campaignClears
    ? 0
    : storeCampaign.percentageOff != null
      ? Math.round(subtotal * Number(storeCampaign.percentageOff)) / 100
      : storeCampaign.amountOff != null
        ? Math.min(subtotal, Number(storeCampaign.amountOff))
        : 0;
  // Effective discount is the larger of the promo code and the
  // campaign — they don't stack.
  const effectiveDiscount = Math.max(promoDiscount, campaignDiscount);

  // Phase AP-8 — visible service charge.
  // Only the fixed portion of the application fee surfaces to the
  // customer; percent-only fees are deducted from the restaurant's
  // payout silently. Only applied when payment method is CARD.
  const feeMode = (storefront?.location as any)?.applicationFeeMode as
    | "none"
    | "fixed_only"
    | "percentage_only"
    | "fixed_and_percentage"
    | undefined;
  const feeFixed = Number(
    (storefront?.location as any)?.applicationFeeFixedAmount ?? 0,
  );
  const usesFixedFee =
    feeMode === "fixed_only" || feeMode === "fixed_and_percentage";
  const serviceCharge =
    paymentMethod === "CARD" && usesFixedFee && feeFixed > 0 ? feeFixed : 0;

  const total =
    Math.max(0, subtotal - effectiveDiscount) + deliveryFee + serviceCharge;
  const cartCount = cart.reduce((s, l) => s + l.quantity, 0);

  // Categories + search filter
  // Phase AP fix — keep every category in the strip even when it has
  // no available items yet, so the menu structure on the storefront
  // mirrors what the operator sees in POS. An empty category just
  // shows an empty-state placeholder under the grid.
  const allCategories = useMemo(
    () => storefront?.menu?.categories ?? [],
    [storefront?.menu?.categories],
  );

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const lists: Array<{ cat: MenuCategory; items: MenuItem[] }> = [];
    for (const cat of allCategories) {
      if (activeCategory !== "all" && cat.id !== activeCategory) continue;
      const items = cat.items
        .filter((link) => link.item.isAvailable)
        .map((link) => link.item)
        .filter(
          (it) =>
            !q ||
            it.name.toLowerCase().includes(q) ||
            (it.description ?? "").toLowerCase().includes(q),
        );
      // On "All" we hide empty categories so the page doesn't render a
      // wall of headings with no products. When the operator picks a
      // specific chip we always render that category so they see the
      // "no items in this category yet" placeholder rather than nothing.
      if (items.length > 0 || activeCategory === cat.id) {
        lists.push({ cat, items });
      }
    }
    return lists;
  }, [allCategories, activeCategory, search]);

  // ── Checkout ─────────────────────────────────────────────────────────────

  const checkout = useMutation({
    mutationFn: () => {
      // Server expects a flat items[] shape — same as the legacy
      // checkout endpoint takes.
      const items = cart.map((l) => ({
        menuItemId: l.menuItemId,
        name: l.displayName,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        modifiers: l.modifiers.map((m) => ({ name: m.name, price: m.price })),
        notes: l.notes,
      }));
      const payload: any = {
        idempotencyKey: `direct-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`,
        fulfillmentType,
        customerInfo: {
          name: customerName,
          phone: customerPhone || undefined,
          email: customerEmail || undefined,
        },
        deliveryAddress:
          fulfillmentType === "DELIVERY"
            ? {
                // Phase AP fix #3 — house/flat number sits in line2
                // so the existing API/print payload picks it up
                // unchanged. line1 stays as "street + number".
                line1: addrLine1,
                line2: addrFlat || undefined,
                city: addrCity,
                postcode: addrPostcode,
                country: "GB",
              }
            : undefined,
        items,
        subtotal,
        deliveryFee,
        total,
        specialInstructions: notes || undefined,
        scheduledFor: scheduledFor ?? undefined,
        // Phase AP — payment method is metadata for now; AP-8 will wire
        // the real Stripe manual-capture flow.
        paymentMethod,
        // Phase AP fix #1 — applied promo discount lands on the order
        // so it shows in operator + accounting reports.
        discount: effectiveDiscount,
        promoCode: promoApplied?.code,
        discountType: promoApplied
          ? promoApplied.freeDelivery
            ? "FREE_DELIVERY"
            : "PROMO_CODE"
          : undefined,
        // Phase AP-5 — attribute the order to the signed-in customer
        // so it shows up on their My Orders page. Undefined means
        // guest checkout — server treats it as no link.
        customerAccountId: authCustomer?.id,
      };
      return axios
        .post(`${API_BASE}/v1/ordering/store/${slug}/checkout`, payload, {
          params: brandId ? { brand: brandId } : undefined,
        })
        .then((r) => r.data);
    },
    onSuccess: (order) => {
      // Phase AP-8 — CARD orders come back with checkoutUrl pointing at
      // the Stripe-hosted payment page. Redirect the whole window so the
      // customer enters their card on Stripe's domain (no PCI scope for
      // us, supports Apple Pay / Google Pay / Link automatically).
      //
      // The success_url Stripe sends them back to is
      // /order/[slug]/confirmation?orderId=...&session_id={...} — the
      // existing waiting-for-restaurant screen polls /order-status by id.
      if (order?.checkoutUrl && typeof window !== "undefined") {
        // Clear the cart NOW so a back-button after payment doesn't show
        // the unpaid cart again. The order is already created server-side.
        dispatch({ type: "CLEAR" });
        window.location.href = order.checkoutUrl;
        return;
      }
      // Cash path: same behaviour as before — show the "waiting for
      // restaurant" confirmation screen in-place.
      setConfirmedOrderId(order.id);
      setCartOpen(false);
      dispatch({ type: "CLEAR" });
    },
  });

  // ── Phase AP-AUTH — customer auth hook + pre-fill effect ─────────────
  //
  // Declared AFTER `checkout` so the post-login replay can reference
  // it. Pre-fills cart name + phone with the customer's profile so
  // they don't retype, and auto-fires checkout if they hit "Place
  // order" before signing in.
  const { customer: authCustomer, logout: logoutCustomer } = useCustomerAuth();
  useEffect(() => {
    if (!authCustomer) return;
    if (!customerName) {
      setCustomerName(
        `${authCustomer.firstName} ${authCustomer.lastName}`.trim(),
      );
    }
    if (!customerPhone && authCustomer.phone) {
      setCustomerPhone(authCustomer.phone);
    }
    if (pendingPlaceOrder) {
      setPendingPlaceOrder(false);
      checkout.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authCustomer]);

  // Wraps the existing checkout.mutate() call so the modal opens when
  // the customer isn't authenticated. The pending flag is consumed
  // by the effect above the moment auth state flips to authenticated.
  const handlePlaceOrder = () => {
    // Phase AW-15 — last-mile client guard. The API rechecks too, but
    // refusing the click here avoids a network round-trip + an
    // unfriendly toast when the storefront is currently paused.
    if (storefront?.closed) return;
    if (!authCustomer) {
      setPendingPlaceOrder(true);
      setLoginOpen(true);
      return;
    }
    checkout.mutate();
  };

  // ── Promo + postcode helpers (Phase AP fix #1 + #2) ─────────────────────

  const applyPromo = async () => {
    const code = promoCode.trim();
    if (!code) return;
    setPromoError(null);
    try {
      const res = await axios.post<{
        valid: boolean;
        reason?: string;
        code?: string;
        discountAmount?: number;
        freeDelivery?: boolean;
      }>(`${API_BASE}/v1/ordering/store/${slug}/promo`, {
        code,
        subtotal,
      });
      if (!res.data.valid) {
        setPromoApplied(null);
        setPromoError(res.data.reason ?? "Code not valid");
        return;
      }
      setPromoApplied({
        code: res.data.code ?? code,
        discountAmount: res.data.discountAmount ?? 0,
        freeDelivery: res.data.freeDelivery === true,
      });
    } catch (err: any) {
      setPromoError(
        err?.response?.data?.message ??
          err?.message ??
          "Could not check that code",
      );
    }
  };

  const runPostcodeLookup = async () => {
    const pc = addrPostcode.trim();
    if (pc.length < 5) {
      setPostcodeLookupNote("Enter a full postcode first");
      setPostcodeSuggestions([]);
      return;
    }
    setPostcodeLookupLoading(true);
    setPostcodeLookupNote(null);
    try {
      const res = await axios.get<{
        provider: string;
        suggestions: Array<{
          id: string;
          label: string;
          line1: string;
          line2?: string;
          city?: string;
          postcode?: string;
        }>;
      }>(`${API_BASE}/v1/address-lookup/postcode`, { params: { postcode: pc } });
      if (res.data.suggestions.length === 0) {
        setPostcodeSuggestions([]);
        setPostcodeLookupNote("No addresses found for this postcode.");
      } else {
        setPostcodeSuggestions(res.data.suggestions);
        const provider = res.data.provider;
        if (provider === "postcodes_io") {
          setPostcodeLookupNote("Town + postcode only — type the house number.");
        } else if (provider === "osm") {
          setPostcodeLookupNote(
            `${res.data.suggestions.length} streets — pick one, then add the house number.`,
          );
        } else {
          setPostcodeLookupNote(
            `${res.data.suggestions.length} address${
              res.data.suggestions.length === 1 ? "" : "es"
            } — tap one to use.`,
          );
        }
      }
    } catch (err: any) {
      setPostcodeSuggestions([]);
      setPostcodeLookupNote(
        err?.response?.data?.message ?? "Postcode lookup failed",
      );
    } finally {
      setPostcodeLookupLoading(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (storefrontQuery.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
      </div>
    );
  }
  if (storefrontQuery.error || !storefront) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <div className="text-center px-4">
          <p className="text-2xl font-bold text-zinc-900 mb-2">
            Store not found
          </p>
          <p className="text-zinc-500 text-sm">
            This ordering link doesn&apos;t exist or has been deactivated.
          </p>
        </div>
      </div>
    );
  }

  if (confirmedOrderId) {
    return (
      <OrderConfirmed
        orderId={confirmedOrderId}
        storeName={storefront.location.name}
        onReset={() => setConfirmedOrderId(null)}
        storeSlug={slug}
        brandId={brandId}
      />
    );
  }

  const headerAddress = [
    storefront.location.addressLine1 ?? storefront.location.address?.line1,
    storefront.location.city ?? storefront.location.address?.city,
    storefront.location.postcode ?? storefront.location.address?.postcode,
  ]
    .filter(Boolean)
    .join(", ");

  const logoUrl = storefront.location.logoUrl ?? storefront.brand.logoUrl ?? null;
  const headerTitle = storefront.location.name || storefront.brand.name;
  const acceptDelivery = cfg?.acceptsDelivery ?? true;
  const acceptCollection = cfg?.acceptsCollection ?? true;

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Top nav */}
      <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="h-9 w-9 rounded-md object-cover" />
            ) : (
              <div className="grid h-9 w-9 place-items-center rounded-md bg-orange-500 text-sm font-bold text-white">
                {headerTitle.slice(0, 1).toUpperCase()}
              </div>
            )}
            <span className="hidden sm:inline text-sm font-semibold text-zinc-900">
              {headerTitle}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* Phase AP-AUTH increment 2b — persistent customer auth
                control. Shows "Sign in" pre-auth, or the avatar +
                first-name dropdown post-auth. Lives next to the cart
                pill so it stays visible the whole time the customer
                is browsing. */}
            <HeaderAuthButton
              customer={authCustomer ?? null}
              onSignInClick={() => setLoginOpen(true)}
              onLogout={logoutCustomer}
              myOrdersHref={`/order/${slug}/my-orders`}
            />
            <button
              onClick={() => setCartOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600"
            >
              <ShoppingBag className="h-4 w-4" /> Cart
              {cartCount > 0 && (
                <span className="ml-1 rounded-full bg-white px-1.5 text-[10px] font-bold text-orange-600">
                  {cartCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Hero banner */}
      <div className="w-full bg-zinc-100">
        {heroImage ? (
          <img
            src={heroImage}
            alt=""
            className="h-48 w-full object-cover sm:h-72"
          />
        ) : (
          <div className="h-48 w-full bg-gradient-to-r from-orange-100 to-amber-50 sm:h-64" />
        )}
      </div>

      <div className="mx-auto max-w-5xl px-4">
        {/* Restaurant info card.
            Sat below the hero now — the previous -mt-12 made the
            title text clip into the banner image at certain viewport
            widths. Dropping the negative margin keeps the banner
            fully visible. The "About" description has also been
            removed from this card; it already lives inside the Info
            modal and was duplicated here. */}
        <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex items-start gap-4">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                className="h-16 w-16 rounded-lg object-cover ring-2 ring-white shadow"
              />
            ) : (
              <div className="grid h-16 w-16 place-items-center rounded-lg bg-orange-500 text-2xl font-bold text-white ring-2 ring-white shadow">
                {headerTitle.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl">
                  {headerTitle}
                </h1>
                <button
                  type="button"
                  onClick={() => setInfoOpen(true)}
                  className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
                >
                  <Info className="h-3.5 w-3.5" /> Info
                </button>
              </div>
              {headerAddress && (
                <p className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
                  <MapPin className="h-3 w-3" /> {headerAddress}
                </p>
              )}
            </div>
          </div>

          {/* Pills + schedule */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {acceptDelivery && (
              <FulfillmentPill
                active={fulfillmentType === "DELIVERY"}
                onClick={() => setFulfillmentType("DELIVERY")}
                icon={<Bike className="h-4 w-4" />}
                label="Delivery"
                sub={`${cfg?.deliveryPrepMinutes ?? 45} mins`}
              />
            )}
            {acceptCollection && (
              <FulfillmentPill
                active={fulfillmentType === "PICKUP"}
                onClick={() => setFulfillmentType("PICKUP")}
                icon={<ShoppingBag className="h-4 w-4" />}
                label="Pickup"
                sub={`${cfg?.collectionPrepMinutes ?? 20} mins`}
              />
            )}
            <button
              onClick={() => setScheduleOpen(true)}
              className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-300"
            >
              <Clock className="h-4 w-4" />
              {scheduledFor
                ? `Scheduled ${formatScheduledFor(scheduledFor)}`
                : "Schedule"}
            </button>
          </div>

          {!storefront.isOpen && (
            <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Store is currently closed — schedule for later or come back.
            </p>
          )}

          {/* Phase AW-15 — operator-pushed pause / busy banners. The
              closed banner blocks Add + Checkout (handled below by
              isAcceptingOrders); busy keeps everything live but warns
              about a longer prep time. */}
          {storefront.closed && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
              <p className="font-semibold">
                {storefront.closed.brandName} currently isn&apos;t accepting
                online orders
              </p>
              {storefront.closed.resumeAt && (
                <p className="mt-0.5">
                  Reopens at{" "}
                  <strong>
                    {new Date(storefront.closed.resumeAt).toLocaleString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}
                  </strong>
                </p>
              )}
              {storefront.closed.reason && (
                <p className="mt-0.5 italic">
                  &ldquo;{storefront.closed.reason}&rdquo;
                </p>
              )}
              <p className="mt-1.5 text-[11px] text-red-700">
                You can keep browsing the menu — checkout is disabled until we
                reopen.
              </p>
            </div>
          )}
          {storeCampaign && !storefront.closed && (storeCampaign.percentageOff != null || storeCampaign.amountOff != null) && (
            <div className="mt-4 rounded-md border border-orange-200 bg-orange-50 px-4 py-2 text-xs text-orange-900">
              <p className="font-semibold">
                🎉{" "}
                {storeCampaign.percentageOff != null
                  ? `${Number(storeCampaign.percentageOff)}% off your order`
                  : `£${Number(storeCampaign.amountOff).toFixed(2)} off your order`}
                {storeCampaign.minOrder
                  ? ` on £${Number(storeCampaign.minOrder).toFixed(2)}+`
                  : ""}
              </p>
              {storeCampaign.name && (
                <p className="mt-0.5 text-[11px] text-orange-800">
                  {storeCampaign.name} — applied automatically at checkout.
                </p>
              )}
            </div>
          )}
          {/* Phase AW-19 — items-only campaign banner. Only shown when
              there's no storewide campaign already taking the slot. */}
          {bogo && !storefront.closed && (
            <div className="mt-4 rounded-md border border-pink-200 bg-pink-50 px-4 py-2 text-xs text-pink-900">
              <p className="font-semibold">🎁 Buy 1, get 1 free</p>
              <p className="mt-0.5 text-[11px] text-pink-800">
                {bogo.campaignName} — add any highlighted item and a free
                copy of the same item lands in your cart automatically.
              </p>
            </div>
          )}
          {freeItem && !storefront.closed && (() => {
            const eligible = eligibleSubtotal >= freeItem.minOrder;
            const remaining = Math.max(0, freeItem.minOrder - eligibleSubtotal);
            const named = freeItem.freeItemIds
              .map((id) => itemsById[id]?.name)
              .filter(Boolean) as string[];
            const headline =
              named.length === 0
                ? "a free item"
                : named.length === 1
                  ? `a free ${named[0]}`
                  : named.length === 2
                    ? `a free ${named[0]} or ${named[1]}`
                    : `a free item (${named.slice(0, -1).join(", ")}, or ${named[named.length - 1]})`;
            return (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
                <p className="font-semibold">
                  ✨ Spend £{freeItem.minOrder.toFixed(2)} and get {headline}
                </p>
                <p className="mt-0.5 text-[11px] text-amber-800">
                  {eligible
                    ? "🎉 Unlocked! Pick your free item in the cart."
                    : `Add £${remaining.toFixed(2)} more (eligible items only) to unlock.`}
                </p>
              </div>
            );
          })()}
          {!storeCampaign && !storefront.closed && Object.keys(itemPromos).length > 0 && (() => {
            const promos = Object.values(itemPromos);
            const uniquePercents = Array.from(new Set(promos.map((p) => p.percentageOff)));
            const uniqueNames = Array.from(new Set(promos.map((p) => p.campaignName)));
            const headline =
              uniquePercents.length === 1
                ? `${uniquePercents[0]}% off selected items`
                : "Discounts on selected items";
            return (
              <div className="mt-4 rounded-md border border-orange-200 bg-orange-50 px-4 py-2 text-xs text-orange-900">
                <p className="font-semibold">🎉 {headline}</p>
                <p className="mt-0.5 text-[11px] text-orange-800">
                  {uniqueNames.length === 1 ? uniqueNames[0] : "Multiple offers"} —
                  applied automatically. Look for the price tags below.
                </p>
              </div>
            );
          })()}
          {storefront.busy && !storefront.closed && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              <p className="font-semibold">
                Busy right now — orders are taking longer
              </p>
              {storefront.busy.extraPrepTime && (
                <p className="mt-0.5">
                  Add about{" "}
                  <strong>{storefront.busy.extraPrepTime} minutes</strong> to
                  the usual prep time.
                </p>
              )}
              {storefront.busy.reason && (
                <p className="mt-0.5 italic">
                  &ldquo;{storefront.busy.reason}&rdquo;
                </p>
              )}
            </div>
          )}
        </div>

        {/* Search */}
        <div className="mt-6">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              value={search}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search for food…"
              className="w-full rounded-xl border border-zinc-200 bg-white px-9 py-3 text-sm focus:border-zinc-400 focus:outline-none"
            />
          </div>
        </div>

        {/* Sticky category chips */}
        <div className="sticky top-[60px] z-30 -mx-4 mt-4 bg-zinc-50/95 backdrop-blur supports-[backdrop-filter]:bg-zinc-50/80">
          <div className="px-4 py-3">
            <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <CategoryChip
                active={activeCategory === "all"}
                onClick={() => setActiveCategory("all")}
              >
                All
              </CategoryChip>
              {allCategories.map((c) => (
                <CategoryChip
                  key={c.id}
                  active={activeCategory === c.id}
                  onClick={() => setActiveCategory(c.id)}
                >
                  {c.name}
                </CategoryChip>
              ))}
            </div>
          </div>
        </div>

        {/* Product grid */}
        <div className="space-y-8 pb-24 pt-4">
          {visibleItems.length === 0 ? (
            <p className="py-16 text-center text-sm text-zinc-400">
              No items match your search.
            </p>
          ) : (
            visibleItems.map(({ cat, items }) => (
              <section key={cat.id} id={`category-${cat.id}`}>
                {activeCategory === "all" && (
                  <h2 className="mb-3 text-lg font-bold text-zinc-900">
                    {cat.name}
                  </h2>
                )}
                {items.length === 0 ? (
                  <p className="rounded-md border border-dashed border-zinc-200 py-6 text-center text-xs text-zinc-400">
                    Nothing in {cat.name} yet — check back soon.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {items.map((item) => (
                      <ProductCard
                        key={item.id}
                        item={item}
                        promo={itemPromos[item.id] ?? null}
                        bogoTrigger={bogoTriggerSet.has(item.id)}
                        onClick={() => handleProductClick(item)}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      </div>

      {/* Cart side panel */}
      {cartOpen && (
        <CartPanel
          onClose={() => setCartOpen(false)}
          cart={cart}
          dispatch={dispatch}
          subtotal={subtotal}
          deliveryFee={deliveryFee}
          serviceCharge={serviceCharge}
          total={total}
          fulfillmentType={fulfillmentType}
          setFulfillmentType={setFulfillmentType}
          acceptDelivery={acceptDelivery}
          acceptCollection={acceptCollection}
          acceptsCash={cfg?.acceptsCash ?? true}
          acceptsCard={cfg?.acceptsCard ?? true}
          customerName={customerName}
          setCustomerName={setCustomerName}
          customerPhone={customerPhone}
          setCustomerPhone={setCustomerPhone}
          customerEmail={customerEmail}
          setCustomerEmail={setCustomerEmail}
          addrFlat={addrFlat}
          setAddrFlat={setAddrFlat}
          addrLine1={addrLine1}
          setAddrLine1={setAddrLine1}
          addrCity={addrCity}
          setAddrCity={setAddrCity}
          addrPostcode={addrPostcode}
          setAddrPostcode={(v) => {
            setAddrPostcode(v);
            // Clear stale suggestions when the operator types again.
            if (postcodeSuggestions.length > 0) setPostcodeSuggestions([]);
            if (postcodeLookupNote) setPostcodeLookupNote(null);
          }}
          promoCode={promoCode}
          setPromoCode={setPromoCode}
          promoApplied={promoApplied}
          promoError={promoError}
          onApplyPromo={() => applyPromo()}
          onClearPromo={() => {
            setPromoApplied(null);
            setPromoCode("");
            setPromoError(null);
          }}
          promoDiscount={promoDiscount}
          campaignDiscount={campaignDiscount}
          campaignName={storeCampaign?.name ?? null}
          freeItemPicker={
            freeItem
              ? {
                  eligible: eligibleSubtotal >= freeItem.minOrder,
                  minOrder: freeItem.minOrder,
                  remaining: Math.max(
                    0,
                    freeItem.minOrder - eligibleSubtotal,
                  ),
                  options: freeItem.freeItemIds
                    .map((id) => ({ id, name: itemsById[id]?.name ?? "" }))
                    .filter((o) => !!o.name),
                  chosenId: chosenFreeItemId,
                  onChoose: setChosenFreeItemId,
                }
              : null
          }
          freeDelivery={freeDelivery}
          postcodeSuggestions={postcodeSuggestions}
          postcodeLookupNote={postcodeLookupNote}
          postcodeLookupLoading={postcodeLookupLoading}
          onPostcodeLookup={() => runPostcodeLookup()}
          onPickPostcodeSuggestion={(s) => {
            if (s.line1) setAddrLine1(s.line1);
            if (s.city) setAddrCity(s.city);
            if (s.postcode) setAddrPostcode(s.postcode);
            setPostcodeSuggestions([]);
            setPostcodeLookupNote(null);
          }}
          slug={slug}
          paymentMethod={paymentMethod}
          setPaymentMethod={setPaymentMethod}
          notes={notes}
          setNotes={setNotes}
          matchedZone={matchedZone}
          scheduledFor={scheduledFor}
          onOpenSchedule={() => setScheduleOpen(true)}
          onPlace={handlePlaceOrder}
          isPlacing={checkout.isPending}
          placeError={
            checkout.error
              ? ((checkout.error as any)?.response?.data?.message ??
                "Could not place order. Try again.")
              : null
          }
        />
      )}

      {/* Modifier modal — reuses POS modal exactly. allModifierGroups
          is required for multi-SKU products (their per-SKU groups are
          stored as plain ID arrays, not FK-linked). */}
      {modalItem && (
        <ModifierSelectionModal
          item={modalItem}
          allModifierGroups={storefront.brandModifierGroups ?? []}
          open={!!modalItem}
          onClose={() => setModalItem(null)}
          onAdd={(line) => {
            // Phase AW-19 — discount the modal's unitPrice too so a
            // pizza with mods still respects the campaign.
            const promo = itemPromos[line.menuItemId];
            const unitPrice = promo
              ? Math.round(line.unitPrice * (1 - promo.percentageOff / 100) * 100) / 100
              : line.unitPrice;
            dispatch({
              type: "ADD",
              line: {
                menuItemId: line.menuItemId,
                displayName: line.displayName,
                unitPrice,
                quantity: line.quantity,
                modifiers: line.modifiers,
                selectedSku: line.selectedSku,
                notes: line.notes,
                plu: line.plu,
              },
            });
            // Phase AP follow-up: adding from the modifier modal no
            // longer auto-pops the cart. The customer browses through
            // the menu and opens the cart manually from the Cart pill
            // when they're ready to checkout.
          }}
        />
      )}

      {/* Info modal — About + opening hours + delivery fees */}
      {infoOpen && (
        <InfoModal
          locationName={headerTitle}
          about={storefront.location.about ?? null}
          address={headerAddress || null}
          openingHours={storefront.location.openingHours}
          deliveryZones={storefront.deliveryZones ?? []}
          isOpenNow={storefront.isOpen}
          onClose={() => setInfoOpen(false)}
        />
      )}

      {/* Schedule modal */}
      {scheduleOpen && (
        <ScheduleModal
          maxDaysAhead={cfg?.scheduleMaxDaysAhead ?? 7}
          slotMinutes={cfg?.scheduleSlotMinutes ?? 15}
          prepMinutes={prepMins}
          openingHours={storefront.location.openingHours}
          onClose={() => setScheduleOpen(false)}
          onPick={(iso) => {
            setScheduledFor(iso);
            setScheduleOpen(false);
          }}
          onAsap={() => {
            setScheduledFor(null);
            setScheduleOpen(false);
          }}
        />
      )}

      {/* Phase AP-AUTH — login / signup modal. Opens on Place Order click
          when the customer isn't authenticated; the pendingPlaceOrder
          flag (set in handlePlaceOrder above) is consumed by the auth
          effect, which auto-fires checkout once the modal closes
          successfully. */}
      <LoginModal
        open={loginOpen}
        storeSlug={String(slug)}
        onClose={() => {
          setLoginOpen(false);
          // If the customer dismissed the modal without signing in,
          // drop the pending flag too so a later auth (e.g. from
          // another tab via cross-tab sync) doesn't auto-checkout.
          setPendingPlaceOrder(false);
        }}
        onAuthenticated={() => {
          // The effect above sees authCustomer flip and replays
          // checkout.mutate(); nothing else to do here.
        }}
      />
    </div>
  );

  function handleProductClick(item: MenuItem) {
    // Phase AW-15 — when the storefront is paused, taps on product
    // cards become inert. The customer can still scroll the menu but
    // can't open the modifier sheet or drop anything in the cart.
    if (storefront?.closed) return;
    const hasMods = (item.modifierGroupLinks?.length ?? 0) > 0;
    const multiSku = !!item.hasMultipleSkus;
    if (hasMods || multiSku) {
      setModalItem(item);
      return;
    }
    // Phase AW-19 — apply per-item promo at add time so cart subtotal
    // and order line price are already discounted. ProductCard shows
    // the strikethrough; cart shows the net price.
    const promo = itemPromos[item.id];
    const unitPrice = promo
      ? Math.round(Number(item.basePrice) * (1 - promo.percentageOff / 100) * 100) / 100
      : Number(item.basePrice);
    dispatch({
      type: "ADD",
      line: {
        menuItemId: item.id,
        displayName: item.name,
        unitPrice,
        quantity: 1,
        modifiers: [],
        selectedSku: null,
        notes: "",
        plu: item.plu ?? null,
      },
    });
    // Phase AP follow-up: do NOT auto-pop the cart. Customer keeps
    // browsing the menu; they tap the Cart pill when they're ready
    // to finish.
  }
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function FulfillmentPill({
  active,
  onClick,
  icon,
  label,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
        active
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300",
      )}
    >
      {icon}
      <span className="flex flex-col text-left">
        <span className="font-semibold leading-tight">{label}</span>
        <span className={cn("text-[10px] leading-tight", active ? "text-white/70" : "text-zinc-500")}>
          {sub}
        </span>
      </span>
    </button>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition",
        active
          ? "border-orange-500 bg-orange-500 text-white"
          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300",
      )}
    >
      {children}
    </button>
  );
}

function ProductCard({
  item,
  promo,
  bogoTrigger,
  onClick,
}: {
  item: MenuItem;
  promo: { percentageOff: number; campaignName: string } | null;
  bogoTrigger?: boolean;
  onClick: () => void;
}) {
  const basePrice = Number(item.basePrice);
  const hasPromo = !!promo && promo.percentageOff > 0;
  const discounted = hasPromo
    ? Math.round(basePrice * (1 - promo!.percentageOff / 100) * 100) / 100
    : basePrice;
  return (
    <button
      onClick={onClick}
      disabled={item.outOfStock}
      className="group flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white text-left transition hover:shadow-md disabled:opacity-50"
    >
      <div className="relative aspect-square w-full bg-zinc-50">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-zinc-300">
            <ShoppingBag className="h-10 w-10" />
          </div>
        )}
        {item.outOfStock && (
          <span className="absolute top-2 left-2 rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white">
            Out of stock
          </span>
        )}
        {hasPromo && !item.outOfStock && (
          <span className="absolute top-2 right-2 rounded-md bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
            {promo!.percentageOff}% OFF
          </span>
        )}
        {bogoTrigger && !hasPromo && !item.outOfStock && (
          <span className="absolute top-2 right-2 rounded-md bg-pink-600 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
            BUY 1 GET 1 FREE
          </span>
        )}
        {bogoTrigger && !item.outOfStock && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-pink-50 px-2 py-0.5 text-[10px] font-semibold text-pink-700 ring-1 ring-pink-200">
            🎁 Free item included
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className="text-sm font-bold text-zinc-900 line-clamp-1">
          {item.name}
        </h3>
        {item.description && (
          <p className="text-xs text-zinc-500 line-clamp-2">
            {item.description}
          </p>
        )}
        <div className="mt-auto flex items-center justify-between pt-2">
          {hasPromo ? (
            <div className="flex flex-col leading-tight">
              <span className="text-[11px] text-zinc-400 line-through">
                £{basePrice.toFixed(2)}
              </span>
              <span className="text-base font-bold text-red-600">
                £{discounted.toFixed(2)}
              </span>
            </div>
          ) : (
            <span className="text-base font-bold text-orange-600">
              £{basePrice.toFixed(2)}
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white group-hover:bg-orange-600">
            <Plus className="h-3.5 w-3.5" /> Add
          </span>
        </div>
      </div>
    </button>
  );
}

// ── Cart Panel ─────────────────────────────────────────────────────────────

interface CartPanelProps {
  onClose: () => void;
  cart: CartLine[];
  dispatch: React.Dispatch<CartAction>;
  subtotal: number;
  deliveryFee: number;
  serviceCharge: number;
  total: number;
  fulfillmentType: "PICKUP" | "DELIVERY";
  setFulfillmentType: (v: "PICKUP" | "DELIVERY") => void;
  acceptDelivery: boolean;
  acceptCollection: boolean;
  acceptsCash: boolean;
  acceptsCard: boolean;
  customerName: string;
  setCustomerName: (v: string) => void;
  customerPhone: string;
  setCustomerPhone: (v: string) => void;
  customerEmail: string;
  setCustomerEmail: (v: string) => void;
  addrFlat: string;
  setAddrFlat: (v: string) => void;
  addrLine1: string;
  setAddrLine1: (v: string) => void;
  addrCity: string;
  setAddrCity: (v: string) => void;
  addrPostcode: string;
  setAddrPostcode: (v: string) => void;
  paymentMethod: "CASH" | "CARD";
  setPaymentMethod: (v: "CASH" | "CARD") => void;
  notes: string;
  setNotes: (v: string) => void;
  matchedZone: { prefix: string; fee: number; minOrder: number | null } | null;
  scheduledFor: string | null;
  onOpenSchedule: () => void;
  onPlace: () => void;
  isPlacing: boolean;
  placeError: string | null;
  // Phase AP fix #1 promo + fix #2 postcode lookup
  promoCode: string;
  setPromoCode: (v: string) => void;
  promoApplied: { code: string; discountAmount: number; freeDelivery: boolean } | null;
  promoError: string | null;
  onApplyPromo: () => void;
  onClearPromo: () => void;
  promoDiscount: number;
  campaignDiscount: number;
  campaignName: string | null;
  freeDelivery: boolean;
  postcodeSuggestions: Array<{
    id: string;
    label: string;
    line1: string;
    line2?: string;
    city?: string;
    postcode?: string;
  }>;
  postcodeLookupNote: string | null;
  postcodeLookupLoading: boolean;
  onPostcodeLookup: () => void;
  onPickPostcodeSuggestion: (s: {
    line1: string;
    line2?: string;
    city?: string;
    postcode?: string;
  }) => void;
  slug: string;
  // Phase AW-19 — FREE_ITEM picker that lives in the cart panel so
  // the customer makes their choice while reviewing the order.
  freeItemPicker: {
    eligible: boolean;
    minOrder: number;
    remaining: number;
    options: Array<{ id: string; name: string }>;
    chosenId: string | null;
    onChoose: (id: string) => void;
  } | null;
}

function CartPanel(props: CartPanelProps) {
  const {
    onClose,
    cart,
    addrFlat,
    setAddrFlat,
    promoCode,
    setPromoCode,
    promoApplied,
    promoError,
    onApplyPromo,
    onClearPromo,
    promoDiscount,
    campaignDiscount,
    campaignName,
    freeDelivery,
    postcodeSuggestions,
    postcodeLookupNote,
    postcodeLookupLoading,
    onPostcodeLookup,
    onPickPostcodeSuggestion,
    freeItemPicker,
    dispatch,
    subtotal,
    deliveryFee,
    serviceCharge,
    total,
    fulfillmentType,
    setFulfillmentType,
    acceptDelivery,
    acceptCollection,
    acceptsCash,
    acceptsCard,
    customerName,
    setCustomerName,
    customerPhone,
    setCustomerPhone,
    customerEmail,
    setCustomerEmail,
    addrLine1,
    setAddrLine1,
    addrCity,
    setAddrCity,
    addrPostcode,
    setAddrPostcode,
    paymentMethod,
    setPaymentMethod,
    notes,
    setNotes,
    matchedZone,
    scheduledFor,
    onOpenSchedule,
    onPlace,
    isPlacing,
    placeError,
  } = props;

  const canPlace =
    cart.length > 0 &&
    customerName.trim().length > 0 &&
    customerPhone.trim().length > 0 &&
    (fulfillmentType === "PICKUP" ||
      (addrLine1 && addrCity && addrPostcode));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col overflow-hidden bg-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Current order</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {freeItemPicker && freeItemPicker.options.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="font-semibold">
                ✨ Free item with purchase
              </p>
              <p className="mt-0.5 text-[11px] text-amber-800">
                {!freeItemPicker.eligible
                  ? `Add £${freeItemPicker.remaining.toFixed(2)} more (eligible items only) to unlock.`
                  : freeItemPicker.options.length === 1
                    ? `🎉 Unlocked! Free ${freeItemPicker.options[0]?.name ?? "item"} added to your cart.`
                    : freeItemPicker.chosenId
                      ? "Gift added to your cart — tap another to swap."
                      : "🎉 Unlocked! Pick which one you want:"}
              </p>
              {freeItemPicker.eligible &&
                freeItemPicker.options.length > 1 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {freeItemPicker.options.map((o) => {
                      const on = freeItemPicker.chosenId === o.id;
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => freeItemPicker.onChoose(o.id)}
                          className={`rounded-full border px-3 py-1 text-[11px] font-medium ${
                            on
                              ? "border-amber-600 bg-amber-600 text-white"
                              : "border-amber-300 bg-white text-amber-900 hover:border-amber-500"
                          }`}
                        >
                          {o.name}
                        </button>
                      );
                    })}
                  </div>
                )}
            </div>
          )}
          {cart.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-400">
              Cart is empty
            </p>
          ) : (
            <ul className="space-y-2">
              {cart.map((l) => (
                <li
                  key={l.id}
                  className="flex items-start gap-3 rounded-md border border-zinc-100 px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900">
                      {l.displayName}
                    </p>
                    {l.modifiers.length > 0 && (
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        {l.modifiers.map((m) => m.name).join(", ")}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-zinc-500">
                      £
                      {(
                        (l.unitPrice + l.modifiers.reduce((s, m) => s + m.price, 0)) *
                        l.quantity
                      ).toFixed(2)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => dispatch({ type: "DECREMENT", id: l.id })}
                      className="grid h-6 w-6 place-items-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <span className="w-5 text-center text-xs font-semibold">
                      {l.quantity}
                    </span>
                    <button
                      onClick={() => dispatch({ type: "INCREMENT", id: l.id })}
                      className="grid h-6 w-6 place-items-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Customer */}
          <Section title="Your details">
            <div className="grid grid-cols-2 gap-2">
              <TextField
                value={customerName}
                onChange={setCustomerName}
                placeholder="Full name"
              />
              <TextField
                value={customerPhone}
                onChange={setCustomerPhone}
                placeholder="Phone"
              />
            </div>
            <TextField
              value={customerEmail}
              onChange={setCustomerEmail}
              placeholder="Email (optional)"
            />
          </Section>

          {/* Fulfillment */}
          <Section title="Order type">
            <div className="flex gap-2">
              {acceptCollection && (
                <Toggle
                  active={fulfillmentType === "PICKUP"}
                  onClick={() => setFulfillmentType("PICKUP")}
                >
                  Collection
                </Toggle>
              )}
              {acceptDelivery && (
                <Toggle
                  active={fulfillmentType === "DELIVERY"}
                  onClick={() => setFulfillmentType("DELIVERY")}
                >
                  Delivery
                </Toggle>
              )}
            </div>
          </Section>

          {/* Address (delivery only) */}
          {fulfillmentType === "DELIVERY" && (
            <Section title="Delivery address">
              {/* Phase AP fix #3 — house/flat number gets its own row */}
              <TextField
                value={addrFlat}
                onChange={setAddrFlat}
                placeholder="House / flat number"
              />
              <TextField
                value={addrLine1}
                onChange={setAddrLine1}
                placeholder="Street name"
              />
              <div className="grid grid-cols-2 gap-2">
                <TextField
                  value={addrCity}
                  onChange={setAddrCity}
                  placeholder="City"
                />
                <div className="flex gap-1">
                  <input
                    value={addrPostcode}
                    onChange={(e) => setAddrPostcode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        onPostcodeLookup();
                      }
                    }}
                    placeholder="Postcode"
                    className="flex-1 rounded-md border border-zinc-200 px-2 py-1.5 text-xs uppercase focus:border-zinc-900 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={onPostcodeLookup}
                    disabled={postcodeLookupLoading || addrPostcode.trim().length < 5}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-[10px] font-medium hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {postcodeLookupLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Search className="h-3 w-3" />
                    )}
                    Find
                  </button>
                </div>
              </div>

              {/* Phase AP fix #2 — picker for the lookup results */}
              {postcodeLookupNote && (
                <p className="text-[11px] text-zinc-500">{postcodeLookupNote}</p>
              )}
              {postcodeSuggestions.length > 0 && (
                <ul className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 bg-white">
                  {postcodeSuggestions.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => onPickPostcodeSuggestion(s)}
                        className="w-full px-2 py-1.5 text-left text-[11px] leading-snug hover:bg-zinc-50"
                      >
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {matchedZone && (
                <p className="text-[11px] text-emerald-700">
                  Matched zone <strong>{matchedZone.prefix}</strong> · £
                  {matchedZone.fee.toFixed(2)} delivery
                  {matchedZone.minOrder ? ` · min £${matchedZone.minOrder.toFixed(2)}` : ""}
                </p>
              )}
              {!matchedZone && addrPostcode.length >= 3 && (
                <p className="text-[11px] text-amber-600">
                  No matching delivery zone — restaurant may not deliver here.
                </p>
              )}
            </Section>
          )}

          {/* Schedule */}
          <Section title="When">
            <button
              type="button"
              onClick={onOpenSchedule}
              className="flex w-full items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-xs hover:bg-zinc-50"
            >
              <span className="text-zinc-700">
                {scheduledFor ? `Scheduled ${formatScheduledFor(scheduledFor)}` : "ASAP"}
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />
            </button>
          </Section>

          {/* Phase AP fix #1 — Promo code redemption */}
          <Section title="Promo code">
            {promoApplied ? (
              <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                <span>
                  <strong>{promoApplied.code}</strong>{" "}
                  {promoApplied.freeDelivery
                    ? "— Free delivery"
                    : `— £${promoDiscount.toFixed(2)} off`}
                </span>
                <button
                  type="button"
                  onClick={onClearPromo}
                  className="ml-2 rounded p-1 hover:bg-emerald-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  value={promoCode}
                  onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                  placeholder="Enter code"
                  className="flex-1 rounded-md border border-zinc-200 px-2 py-1.5 text-xs uppercase focus:border-zinc-900 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={onApplyPromo}
                  disabled={!promoCode.trim()}
                  className="rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}
            {promoError && (
              <p className="text-[11px] text-red-600">{promoError}</p>
            )}
          </Section>

          {/* Payment */}
          <Section title="Payment">
            <div className="flex gap-2">
              {acceptsCash && (
                <Toggle
                  active={paymentMethod === "CASH"}
                  onClick={() => setPaymentMethod("CASH")}
                >
                  Cash
                </Toggle>
              )}
              {acceptsCard && (
                <Toggle
                  active={paymentMethod === "CARD"}
                  onClick={() => setPaymentMethod("CARD")}
                >
                  Card
                </Toggle>
              )}
            </div>
            {paymentMethod === "CARD" && (
              <p className="text-[11px] text-zinc-500">
                Card payments are authorised now and only captured after the
                restaurant accepts your order.
              </p>
            )}
          </Section>

          {/* Notes */}
          <Section title="Order notes (optional)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Allergies, doorbell instructions, etc."
              rows={2}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
            />
          </Section>
        </div>

        {/* Totals + place */}
        <footer className="border-t border-zinc-200 px-4 py-3 space-y-2">
          <Row label="Subtotal" value={`£${subtotal.toFixed(2)}`} />
          {campaignDiscount >= promoDiscount && campaignDiscount > 0 && (
            <Row
              label={`Discount (${campaignName ?? "Promo"})`}
              value={`-£${campaignDiscount.toFixed(2)}`}
            />
          )}
          {promoDiscount > campaignDiscount && promoDiscount > 0 && (
            <Row
              label={`Discount (${promoApplied?.code ?? ""})`}
              value={`-£${promoDiscount.toFixed(2)}`}
            />
          )}
          {fulfillmentType === "DELIVERY" && (
            <Row
              label="Delivery"
              value={
                freeDelivery
                  ? "Free"
                  : deliveryFee > 0
                    ? `£${deliveryFee.toFixed(2)}`
                    : "—"
              }
            />
          )}
          {serviceCharge > 0 && (
            <Row
              label="Service charge"
              value={`£${serviceCharge.toFixed(2)}`}
            />
          )}
          <Row label="Total" value={`£${total.toFixed(2)}`} bold />
          {placeError && (
            <p className="text-[11px] text-red-600">{placeError}</p>
          )}
          <button
            onClick={onPlace}
            disabled={!canPlace || isPlacing}
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {isPlacing && <Loader2 className="h-4 w-4 animate-spin" />}
            Place order
          </button>
        </footer>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function TextField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
    />
  );
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md border px-3 py-1.5 text-xs font-medium",
        active
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50",
      )}
    >
      {children}
    </button>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between text-xs",
        bold ? "text-sm font-bold text-zinc-900" : "text-zinc-600",
      )}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

// ── Schedule Modal ─────────────────────────────────────────────────────────

function ScheduleModal({
  maxDaysAhead,
  slotMinutes,
  prepMinutes,
  openingHours,
  onClose,
  onPick,
  onAsap,
}: {
  maxDaysAhead: number;
  slotMinutes: number;
  prepMinutes: number;
  openingHours: any;
  onClose: () => void;
  onPick: (iso: string) => void;
  onAsap: () => void;
}) {
  const days = useMemo(() => {
    const out: Date[] = [];
    const today = new Date();
    for (let i = 0; i < maxDaysAhead; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      out.push(d);
    }
    return out;
  }, [maxDaysAhead]);

  const [activeDayIdx, setActiveDayIdx] = useState(0);
  const activeDay = days[activeDayIdx] ?? days[0]!;

  const slots = useMemo(
    () => computeSlots(activeDay, slotMinutes, prepMinutes, openingHours),
    [activeDay, slotMinutes, prepMinutes, openingHours],
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h3 className="text-sm font-semibold text-zinc-900">
            When would you like your order?
          </h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Day strip */}
        <div className="flex gap-2 overflow-x-auto px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {days.map((d, i) => {
            const label =
              i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short" });
            const sub = d.toLocaleDateString(undefined, {
              day: "2-digit",
              month: "short",
            });
            return (
              <button
                key={i}
                onClick={() => setActiveDayIdx(i)}
                className={cn(
                  "flex-shrink-0 rounded-lg border px-3 py-2 text-xs font-medium",
                  activeDayIdx === i
                    ? "border-orange-500 bg-orange-50 text-orange-700"
                    : "border-zinc-200 bg-white text-zinc-700",
                )}
              >
                <div className="font-bold">{label}</div>
                <div className="text-[10px] text-zinc-500">{sub}</div>
              </button>
            );
          })}
        </div>

        {/* Slots */}
        <div className="max-h-72 overflow-y-auto px-4 pb-4">
          {activeDayIdx === 0 && (
            <button
              onClick={onAsap}
              className="mb-2 flex w-full items-center justify-between rounded-md border border-orange-500 bg-orange-50 px-3 py-2 text-xs font-semibold text-orange-700"
            >
              <span className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                ASAP — ready in {prepMinutes} mins
              </span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
          {slots.length === 0 ? (
            <p className="py-6 text-center text-xs text-zinc-400">
              Closed on this day.
            </p>
          ) : (
            <ul className="space-y-1">
              {slots.map((iso) => (
                <li key={iso}>
                  <button
                    onClick={() => onPick(iso)}
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-50"
                  >
                    <span>{formatTime(iso)}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function computeSlots(
  day: Date,
  slotMinutes: number,
  prepMinutes: number,
  openingHours: any,
): string[] {
  // Determine the day's open windows from the Phase AN map shape. If
  // the location stores legacy array hours, return empty so the modal
  // shows the ASAP-only path.
  if (!openingHours || Array.isArray(openingHours)) return [];
  const dayKey = DAY_KEYS[day.getDay()];
  if (!dayKey) return [];
  const dayCfg = openingHours[dayKey];
  if (!dayCfg?.enabled || !Array.isArray(dayCfg.slots)) return [];

  const now = new Date();
  const isToday = day.toDateString() === now.toDateString();
  const earliest = isToday
    ? new Date(now.getTime() + prepMinutes * 60_000)
    : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0);

  const out: string[] = [];
  for (const slot of dayCfg.slots) {
    if (!slot?.from || !slot?.to) continue;
    const [fh = 0, fm = 0] = String(slot.from).split(":").map(Number);
    const [th = 0, tm = 0] = String(slot.to).split(":").map(Number);
    const start = new Date(day);
    start.setHours(fh, fm, 0, 0);
    const end = new Date(day);
    end.setHours(th, tm, 0, 0);
    // Wrap past midnight not supported here — limit at 23:59.
    if (end <= start) end.setHours(23, 59, 0, 0);
    for (
      let t = new Date(Math.max(start.getTime(), earliest.getTime()));
      t <= end;
      t = new Date(t.getTime() + slotMinutes * 60_000)
    ) {
      // Snap to the next slot interval if t < earliest
      if (t < earliest) continue;
      out.push(t.toISOString());
    }
  }
  return out;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatScheduledFor(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const label = isToday
    ? "today"
    : isTomorrow
      ? "tomorrow"
      : d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" });
  return `${label} ${formatTime(iso)}`;
}

// ── Confirmation / live tracking ────────────────────────────────────────────
//
// Phase AP fix #3: replaces the static "Order placed!" card with a real
// status-polling experience.
//
//   PENDING                → "Processing your order…" with an animated
//                            hourglass icon. Polls every 3s.
//   ACCEPTED → COMPLETED   → "Order accepted!" with the customer-facing
//                            order number badge + a vertical timeline
//                            that ticks each milestone as the staff
//                            transitions it on the POS.
//   CANCELLED / REJECTED   → "Sorry, {storeName} has cancelled your
//                            order" with the reason the staff entered
//                            (when there is one).
//
// All driven off /v1/ordering/orders/:orderId/status — public, no auth.

type StatusPayload = {
  id: string;
  status: string;
  fulfillmentType: string;
  orderNumber?: number | null;
  displayId?: string | null;
  receivedAt: string;
  acceptedAt?: string | null;
  preparingAt?: string | null;
  readyAt?: string | null;
  outForDeliveryAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  estimatedReadyAt?: string | null;
  location?: { name?: string } | null;
};

function OrderConfirmed({
  orderId,
  storeName,
  onReset,
  storeSlug,
  brandId,
}: {
  orderId: string;
  storeName: string;
  onReset: () => void;
  storeSlug: string;
  // Phase AW — passed through so the "Back to menu" anchor in
  // AcceptedScreen rebuilds the URL with ?brand=<id>; without it the
  // anchor falls back to the location's default storefront.
  brandId: string | null;
}) {
  // Poll every 3s. Stop polling once the order reaches a terminal state
  // (delivered / collected / cancelled / rejected) — no point hammering
  // the API after that.
  const statusQuery = useQuery({
    queryKey: ["ordering", "order-status", orderId],
    queryFn: () =>
      axios
        .get<StatusPayload>(
          `${API_BASE}/v1/ordering/orders/${orderId}/status`,
        )
        .then((r) => r.data),
    refetchInterval: (q) => {
      const s = (q.state.data as StatusPayload | undefined)?.status;
      const terminal = ["COMPLETED", "CANCELLED", "REJECTED", "FAILED"];
      return s && terminal.includes(s) ? false : 3000;
    },
  });

  const data = statusQuery.data;
  const status = data?.status ?? "PENDING";
  const cancelled = ["CANCELLED", "REJECTED", "FAILED"].includes(status);
  const accepted = !cancelled && status !== "PENDING";

  if (cancelled) {
    return (
      <CancelledScreen
        storeName={data?.location?.name ?? storeName}
        reason={data?.cancelReason ?? null}
        onReset={onReset}
      />
    );
  }

  if (!accepted) {
    return <PendingScreen storeName={storeName} onReset={onReset} />;
  }

  return (
    <AcceptedScreen
      data={data!}
      storeName={storeName}
      onReset={onReset}
      storeSlug={storeSlug}
      brandId={brandId}
    />
  );
}

function PendingScreen({
  storeName,
  onReset,
}: {
  storeName: string;
  onReset: () => void;
}) {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center">
      {/* Sand-timer animation: the icon itself flips between two states
          via CSS keyframes (defined in globals.css fallback below) so
          the user sees something moving even on a slow connection. */}
      <div className="relative mb-6">
        {/* Inline keyframes — keeps this self-contained without
            touching tailwind.config / globals.css. */}
        <style>{`
          @keyframes flip-clock {
            0%   { transform: rotate(0deg);   }
            45%  { transform: rotate(0deg);   }
            50%  { transform: rotate(180deg); }
            95%  { transform: rotate(180deg); }
            100% { transform: rotate(360deg); }
          }
          .animate-flip { animation: flip-clock 3s ease-in-out infinite; transform-origin: 50% 50%; }
        `}</style>
        <div className="h-24 w-24 rounded-full bg-orange-50 grid place-items-center animate-pulse">
          <Hourglass className="h-12 w-12 text-orange-500 animate-flip" />
        </div>
      </div>
      <h1 className="text-2xl font-bold text-zinc-900 mb-2">
        Processing your order…
      </h1>
      <p className="max-w-sm text-sm text-zinc-500 mb-8">
        Please wait while <span className="font-semibold">{storeName}</span>{" "}
        confirms your order. This usually takes a minute or two.
      </p>
      <p className="text-[11px] text-zinc-400">
        You can leave this page open — we&apos;ll update it as soon as the
        restaurant responds.
      </p>
      <button
        onClick={onReset}
        className="mt-8 text-xs text-zinc-400 underline hover:text-zinc-600"
      >
        Cancel and go back
      </button>
    </div>
  );
}

function CancelledScreen({
  storeName,
  reason,
  onReset,
}: {
  storeName: string;
  reason: string | null;
  onReset: () => void;
}) {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center">
      <div className="h-20 w-20 rounded-full bg-red-50 grid place-items-center mb-6">
        <X className="h-10 w-10 text-red-500" />
      </div>
      <h1 className="text-2xl font-bold text-zinc-900 mb-2">
        Sorry, {storeName} has cancelled your order
      </h1>
      {reason ? (
        <div className="max-w-sm rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 mb-6">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-red-600 mb-1">
            Reason
          </p>
          {reason}
        </div>
      ) : (
        <p className="max-w-sm text-sm text-zinc-500 mb-6">
          No reason was provided. Please contact the restaurant for more
          details.
        </p>
      )}
      <p className="text-xs text-zinc-400 mb-8">
        You have not been charged.
      </p>
      <button
        onClick={onReset}
        className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600"
      >
        Back to menu
      </button>
    </div>
  );
}

function AcceptedScreen({
  data,
  storeName,
  onReset,
  storeSlug,
  brandId,
}: {
  data: StatusPayload;
  storeName: string;
  onReset: () => void;
  /** Phase AP-5 — used by the "Back to menu" link to navigate without
   *  resetting the order-tracking state. */
  storeSlug: string;
  /** Phase AW — when the storefront was brand-pinned, keep the pin on
   *  the Back-to-menu anchor so the customer lands back on the brand
   *  storefront, not the location default. */
  brandId: string | null;
}) {
  const isDelivery = data.fulfillmentType === "DELIVERY";
  // Steps in order. Each step is "done" once its timestamp fires.
  const steps: Array<{ key: string; label: string; at: string | null | undefined }> = [
    { key: "RECEIVED", label: "Order received", at: data.receivedAt },
    { key: "ACCEPTED", label: "Confirmed by restaurant", at: data.acceptedAt },
    { key: "PREPARING", label: "Preparing your food", at: data.preparingAt },
    { key: "READY", label: isDelivery ? "Ready for driver" : "Ready to collect", at: data.readyAt },
    ...(isDelivery
      ? [
          {
            key: "OUT_FOR_DELIVERY",
            label: "Out for delivery",
            at: data.outForDeliveryAt,
          },
          { key: "DELIVERED", label: "Delivered", at: data.deliveredAt },
        ]
      : [{ key: "COLLECTED", label: "Collected", at: data.deliveredAt }]),
  ];
  const orderRef = data.orderNumber
    ? `#${data.orderNumber}`
    : data.displayId
      ? `#${data.displayId}`
      : `#${data.id.slice(-6).toUpperCase()}`;
  const completed = data.status === "COMPLETED";

  return (
    <div className="min-h-screen bg-white flex flex-col items-center px-6 py-12">
      <div className="w-full max-w-md text-center">
        <div className="h-20 w-20 mx-auto rounded-full bg-emerald-100 grid place-items-center mb-6">
          <CheckCircle className="h-10 w-10 text-emerald-500" />
        </div>
        <h1 className="text-2xl font-bold text-zinc-900 mb-1">
          {completed
            ? isDelivery
              ? "Order delivered!"
              : "Order collected!"
            : "Your order has been accepted"}
        </h1>
        <p className="text-sm text-zinc-500 mb-6">
          {storeName} is on it. Track your order below — this page updates
          automatically as your order progresses.
        </p>
        <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-2 mb-8">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Order number
          </span>
          <span className="font-mono text-lg font-bold text-zinc-900">
            {orderRef}
          </span>
        </div>
        {data.estimatedReadyAt && !completed && (
          <p className="mb-8 text-xs text-zinc-500">
            Est. ready by{" "}
            <span className="font-semibold text-zinc-700">
              {new Date(data.estimatedReadyAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </p>
        )}

        {/* Vertical timeline — each step lights up as the POS marks it. */}
        <ol className="text-left">
          {steps.map((s, i) => {
            const done = !!s.at;
            const isLast = i === steps.length - 1;
            // Mark the most-recent done step as "active" so the
            // customer can see at a glance where their order is.
            const isActive =
              done &&
              (i === steps.length - 1 || !steps[i + 1]?.at);
            return (
              <li key={s.key} className="relative flex items-start gap-3 pb-5">
                {!isLast && (
                  <span
                    className={`absolute left-[11px] top-6 h-full w-0.5 ${
                      done ? "bg-emerald-300" : "bg-zinc-200"
                    }`}
                  />
                )}
                <span
                  className={`relative grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold ${
                    done
                      ? isActive
                        ? "bg-emerald-500 text-white ring-4 ring-emerald-100"
                        : "bg-emerald-500 text-white"
                      : "bg-zinc-200 text-zinc-400"
                  }`}
                >
                  {done ? "✓" : i + 1}
                </span>
                <div className="flex-1 min-w-0 pt-0.5">
                  <p
                    className={`text-sm ${
                      done ? "font-semibold text-zinc-900" : "text-zinc-400"
                    }`}
                  >
                    {s.label}
                  </p>
                  {s.at && (
                    <p className="mt-0.5 text-[11px] text-zinc-400">
                      {new Date(s.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={onReset}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600"
          >
            Order again
          </button>
          {/* Phase AP-5 follow-up — explicit way out of the tracking
              screen back to the menu. Without this customers were stuck
              on the tracker until the order completed; many wanted to
              keep browsing or place a second order while the first
              cooked. Same handler as Order again would reset the page
              entirely; this just navigates back without touching the
              cart, which is what most customers expect. */}
          <a
            href={
              brandId
                ? `/order/${storeSlug}?brand=${encodeURIComponent(brandId)}`
                : `/order/${storeSlug}`
            }
            className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Back to menu
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Info modal (Phase AP) ──────────────────────────────────────────────────
//
// Surfaced from the Info chip on the restaurant header. Renders three
// sections matching the Just Eat / Uber Eats info sheet the operator
// shared as a reference:
//
//   • A little bit about us — location.about
//   • Delivery times — 7-day opening-hours table (Phase AN map shape)
//   • Delivery fee — every configured delivery zone with its prefix and
//     fee. When no zones are configured we just say "Manual fee — call
//     the restaurant" so the customer doesn't assume free delivery.

function InfoModal({
  locationName,
  about,
  address,
  openingHours,
  deliveryZones,
  isOpenNow,
  onClose,
}: {
  locationName: string;
  about: string | null;
  address: string | null;
  openingHours: any;
  deliveryZones: Array<{
    postcodePrefix: string;
    fee: string | number;
    minOrderValue: string | number | null;
  }>;
  isOpenNow: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="text-base font-bold text-zinc-900">About</h2>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-6 overflow-y-auto p-4">
          {/* About */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-zinc-500" />
              <h3 className="text-sm font-bold text-zinc-900">A little bit about us</h3>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 leading-relaxed">
              {about?.trim() ? (
                <p>{about}</p>
              ) : (
                <p className="text-zinc-500">
                  {locationName} hasn&apos;t added a description yet.
                </p>
              )}
              {address && (
                <p className="mt-2 flex items-center gap-1 text-xs text-zinc-500">
                  <MapPin className="h-3 w-3" /> {address}
                </p>
              )}
            </div>
          </section>

          {/* Delivery times */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <Clock className="h-4 w-4 text-zinc-500" />
              <h3 className="text-sm font-bold text-zinc-900">Delivery times</h3>
              <span
                className={cn(
                  "ml-auto text-[10px] font-semibold uppercase tracking-wider",
                  isOpenNow ? "text-emerald-600" : "text-red-600",
                )}
              >
                {isOpenNow ? "Open" : "Closed"}
              </span>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm">
              <OpeningHoursTable openingHours={openingHours} />
            </div>
          </section>

          {/* Delivery fees */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <Receipt className="h-4 w-4 text-zinc-500" />
              <h3 className="text-sm font-bold text-zinc-900">Delivery fee</h3>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm">
              {deliveryZones.length === 0 ? (
                <p className="text-zinc-600">
                  Delivery fee depends on your postcode — enter it in the cart
                  to see the price.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {deliveryZones.map((z) => {
                    const fee = Number(z.fee);
                    const min =
                      z.minOrderValue != null ? Number(z.minOrderValue) : null;
                    return (
                      <li
                        key={z.postcodePrefix}
                        className="flex items-center justify-between gap-3 border-b border-zinc-200 pb-1.5 last:border-0 last:pb-0"
                      >
                        <span className="font-mono text-xs text-zinc-700">
                          {z.postcodePrefix}
                        </span>
                        <span className="text-right">
                          <span className="text-sm font-semibold text-zinc-900">
                            {fee > 0 ? `£${fee.toFixed(2)}` : "Free"}
                          </span>
                          {min ? (
                            <span className="block text-[10px] text-zinc-500">
                              min £{min.toFixed(2)}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// 7-day opening hours table. Reads the Phase AN map shape; falls back
// to a "Hours not set" message when the location hasn't configured them.
const INFO_DAYS: Array<[string, string]> = [
  ["monday", "Monday"],
  ["tuesday", "Tuesday"],
  ["wednesday", "Wednesday"],
  ["thursday", "Thursday"],
  ["friday", "Friday"],
  ["saturday", "Saturday"],
  ["sunday", "Sunday"],
];

function OpeningHoursTable({ openingHours }: { openingHours: any }) {
  if (!openingHours || Array.isArray(openingHours)) {
    return (
      <p className="text-zinc-500 text-xs">
        Hours not set — call the restaurant to confirm.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {INFO_DAYS.map(([key, label]) => {
        const day = openingHours[key];
        const closed = !day?.enabled || !Array.isArray(day.slots) || day.slots.length === 0;
        const summary = closed
          ? "Closed"
          : day.slots
              .map((s: any) => `${s.from ?? "??"} – ${s.to ?? "??"}`)
              .join(", ");
        return (
          <li key={key} className="flex items-center justify-between">
            <span className="text-zinc-700">{label}</span>
            <span className={cn(closed ? "text-zinc-400" : "text-zinc-900 font-medium")}>
              {summary}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
