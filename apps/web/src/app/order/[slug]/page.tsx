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

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useReducer,
} from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { LoginModal } from "@/components/storefront/login-modal";
import { FoodPlaceholder } from "@/components/storefront/food-placeholder";
import {
  RatingPill,
  StorefrontReviews,
} from "@/components/storefront/storefront-reviews";
import { HeaderAuthButton } from "@/components/storefront/header-auth-button";
import { useCustomerAuth } from "@/hooks/use-customer-auth";
import {
  ShoppingBag,
  CalendarDays,
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
  Phone,
  Users,
} from "lucide-react";
import { GroupBasketPanel } from "@/components/storefront/group-basket-panel";
import { StartGroupOrderModal } from "@/components/storefront/start-group-order-modal";
import { AddressSearchField } from "@/components/storefront/address-search-field";
import { PwaManifestLink } from "@/components/storefront/pwa-manifest-link";
import { OrderNotifications } from "@/components/order/order-notifications";
import {
  getGuestName,
  getGuestRef,
  groupOrdersClient,
  setGuestName,
  type GroupOrderView,
} from "@/lib/api/group-orders.client";
import { publicReservationsClient } from "@/lib/api/reservations.client";
import { cn } from "@/lib/utils";
import { DeliveryTrackingMap } from "@/components/order/delivery-tracking-map";
import { CustomerDriverChat } from "@/components/order/customer-driver-chat";
import {
  ModifierSelectionModal,
} from "@/components/pos/modifier-selection-modal";
import type {
  MenuItem,
  MenuCategory,
} from "@/lib/api/menus.client";
import { round2 } from "@orderhub/shared";
import { displayPrice } from "@/lib/menu/display-price";
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
    showItemImages?: boolean;
  };
  deliveryZones?: Array<{
    postcodePrefix: string;
    fee: string | number;
    minOrderValue: string | number | null;
  }>;
  // Only present when WhatsApp ordering is configured AND live for this
  // location. Drives the "Order on WhatsApp" button. displayPhoneNumber is
  // E.164 (e.g. "+447…"); build the wa.me link by stripping non-digits.
  whatsapp?: {
    enabled: boolean;
    displayPhoneNumber?: string;
  } | null;
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
  | { type: "SET"; lines: CartLine[] }
  | { type: "CLEAR" };

function cartReducer(state: CartLine[], action: CartAction): CartLine[] {
  switch (action.type) {
    // Replace the whole cart — used to hydrate a saved basket from
    // localStorage on mount so a refresh/login doesn't lose it.
    case "SET":
      return action.lines;
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

export default function OrderPageRoute() {
  // useSearchParams must be inside a Suspense boundary so Next.js
  // can statically prerender the shell — see google-callback for
  // the same pattern.
  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center text-zinc-400" />}>
      <OrderPage />
    </Suspense>
  );
}

// WhatsApp glyph — lucide dropped brand icons, so inline the official
// logo path. Inherits color via currentColor (white on the green button).
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.002-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

function OrderPage() {
  const { slug } = useParams<{ slug: string }>();
  // Phase AW — brand context. /brand/<slug> redirects here with
  // ?brand=<id>; we forward that to the API so the storefront returns
  // the brand's identity (name, logo, address, about, Stripe Connect)
  // instead of the underlying physical location's. Read once at mount
  // so the React Query key stays stable across renders.
  // Phase AW-30 follow-up — Next.js `router.replace` from the brand
  // route is async; reading window.location.search via useMemo([]) at
  // mount races the URL update, so the first storefront fetch went
  // out with brandId=null and rendered the underlying location's
  // identity for a beat before the second fetch corrected it. The
  // reactive useSearchParams hook gives us the always-current value
  // — no flicker, no double-fetch from stale state.
  const searchParams = useSearchParams();
  const brandId = searchParams?.get("brand") ?? null;
  // Group ordering — ?group=<token> puts this whole page in group mode: the
  // menu, modifier sheet and product cards work exactly as they do normally,
  // but an "Add" lands in the shared basket instead of the local cart. The
  // token comes from the share link (via the join page), never from state, so
  // a refresh or a returning tab picks the same basket back up.
  const groupToken = searchParams?.get("group") ?? null;
  const router = useRouter();
  const queryClient = useQueryClient();
  const [cart, dispatch] = useReducer(cartReducer, []);
  const [cartOpen, setCartOpen] = useState(false);

  // Persist the basket per storefront (slug + brand) so a page refresh, a
  // login / Google-OAuth redirect, or closing and reopening the browser
  // keeps the customer's cart. Hydrate once on mount; save on every change
  // after. Keyed by brand so a multi-brand kitchen doesn't mix baskets.
  const cartKey = `orderhub.cart.${slug}${brandId ? `:${brandId}` : ""}`;
  // WHICH key we've hydrated, not merely whether we have. The key contains
  // the brand, so it changes when ?brand= arrives or switches — and a plain
  // boolean stayed true across that change, letting the save effect below
  // fire against the NEW key while `cart` was still the old empty state. That
  // deleted a perfectly good saved basket a beat before hydration could read
  // it. Comparing keys means we only ever write to a key we've read first.
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(cartKey);
      if (raw) {
        const lines = JSON.parse(raw);
        if (Array.isArray(lines) && lines.length > 0) {
          dispatch({ type: "SET", lines });
        }
      }
    } catch {
      /* corrupt / unavailable storage — start empty */
    }
    setHydratedKey(cartKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey]);
  useEffect(() => {
    // Only write to the key we have actually read. Skipping the
    // pre-hydration commit isn't enough on its own: the key itself changes
    // when the brand does, and writing an empty cart to a key we haven't
    // hydrated yet is how a saved basket disappears.
    if (typeof window === "undefined" || hydratedKey !== cartKey) return;
    try {
      if (cart.length > 0) {
        window.localStorage.setItem(cartKey, JSON.stringify(cart));
      } else {
        window.localStorage.removeItem(cartKey);
      }
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [cart, cartKey, hydratedKey]);

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
  // "Keep me updated by SMS" — ticked by default, customer can opt out.
  const [smsMarketingConsent, setSmsMarketingConsent] = useState(true);
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

  // Does this location take table bookings from the web? Drives the
  // "Book a table" button. Fetched separately (and only once the store
  // is resolved) so a shop with reservations off pays nothing for it,
  // and a failure here can never stop the menu rendering.
  const reservationsQuery = useQuery({
    queryKey: ["storefront-reservations", storefront?.location?.id],
    queryFn: () => publicReservationsClient.settings(storefront!.location.id),
    enabled: !!storefront?.location?.id,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const reservationSettings = reservationsQuery.data;

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

  // unitPrice ALREADY includes the modifiers — calculateCartItem() returns
  // basePrice + sum(modifiers), and that is what the modal shows as its
  // total. Adding them again here charged every option twice: a 12"
  // stuffed-crust Toscana rang up at £16.10 instead of £12.00.
  const subtotal = round2(
    cart.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0),
  );
  // Phase AP fix #1 — promo code: FREE_DELIVERY zeroes the fee,
  // FIXED/PERCENTAGE produce a discountAmount that comes off subtotal.
  const promoDiscount = promoApplied?.discountAmount ?? 0;
  // Phase AW-19 — FREE_DELIVERY campaign matches the brand+audience
  // server-side. When present, delivery fee is forced to 0 here and
  // the checkout endpoint re-enforces it so a tampered cart can't
  // charge anyway.
  const freeDeliveryCampaign:
    | { campaignId: string; campaignName: string }
    | null = (storefront as any)?.freeDelivery ?? null;
  const freeDelivery =
    promoApplied?.freeDelivery === true || !!freeDeliveryCampaign;
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
    // Campaign freebies mirror the LOCAL cart, which group mode doesn't use —
    // and the group place path doesn't re-resolve campaigns server-side, so a
    // freebie added here would be a promise the order never keeps.
    if (!bogo || groupToken) return;
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
  }, [cart, bogo, bogoTriggerSet, groupToken]);

  // Phase AW-19 — eligible spend for FREE_ITEM unlock = subtotal of
  // all paid lines whose item category is NOT in the exclusion set.
  // Free lines (BOGO mirrors, free-item gifts) are skipped so they
  // can't bootstrap their own threshold.
  const eligibleSubtotal = useMemo(() => {
    if (!freeItem) return 0;
    return cart.reduce((sum, l) => {
      if (l.unitPrice === 0) return sum;
      if (excludedItemIdSet.has(l.menuItemId)) return sum;
      // Same rule as the subtotal: unitPrice is already modifier-inclusive,
      // so double-adding here would unlock the freebie early.
      return sum + l.unitPrice * l.quantity;
    }, 0);
  }, [cart, freeItem, excludedItemIdSet]);
  // Gift line auto-management: when eligible and a chosen freebie
  // is set, add it at £0; when no longer eligible OR the choice
  // changes, remove the existing gift first. Marker = freeItemOf
  // on the cart line.
  useEffect(() => {
    if (!freeItem || groupToken) return; // see the BOGO effect above
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
  }, [cart, freeItem, eligibleSubtotal, chosenFreeItemId, itemsById, groupToken]);
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

  // The two rails above the menu.
  //
  // Top sellers come already resolved and ordered from the API — it filters
  // the operator's picks against the live menu, so anything pulled or 86'd is
  // gone before it reaches us. Promotions are derived here instead, from the
  // campaign map the page already computes, so the rail and the per-item
  // badges can never disagree about what's discounted.
  const topSellers: MenuItem[] = useMemo(
    () => ((storefront as any)?.topSellers ?? []) as MenuItem[],
    [storefront],
  );
  const promoItems: MenuItem[] = useMemo(() => {
    const seen = new Set<string>();
    const out: MenuItem[] = [];
    for (const cat of allCategories) {
      for (const link of (cat as any).items ?? []) {
        const item = link?.item as MenuItem | undefined;
        if (!item?.id || seen.has(item.id)) continue;
        if (!itemPromos[item.id]) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [allCategories, itemPromos]);

  // Inline quantity control on the menu row.
  //
  // Only for items with nothing to choose — no modifier groups and no sizes.
  // For those, opening a modal to press one button is friction, and the
  // customer can't otherwise see how many they've already added without
  // opening the cart. Anything configurable still opens the sheet, because a
  // second "Large, no onions" is not the same line as the first.
  const isSimpleItem = useCallback(
    (item: MenuItem) =>
      !(item.modifierGroupLinks?.length ?? 0) && !(item as any).hasMultipleSkus,
    [],
  );
  // The plain line for an item: same item, no modifiers, no note. A line
  // customised in the sheet must never be stepped by the row.
  const plainLineFor = useCallback(
    (itemId: string) =>
      cart.find(
        (l) =>
          l.menuItemId === itemId &&
          (l.modifiers?.length ?? 0) === 0 &&
          !l.notes,
      ) ?? null,
    [cart],
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

  // ── Group ordering ───────────────────────────────────────────────────────
  //
  // One shared basket, several people, one order at the end. The local cart is
  // left alone while group mode is on: adds go straight to the API so everyone
  // sees them, which is the entire point.

  const [groupRef, setGroupRef] = useState("");
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [startGroupOpen, setStartGroupOpen] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [removingGroupItemId, setRemovingGroupItemId] = useState<string | null>(
    null,
  );
  // localStorage is client-only, so the ref can't be read during render.
  useEffect(() => setGroupRef(getGuestRef()), []);

  const groupKey = ["group-order", groupToken, groupRef] as const;
  const groupQuery = useQuery<GroupOrderView>({
    queryKey: groupKey,
    queryFn: () => groupOrdersClient.get(String(groupToken), groupRef),
    enabled: !!groupToken && !!groupRef,
    // Someone else adding chips has to show up without a refresh. Guests have
    // no account, so there is no socket room for them to join — a five-second
    // poll is the honest way to keep a shared basket live.
    refetchInterval: 5_000,
    retry: false,
  });
  const basket = groupQuery.data ?? null;
  const groupMode = !!groupToken;
  const groupOpen = basket?.status === "OPEN";
  const groupCount = basket?.items.reduce((s, i) => s + i.quantity, 0) ?? 0;

  // Delivery vs collection is the host's call, made before anyone joined,
  // because it decides the fees the group is sharing. Mirror it into the
  // page's own state so prep times, the delivery-zone match and the pills all
  // agree with the basket.
  const groupFulfillment = basket?.fulfillmentType;
  useEffect(() => {
    if (!groupFulfillment) return;
    const next = groupFulfillment === "DELIVERY" ? "DELIVERY" : "PICKUP";
    setFulfillmentType((cur) => (cur === next ? cur : next));
  }, [groupFulfillment]);

  const groupErrorFrom = (err: unknown, fallback: string) =>
    ((err as any)?.response?.data?.message as string) ?? fallback;

  const applyBasket = (view: GroupOrderView) => {
    queryClient.setQueryData(groupKey, view);
    setGroupError(null);
  };

  const startGroup = useMutation({
    mutationFn: (vars: { name: string; fulfillmentType: "DELIVERY" | "PICKUP" }) =>
      groupOrdersClient.create({
        locationId: storefront!.location.id,
        brandId: brandId ?? undefined,
        hostName: vars.name,
        hostRef: groupRef,
        fulfillmentType: vars.fulfillmentType,
      }),
    onSuccess: (view, vars) => {
      setGuestName(vars.name);
      setStartGroupOpen(false);
      // Put the token in the URL rather than in state: the host can now
      // refresh, or come back tomorrow, and still be in the same basket.
      router.replace(
        `/order/${slug}?group=${encodeURIComponent(view.token)}${
          brandId ? `&brand=${encodeURIComponent(brandId)}` : ""
        }`,
      );
      queryClient.setQueryData(["group-order", view.token, groupRef], view);
      setGroupPanelOpen(true);
    },
  });

  const addToGroup = useMutation({
    mutationFn: (line: Omit<CartLine, "id">) => {
      const name = getGuestName();
      // No name yet (a link opened straight into the menu, or a cleared
      // browser): the join page is where that gets asked for.
      if (!name) {
        router.push(`/order/${slug}/group/${groupToken}`);
        return Promise.reject(new Error("NO_NAME"));
      }
      return groupOrdersClient.addItem(String(groupToken), {
        addedByName: name,
        addedByRef: groupRef,
        cartItem: {
          name: line.displayName,
          unitPrice: line.unitPrice,
          menuItemId: line.menuItemId,
          notes: line.notes || undefined,
          // Same shape the ordinary checkout sends: name + price only.
          modifiers: line.modifiers.map((m) => ({
            name: m.name,
            price: m.price,
          })),
        },
        quantity: line.quantity,
        // unitPrice is already modifier-inclusive — the same rule the local
        // cart's subtotal follows. Adding modifiers again here would charge
        // every option twice.
        lineTotal: round2(line.unitPrice * line.quantity),
      });
    },
    onSuccess: (view) => applyBasket(view),
    onError: (err) => {
      if ((err as Error)?.message === "NO_NAME") return;
      setGroupError(groupErrorFrom(err, "Couldn't add that to the basket."));
    },
  });

  const removeFromGroup = useMutation({
    mutationFn: (itemId: string) => {
      setRemovingGroupItemId(itemId);
      return groupOrdersClient.removeItem(String(groupToken), itemId, groupRef);
    },
    onSuccess: (view) => applyBasket(view),
    onError: (err) =>
      setGroupError(groupErrorFrom(err, "Couldn't remove that item.")),
    onSettled: () => setRemovingGroupItemId(null),
  });

  const lockGroup = useMutation({
    mutationFn: (next: "lock" | "unlock") =>
      next === "lock"
        ? groupOrdersClient.lock(String(groupToken), groupRef)
        : groupOrdersClient.unlock(String(groupToken), groupRef),
    onSuccess: (view) => applyBasket(view),
    onError: (err) =>
      setGroupError(groupErrorFrom(err, "Couldn't close the basket.")),
  });

  const placeGroup = useMutation({
    mutationFn: () =>
      groupOrdersClient.place(String(groupToken), {
        hostRef: groupRef,
        customerInfo: {
          name: customerName,
          phone: customerPhone || undefined,
          email: customerEmail || undefined,
        },
        deliveryAddress:
          basket?.fulfillmentType === "DELIVERY"
            ? {
                line1: addrLine1,
                line2: addrFlat || undefined,
                city: addrCity,
                postcode: addrPostcode,
                country: "GB",
              }
            : undefined,
        deliveryFee:
          basket?.fulfillmentType === "DELIVERY" ? deliveryFee : 0,
        specialInstructions: notes || undefined,
        paymentMethod,
        // Stable per basket: a double-tap on Place order can't become two
        // orders, and neither can a retry after a dropped connection.
        idempotencyKey: `group-${groupToken}`,
      }),
    onSuccess: (order) => {
      if (order?.checkoutUrl && typeof window !== "undefined") {
        window.location.href = order.checkoutUrl;
        return;
      }
      setGroupPanelOpen(false);
      setConfirmedOrderId(order.id);
      // Drop ?group= so the tracking screen — and a refresh of it — isn't
      // still pointed at a basket that has already become an order.
      if (typeof window !== "undefined") {
        window.history.replaceState(
          {},
          "",
          `${window.location.pathname}${brandId ? `?brand=${brandId}` : ""}`,
        );
      }
    },
    onError: (err) =>
      setGroupError(groupErrorFrom(err, "Couldn't place the group order.")),
  });

  const cancelGroup = useMutation({
    mutationFn: () => groupOrdersClient.cancel(String(groupToken), groupRef),
    onSuccess: () => {
      setGroupPanelOpen(false);
      router.replace(`/order/${slug}${brandId ? `?brand=${brandId}` : ""}`);
    },
    onError: (err) =>
      setGroupError(groupErrorFrom(err, "Couldn't cancel the group order.")),
  });

  /**
   * The single door into a basket. Everything that adds an item — a tap on a
   * simple product, or the modifier sheet's Add — goes through here, so group
   * mode can never be half-applied.
   */
  const addLine = (line: Omit<CartLine, "id">) => {
    if (groupMode) {
      // A closed, placed or expired basket takes nothing more. Refuse here
      // rather than round-tripping to a 400 the customer would only see if
      // they thought to open the basket panel.
      if (basket && basket.status !== "OPEN") {
        setGroupError(
          basket.status === "LOCKED"
            ? `${basket.hostName ?? "The host"} has closed the basket — nothing else can be added.`
            : "This group order is closed. Start your own order to keep going.",
        );
        return;
      }
      addToGroup.mutate(line);
      return;
    }
    dispatch({ type: "ADD", line });
  };

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
        // "Keep me updated by SMS" checkbox → SMS-marketing consent.
        marketingConsent: smsMarketingConsent,
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
        //
        // Delete from storage SYNCHRONOUSLY, not just via dispatch: the
        // navigation on the next line leaves before React re-renders, so the
        // effect that mirrors an empty cart into localStorage never runs. The
        // basket therefore survived the whole payment and was still sitting
        // there next time the customer opened the site — the "it remembers my
        // last order" complaint.
        try {
          window.localStorage.removeItem(cartKey);
        } catch {
          /* private mode — the dispatch below still clears the UI */
        }
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

  // Brand logo wins over the location logo — the storefront is a BRAND's
  // customer-facing identity (a kitchen running several brands shows each
  // brand's own logo, uploaded in Brands → Settings), and receipts already
  // resolve brand-first. Location logo is only a fallback for a brand that
  // never set its own.
  const logoUrl = storefront.brand.logoUrl ?? storefront.location.logoUrl ?? null;
  const headerTitle = storefront.location.name || storefront.brand.name;
  const acceptDelivery = cfg?.acceptsDelivery ?? true;
  const acceptCollection = cfg?.acceptsCollection ?? true;

  // "Order on WhatsApp" — only when the location has WhatsApp configured +
  // live (the API returns `whatsapp` only then). wa.me needs the number
  // with no "+"/spaces; prefill a friendly opener with the store name.
  const waDigits =
    storefront.whatsapp?.enabled && storefront.whatsapp.displayPhoneNumber
      ? storefront.whatsapp.displayPhoneNumber.replace(/\D/g, "")
      : "";
  const whatsappHref = waDigits
    ? `https://wa.me/${waDigits}?text=${encodeURIComponent(
        `Hi ${headerTitle}, I'd like to place an order.`,
      )}`
    : null;

  // "Book a table" — only for locations running table service AND taking
  // bookings online. Both flags come from the public settings endpoint,
  // so a shop that hasn't switched reservations on never sees the button
  // (and a guest who guesses the URL still gets turned away server-side).
  const bookingHref = reservationSettings?.tableServiceEnabled &&
    reservationSettings?.onlineEnabled
    ? `/book/${storefront.location.id}`
    : null;

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Phase AX — makes this storefront installable as the restaurant's own
          app, and on iOS is what unlocks Web Push at all. Renders nothing. */}
      <PwaManifestLink
        slug={slug}
        brandId={brandId}
        name={headerTitle}
        logoUrl={logoUrl}
      />
      {/* Top nav */}
      <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex shrink-0 items-center gap-2">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                className="h-9 w-9 shrink-0 rounded-md bg-white object-contain p-1"
              />
            ) : (
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-orange-500 text-sm font-bold text-white">
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
            {/* Order on WhatsApp — shown only when this location has
                WhatsApp ordering configured and live. Opens the store's
                WhatsApp chat with a prefilled opener. */}
            {whatsappHref && (
              <a
                href={whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                title="Try WhatsApp AI ordering"
                aria-label="Try WhatsApp AI ordering"
                className="oh-ai-glow inline-flex shrink-0 items-center gap-1 rounded-full bg-[#25D366] px-2.5 py-2 text-xs font-semibold text-white hover:bg-[#1ebe5d] sm:gap-1.5 sm:rounded-md sm:px-3 sm:text-sm"
              >
                <WhatsAppIcon className="h-4 w-4 shrink-0" />
                <span className="whitespace-nowrap sm:hidden">WhatsApp AI</span>
                <span className="hidden whitespace-nowrap sm:inline">
                  Try WhatsApp AI ordering
                </span>
              </a>
            )}
            {/* Book a table — sits next to Cart because booking and
                ordering are the two things a diner comes here to do.
                Outline, not solid, so it never competes with Cart. */}
            {bookingHref && (
              <a
                href={bookingHref}
                title="Book a table"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-xs font-semibold text-zinc-800 hover:border-zinc-400 hover:bg-zinc-50 sm:px-3 sm:text-sm"
              >
                <CalendarDays className="h-4 w-4 shrink-0" />
                {/* One span, not two — a second element would inherit the
                    flex gap on top of the word space and render
                    "Book  a table". */}
                <span className="whitespace-nowrap">
                  Book<span className="hidden sm:inline"> a table</span>
                </span>
              </a>
            )}
            <HeaderAuthButton
              customer={authCustomer ?? null}
              onSignInClick={() => setLoginOpen(true)}
              onLogout={logoutCustomer}
              myOrdersHref={`/order/${slug}/my-orders${brandId ? `?brand=${brandId}` : ""}`}
            />
            {/* In group mode the personal cart isn't the basket that
                matters, so the pill opens the shared one instead. */}
            {groupMode ? (
              <button
                onClick={() => setGroupPanelOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600"
              >
                <Users className="h-4 w-4" /> Group
                {groupCount > 0 && (
                  <span className="ml-1 rounded-full bg-white px-1.5 text-[10px] font-bold text-orange-600">
                    {groupCount}
                  </span>
                )}
              </button>
            ) : (
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
            )}
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
                className="h-24 w-24 shrink-0 rounded-lg bg-white object-contain p-1.5 ring-2 ring-white shadow sm:h-28 sm:w-28"
              />
            ) : (
              <div className="grid h-24 w-24 shrink-0 place-items-center rounded-lg bg-orange-500 text-3xl font-bold text-white ring-2 ring-white shadow sm:h-28 sm:w-28">
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
                {/* Your own rating, from your own customers — the reason we
                    stopped sending people to Google. Renders nothing until a
                    shop actually has reviews. */}
                <RatingPill
                  brandId={brandId ?? undefined}
                  locationId={storefront?.location?.id}
                  onClick={() =>
                    document
                      .getElementById("reviews")
                      ?.scrollIntoView({ behavior: "smooth" })
                  }
                />
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
                // Fixed by the host in group mode — it decides the fees the
                // whole group is sharing, so it can't move once people have
                // started adding.
                onClick={() => !groupMode && setFulfillmentType("DELIVERY")}
                icon={<Bike className="h-4 w-4" />}
                label="Delivery"
                sub={`${cfg?.deliveryPrepMinutes ?? 45} mins`}
              />
            )}
            {acceptCollection && (
              <FulfillmentPill
                active={fulfillmentType === "PICKUP"}
                onClick={() => !groupMode && setFulfillmentType("PICKUP")}
                icon={<ShoppingBag className="h-4 w-4" />}
                label="Pickup"
                sub={`${cfg?.collectionPrepMinutes ?? 20} mins`}
              />
            )}
            {!groupMode && (
              <button
                onClick={() => setScheduleOpen(true)}
                className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-300"
              >
                <Clock className="h-4 w-4" />
                {scheduledFor
                  ? `Scheduled ${formatScheduledFor(scheduledFor)}`
                  : "Schedule"}
              </button>
            )}

            {/* Order together — one basket, several people, one order. Sits
                with the fulfillment pills because "who's eating" is the same
                kind of decision as "how does it get here". Hidden while the
                shop is paused, like every other way into a basket. */}
            {!groupMode && !storefront.closed && (
              <button
                onClick={() => setStartGroupOpen(true)}
                className="inline-flex items-center gap-2 rounded-full border border-orange-300 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-700 hover:border-orange-400 hover:bg-orange-100"
              >
                <Users className="h-4 w-4" />
                Order together
              </button>
            )}

            {/* Eating in? Sits with Delivery/Pickup because "how do I
                want to be served" is the same question — but styled as a
                link, not a fulfillment pill, since it leaves the menu. */}
            {bookingHref && (
              <a
                href={bookingHref}
                className="inline-flex items-center gap-2 rounded-full border border-orange-300 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-700 hover:border-orange-400 hover:bg-orange-100"
              >
                <CalendarDays className="h-4 w-4" />
                Book a table
              </a>
            )}
          </div>

          {/* Group mode — say so plainly and permanently. Without this the
              customer adds three things, opens the cart out of habit, finds it
              empty and assumes the site is broken. */}
          {groupMode && (basket || groupQuery.error) && (
            <div className="mt-4 rounded-md border border-orange-200 bg-orange-50 px-4 py-3 text-xs text-orange-900">
              {groupQuery.error || !basket ? (
                <>
                  <p className="font-semibold">This group order isn&apos;t available</p>
                  <p className="mt-0.5 text-[11px] text-orange-800">
                    {((groupQuery.error as any)?.response?.data?.message as string) ??
                      "The link may have expired."}{" "}
                    <a
                      className="underline"
                      href={`/order/${slug}${brandId ? `?brand=${brandId}` : ""}`}
                    >
                      Order on your own instead
                    </a>
                    .
                  </p>
                </>
              ) : basket.status === "PLACED" ? (
                <>
                  <p className="font-semibold">
                    This group order has already been placed
                  </p>
                  <p className="mt-0.5 text-[11px] text-orange-800">
                    Anything you add now would be a separate order.{" "}
                    <a
                      className="underline"
                      href={`/order/${slug}${brandId ? `?brand=${brandId}` : ""}`}
                    >
                      Start your own
                    </a>
                    .
                  </p>
                </>
              ) : basket.status === "CANCELLED" || basket.status === "EXPIRED" ? (
                <>
                  <p className="font-semibold">
                    This group order is {basket.status === "EXPIRED" ? "expired" : "cancelled"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-orange-800">
                    <a
                      className="underline"
                      href={`/order/${slug}${brandId ? `?brand=${brandId}` : ""}`}
                    >
                      Order on your own instead
                    </a>
                    .
                  </p>
                </>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 font-semibold">
                      <Users className="h-3.5 w-3.5" />
                      {basket.isHost
                        ? "Your group order"
                        : `${basket.hostName ?? "A friend"}'s group order`}
                    </p>
                    <p className="mt-0.5 text-[11px] text-orange-800">
                      {basket.status === "LOCKED"
                        ? `Basket closed — ${
                            basket.isHost
                              ? "finish checkout in the basket"
                              : `${basket.hostName ?? "the host"} is checking out`
                          }.`
                        : `Everything you add goes in together · ${
                            basket.people.length
                          } ${basket.people.length === 1 ? "person" : "people"} · £${basket.subtotal.toFixed(
                            2,
                          )}`}
                    </p>
                  </div>
                  <button
                    onClick={() => setGroupPanelOpen(true)}
                    className="shrink-0 rounded-full bg-orange-500 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-orange-600"
                  >
                    View basket
                  </button>
                </div>
              )}
              {/* Failures from an Add belong here, not only in the panel —
                  the customer is looking at the menu when they happen. */}
              {groupError && (
                <p className="mt-2 border-t border-orange-200 pt-2 text-[11px] text-red-700">
                  {groupError}
                </p>
              )}
            </div>
          )}

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
          {storeCampaign && !groupMode && !storefront.closed && (storeCampaign.percentageOff != null || storeCampaign.amountOff != null) && (
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
          {bogo && !groupMode && !storefront.closed && (
            <div className="mt-4 rounded-md border border-pink-200 bg-pink-50 px-4 py-2 text-xs text-pink-900">
              <p className="font-semibold">🎁 Buy 1, get 1 free</p>
              <p className="mt-0.5 text-[11px] text-pink-800">
                {bogo.campaignName} — add any highlighted item and a free
                copy of the same item lands in your cart automatically.
              </p>
            </div>
          )}
          {freeDeliveryCampaign && !storefront.closed && (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-900">
              <p className="font-semibold">🚚 Free delivery</p>
              <p className="mt-0.5 text-[11px] text-emerald-800">
                {freeDeliveryCampaign.campaignName} — delivery is on the house
                for this order.
              </p>
            </div>
          )}
          {freeItem && !groupMode && !storefront.closed && (() => {
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
          {/* Promotions and Top sellers lead the menu, above every category —
              the two things a browsing customer responds to first. Both are
              hidden while a specific category or a search is active, so they
              never sit between the customer and what they asked for. */}
          {activeCategory === "all" && !search.trim() && (
            <>
              {promoItems.length > 0 && (
                <section id="category-promotions">
                  <h2 className="mb-3 text-lg font-bold text-zinc-900">
                    Promotions
                  </h2>
                  <ItemRail
                    items={promoItems}
                    itemPromos={itemPromos}
                    showImage={cfg?.showItemImages ?? true}
                    onPick={handleProductClick}
                  />
                </section>
              )}
              {topSellers.length > 0 && (
                <section id="category-top-sellers">
                  <h2 className="mb-3 text-lg font-bold text-zinc-900">
                    Top sellers
                  </h2>
                  <ItemRail
                    items={topSellers}
                    itemPromos={itemPromos}
                    showImage={cfg?.showItemImages ?? true}
                    onPick={handleProductClick}
                  />
                </section>
              )}
            </>
          )}

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
                  <>
                    {/* Phones get a list, not a grid. A card per row wastes
                        most of a 375px screen on padding and image, so the
                        customer scrolls past three items where a row layout
                        shows six — the same shape the table-ordering page
                        already uses. Desktop keeps the card grid. */}
                    <div className="divide-y divide-zinc-100 sm:hidden">
                      {items.map((item) => (
                        <StoreItemRow
                          key={item.id}
                          item={item}
                          promo={itemPromos[item.id] ?? null}
                          showImage={cfg?.showItemImages ?? true}
                          onClick={() => handleProductClick(item)}
                          categoryName={cat.name}
                          stepper={
                            isSimpleItem(item)
                              ? {
                                  qty: plainLineFor(item.id)?.quantity ?? 0,
                                  onInc: () => handleProductClick(item),
                                  onDec: () => {
                                    const line = plainLineFor(item.id);
                                    if (line) dispatch({ type: "DECREMENT", id: line.id });
                                  },
                                }
                              : null
                          }
                        />
                      ))}
                    </div>
                    <div className="hidden gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-4">
                      {items.map((item) => (
                        <ProductCard
                          key={item.id}
                          item={item}
                          promo={itemPromos[item.id] ?? null}
                          bogoTrigger={bogoTriggerSet.has(item.id)}
                          showImage={cfg?.showItemImages ?? true}
                          onClick={() => handleProductClick(item)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </section>
            ))
          )}

          {/* Customer reviews — below the menu, where a browsing customer
              lands after scrolling. Renders nothing until the shop has one. */}
          <StorefrontReviews
            brandId={brandId ?? undefined}
            locationId={storefront?.location?.id}
          />
        </div>
      </div>

      {/* Shared basket — replaces the cart panel entirely in group mode. */}
      {groupPanelOpen && basket && (
        <GroupBasketPanel
          basket={basket}
          myRef={groupRef}
          shareUrl={groupOrdersClient.shareUrl(String(slug), basket.token)}
          onClose={() => setGroupPanelOpen(false)}
          onRemoveItem={(id) => removeFromGroup.mutate(id)}
          removingItemId={removingGroupItemId}
          onLock={() => lockGroup.mutate("lock")}
          onUnlock={() => lockGroup.mutate("unlock")}
          onPlace={() => placeGroup.mutate()}
          onCancel={() => {
            if (
              window.confirm(
                "Cancel this group order? Everyone's items will be lost.",
              )
            ) {
              cancelGroup.mutate();
            }
          }}
          isLocking={lockGroup.isPending}
          isPlacing={placeGroup.isPending}
          actionError={groupError}
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
            if (postcodeSuggestions.length > 0) setPostcodeSuggestions([]);
            if (postcodeLookupNote) setPostcodeLookupNote(null);
          }}
          paymentMethod={paymentMethod}
          setPaymentMethod={setPaymentMethod}
          acceptsCash={cfg?.acceptsCash ?? true}
          acceptsCard={cfg?.acceptsCard ?? true}
          notes={notes}
          setNotes={setNotes}
          deliveryFee={deliveryFee}
          matchedZone={matchedZone}
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
        />
      )}

      {startGroupOpen && (
        <StartGroupOrderModal
          storeName={headerTitle}
          initialName={
            getGuestName() ||
            (authCustomer
              ? `${authCustomer.firstName} ${authCustomer.lastName}`.trim()
              : "")
          }
          fulfillmentType={fulfillmentType}
          acceptDelivery={acceptDelivery}
          acceptCollection={acceptCollection}
          isCreating={startGroup.isPending}
          error={
            startGroup.error
              ? ((startGroup.error as any)?.response?.data?.message ??
                "Couldn't start the group order. Try again.")
              : null
          }
          onStart={(name, type) =>
            startGroup.mutate({ name, fulfillmentType: type })
          }
          onClose={() => setStartGroupOpen(false)}
        />
      )}

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
          smsMarketingConsent={smsMarketingConsent}
          setSmsMarketingConsent={setSmsMarketingConsent}
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
            // addLine, not dispatch — in group mode this has to land in the
            // shared basket instead of the local cart.
            addLine({
              menuItemId: line.menuItemId,
              displayName: line.displayName,
              unitPrice,
              quantity: line.quantity,
              modifiers: line.modifiers,
              selectedSku: line.selectedSku,
              notes: line.notes,
              plu: line.plu,
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
        brandId={brandId}
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
    addLine({
      menuItemId: item.id,
      displayName: item.name,
      unitPrice,
      quantity: 1,
      modifiers: [],
      selectedSku: null,
      notes: "",
      plu: item.plu ?? null,
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

/**
 * A menu item as a list row — the phone layout.
 *
 * Text leads and the image sits right, which is what a customer scanning a
 * menu on a phone actually reads: name, price, then the picture to confirm.
 * The add button overlays the image corner so the whole row stays tappable
 * without a separate control stealing width.
 */
/**
 * A horizontally-scrolling strip of items — Promotions and Top sellers.
 *
 * A rail rather than a grid on purpose: these sections sit above the menu, and
 * a grid of six would push the actual categories off the first screen. Scroll
 * snapping keeps the cards aligned as the customer flicks through.
 */
function ItemRail({
  items,
  itemPromos,
  showImage,
  onPick,
}: {
  items: MenuItem[];
  itemPromos: Record<string, { percentageOff: number; campaignName: string }>;
  showImage?: boolean;
  onPick: (item: MenuItem) => void;
}) {
  return (
    <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
      {items.map((item) => {
        const promo = itemPromos[item.id] ?? null;
        const { amount: base, from: fromSize } = displayPrice(item as any);
        const hasPromo = !!promo && promo.percentageOff > 0;
        const discounted = hasPromo
          ? Math.round(base * (1 - promo.percentageOff / 100) * 100) / 100
          : base;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onPick(item)}
            disabled={item.outOfStock}
            className="w-[150px] flex-shrink-0 snap-start text-left disabled:opacity-50 sm:w-[170px]"
          >
            {showImage !== false && (
              <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-zinc-100">
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imageUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <FoodPlaceholder name={item.name} className="h-full w-full" />
                )}
                {!item.outOfStock && (
                  <span className="absolute bottom-1.5 right-1.5 grid h-8 w-8 place-items-center rounded-full bg-white text-zinc-900 shadow-md">
                    <Plus className="h-4 w-4" />
                  </span>
                )}
              </div>
            )}
            <p className="mt-2 line-clamp-2 text-[13px] font-semibold leading-snug text-zinc-900">
              {item.name}
            </p>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              {fromSize && (
                <span className="text-[10px] font-medium text-zinc-500">From</span>
              )}
              <span
                className={`text-[13px] font-bold ${hasPromo ? "text-red-600" : "text-zinc-900"}`}
              >
                £{discounted.toFixed(2)}
              </span>
              {hasPromo && (
                <span className="text-[12px] text-zinc-400 line-through">
                  £{base.toFixed(2)}
                </span>
              )}
            </div>
            {hasPromo && (
              <span className="mt-1 inline-block rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-bold text-white">
                -{promo.percentageOff}%
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function StoreItemRow({
  item,
  promo,
  showImage,
  onClick,
  categoryName,
  stepper,
}: {
  item: MenuItem;
  promo: { percentageOff: number; campaignName: string } | null;
  showImage?: boolean;
  onClick: () => void;
  /** Category name — picks the placeholder graphic when the dish name is silent. */
  categoryName?: string;
  /** Set for items with nothing to choose — shows −/qty/+ instead of a plain +. */
  stepper?: {
    qty: number;
    onInc: () => void;
    onDec: () => void;
  } | null;
}) {
  const { amount: base, from: fromSize } = displayPrice(item as any);
  const hasPromo = !!promo && promo.percentageOff > 0;
  const discounted = hasPromo
    ? Math.round(base * (1 - promo!.percentageOff / 100) * 100) / 100
    : base;

  const showStepper = !!stepper && stepper.qty > 0 && !item.outOfStock;

  // Buttons can't nest. While the stepper is on screen the row is a plain
  // div with a tappable title area, so the −/+ controls stay real buttons.
  const RowTag: any = showStepper ? "div" : "button";
  const rowProps = showStepper
    ? {}
    : { type: "button" as const, onClick, disabled: item.outOfStock };

  return (
    <RowTag
      {...rowProps}
      className="flex w-full items-start gap-3 py-3 text-left disabled:opacity-50"
    >
      <div
        className="min-w-0 flex-1"
        onClick={showStepper ? onClick : undefined}
        role={showStepper ? "button" : undefined}
        tabIndex={showStepper ? 0 : undefined}
      >
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug text-zinc-900">
            {item.name}
          </h3>
          {item.outOfStock && (
            <span className="mt-0.5 flex-shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600">
              Sold out
            </span>
          )}
        </div>
        {item.description && (
          <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-zinc-500">
            {item.description}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {fromSize && (
            <span className="text-[11px] font-medium text-zinc-500">From</span>
          )}
          <span
            className={`text-[15px] font-bold ${hasPromo ? "text-red-600" : "text-zinc-900"}`}
          >
            £{discounted.toFixed(2)}
          </span>
          {hasPromo && (
            <>
              <span className="text-[13px] text-zinc-400 line-through">
                £{base.toFixed(2)}
              </span>
              <span className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-bold text-white">
                -{promo!.percentageOff}%
              </span>
            </>
          )}
        </div>
      </div>

      {showImage !== false && (
        <div className="relative h-[88px] w-[88px] flex-shrink-0 overflow-hidden rounded-xl bg-zinc-100">
          {item.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.imageUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <FoodPlaceholder
              name={item.name}
              hint={categoryName}
              className="h-full w-full"
            />
          )}
          {!item.outOfStock && !showStepper && (
            <span className="absolute bottom-1 right-1 grid h-7 w-7 place-items-center rounded-full bg-white text-zinc-900 shadow-md">
              <Plus className="h-4 w-4" />
            </span>
          )}
        </div>
      )}

      {/* How many are in the basket, and how to change it, without opening
          the cart or a sheet. Only ever shown once something is added. */}
      {showStepper && (
        <div className="flex flex-shrink-0 items-center gap-1 self-center rounded-full border border-zinc-200 bg-white px-1 py-1">
          <button
            type="button"
            aria-label={`Remove one ${item.name}`}
            onClick={stepper!.onDec}
            className="grid h-7 w-7 place-items-center rounded-full text-zinc-700 active:bg-zinc-100"
          >
            <Minus className="h-4 w-4" />
          </button>
          <span className="min-w-[1.25rem] text-center text-sm font-semibold tabular-nums text-zinc-900">
            {stepper!.qty}
          </span>
          <button
            type="button"
            aria-label={`Add another ${item.name}`}
            onClick={stepper!.onInc}
            className="grid h-7 w-7 place-items-center rounded-full bg-zinc-900 text-white active:opacity-80"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      )}
    </RowTag>
  );
}

function ProductCard({
  item,
  promo,
  bogoTrigger,
  showImage = true,
  onClick,
}: {
  item: MenuItem;
  promo: { percentageOff: number; campaignName: string } | null;
  bogoTrigger?: boolean;
  showImage?: boolean;
  onClick: () => void;
}) {
  // A sized product prices its sizes, not itself — show the cheapest rather
  // than the placeholder 0 sitting on basePrice.
  const { amount: basePrice, from: fromSize } = displayPrice(item as any);
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
      {showImage && (
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
      )}
      <div className="flex flex-1 flex-col gap-1 p-4">
        {/* Image-off menus surface the same status badges inline, since the
            image overlay that normally carries them isn't rendered. */}
        {!showImage &&
          (item.outOfStock || hasPromo || bogoTrigger) && (
            <div className="flex flex-wrap gap-1">
              {item.outOfStock && (
                <span className="rounded-md bg-red-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                  Out of stock
                </span>
              )}
              {hasPromo && !item.outOfStock && (
                <span className="rounded-md bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
                  {promo!.percentageOff}% OFF
                </span>
              )}
              {bogoTrigger && !item.outOfStock && (
                <span className="rounded-md bg-pink-600 px-2 py-0.5 text-[10px] font-bold text-white">
                  BUY 1 GET 1 FREE
                </span>
              )}
            </div>
          )}
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
                {fromSize && (
                  <span className="mr-1 text-[11px] font-medium">From</span>
                )}
                £{discounted.toFixed(2)}
              </span>
            </div>
          ) : (
            <span className="text-base font-bold text-orange-600">
              {fromSize && (
                <span className="mr-1 text-[11px] font-medium text-zinc-500">
                  From
                </span>
              )}
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
  smsMarketingConsent: boolean;
  setSmsMarketingConsent: (v: boolean) => void;
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
    smsMarketingConsent,
    setSmsMarketingConsent,
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
                      {(l.unitPrice * l.quantity).toFixed(2)}
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
            <label className="mt-1 flex cursor-pointer items-start gap-2 text-xs text-zinc-500">
              <input
                type="checkbox"
                checked={smsMarketingConsent}
                onChange={(e) => setSmsMarketingConsent(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300"
              />
              <span>Keep me updated with offers &amp; news by SMS</span>
            </label>
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
              {/* Search first, type second. Most customers finish here and
                  never touch the fields below — but the fields stay, because
                  new-builds and flats above shops are exactly the addresses
                  Google is worst at. */}
              <AddressSearchField
                onPick={(a) => {
                  if (a.line1) setAddrLine1(a.line1);
                  if (a.city) setAddrCity(a.city);
                  if (a.postcode) setAddrPostcode(a.postcode.toUpperCase());
                }}
              />
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
              {/* City + postcode + Find in one row. Inputs get min-w-0 so they
                  shrink on narrow phones instead of pushing the Find button
                  past the viewport edge (it was invisible on mobile). */}
              <div className="grid grid-cols-[1fr,1fr,auto] gap-1.5">
                <input
                  value={addrCity}
                  onChange={(e) => setAddrCity(e.target.value)}
                  placeholder="City"
                  className="min-w-0 rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                />
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
                  className="min-w-0 rounded-md border border-zinc-200 px-2 py-1.5 text-xs uppercase focus:border-zinc-900 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={onPostcodeLookup}
                  disabled={postcodeLookupLoading || addrPostcode.trim().length < 5}
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-zinc-300 bg-white px-2.5 text-[11px] font-medium hover:bg-zinc-50 disabled:opacity-50"
                >
                  {postcodeLookupLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Search className="h-3 w-3" />
                  )}
                  Find
                </button>
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
  // Phase AW-30 — accept both `{ enabled, slots }` (location drawer)
  // and bare `[{ from, to }]` (brand drawer) shapes.
  const slots: Array<{ from?: string; to?: string }> = Array.isArray(dayCfg)
    ? dayCfg
    : dayCfg && dayCfg.enabled !== false && Array.isArray(dayCfg.slots)
      ? dayCfg.slots
      : [];
  if (slots.length === 0) return [];

  const now = new Date();
  const isToday = day.toDateString() === now.toDateString();
  const earliest = isToday
    ? new Date(now.getTime() + prepMinutes * 60_000)
    : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0);

  const out: string[] = [];
  for (const slot of slots) {
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
  destination?: { lat: number; lng: number } | null;
  driver?: {
    name?: string | null;
    phone?: string | null;
    lat?: number | null;
    lng?: number | null;
    lastPingAt?: string | null;
  } | null;
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
      if (s && terminal.includes(s)) return false;
      // Poll faster while the driver is moving so the live map keeps up.
      return s === "OUT_FOR_DELIVERY" || s === "RIDER_ARRIVED" ? 2000 : 3000;
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
  // Phase AW-30 — prefer the 5-char displayId so the confirmation +
  // tracker screens match the receipt and the My Orders list.
  const orderRef = data.displayId
    ? `#${data.displayId}`
    : data.orderNumber
      ? `#${data.orderNumber}`
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
            : data.driver
              ? "Your order is on the way 🛵"
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
        {/* Phase AX — the best moment to ask. The order is placed, the
            customer is invested, and they're about to wonder how long they
            have to sit on this page. Gone once the order is finished. */}
        {!completed && (
          <div className="mb-8 text-left">
            <OrderNotifications orderId={data.id} slug={storeSlug} />
          </div>
        )}
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

        {/* Live delivery tracking — appears the moment the driver starts the
            job (status → out for delivery): map, call + chat, front-and-centre. */}
        {data.driver && (
          <div className="mb-8 space-y-4 text-left">
            <div className="flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <div>
                <p className="text-xs font-medium text-emerald-700">Your driver</p>
                <p className="text-sm font-bold text-zinc-900">{data.driver.name ?? "On the way"}</p>
              </div>
              {data.driver.phone && (
                <a
                  href={`tel:${data.driver.phone}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
                >
                  <Phone className="h-4 w-4" /> Call
                </a>
              )}
            </div>

            {(data.driver.lat != null && data.driver.lng != null) || data.destination ? (
              <DeliveryTrackingMap
                driver={
                  data.driver.lat != null && data.driver.lng != null
                    ? { lat: data.driver.lat, lng: data.driver.lng }
                    : null
                }
                destination={data.destination ?? null}
              />
            ) : (
              <p className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-center text-xs text-zinc-500">
                Waiting for your driver&apos;s location…
              </p>
            )}

            <CustomerDriverChat orderId={data.id} driverName={data.driver.name} />
          </div>
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
  // Phase AW-30 — two shapes ship through here. The location drawer
  // saves `{ monday: { enabled, slots:[{from,to}] } }`; the brand
  // drawer saves the flatter `{ monday: [{from,to}] }`. Coerce to the
  // slots array up front so both render the same way.
  const slotsFor = (day: any): Array<{ from?: string; to?: string }> => {
    if (Array.isArray(day)) return day;
    if (day && day.enabled !== false && Array.isArray(day.slots)) return day.slots;
    return [];
  };
  return (
    <ul className="space-y-1.5">
      {INFO_DAYS.map(([key, label]) => {
        const day = openingHours[key];
        const slots = slotsFor(day);
        const closed = slots.length === 0;
        const summary = closed
          ? "Closed"
          : slots
              .map((s) => `${s.from ?? "??"} – ${s.to ?? "??"}`)
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
