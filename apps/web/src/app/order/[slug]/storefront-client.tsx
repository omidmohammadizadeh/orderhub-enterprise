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

import { WelcomeSplash, type WelcomeSplashData } from "@/components/storefront/welcome-splash";
import { HygieneBadge, type StorefrontHygiene } from "@/components/storefront/hygiene-badge";
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
import { readEmailRef, rememberEmailRef } from "@/lib/email-marketing/attribution";
import {
  bounceBackToRestaurantApp,
  restaurantAppAutoReturn,
  restaurantAppScheme,
  useInRestaurantApp,
} from "@/lib/in-restaurant-app";
import { AppInstallBanner, AppInstallCard, type CustomerAppLinks } from "@/components/storefront/app-install";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  formatMoney,
  currencySymbol,
  applyMultiBuys,
  basketMinAge,
  describeMultiBuy,
  normaliseSellBy,
  sellByLabel,
  weighedLineName,
  type SellBy,
  type MultiBuyApplication,
  type MultiBuyDeal,
  isPlausibleCustomerPhone,
  hasHouseNumberOrName,
  loyaltyRewardDiscount,
  loyaltyRewardKind,
  type LoyaltyRewardTerms,
} from "@orderhub/shared";
import axios from "axios";
import { LoginModal } from "@/components/storefront/login-modal";
import { FoodPlaceholder } from "@/components/storefront/food-placeholder";
import { StorefrontTabBar } from "@/components/storefront/tab-bar";
import { PoweredByOrderHub } from "@/components/storefront/powered-by";
import { ReferralClaim } from "@/components/storefront/referral-claim";
import { ReferAFriend } from "@/components/storefront/refer-a-friend";
import { PlacingOrderSheet } from "@/components/storefront/placing-order-sheet";
import { TipStep } from "@/components/storefront/tip-step";
import { ShopProductTile } from "@/components/storefront/shop-product-tile";
import { WeightSheet } from "@/components/storefront/weight-sheet";
import {
  RatingPill,
  StorefrontReviews,
} from "@/components/storefront/storefront-reviews";
import { HeaderAuthButton } from "@/components/storefront/header-auth-button";
import { BasketBar, BasketPanel } from "@/components/storefront/basket";
import {
  CategoryTabs,
  sectionDomId,
  type CategoryTab,
} from "@/components/storefront/category-tabs";
import { MenuItemCard } from "@/components/storefront/menu-item-card";
import { StorefrontSkeleton } from "@/components/storefront/storefront-skeleton";
import { pickBrandColour, storefrontThemeStyle } from "@/lib/storefront-theme";
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
import {
  resolveZone,
  zoneMode,
  areaZoneNames,
  normaliseAreaName,
  radiusBands,
  postcodeRequiredFor,
  formatDistance,
  type ZoneLike,
} from "@orderhub/shared";

/** Same community, allowing for spelling and the Arabic article — "Al Barsha"
 *  and "Barsha" are one place. Uses the shared normaliser so the browser's idea
 *  of "same area" is the server's. */
const sameArea = (a: string, b: string) =>
  normaliseAreaName(a) === normaliseAreaName(b);

/** A delivery zone row as the storefront receives it. Every mode field is
 *  nullable because a row is exactly one of the three — this used to be typed
 *  as `postcodePrefix: string`, which was a lie the moment a brand switched to
 *  distance bands and the cart called .toUpperCase() on a null. */
type DeliveryZoneRow = ZoneLike & {
  id: string;
  postcodePrefix: string | null;
  areaName: string | null;
  maxDistanceMiles: string | number | null;
  fee: string | number;
  minOrderValue: string | number | null;
};
import { PwaManifestLink } from "@/components/storefront/pwa-manifest-link";
import { OrderNotifications } from "@/components/order/order-notifications";
import { EmbeddedPaymentSheet } from "@/components/order/embedded-payment-sheet";
import {
  getGuestName,
  getGuestRef,
  groupOrdersClient,
  setGuestName,
  type GroupOrderView,
} from "@/lib/api/group-orders.client";
import { publicReservationsClient } from "@/lib/api/reservations.client";
import { cn } from "@/lib/utils";
import { LiveDeliveryPanel } from "@/components/order/live-delivery-panel";
import {
  ModifierSelectionModal,
} from "@/components/pos/modifier-selection-modal";
import type {
  MenuItem,
  MenuCategory,
} from "@/lib/api/menus.client";
import {
  round2,
  toOrderLineModifier,
  itemAllowsFulfillment,
} from "@orderhub/shared";
import { displayPrice } from "@/lib/menu/display-price";
import {
  cartIsStale,
  clearCart,
  loadCart,
  loadFulfillment,
  saveCart,
  saveFulfillment,
} from "@/lib/cart-storage";
import { forgetCheckout, readCheckout, rememberCheckout } from "@/lib/checkout-resume";
import type { SelectedModifier, ProductSku } from "@orderhub/shared";

// ── Types ──────────────────────────────────────────────────────────────────

interface Storefront {
  location: {
    id: string;
    /** Retail R3 — GROCERY / RETAIL get the shop layout. Absent on old payloads. */
    businessType?: "RESTAURANT" | "GROCERY" | "RETAIL" | "SALON";
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
    /** ISO-4217, from the location. Absent on an older cached payload. */
    currency?: string | null;
    address?: { line1?: string; city?: string; postcode?: string } | null;
    openingHours: any;
    deliveryConfig?: { deliveryFeeFixed?: number; minimumOrder?: number };
    busyMode?: boolean;
    currentPrepTime?: number;
  };
  brand: {
    id: string;
    name: string;
    logoUrl?: string | null;
    /** The brand's storefront accent, `#rrggbb`; null = default. */
    primaryColor?: string | null;
  };
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
  deliveryZones?: DeliveryZoneRow[];
  // Only present when WhatsApp ordering is configured AND live for this
  // location. Drives the "Order on WhatsApp" button. displayPhoneNumber is
  // E.164 (e.g. "+447…"); build the wa.me link by stripping non-digits.
  whatsapp?: {
    enabled: boolean;
    displayPhoneNumber?: string;
  } | null;
  /** Today's phone welcome screen for this location, if one is scheduled. */
  splash?: WelcomeSplashData | null;
  /** FSA food hygiene rating; null when unlinked or hidden by the shop. */
  hygiene?: StorefrontHygiene | null;
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
  /** Retail R3 — shops only: may the picker swap this if it's out of stock?
   *  Absent = yes (BEST_MATCH), the grocery norm. */
  substitution?: "BEST_MATCH" | "NONE";
  /** Retail — weighed products: grams per pack (the checkout re-prices it). */
  weightGrams?: number;
}

type CartAction =
  | { type: "ADD"; line: Omit<CartLine, "id"> }
  | { type: "INCREMENT"; id: string }
  | { type: "DECREMENT"; id: string }
  | { type: "REMOVE"; id: string }
  | { type: "SET"; lines: CartLine[] }
  | { type: "SET_SUBSTITUTION"; id: string; value: "BEST_MATCH" | "NONE" }
  | { type: "CLEAR" };

/**
 * Two cart lines are the same order when everything a customer chose matches.
 *
 * Modifiers are sorted before comparing so picking the same three sauces in a
 * different order still counts as the same line. Promo pricing rides on
 * unitPrice, so a discounted line never merges with a full-price one.
 *
 * bogoOf / freeItemOf are deliberately part of the key: a freebie mirrors a
 * specific trigger line and must not be folded into the paid one.
 */
function cartLineKey(line: Omit<CartLine, "id">): string {
  const mods = (line.modifiers ?? [])
    .map((m) => `${m.id ?? ""}~${m.name ?? ""}~${m.price ?? 0}`)
    .sort()
    .join("|");
  return [
    line.menuItemId,
    line.unitPrice,
    (line.notes ?? "").trim(),
    line.selectedSku?.name ?? "",
    line.plu ?? "",
    line.bogoOf ?? "",
    line.freeItemOf ?? "",
    line.weightGrams ?? "",
    mods,
  ].join("\u0000");
}

function cartReducer(state: CartLine[], action: CartAction): CartLine[] {
  switch (action.type) {
    // Replace the whole cart — used to hydrate a saved basket from
    // localStorage on mount so a refresh/login doesn't lose it.
    case "SET":
      return action.lines;
    // Adding something already in the cart raises its quantity instead of
    // laying a second identical line beside the first.
    //
    // Pushing every time is what made the row stepper look broken: tap + on a
    // sauce twice and you got two lines of one, so the stepper — which reads
    // the FIRST matching line — sat at 1 while the cart badge climbed. It also
    // sent the kitchen "1x Garlic Sauce" printed nine times instead of
    // "9x Garlic Sauce".
    case "ADD": {
      const key = cartLineKey(action.line);
      const at = state.findIndex((l) => cartLineKey(l) === key);
      if (at >= 0) {
        return state.map((l, i) =>
          i === at ? { ...l, quantity: l.quantity + action.line.quantity } : l,
        );
      }
      return [
        ...state,
        { ...action.line, id: Math.random().toString(36).slice(2) },
      ];
    }
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
    case "SET_SUBSTITUTION":
      return state.map((l) => (l.id === action.id ? { ...l, substitution: action.value } : l));
    case "CLEAR":
      return [];
    default:
      return state;
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

// ── Page ───────────────────────────────────────────────────────────────────

// This used to BE the route's page.tsx. It moved out so `page.tsx` could
// become a server component and export generateMetadata — a "use client"
// module cannot, and without it every shop's storefront inherited the
// site-wide B2B title/description into Google and into every link preview
// a shop pastes into WhatsApp. The UI below is unchanged; the route still
// resolves slug + ?brand= from useParams/useSearchParams as it always did.
export default function StorefrontClient() {
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
  // Inside one of the restaurant apps (WebView user agent "OrderHubApp/").
  const inApp = useInRestaurantApp();
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
  // A marketing email's link carries ?er=<recipient>. Remember it so the order
  // it leads to — today or later this week — is credited to that campaign.
  const emailRef = searchParams?.get("er") ?? null;
  useEffect(() => {
    if (emailRef) rememberEmailRef(emailRef);
  }, [emailRef]);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [cart, dispatch] = useReducer(cartReducer, []);
  const [cartOpen, setCartOpen] = useState(false);

  // Persist the basket per storefront (slug + brand) so a page refresh, a
  // login / Google-OAuth redirect, or closing and reopening the browser
  // keeps the customer's cart. Hydrate once on mount; save on every change
  // after. Keyed by brand so a multi-brand kitchen doesn't mix baskets.
  //
  // It expires after twelve hours untouched — see lib/cart-storage. Keeping
  // it across a refresh is the point; keeping it across a week is how a
  // customer who changed their mind on Tuesday opens the site on Friday to
  // find two pizzas waiting, at prices the shop may have changed since.
  const cartKey = `orderhub.cart.${slug}${brandId ? `:${brandId}` : ""}`;
  // WHICH key we've hydrated, not merely whether we have. The key contains
  // the brand, so it changes when ?brand= arrives or switches — and a plain
  // boolean stayed true across that change, letting the save effect below
  // fire against the NEW key while `cart` was still the old empty state. That
  // deleted a perfectly good saved basket a beat before hydration could read
  // it. Comparing keys means we only ever write to a key we've read first.
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  // When this basket was last written, for the open-tab check below.
  const cartTouchedAt = useRef<number | null>(null);
  useEffect(() => {
    const { lines, savedAt } = loadCart<CartLine>(cartKey);
    if (lines.length > 0) dispatch({ type: "SET", lines });
    cartTouchedAt.current = savedAt;
    setHydratedKey(cartKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey]);
  useEffect(() => {
    // Only write to the key we have actually read. Skipping the
    // pre-hydration commit isn't enough on its own: the key itself changes
    // when the brand does, and writing an empty cart to a key we haven't
    // hydrated yet is how a saved basket disappears.
    if (hydratedKey !== cartKey) return;
    saveCart(cartKey, cart);
    cartTouchedAt.current = cart.length > 0 ? Date.now() : null;
  }, [cart, cartKey, hydratedKey]);

  // The tab somebody left open. Hydration runs once per key, so a laptop
  // left on the storefront overnight still holds yesterday's basket in
  // memory long after the stored copy expired. Catch it on the way back to
  // the foreground.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      if (cart.length > 0 && cartIsStale(cartTouchedAt.current)) {
        dispatch({ type: "CLEAR" });
        setCartOpen(false);
      }
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [cart.length]);

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
  const [fulfillmentType, setFulfillmentType] = useState<"PICKUP" | "DELIVERY">(
    "PICKUP",
  );
  // Kept with the basket (lib/cart-storage) — a reload used to bring the
  // basket back but reset this to collection, so a customer who chose
  // delivery and then signed in paid for a collection order. Same
  // read-before-write key guard as the basket above.
  const [fulfillmentHydratedKey, setFulfillmentHydratedKey] = useState<string | null>(null);
  useEffect(() => {
    // ?mode=delivery|collection (the restaurant apps' Home buttons) beats
    // the saved choice, then leaves the URL so a reload keeps what the
    // customer changes it to afterwards.
    const asked = new URL(window.location.href).searchParams.get("mode");
    const fromLink = asked === "delivery" ? "DELIVERY" : asked === "collection" ? "PICKUP" : null;
    const saved = fromLink ?? loadFulfillment(cartKey);
    if (saved) setFulfillmentType(saved);
    if (fromLink) {
      const url = new URL(window.location.href);
      url.searchParams.delete("mode");
      window.history.replaceState(null, "", url.toString());
    }
    setFulfillmentHydratedKey(cartKey);
  }, [cartKey]);
  useEffect(() => {
    if (fulfillmentHydratedKey !== cartKey) return;
    saveFulfillment(cartKey, fulfillmentType);
  }, [fulfillmentType, cartKey, fulfillmentHydratedKey]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null); // ISO
  const [modalItem, setModalItem] = useState<MenuItem | null>(null);
  // Retail — a loose product waiting for the shopper to pick an amount.
  const [weighItem, setWeighItem] = useState<MenuItem | null>(null);
  const [confirmedOrderId, setConfirmedOrderId] = useState<string | null>(null);
  // Set once an embedded CARD order has been created and is waiting to be
  // paid on-page. Non-null means the payment sheet is up.
  const [pendingPayment, setPendingPayment] = useState<{
    clientSecret: string;
    stripeAccountId: string;
    amountPence: number;
    orderId: string;
  } | null>(null);

  // Phase AP-8 — Stripe Checkout success URL bounces the customer back to
  // /order/[slug]/confirmation which redirects here with ?confirmedOrderId
  // in the query string. Pick it up on mount so the order-tracking screen
  // shows automatically instead of the empty cart.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Cancelled on a payment page a restaurant app opened in a Chrome tab
    // (Android): back to the app rather than a menu in the browser.
    if (bounceBackToRestaurantApp()) return;
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
  // Between "Place order" and the order actually being created.
  const [holding, setHolding] = useState(false);
  // Tip step sits between the basket and the hold. Amount in pounds; goes
  // to the restaurant, so it shows on collection orders too.
  const [tipOpen, setTipOpen] = useState(false);
  const [tipAmount, setTipAmount] = useState(0);

  // Cart panel form state
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  // "Keep me updated by SMS" — ticked by default, customer can opt out.
  const [smsMarketingConsent, setSmsMarketingConsent] = useState(true);
  // "Email me offers" — ticked by default like the SMS box; the customer
  // unticks it if they'd rather not. It goes to their ACCOUNT email (the one
  // they signed in with), never the optional checkout field.
  const [emailMarketingConsent, setEmailMarketingConsent] = useState(true);
  // Challenge 25 — "I'm 18 or over", asked only when the basket needs it.
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [addrFlat, setAddrFlat] = useState(""); // Phase AP fix #3 — house/flat number
  const [addrLine1, setAddrLine1] = useState("");
  const [addrCity, setAddrCity] = useState("");
  const [addrPostcode, setAddrPostcode] = useState("");
  // The community the customer delivers to. In the Gulf this is what prices
  // the order — there is no postcode — so it is as load-bearing there as
  // addrPostcode is in the UK.
  const [addrArea, setAddrArea] = useState("");
  // Kept when the address came from a Places pick, so distance bands don't
  // re-geocode a string the browser already resolved.
  const [addrPoint, setAddrPoint] = useState<{ lat: number; lng: number } | null>(
    null,
  );
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
  // Every price on this page goes through money(). A hardcoded £ here is a
  // customer in Dubai reading AED prices as pounds — the one place where
  // getting currency wrong reaches the person actually paying.
  // The API sends it as location.currency — there is no `store` key, so the
  // old `storefront.store.currency` read was always undefined and every Gulf
  // storefront priced in £ (seen on the Dubai test store, 2026-10-30).
  const currency =
    (storefront as any)?.location?.currency ?? (storefront as any)?.store?.currency ?? "GBP";
  const money = (n: number | string | null | undefined) =>
    formatMoney(n, currency, { compact: true });
  const symbol = currencySymbol(currency);

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

  const shopCountry = storefront?.location?.country ?? "GB";
  const zones = useMemo(
    () => storefront?.deliveryZones ?? [],
    [storefront?.deliveryZones],
  );
  /** POSTCODE | RADIUS | AREA | NONE — decided by the rows the brand saved,
   *  so the cart can never quote on a model the shop isn't using. */
  const mode = useMemo(() => zoneMode(zones), [zones]);
  /** The areas this shop delivers to. This list IS the picker below. */
  const deliveryAreas = useMemo(() => areaZoneNames(zones), [zones]);
  const needsPostcode = postcodeRequiredFor(shopCountry);

  // Auto-derived delivery fee. Identical logic to the server's — literally the
  // same function — so the fee shown in the cart is the fee charged at
  // checkout. Distance is left undefined here: measuring it needs a geocoder,
  // and the server does that half.
  const match = useMemo(() => {
    if (fulfillmentType !== "DELIVERY") return null;
    if (!zones.length) return null;
    return resolveZone(zones, {
      postcode: addrPostcode,
      area: addrArea,
    });
  }, [fulfillmentType, addrPostcode, addrArea, zones]);
  const matchedZone = match?.matched
    ? {
        prefix: match.label ?? "",
        fee: match.fee,
        minOrder: match.minOrderValue,
      }
    : null;
  /** The customer picked an area this shop doesn't serve. A refusal, not a
   *  pricing gap — the picker was built from the shop's own zone list, so
   *  there is no mistyped-postcode case to be generous about. */
  const areaUnserviceable = match?.unserviceable === true;

  // Distance bands: ask the server for the REAL band.
  //
  // The browser can't measure distance, so resolveZone above falls back to the
  // furthest band — which meant choosing "Delivery" quoted the top price
  // before an address was even typed, and a two-mile customer saw the 3–5 mile
  // fee. The server can geocode, so once there is something to price, ask it.
  //
  // Until it answers the maximum stands: quoting low and charging more at
  // checkout is the one direction that surprises a customer.
  const [radiusQuote, setRadiusQuote] = useState<
    { fee: number; label: string | null; distanceMiles: number | null } | null
  >(null);
  const quoteLocationId = storefront?.location?.id;

  useEffect(() => {
    if (fulfillmentType !== "DELIVERY" || mode !== "RADIUS" || !quoteLocationId) {
      setRadiusQuote(null);
      return;
    }
    const postcode = addrPostcode.trim();
    const area = addrArea.trim();
    const lat = addrPoint?.lat;
    const lng = addrPoint?.lng;
    // Nothing to price on yet — leave the maximum showing.
    if (!postcode && !area && lat == null) {
      setRadiusQuote(null);
      return;
    }

    let cancelled = false;
    // Debounced: this geocodes, and firing per keystroke would be both slow
    // and, outside the UK, a paid call per character.
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ locationId: quoteLocationId });
        // Bands can hang off the brand rather than the location, so the brand
        // has to travel with the question or the server finds no zones at all.
        if (brandId) params.set("brandId", brandId);
        if (postcode) params.set("postcode", postcode);
        if (area) params.set("area", area);
        if (lat != null && lng != null) {
          params.set("lat", String(lat));
          params.set("lng", String(lng));
        }
        const res = await fetch(
          `${API_BASE}/v1/delivery-zones/public/quote?${params.toString()}`,
        );
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled || !body?.matched) return;
        setRadiusQuote({
          fee: Number(body.fee) || 0,
          label: body.zoneLabel ?? body.label ?? null,
          distanceMiles:
            typeof body.distanceMiles === "number" ? body.distanceMiles : null,
        });
      } catch {
        // Keep the safe maximum rather than showing nothing.
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    fulfillmentType,
    mode,
    quoteLocationId,
    brandId,
    addrPostcode,
    addrArea,
    addrPoint?.lat,
    addrPoint?.lng,
  ]);

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
  // A postcode that doesn't match any configured zone is a data gap, not a
  // free ride — charge the brand's highest configured fee instead of 0, so
  // the customer never gets accidental free delivery and the order still
  // goes through. The checkout endpoint re-enforces this same fallback
  // server-side, so a tampered cart can't force it back to 0 either.
  const highestZoneFee = useMemo(
    () =>
      (storefront?.deliveryZones ?? []).reduce(
        (max, z) => Math.max(max, Number(z.fee)),
        0,
      ),
    [storefront?.deliveryZones],
  );
  // Postcode/radius only. In area mode an unmatched address is refused
  // outright, so quietly charging it the top rate would be charging for a
  // delivery we've already said we won't make.
  const noZoneMatched =
    fulfillmentType === "DELIVERY" &&
    mode !== "AREA" &&
    !matchedZone &&
    addrPostcode.replace(/\s+/g, "").length >= 3 &&
    highestZoneFee > 0;
  // The server's answer wins over the browser's worst case.
  const rawDeliveryFee =
    radiusQuote?.fee ?? matchedZone?.fee ?? (noZoneMatched ? highestZoneFee : 0);
  const deliveryFee = freeDelivery ? 0 : rawDeliveryFee;

  // Phase AW-19 — auto-apply the storefront's matched marketing
  // campaign. Server returns the eligible campaign in
  // storefront.campaign; we apply it as a discount line on the cart
  // when the subtotal clears its minOrder (if set). Re-resolves
  // server-side at checkout so a tampered total can't cheat.
  const storeCampaign = (storefront as any)?.campaign ?? null;
  // Phase AW-19 — per-item promo map from PERCENT_OFF_ITEMS campaigns.
  // Keyed by itemId → { percentageOff, campaignName }. Drives the
  // strikethrough badge on MenuItemCard and the discounted unitPrice
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
  // Retail — multi-buys ("3 for £2", meal deals) come off first, with the
  // same engine the checkout charges by; the campaign or promo code then
  // applies to what's left.
  const multiBuyDeals: MultiBuyDeal[] = (storefront as any)?.multiBuys ?? [];
  const multiBuy = useMemo(
    () =>
      applyMultiBuys(
        cart.map((l) => ({ menuItemId: l.menuItemId, unitPrice: l.unitPrice, quantity: l.quantity })),
        multiBuyDeals,
      ),
    [cart, multiBuyDeals],
  );
  const afterDeals = round2(Math.max(0, subtotal - multiBuy.savings));
  // The first multi-buy each product counts towards, for its tile badge.
  const dealLabelFor = useCallback(
    (itemId: string): string | null => {
      const d = multiBuyDeals.find((x) =>
        x.mode === "MEAL_DEAL" ? x.slots.some((sl) => sl.itemIds.includes(itemId)) : x.itemIds.includes(itemId),
      );
      return d ? describeMultiBuy(d, currencySymbol(currency)) : null;
    },
    [multiBuyDeals, currency],
  );
  const campaignClears =
    storeCampaign &&
    (storeCampaign.minOrder == null ||
      afterDeals >= Number(storeCampaign.minOrder));
  const campaignDiscount = !campaignClears
    ? 0
    : storeCampaign.percentageOff != null
      ? Math.round(afterDeals * Number(storeCampaign.percentageOff)) / 100
      : storeCampaign.amountOff != null
        ? Math.min(afterDeals, Number(storeCampaign.amountOff))
        : 0;
  // The promo code and the campaign don't stack — the larger applies, on
  // top of any multi-buy saving.
  const effectiveDiscount = round2(
    multiBuy.savings + Math.max(Math.min(promoDiscount, afterDeals), campaignDiscount),
  );
  // Challenge 25 — the highest age any product in the basket needs.
  const cartMinAge = basketMinAge(cart.map((l) => itemsById[l.menuItemId] as any));

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
    () =>
      (((storefront as any)?.topSellers ?? []) as MenuItem[]).filter((it) =>
        itemAllowsFulfillment(it, fulfillmentType),
      ),
    [storefront, fulfillmentType],
  );
  const promoItems: MenuItem[] = useMemo(() => {
    const seen = new Set<string>();
    const out: MenuItem[] = [];
    for (const cat of allCategories) {
      for (const link of (cat as any).items ?? []) {
        const item = link?.item as MenuItem | undefined;
        if (!item?.id || seen.has(item.id)) continue;
        if (!itemAllowsFulfillment(item, fulfillmentType)) continue;
        if (!itemPromos[item.id]) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [allCategories, itemPromos, fulfillmentType]);

  // Inline quantity control on the menu row.
  //
  // Only for items with nothing to choose — no modifier groups and no sizes.
  // For those, opening a modal to press one button is friction, and the
  // customer can't otherwise see how many they've already added without
  // opening the cart. Anything configurable still opens the sheet, because a
  // second "Large, no onions" is not the same line as the first.
  // Retail R3 — a GROCERY/RETAIL location gets the shop layout: product tiles
  // with steppers, stock-aware, per-line substitution in the basket.
  const isShop =
    storefront?.location?.businessType === "GROCERY" ||
    storefront?.location?.businessType === "RETAIL";
  // A barber or salon has no menu to order from: its storefront link (the
  // one already on Instagram and Google) opens the booking page instead.
  const salonLocationId =
    storefront?.location?.businessType === "SALON" ? storefront.location.id : null;
  useEffect(() => {
    if (salonLocationId) window.location.replace(`/salon/${encodeURIComponent(salonLocationId)}`);
  }, [salonLocationId]);
  const shopMinDelivery = isShop ? Number(cfg?.minOrderForDelivery ?? 0) || null : null;

  const isSimpleItem = useCallback(
    (item: MenuItem) =>
      !(item.modifierGroupLinks?.length ?? 0) &&
      !(item as any).hasMultipleSkus &&
      !normaliseSellBy((item as any).sellBy),
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
      // A whole category can be turned off for a service mode, which takes
      // everything inside it — skip it rather than rendering an empty heading.
      if (!itemAllowsFulfillment(cat, fulfillmentType)) continue;
      const items = cat.items
        .filter((link) => link.item.isAvailable)
        .map((link) => link.item)
        // Products the shop does not sell this way. Switching between
        // collection and delivery re-runs this, so the menu changes with the
        // choice rather than failing at checkout.
        .filter((it) => itemAllowsFulfillment(it, fulfillmentType))
        .filter(
          (it) =>
            !q ||
            it.name.toLowerCase().includes(q) ||
            (it.description ?? "").toLowerCase().includes(q),
        );
      // Empty categories are left out: the tabs are a table of contents for
      // the sections below, and a tab with no section has nowhere to go.
      if (items.length > 0) lists.push({ cat, items });
    }
    return lists;
  }, [allCategories, search, fulfillmentType]);

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
          // Same shape the ordinary checkout sends, including the size and
          // option ids the server needs to price the line when the host places.
          modifiers: line.modifiers.map((m) => ({
            ...toOrderLineModifier(m),
            ...(m.id ? { optionId: m.id } : {}),
          })),
          ...(line.selectedSku ? { skuPlu: line.selectedSku.plu ?? null, skuName: line.selectedSku.name } : {}),
          ...(line.weightGrams ? { weightGrams: line.weightGrams } : {}),
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

  // Challenge 25 for a group basket: every guest's lines, looked up on the menu.
  const groupMinAge = basketMinAge(
    (basket?.items ?? []).map((i: any) => itemsById[String(i.cartItem?.menuItemId ?? "")] as any),
  );
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
                postcode: addrPostcode || undefined,
                area: addrArea || undefined,
                latitude: addrPoint?.lat,
                longitude: addrPoint?.lng,
                // The SHOP's country, not a constant. Hardcoding "GB" put a
                // Dubai delivery in the United Kingdom on the order record,
                // the ticket and the dispatch map.
                country: shopCountry,
              }
            : undefined,
        deliveryFee:
          basket?.fulfillmentType === "DELIVERY" ? deliveryFee : 0,
        specialInstructions: notes || undefined,
        paymentMethod,
        // Stable per basket: a double-tap on Place order can't become two
        // orders, and neither can a retry after a dropped connection.
        idempotencyKey: `group-${groupToken}`,
        ...(groupMinAge ? { ageConfirmed } : {}),
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
        // The option id and the size let the server price the line exactly
        // (it re-prices every line; unitPrice here is only a cross-check).
        modifiers: l.modifiers.map((m) => ({
          ...toOrderLineModifier(m),
          ...(m.id ? { optionId: m.id } : {}),
        })),
        ...(l.selectedSku ? { skuPlu: l.selectedSku.plu ?? null, skuName: l.selectedSku.name } : {}),
        ...(l.weightGrams ? { weightGrams: l.weightGrams } : {}),
        notes: l.notes,
        // Retail R3 — ignored by the server for restaurants.
        ...(l.substitution ? { substitution: l.substitution } : {}),
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
                postcode: addrPostcode || undefined,
                area: addrArea || undefined,
                latitude: addrPoint?.lat,
                longitude: addrPoint?.lng,
                country: shopCountry,
              }
            : undefined,
        items,
        subtotal,
        deliveryFee,
        tipAmount,
        total: round2(orderTotal + tipAmount),
        specialInstructions: notes || undefined,
        scheduledFor: scheduledFor ?? undefined,
        paymentMethod,
        // Card is paid on this page (Apple Pay / Google Pay / card form)
        // rather than on Stripe's hosted page, so ask for a PaymentIntent
        // secret instead of a redirect URL. Ignored for cash.
        embedded: paymentMethod === "CARD",
        // Inside a restaurant app: lets the payment return pages hand the
        // customer back to the app from the Chrome tab it pays in (Android).
        appScheme: restaurantAppScheme() ?? undefined,
        appAutoReturn: restaurantAppAutoReturn() || undefined,
        // Phase AP fix #1 — applied promo discount lands on the order
        // so it shows in operator + accounting reports.
        discount: orderDiscount,
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
        // The reward the customer chose to spend. The id only — the server
        // takes the item and its price from the reward itself, because a
        // basket that says "this is free" is a basket anyone can write.
        loyaltyRewardId:
          useLoyaltyReward && loyaltyReward && loyaltyMoney.short === 0 ? loyaltyReward.id : undefined,
        // "Keep me updated by SMS" checkbox → SMS-marketing consent.
        marketingConsent: smsMarketingConsent,
        // "Email me offers" → email-marketing consent, separate from SMS.
        emailMarketingConsent,
        // The marketing email this visit came from, if any (?er= on the link).
        emailRecipientId: readEmailRef(),
        // Challenge 25 — the server refuses a restricted basket without it.
        ...(cartMinAge ? { ageConfirmed } : {}),
      };
      return axios
        .post(`${API_BASE}/v1/ordering/store/${slug}/checkout`, payload, {
          params: brandId ? { brand: brandId } : undefined,
        })
        .then((r) => r.data);
    },
    onSuccess: (order) => {
      // Inside a restaurant's own app: tell the shell about the order so it
      // follows it for push. The app's injected checkout hook can miss on
      // Android (its script races the page load), and a cash order confirms
      // in place with no URL for it to notice — so every stage went out to
      // "no subscribers". ReactNativeWebView is added natively to every page.
      try {
        const rn = (window as any).ReactNativeWebView;
        if (order?.id && rn?.postMessage) {
          rn.postMessage(
            JSON.stringify({
              type: "checkout",
              orderId: String(order.id),
              checkoutUrl: order.checkoutUrl || null,
              pendingPayment: !!order.clientSecret,
              url: window.location.href,
            }),
          );
        }
      } catch {}
      // Embedded card — the order exists but isn't paid yet, so open the
      // payment sheet over the page. The cart is deliberately NOT cleared
      // here: if the customer backs out or their card is declined, they
      // land back on a basket they can retry from. It clears on success.
      if (order?.clientSecret && order?.stripeAccountId) {
        setPendingPayment({
          clientSecret: order.clientSecret,
          stripeAccountId: order.stripeAccountId,
          amountPence: order.amountPence ?? Math.round(order.total * 100),
          orderId: order.id,
        });
        setCartOpen(false);
        return;
      }
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
        clearCart(cartKey);
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
  const {
    customer: authCustomer,
    token: customerToken,
    logout: logoutCustomer,
    updateProfile,
  } = useCustomerAuth();
  // "Save my details for next time" at checkout. On by default: the whole
  // point is not typing the address again.
  const [saveDetails, setSaveDetails] = useState(true);

  // A reward waiting on this customer's card at this shop. Read at checkout
  // rather than carried in the basket, so it reflects what they actually have
  // right now — a reward spent on another device between adding to the basket
  // and paying should not still be offered here.
  const { data: claimable } = useQuery({
    queryKey: ["loyalty-claimable", storefront?.location?.id, authCustomer?.id],
    enabled: !!storefront?.location?.id && !!customerToken,
    queryFn: () =>
      axios
        .get(`${API_BASE}/v1/loyalty/claimable`, {
          params: { locationId: storefront!.location.id },
          headers: { Authorization: `Bearer ${customerToken}` },
        })
        .then(
          (r) =>
            r.data as Array<
              { id: string; label: string } & Pick<LoyaltyRewardTerms, "percentOff" | "amountOff" | "maxDiscount" | "minOrder">
            >,
        ),
  });
  const loyaltyReward = claimable?.[0] ?? null;
  // Opt IN, not out. Someone may be saving it for a bigger order, and
  // spending it for them is spending something they earned.
  const [useLoyaltyReward, setUseLoyaltyReward] = useState(false);
  // A money-off reward (% or £ off) comes off after deals and offers, worked
  // out exactly as the server does it. Under its minimum order it gives
  // nothing and is not spent. A free-item reward is a £0 line instead.
  const loyaltyMoney =
    useLoyaltyReward && loyaltyReward && loyaltyRewardKind(loyaltyReward) !== "FREE_ITEM"
      ? loyaltyRewardDiscount(loyaltyReward, subtotal - effectiveDiscount)
      : { amount: 0, short: 0 };
  const orderDiscount = round2(effectiveDiscount + loyaltyMoney.amount);
  const orderTotal = round2(Math.max(0, total - loyaltyMoney.amount));
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
    // The saved address, but never over anything already typed.
    if (!addrLine1 && !addrFlat && !addrPostcode && authCustomer.addressLine1) {
      setAddrLine1(authCustomer.addressLine1);
      if (authCustomer.addressLine2) setAddrFlat(authCustomer.addressLine2);
      if (authCustomer.addressCity) setAddrCity(authCustomer.addressCity);
      if (authCustomer.addressPostcode) setAddrPostcode(authCustomer.addressPostcode);
      if (authCustomer.addressArea) setAddrArea(authCustomer.addressArea);
    }
    // Signed in from the checkout's own "Place order" (email + password,
    // same page): carry on to the tip step exactly as if they had been
    // signed in all along. This used to call checkout.mutate() directly,
    // which skipped the tip and the undo hold and placed the order the
    // instant the modal closed.
    if (pendingPlaceOrder) {
      setPendingPlaceOrder(false);
      forgetCheckout();
      setCartOpen(true);
      setTipOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authCustomer]);

  // Back from a sign-in that LEFT the page (Google, or the confirmation
  // email). First make sure we're on the brand they were ordering from — the
  // basket is saved per brand, so the wrong URL shows an empty one — then,
  // once signed in with the basket loaded, reopen it where they left off.
  useEffect(() => {
    const note = readCheckout(String(slug));
    if (note?.brandId && !brandId) {
      router.replace(`/order/${slug}?brand=${encodeURIComponent(note.brandId)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, brandId]);
  useEffect(() => {
    if (!authCustomer || hydratedKey !== cartKey) return;
    const note = readCheckout(String(slug));
    if (!note || (note.brandId ?? null) !== brandId) return;
    forgetCheckout();
    if (cart.length > 0) setCartOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authCustomer, hydratedKey, cartKey]);

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
      rememberCheckout(String(slug), brandId);
      setLoginOpen(true);
      return;
    }
    // Next order on any of their shops starts filled in. Fire and forget:
    // a failed save must never stand between the customer and their food.
    if (saveDetails) {
      const delivery = fulfillmentType === "DELIVERY";
      void updateProfile({
        phone: customerPhone.trim() || undefined,
        ...(delivery && addrLine1.trim()
          ? {
              addressLine1: addrLine1.trim(),
              addressLine2: addrFlat.trim() || null,
              addressCity: addrCity.trim() || null,
              addressPostcode: addrPostcode.trim() || null,
              addressArea: addrArea.trim() || null,
            }
          : {}),
      }).catch(() => undefined);
    }
    // Ask about a tip, then hold. The order is deliberately NOT created
    // until the hold expires — see PlacingOrderSheet.
    setTipOpen(true);
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
        // Lets a once-per-customer code say "already used" here, not at payment.
        customerAccountId: authCustomer?.id ?? undefined,
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

  // Never sit on a mode the shop doesn't offer. A delivery-only shop shows
  // just the Delivery pill, but the page starts on collection — so nothing
  // looked selected and an order placed without tapping it went through as
  // a collection.
  useEffect(() => {
    if (groupMode || !cfg) return;
    const acceptDelivery = cfg.acceptsDelivery ?? true;
    const acceptCollection = cfg.acceptsCollection ?? true;
    if (fulfillmentType === "PICKUP" && !acceptCollection && acceptDelivery) {
      setFulfillmentType("DELIVERY");
    } else if (fulfillmentType === "DELIVERY" && !acceptDelivery && acceptCollection) {
      setFulfillmentType("PICKUP");
    }
  }, [fulfillmentType, cfg, groupMode]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (storefrontQuery.isLoading) {
    return <StorefrontSkeleton />;
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
        customerApp={(storefront as any).customerApp ?? null}
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
  // Not inside the restaurant's own app: it already is the ordering channel,
  // and sending its customer off to WhatsApp mid-order is a step backwards.
  const whatsappHref = waDigits && !inApp
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

  // The brand's own colour (Brands → storefront settings). Per brand, so
  // ?brand= swaps it along with the name and logo; none set = default accent.
  const brandColour = pickBrandColour(storefront.brand?.primaryColor);
  const searching = !!search.trim();
  const menuTabs: CategoryTab[] = [
    ...(!searching && promoItems.length > 0
      ? [{ id: "promotions", label: "Promotions" }]
      : []),
    ...(!searching && topSellers.length > 0
      ? [{ id: "top-sellers", label: "Top sellers" }]
      : []),
    ...visibleItems.map(({ cat }) => ({ id: cat.id, label: cat.name })),
  ];
  const basketCount = groupMode ? groupCount : cartCount;
  const basketSubtotal = groupMode ? (basket?.subtotal ?? 0) : subtotal;
  const openBasket = () =>
    groupMode ? basket && setGroupPanelOpen(true) : setCartOpen(true);
  // A full loyalty card is an order on its own — keep a way into checkout
  // even with nothing else in the basket.
  const rewardOnly =
    !groupMode && cartCount === 0 && !!loyaltyReward && loyaltyRewardKind(loyaltyReward) === "FREE_ITEM";
  const chipClass =
    "inline-flex h-11 items-center gap-1.5 rounded-full border border-sf-border bg-sf-surface px-3.5 text-[13px] font-semibold text-sf-text transition-[border-color,transform] duration-150 hover:border-sf-border-strong active:scale-[0.97] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sf-bg";

  return (
    <div className="sf-root min-h-screen" style={storefrontThemeStyle(brandColour)}>
      <WelcomeSplash
        splash={storefront.splash}
        storeKey={String(slug)}
        shopName={headerTitle}
        preview={searchParams?.get("splash") === "preview"}
        skip={!!groupToken || !!searchParams?.get("reorder")}
      />
      {/* Phase AX — makes this storefront installable as the restaurant's own
          app, and on iOS is what unlocks Web Push at all. Renders nothing. */}
      <PwaManifestLink
        slug={slug}
        brandId={brandId}
        name={headerTitle}
        logoUrl={logoUrl}
      />
      {/* Top nav. No basket here: on a phone it lives in the bar at the
          bottom where the thumb is, on a laptop in the panel beside the menu. */}
      {/* "Get the app" on phones, when this brand's own app is promoted. */}
      <AppInstallBanner
        app={(storefront as any).customerApp ?? null}
        brandKey={brandId ?? slug}
        name={headerTitle}
        logoUrl={logoUrl}
      />
      <header className="sticky top-0 z-40 h-16 border-b border-sf-border bg-sf-surface">
        <div className="mx-auto flex h-full max-w-6xl items-center gap-3 px-4">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              className="h-10 w-10 shrink-0 rounded-xl bg-white object-contain p-1 ring-1 ring-sf-border"
            />
          ) : (
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sf-cta text-base font-bold text-white">
              {headerTitle.slice(0, 1).toUpperCase()}
            </div>
          )}
          <span className="min-w-0 truncate text-[15px] font-semibold text-sf-text">
            {headerTitle}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* Book a table — booking and ordering are the two things a diner
                comes here to do. Quiet, so it never competes with the basket. */}
            {bookingHref && (
              <a
                href={bookingHref}
                aria-label="Book a table"
                className="inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-full px-2.5 text-sm font-semibold text-sf-text transition-colors hover:bg-sf-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent sm:px-3.5"
              >
                <CalendarDays className="h-5 w-5 shrink-0" aria-hidden />
                <span className="hidden whitespace-nowrap sm:inline">Book a table</span>
              </a>
            )}
            {/* Phase AP-AUTH increment 2b — persistent customer auth control:
                a person icon pre-auth, the avatar + account menu after. */}
            <HeaderAuthButton
              customer={authCustomer ?? null}
              onSignInClick={() => setLoginOpen(true)}
              onLogout={logoutCustomer}
              myOrdersHref={`/order/${slug}/my-orders${brandId ? `?brand=${brandId}` : ""}`}
              rewardsHref={`/order/${slug}/rewards${brandId ? `?brand=${brandId}` : ""}`}
              accountHref={`/order/${slug}/account${brandId ? `?brand=${brandId}` : ""}`}
            />
          </div>
        </div>
      </header>

      {/* Hero banner */}
      <div className="relative h-44 w-full overflow-hidden bg-sf-raised sm:h-64 lg:h-72">
        {heroImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={heroImage} alt="" className="h-full w-full object-cover" />
        ) : (
          <div
            className="h-full w-full"
            style={{
              background:
                "linear-gradient(135deg, color-mix(in srgb, var(--sf-accent) 28%, var(--sf-bg)) 0%, var(--sf-bg) 100%)",
            }}
          />
        )}
      </div>

      <div className="mx-auto max-w-6xl px-4">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-8">
          <main className="min-w-0">
            {/* Restaurant identity. Only the logo overlaps the hero; the name
                sits below it, so a long name never clips into the banner. */}
            <section aria-labelledby="store-name">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt=""
                  className="relative -mt-10 h-20 w-20 rounded-2xl bg-white object-contain p-1.5 shadow-[0_6px_20px_-8px_rgba(0,0,0,0.35)] ring-4 ring-[var(--sf-bg)] sm:-mt-12 sm:h-24 sm:w-24"
                />
              ) : (
                <div className="relative -mt-10 grid h-20 w-20 place-items-center rounded-2xl bg-sf-cta text-3xl font-bold text-white ring-4 ring-[var(--sf-bg)] sm:-mt-12 sm:h-24 sm:w-24">
                  {headerTitle.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="mt-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1
                    id="store-name"
                    className="text-2xl font-bold tracking-tight text-sf-text [overflow-wrap:anywhere] [text-wrap:balance] sm:text-3xl"
                  >
                    {headerTitle}
                  </h1>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-sf-muted">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-sf-text">
                      <span
                        aria-hidden
                        className={cn(
                          "h-2 w-2 rounded-full",
                          storefront.isOpen && !storefront.closed ? "bg-emerald-500" : "bg-zinc-400",
                        )}
                      />
                      {storefront.isOpen && !storefront.closed ? "Open now" : "Closed"}
                    </span>
                    {headerAddress && (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span className="min-w-0">{headerAddress}</span>
                      </span>
                    )}
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
                </div>
                <button
                  type="button"
                  onClick={() => setInfoOpen(true)}
                  className={cn(chipClass, "shrink-0")}
                >
                  <Info className="h-4 w-4" aria-hidden /> Info
                </button>
              </div>

              {/* FSA food hygiene rating — refreshed nightly by the API. */}
              {storefront.hygiene && (
                <div className="mt-3">
                  <HygieneBadge hygiene={storefront.hygiene} />
                </div>
              )}

              {/* How, when and who. */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {(acceptDelivery || acceptCollection) && (
                  <div
                    role="group"
                    aria-label="Order type"
                    className="inline-flex rounded-full bg-sf-raised p-1"
                  >
                    {acceptDelivery && (
                      <FulfillmentPill
                        active={fulfillmentType === "DELIVERY"}
                        // Fixed by the host in group mode — it decides the fees the
                        // whole group is sharing, so it can't move once people have
                        // started adding.
                        onClick={() => !groupMode && setFulfillmentType("DELIVERY")}
                        icon={<Bike className="h-4 w-4" aria-hidden />}
                        label="Delivery"
                        sub={`${cfg?.deliveryPrepMinutes ?? 45} min`}
                      />
                    )}
                    {acceptCollection && (
                      <FulfillmentPill
                        active={fulfillmentType === "PICKUP"}
                        onClick={() => !groupMode && setFulfillmentType("PICKUP")}
                        icon={<ShoppingBag className="h-4 w-4" aria-hidden />}
                        label="Pickup"
                        sub={`${cfg?.collectionPrepMinutes ?? 20} min`}
                      />
                    )}
                  </div>
                )}
                {!groupMode && (
                  <button onClick={() => setScheduleOpen(true)} className={chipClass}>
                    <Clock className="h-4 w-4" aria-hidden />
                    {scheduledFor
                      ? `Scheduled ${formatScheduledFor(scheduledFor)}`
                      : "Schedule"}
                  </button>
                )}
                {/* Order together — one basket, several people, one order.
                    Hidden while the shop is paused, like every other way into
                    a basket. */}
                {!groupMode && !storefront.closed && (
                  <button onClick={() => setStartGroupOpen(true)} className={chipClass}>
                    <Users className="h-4 w-4" aria-hidden />
                    Order together
                  </button>
                )}
                {/* WhatsApp ordering is another way to place the order, the
                    same kind of choice as collection or delivery. */}
                {whatsappHref && (
                  <a
                    href={whatsappHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={chipClass}
                  >
                    <WhatsAppIcon className="h-4 w-4 shrink-0 text-[#25D366]" />
                    WhatsApp AI ordering
                    <span className="sr-only"> (opens WhatsApp in a new tab)</span>
                  </a>
                )}
                {bookingHref && (
                  <a href={bookingHref} className={chipClass}>
                    <CalendarDays className="h-4 w-4" aria-hidden />
                    Book a table
                  </a>
                )}
              </div>

              <div>
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
                              } ${basket.people.length === 1 ? "person" : "people"} · ${money(
                                basket.subtotal,
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
                      : `${money(Number(storeCampaign.amountOff))} off your order`}
                    {storeCampaign.minOrder
                      ? ` on ${money(Number(storeCampaign.minOrder))}+`
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
                      ✨ Spend {money(freeItem.minOrder)} and get {headline}
                    </p>
                    <p className="mt-0.5 text-[11px] text-amber-800">
                      {eligible
                        ? "🎉 Unlocked! Pick your free item in the cart."
                        : `Add ${money(remaining)} more (eligible items only) to unlock.`}
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
            </section>

            {/* Refer a friend, above the menu. It only works if somebody
                notices it and tells a friend; renders nothing when the shop
                runs no programme. */}
            <div className="mt-5 empty:hidden">
              <ReferAFriend
                locationId={storefront?.location?.id}
                brandName={storefront?.brand?.name ?? storefront?.location?.name}
                shareUrl={
                  typeof window !== "undefined"
                    ? `${window.location.origin}/order/${encodeURIComponent(String(slug))}${brandId ? `?brand=${brandId}` : ""}`
                    : ""
                }
                currency={currency}
                token={customerToken}
              />
            </div>

            {/* Search */}
            <div className="mt-6">
              <label className="relative block">
                <span className="sr-only">Search the menu</span>
                <Search
                  className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-sf-muted"
                  aria-hidden
                />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={isShop ? "Search products…" : "Search for food…"}
                  className="h-12 w-full rounded-full border border-sf-border bg-sf-surface pl-11 pr-4 text-[15px] text-sf-text placeholder:text-sf-muted focus:border-sf-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent"
                />
              </label>
            </div>

            {/* Sticky category tabs — scroll-spy, tap to jump. */}
            <div className="h-3" aria-hidden />
            <CategoryTabs tabs={menuTabs} stickyTop={64} />

            {/* Menu */}
            <div className="space-y-10 pb-16 pt-6">
              {/* Promotions and Top sellers lead the menu — the two things a
                  browsing customer responds to first. Hidden while searching,
                  so they never sit between the customer and what they asked for. */}
              {!searching && promoItems.length > 0 && (
                <section id={sectionDomId("promotions")} aria-labelledby="h-promotions">
                  <h2 id="h-promotions" className="mb-3 text-xl font-bold tracking-tight text-sf-text [overflow-wrap:anywhere]">
                    Promotions
                  </h2>
                  <ItemRail
                    money={money}
                    items={promoItems}
                    itemPromos={itemPromos}
                    showImage={cfg?.showItemImages ?? true}
                    onPick={handleProductClick}
                  />
                </section>
              )}
              {!searching && topSellers.length > 0 && (
                <section id={sectionDomId("top-sellers")} aria-labelledby="h-top-sellers">
                  <h2 id="h-top-sellers" className="mb-3 text-xl font-bold tracking-tight text-sf-text [overflow-wrap:anywhere]">
                    Top sellers
                  </h2>
                  <ItemRail
                    money={money}
                    items={topSellers}
                    itemPromos={itemPromos}
                    showImage={cfg?.showItemImages ?? true}
                    onPick={handleProductClick}
                  />
                </section>
              )}

              {visibleItems.length === 0 ? (
                <p className="py-16 text-center text-sm text-sf-muted">
                  {searching ? "No items match your search." : "Nothing on the menu yet — check back soon."}
                </p>
              ) : (
                visibleItems.map(({ cat, items }) => (
                  <section
                    key={cat.id}
                    id={sectionDomId(cat.id)}
                    aria-labelledby={`h-${cat.id}`}
                  >
                    <h2
                      id={`h-${cat.id}`}
                      className="mb-3 text-xl font-bold tracking-tight text-sf-text [overflow-wrap:anywhere]"
                    >
                      {cat.name}
                    </h2>
                    {isShop ? (
                      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
                        {items.map((item) => {
                          const { amount, from } = displayPrice(item as any);
                          const promo = itemPromos[item.id] ?? null;
                          const off = promo && promo.percentageOff > 0 ? promo.percentageOff : 0;
                          const simple = isSimpleItem(item);
                          return (
                            <ShopProductTile
                              key={item.id}
                              name={item.name}
                              imageUrl={(cfg?.showItemImages ?? true) ? (item as any).imageUrl : null}
                              price={money(off ? Math.round(amount * (1 - off / 100) * 100) / 100 : amount)}
                              wasPrice={off ? money(amount) : null}
                              fromPrice={!!from}
                              soldOut={!!(item as any).outOfStock}
                              qty={simple ? (plainLineFor(item.id)?.quantity ?? 0) : 0}
                              simple={simple}
                              onInc={() => handleProductClick(item)}
                              onDec={() => {
                                const line = plainLineFor(item.id);
                                if (line) dispatch({ type: "DECREMENT", id: line.id });
                              }}
                              onOpen={() => openItemSheet(item)}
                              unitSuffix={
                                normaliseSellBy((item as any).sellBy)
                                  ? sellByLabel(normaliseSellBy((item as any).sellBy) as SellBy)
                                  : null
                              }
                              deal={dealLabelFor(item.id)}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2">
                        {items.map((item) => (
                          <MenuItemCard
                            key={item.id}
                            item={item}
                            money={money}
                            promo={itemPromos[item.id] ?? null}
                            bogoTrigger={bogoTriggerSet.has(item.id)}
                            showImage={cfg?.showItemImages ?? true}
                            categoryName={cat.name}
                            disabled={!!storefront.closed}
                            onOpen={() => openItemSheet(item)}
                            onQuickAdd={() => handleProductClick(item)}
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
          </main>

          {/* Desktop basket — beside the menu, always in view. */}
          <BasketPanel
            title={groupMode ? "Group basket" : "Your basket"}
            lines={
              groupMode
                ? []
                : cart.map((l) => ({
                    id: l.id,
                    name: l.displayName,
                    detail: l.modifiers.map((m) => m.name).join(", ") || null,
                    quantity: l.quantity,
                    lineTotal: money(l.unitPrice * l.quantity),
                  }))
            }
            count={basketCount}
            subtotal={money(basketSubtotal)}
            ctaLabel={groupMode ? "View group basket" : "Go to checkout"}
            onCta={openBasket}
            ctaDisabled={groupMode && !basket}
            onInc={groupMode ? undefined : (id) => dispatch({ type: "INCREMENT", id })}
            onDec={groupMode ? undefined : (id) => dispatch({ type: "DECREMENT", id })}
            footnote={
              groupMode
                ? "Everyone's items go in together as one order."
                : fulfillmentType === "DELIVERY"
                  ? "Delivery fee and offers are added at checkout."
                  : "Offers are applied at checkout."
            }
            emptyAction={
              rewardOnly
                ? { label: "Claim your reward", onClick: () => setCartOpen(true) }
                : null
            }
          />
        </div>
      </div>

      {/* Shared basket — replaces the cart panel entirely in group mode. */}
      {groupPanelOpen && basket && (
        <GroupBasketPanel
          money={money}
          basket={basket}
          myRef={groupRef}
          shareUrl={groupOrdersClient.shareUrl(String(slug), basket.token)}
          onClose={() => setGroupPanelOpen(false)}
          onRemoveItem={(id) => removeFromGroup.mutate(id)}
          minAge={groupMinAge}
          ageConfirmed={ageConfirmed}
          setAgeConfirmed={setAgeConfirmed}
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
          addrArea={addrArea}
          setAddrArea={setAddrArea}
          deliveryAreas={deliveryAreas}
          zoneMode={mode}
          areaUnserviceable={areaUnserviceable}
          shopCountry={shopCountry}
          needsPostcode={needsPostcode}
          onPickAddress={(a) => {
            if (a.line1) setAddrLine1(a.line1);
            // The flat / building the lookup found belongs in the house box,
            // or the order goes out with the street alone.
            if (a.line2) setAddrFlat(a.line2);
            if (a.city) setAddrCity(a.city);
            if (a.postcode) setAddrPostcode(a.postcode.toUpperCase());
            // Preselect the area when Places named one we actually serve.
            // Matching is still exact — a community we don't have a zone for
            // leaves the picker empty rather than guessing a neighbour.
            if (a.area && deliveryAreas.some((z) => sameArea(z, a.area!))) {
              setAddrArea(deliveryAreas.find((z) => sameArea(z, a.area!))!);
            }
            if (a.latitude != null && a.longitude != null) {
              setAddrPoint({ lat: a.latitude, lng: a.longitude });
            }
          }}
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
            if (s.line2) setAddrFlat(s.line2);
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
          money={money}
          onClose={() => setCartOpen(false)}
          cart={cart}
          dispatch={dispatch}
          isShop={isShop}
          minOrderForDelivery={shopMinDelivery}
          subtotal={subtotal}
          deliveryFee={deliveryFee}
          serviceCharge={serviceCharge}
          total={orderTotal}
          loyaltyMoney={loyaltyMoney}
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
          emailMarketingConsent={emailMarketingConsent}
          setEmailMarketingConsent={setEmailMarketingConsent}
          accountEmail={authCustomer?.email ?? null}
          saveDetails={saveDetails}
          setSaveDetails={setSaveDetails}
          loyaltyReward={loyaltyReward}
          useLoyaltyReward={useLoyaltyReward}
          setUseLoyaltyReward={setUseLoyaltyReward}
          setSmsMarketingConsent={setSmsMarketingConsent}
          addrFlat={addrFlat}
          setAddrFlat={setAddrFlat}
          addrLine1={addrLine1}
          setAddrLine1={setAddrLine1}
          addrCity={addrCity}
          setAddrCity={setAddrCity}
          addrArea={addrArea}
          setAddrArea={setAddrArea}
          deliveryAreas={deliveryAreas}
          zoneMode={mode}
          areaUnserviceable={areaUnserviceable}
          shopCountry={shopCountry}
          needsPostcode={needsPostcode}
          onPickAddress={(a) => {
            if (a.line1) setAddrLine1(a.line1);
            // The flat / building the lookup found belongs in the house box,
            // or the order goes out with the street alone.
            if (a.line2) setAddrFlat(a.line2);
            if (a.city) setAddrCity(a.city);
            if (a.postcode) setAddrPostcode(a.postcode.toUpperCase());
            // Preselect the area when Places named one we actually serve.
            // Matching is still exact — a community we don't have a zone for
            // leaves the picker empty rather than guessing a neighbour.
            if (a.area && deliveryAreas.some((z) => sameArea(z, a.area!))) {
              setAddrArea(deliveryAreas.find((z) => sameArea(z, a.area!))!);
            }
            if (a.latitude != null && a.longitude != null) {
              setAddrPoint({ lat: a.latitude, lng: a.longitude });
            }
          }}
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
          multiBuyApplied={multiBuy.applied}
          cartMinAge={cartMinAge}
          ageConfirmed={ageConfirmed}
          setAgeConfirmed={setAgeConfirmed}
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
            if (s.line2) setAddrFlat(s.line2);
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
          quotedFee={radiusQuote?.fee ?? null}
          noZoneMatched={noZoneMatched}
          highestZoneFee={highestZoneFee}
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
      {weighItem && (
        <WeightSheet
          name={weighItem.name}
          pricePerUnit={Number(weighItem.basePrice)}
          sellBy={normaliseSellBy((weighItem as any).sellBy) as SellBy}
          percentageOff={itemPromos[weighItem.id]?.percentageOff ?? 0}
          money={money}
          onClose={() => setWeighItem(null)}
          onAdd={(grams, unitPrice, quantity) => {
            const item = weighItem;
            setWeighItem(null);
            addLine({
              menuItemId: item.id,
              displayName: weighedLineName(
                item.name,
                grams,
                Number(item.basePrice),
                normaliseSellBy((item as any).sellBy) as SellBy,
                currencySymbol(currency),
              ),
              unitPrice,
              quantity,
              modifiers: [],
              selectedSku: null,
              notes: "",
              plu: item.plu ?? null,
              weightGrams: grams,
            });
          }}
        />
      )}

      {modalItem && (
        <ModifierSelectionModal
          item={modalItem}
          currency={currency}
          allModifierGroups={storefront.brandModifierGroups ?? []}
          // Customer-facing: photo-led sheet, one priced Add button. The
          // till keeps the compact dialog — same logic, different chrome.
          presentation="sheet"
          // One question per screen, as the till and table pages already do.
          // A long scroll of every group at once is where customers miss a
          // required choice and then cannot see why the button is disabled.
          flow="stepped"
          heroFallback={
            <FoodPlaceholder name={modalItem.name} className="h-full w-full" />
          }
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
          money={money}
          locationName={headerTitle}
          about={storefront.location.about ?? null}
          address={headerAddress || null}
          openingHours={storefront.location.openingHours}
          deliveryZones={storefront.deliveryZones ?? []}
          shopCountry={shopCountry}
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

      {tipOpen && (
        <TipStep
          money={money}
          symbol={symbol}
          tipBase={subtotal}
          brandName={storefront.brand?.name ?? storefront.location.name}
          isShop={isShop}
          onBack={() => setTipOpen(false)}
          onContinue={(tip) => {
            setTipAmount(tip);
            setTipOpen(false);
            setHolding(true);
          }}
        />
      )}

      {holding && (
        <PlacingOrderSheet
          money={money}
          summary={{
            brandName: storefront.brand?.name ?? storefront.location.name,
            fulfilment:
              fulfillmentType === "DELIVERY" ? "Delivery" : "Collection",
            addressLine:
              fulfillmentType === "DELIVERY"
                ? [addrLine1, addrPostcode].filter(Boolean).join(", ") || null
                : null,
            when: scheduledFor
              ? `Scheduled for ${new Date(scheduledFor).toLocaleString("en-GB", {
                  weekday: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
              : null,
            lines: cart.map((l) => ({
              quantity: l.quantity,
              name: l.displayName,
            })),
            tip: tipAmount,
            total: round2(orderTotal + tipAmount),
          }}
          onCommit={() => {
            setHolding(false);
            checkout.mutate();
          }}
          onCancel={() => setHolding(false)}
        />
      )}

      {pendingPayment && (
        <EmbeddedPaymentSheet
          money={money}
          clientSecret={pendingPayment.clientSecret}
          stripeAccountId={pendingPayment.stripeAccountId}
          amountPence={pendingPayment.amountPence}
          orderId={pendingPayment.orderId}
          slug={String(slug)}
          brandId={brandId}
          onPaid={() => {
            // Paid. Clear the basket from storage synchronously as well as
            // through the reducer — same reason the hosted path does: a
            // customer who reopens the site shouldn't find the order they
            // already paid for still sitting in their cart.
            clearCart(cartKey);
            dispatch({ type: "CLEAR" });
            setPendingPayment(null);
            setConfirmedOrderId(pendingPayment.orderId);
          }}
          onCancel={() => {
            // Backed out before paying. The order exists server-side but
            // unpaid, so it never reaches the staff board — same outcome as
            // abandoning the hosted Stripe page. Their basket is intact.
            setPendingPayment(null);
            setCartOpen(true);
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

      {/* A friend who arrived on someone's ?ref= link. Claimed as soon as
          there is an account to attach it to, so they are told they qualify —
          or that they do not — while they can still do something about it. */}
      <ReferralClaim
        locationId={storefront?.location?.id}
        token={customerToken}
        customerId={authCustomer?.id}
      />


      {/* Mobile tab bar. On a phone a storefront is four places, not one long
          page — what's on, what to order, what you ordered, what you've
          earned — and a footer is the only navigation a thumb can reach while
          scrolling a long menu. Desktop keeps its header and never renders
          this. */}
      {/* Phone / tablet basket — slides up with the first item. */}
      <BasketBar
        count={basketCount}
        total={money(basketSubtotal)}
        label={groupMode ? "View group basket" : "View basket"}
        onOpen={openBasket}
        idleLabel={rewardOnly ? "Claim your reward" : null}
      />

      <PoweredByOrderHub />

      <StorefrontTabBar slug={String(slug)} brandId={brandId} />
    </div>
  );

  /**
   * Open the item sheet — photo, full description, quantity, priced Add.
   *
   * Separate from handleProductClick because on mobile the two gestures mean
   * different things: + adds one immediately, tapping the card asks to SEE the
   * item first. A simple item used to skip the sheet entirely and drop
   * straight into the basket, so its photo and description were unreachable
   * on a phone even though both exist.
   */
  function openItemSheet(item: MenuItem) {
    if (storefront?.closed) return;
    if (normaliseSellBy((item as any).sellBy)) {
      setWeighItem(item);
      return;
    }
    setModalItem(item);
  }

  function handleProductClick(item: MenuItem) {
    // Phase AW-15 — when the storefront is paused, taps on product
    // cards become inert. The customer can still scroll the menu but
    // can't open the modifier sheet or drop anything in the cart.
    if (storefront?.closed) return;
    if (normaliseSellBy((item as any).sellBy)) {
      setWeighItem(item);
      return;
    }
    const hasMods = (item.modifierGroupLinks?.length ?? 0) > 0;
    const multiSku = !!item.hasMultipleSkus;
    if (hasMods || multiSku) {
      setModalItem(item);
      return;
    }
    // Phase AW-19 — apply per-item promo at add time so cart subtotal
    // and order line price are already discounted. MenuItemCard shows
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
  // One half of a segmented control: the selected side lifts onto a surface,
  // the other recedes. Reads as "pick one" without any extra copy.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex min-h-[44px] items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold",
        "transition-[background-color,color,box-shadow] duration-150 motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent",
        active
          ? "bg-sf-surface text-sf-text shadow-[0_1px_4px_rgba(0,0,0,0.14)]"
          : "text-sf-muted hover:text-sf-text",
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="font-medium text-sf-muted">· {sub}</span>
    </button>
  );
}

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
  money,
}: {
  items: MenuItem[];
  itemPromos: Record<string, { percentageOff: number; campaignName: string }>;
  showImage?: boolean;
  onPick: (item: MenuItem) => void;
  /** Bound to THIS store's currency by the page — never format money here. */
  money: (n: number | string | null | undefined) => string;
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
            className="group w-[150px] flex-shrink-0 snap-start rounded-xl text-left transition-transform duration-150 active:scale-[0.97] disabled:opacity-50 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sf-bg sm:w-[170px]"
          >
            {showImage !== false && (
              <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-sf-raised">
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
                  <span
                    aria-hidden
                    className="absolute bottom-1.5 right-1.5 grid h-9 w-9 place-items-center rounded-full bg-sf-cta text-white shadow-md"
                  >
                    <Plus className="h-4 w-4" />
                  </span>
                )}
              </div>
            )}
            <p className="mt-2 line-clamp-2 text-[13px] font-semibold leading-snug text-sf-text">
              {item.name}
            </p>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              {fromSize && (
                <span className="text-[11px] font-medium text-sf-muted">From</span>
              )}
              <span
                className={`text-[13px] font-semibold tabular-nums ${hasPromo ? "text-sf-promo" : "text-sf-text"}`}
              >
                {money(discounted)}
              </span>
              {hasPromo && (
                <span className="text-[12px] tabular-nums text-sf-muted line-through">
                  {money(base)}
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

// ── Cart Panel ─────────────────────────────────────────────────────────────

interface CartPanelProps {
  /** Bound to THIS store's currency by the page — never format money here. */
  money: (n: number | string | null | undefined) => string;
  onClose: () => void;
  cart: CartLine[];
  dispatch: React.Dispatch<CartAction>;
  /** Retail R3 — shop basket: per-line substitution, delivery minimum. */
  isShop?: boolean;
  minOrderForDelivery?: number | null;
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
  emailMarketingConsent: boolean;
  setEmailMarketingConsent: (v: boolean) => void;
  /** The signed-in account's address — where offers would go. */
  accountEmail: string | null;
  /** Signed in: remember phone + address on the account at Place order. */
  saveDetails: boolean;
  setSaveDetails: (v: boolean) => void;
  loyaltyReward: ({ id: string; label: string } & LoyaltyRewardTerms) | null;
  /** What a money-off reward takes off, or how much more it needs. */
  loyaltyMoney: { amount: number; short: number };
  useLoyaltyReward: boolean;
  setUseLoyaltyReward: (v: boolean) => void;
  setSmsMarketingConsent: (v: boolean) => void;
  customerEmail: string;
  setCustomerEmail: (v: string) => void;
  addrFlat: string;
  setAddrFlat: (v: string) => void;
  addrLine1: string;
  setAddrLine1: (v: string) => void;
  addrCity: string;
  setAddrCity: (v: string) => void;
  addrArea: string;
  setAddrArea: (v: string) => void;
  /** The shop's own delivery areas — this list IS the picker. */
  deliveryAreas: string[];
  zoneMode: "AREA" | "RADIUS" | "POSTCODE" | "NONE";
  areaUnserviceable: boolean;
  shopCountry: string;
  needsPostcode: boolean;
  onPickAddress: (a: {
    line1?: string;
    line2?: string;
    city?: string;
    area?: string;
    postcode?: string;
    latitude?: number;
    longitude?: number;
  }) => void;
  addrPostcode: string;
  setAddrPostcode: (v: string) => void;
  paymentMethod: "CASH" | "CARD";
  setPaymentMethod: (v: "CASH" | "CARD") => void;
  notes: string;
  setNotes: (v: string) => void;
  matchedZone: { prefix: string; fee: number; minOrder: number | null } | null;
  /** The server's real distance-band fee, once it has answered. */
  quotedFee: number | null;
  noZoneMatched: boolean;
  highestZoneFee: number;
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
  multiBuyApplied: MultiBuyApplication[];
  cartMinAge: number | null;
  ageConfirmed: boolean;
  setAgeConfirmed: (v: boolean) => void;
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
    money,
    onClose,
    cart,
    isShop,
    minOrderForDelivery,
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
    multiBuyApplied,
    cartMinAge,
    ageConfirmed,
    setAgeConfirmed,
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
    emailMarketingConsent,
    setEmailMarketingConsent,
    accountEmail,
    saveDetails,
    setSaveDetails,
    loyaltyReward,
    loyaltyMoney,
    useLoyaltyReward,
    setUseLoyaltyReward,
    setSmsMarketingConsent,
    addrLine1,
    setAddrLine1,
    addrCity,
    setAddrCity,
    addrArea,
    setAddrArea,
    deliveryAreas,
    zoneMode: mode,
    areaUnserviceable,
    shopCountry,
    needsPostcode,
    onPickAddress,
    addrPostcode,
    setAddrPostcode,
    paymentMethod,
    setPaymentMethod,
    notes,
    setNotes,
    matchedZone,
    quotedFee,
    noZoneMatched,
    highestZoneFee,
    scheduledFor,
    onOpenSchedule,
    onPlace,
    isPlacing,
    placeError,
  } = props;

  // What makes an address complete depends on where the shop is. The UAE has
  // no postal codes in everyday use, so requiring one here left Place order
  // permanently disabled for every Gulf customer — no error, no explanation,
  // just a dead button. Where the shop prices by area, the picked area takes
  // the postcode's place as the required field, because it is what prices the
  // order.
  // A UK door needs a number (or a house name). Gulf addresses are buildings
  // and areas, so the rule follows the postcode rule's country split.
  const houseNumberMissing =
    needsPostcode &&
    !!addrLine1.trim() &&
    !hasHouseNumberOrName({ line1: addrLine1, line2: addrFlat });
  const addressComplete =
    !!addrLine1 &&
    !houseNumberMissing &&
    !!addrCity &&
    (!needsPostcode || !!addrPostcode) &&
    (mode !== "AREA" || (!!addrArea && !areaUnserviceable));
  // A claimed reward is an order in its own right. Somebody whose card is
  // full has earned a free thing and should be able to come and collect it
  // without buying something else first — being made to add a drink to claim
  // a free chicken is the sort of small meanness people remember.
  const rewardApplied = !!loyaltyReward && useLoyaltyReward;
  // Only a free item is an order on its own; % or £ off needs a basket.
  const rewardIsItem = !!loyaltyReward && loyaltyRewardKind(loyaltyReward) === "FREE_ITEM";
  const freeItemApplied = rewardApplied && rewardIsItem;
  // Retail R3 — a shop's delivery minimum (the server enforces it too).
  const belowShopMinimum =
    !!isShop && fulfillmentType === "DELIVERY" && !!minOrderForDelivery && subtotal + 1e-9 < minOrderForDelivery;
  // Any string used to place an order, so a shop could be left unable to
  // ring the customer. Shape only: it can't prove the number is theirs.
  const phoneValid = isPlausibleCustomerPhone(customerPhone, shopCountry);
  // A dialog closes on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canPlace =
    !belowShopMinimum &&
    (cart.length > 0 || freeItemApplied) &&
    customerName.trim().length > 0 &&
    phoneValid &&
    (fulfillmentType === "PICKUP" || addressComplete) &&
    (!cartMinAge || ageConfirmed);

  return (
    <div className="sf-backdrop-enter fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-panel-title"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md animate-slide-in-right flex-col overflow-hidden bg-white text-zinc-900 shadow-2xl [color-scheme:light] motion-reduce:animate-none"
      >
        <header className="flex items-center justify-between border-b border-zinc-200 py-1 pl-4 pr-1">
          <h2 id="cart-panel-title" className="text-base font-semibold text-zinc-900">
            Your order
          </h2>
          <button
            onClick={onClose}
            aria-label="Close basket"
            className="grid h-11 w-11 place-items-center rounded-full text-zinc-500 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* overflow-x-hidden, and min-w-0 so a long item name or a row that
            refuses to wrap cannot widen the panel. On a phone the cart is the
            whole screen, and a sideways drag to reach the payment buttons is
            the last thing anyone wants at the paying step. */}
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-4 py-3">
          {freeItemPicker && freeItemPicker.options.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="font-semibold">
                ✨ Free item with purchase
              </p>
              <p className="mt-0.5 text-[11px] text-amber-800">
                {!freeItemPicker.eligible
                  ? `Add ${money(freeItemPicker.remaining)} more (eligible items only) to unlock.`
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
          {/* The reward as a line, priced at nothing.
              DISPLAY ONLY — it is not in `cart` and is never sent as an item.
              The server adds the real line from the reward itself, because a
              basket that says "this is free" is a basket anyone can write. */}
          {freeItemApplied && (
            <div className="mb-2 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
              <span className="mt-0.5 text-amber-500">★</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-900">
                  {loyaltyReward!.label}
                </p>
                <p className="mt-0.5 text-[11px] text-amber-800">
                  Your reward — free
                </p>
              </div>
              <span className="text-sm font-semibold text-zinc-900">
                {money(0)}
              </span>
            </div>
          )}
          {cart.length === 0 && !freeItemApplied ? (
            <p className="py-10 text-center text-sm text-zinc-400">
              Cart is empty
            </p>
          ) : cart.length === 0 ? null : (
            <ul className="space-y-2">
              {cart.map((l) => (
                <li
                  key={l.id}
                  className="flex items-start gap-3 rounded-md border border-zinc-100 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900 [overflow-wrap:anywhere]">
                      {l.displayName}
                    </p>
                    {l.modifiers.length > 0 && (
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        {l.modifiers.map((m) => m.name).join(", ")}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-zinc-500">
                      {money(l.unitPrice * l.quantity)}
                    </p>
                    {isShop && l.weightGrams ? (
                      // Weighed lines are re-weighed, never swapped.
                      <p className="mt-1 text-[11px] text-zinc-500">Weighed when picked — lighter is refunded</p>
                    ) : isShop && !l.bogoOf && !l.freeItemOf && (
                      <label className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-600">
                        <input
                          type="checkbox"
                          checked={l.substitution !== "NONE"}
                          onChange={(e) =>
                            dispatch({
                              type: "SET_SUBSTITUTION",
                              id: l.id,
                              value: e.target.checked ? "BEST_MATCH" : "NONE",
                            })
                          }
                        />
                        Swap for similar if out of stock
                      </label>
                    )}
                  </div>
                  <div className="-my-1.5 -mr-2 flex items-center">
                    <button
                      onClick={() => dispatch({ type: "DECREMENT", id: l.id })}
                      aria-label={`Remove one ${l.displayName}`}
                      className="group/step grid h-11 w-11 place-items-center rounded-full focus-visible:outline-none"
                    >
                      <span className="grid h-8 w-8 place-items-center rounded-full border border-zinc-200 text-zinc-700 group-hover/step:bg-zinc-50 group-focus-visible/step:ring-2 group-focus-visible/step:ring-zinc-400">
                        <Minus className="h-3.5 w-3.5" />
                      </span>
                    </button>
                    <span className="w-5 text-center text-sm font-semibold tabular-nums">
                      {l.quantity}
                    </span>
                    <button
                      onClick={() => dispatch({ type: "INCREMENT", id: l.id })}
                      aria-label={`Add another ${l.displayName}`}
                      className="group/step grid h-11 w-11 place-items-center rounded-full focus-visible:outline-none"
                    >
                      <span className="grid h-8 w-8 place-items-center rounded-full border border-zinc-200 text-zinc-700 group-hover/step:bg-zinc-50 group-focus-visible/step:ring-2 group-focus-visible/step:ring-zinc-400">
                        <Plus className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Customer */}
          <Section title="Your details">
            {/* Stacked on a phone. Side by side gives each field about 160px,
                which is not enough for a full name and a phone number, and the
                text scrolls inside the box while they type. */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <TextField
                value={customerName}
                onChange={setCustomerName}
                placeholder="Full name"
              />
              <TextField
                value={customerPhone}
                onChange={setCustomerPhone}
                placeholder="Phone"
                type="tel"
              />
            </div>
            {customerPhone.trim().length > 0 && !phoneValid && (
              <p className="text-[11px] text-red-600">
                Enter a phone number the restaurant can call you on.
              </p>
            )}
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
            {accountEmail && (
              <label className="mt-1 flex cursor-pointer items-start gap-2 text-xs text-zinc-500">
                <input
                  type="checkbox"
                  checked={emailMarketingConsent}
                  onChange={(e) => setEmailMarketingConsent(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300"
                />
                <span>
                  Keep me updated with offers &amp; news by email ({accountEmail}). Unsubscribe any time.
                </span>
              </label>
            )}
            {/* Signed in: offer to remember the phone + delivery address on
                their account, so the next order anywhere starts filled in. */}
            {accountEmail && (
              <label className="mt-1 flex cursor-pointer items-start gap-2 text-xs text-zinc-500">
                <input
                  type="checkbox"
                  checked={saveDetails}
                  onChange={(e) => setSaveDetails(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300"
                />
                <span>
                  Save my phone number{fulfillmentType === "DELIVERY" ? " and address" : ""} for
                  next time. Change it any time in My account.
                </span>
              </label>
            )}
          </Section>

          {cartMinAge && (
            <Section title={`Age check — ${cartMinAge}+`}>
              <div className="rounded-md border border-amber-300 bg-amber-50 p-2.5">
                <label className="flex cursor-pointer items-start gap-2 text-xs text-amber-950">
                  <input
                    type="checkbox"
                    checked={ageConfirmed}
                    onChange={(e) => setAgeConfirmed(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-amber-400"
                  />
                  <span>
                    <span className="font-semibold">I&apos;m {cartMinAge} or over.</span> Your basket has
                    age-restricted items. We&apos;ll ask for photo ID when you{" "}
                    {fulfillmentType === "DELIVERY" ? "receive your order" : "collect"}, and won&apos;t hand it
                    over without it.
                  </span>
                </label>
              </div>
            </Section>
          )}

          {/* The loyalty reward, offered rather than applied.
              Opt IN, not out: someone may be saving it for a bigger order,
              and spending it for them is spending something they earned. */}
          {loyaltyReward && (
            <Section title="Your reward">
              <button
                type="button"
                onClick={() => setUseLoyaltyReward(!useLoyaltyReward)}
                className={`flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition ${
                  useLoyaltyReward
                    ? "border-amber-400 bg-amber-50"
                    : "border-dashed border-zinc-300 bg-white"
                }`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg ${
                    useLoyaltyReward ? "bg-amber-400" : "bg-zinc-100"
                  }`}
                >
                  ★
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-zinc-900">
                    {loyaltyReward.label}
                  </span>
                  <span className="block text-xs text-zinc-500">
                    {!rewardIsItem && useLoyaltyReward && loyaltyMoney.short > 0
                      ? `Add ${money(loyaltyMoney.short)} more to use it — or save it for next time`
                      : !rewardIsItem && useLoyaltyReward
                        ? `${money(loyaltyMoney.amount)} off this order`
                        : useLoyaltyReward
                          ? "Added to this order — free"
                          : "Your card is full. Tap to use it."}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold ${
                    useLoyaltyReward
                      ? "bg-amber-400 text-amber-950"
                      : "bg-zinc-900 text-white"
                  }`}
                >
                  {useLoyaltyReward ? "Added" : "Use it"}
                </span>
              </button>
            </Section>
          )}

          {/* Fulfillment */}
          <Section title="Order type">
            <div className="flex flex-wrap gap-2 [&>*]:min-w-0 [&>*]:flex-1">
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
                country={shopCountry.toLowerCase()}
                placeholder={
                  needsPostcode
                    ? "Search your address"
                    : "Search building, street or community"
                }
                onPick={onPickAddress}
              />
              {/* Phase AP fix #3 — house/flat number gets its own row */}
              <TextField
                value={addrFlat}
                onChange={setAddrFlat}
                placeholder={needsPostcode ? "House number or name (required)" : "House / flat number"}
              />
              <TextField
                value={addrLine1}
                onChange={setAddrLine1}
                placeholder="Street name"
              />
              {houseNumberMissing && (
                <p className="text-[11px] text-red-600">
                  Add your house number or name so the driver can find you.
                </p>
              )}
              {/* City + postcode + Find in one row. Inputs get min-w-0 so they
                  shrink on narrow phones instead of pushing the Find button
                  past the viewport edge (it was invisible on mobile). */}
              {/* City, and — where the country actually has them — postcode
                  plus Find. Inputs get min-w-0 so they shrink on narrow phones
                  instead of pushing the Find button past the viewport edge (it
                  was invisible on mobile). */}
              <div
                className={
                  needsPostcode
                    ? "grid grid-cols-[1fr,1fr,auto] gap-1.5"
                    : "grid grid-cols-1 gap-1.5"
                }
              >
                <input
                  value={addrCity}
                  onChange={(e) => setAddrCity(e.target.value)}
                  placeholder={needsPostcode ? "City" : "City / emirate"}
                  className="min-w-0 rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                />
                {needsPostcode && (
                  <>
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
                  </>
                )}
              </div>

              {/* The delivery area. Only where the shop prices by area — the
                  options are the operator's own zones, so anything not on this
                  list is somewhere they've said they don't go. That's why
                  there's no free-text fallback: a typed area we can't price is
                  a promise we can't keep. */}
              {mode === "AREA" && (
                <div className="space-y-1">
                  <select
                    value={addrArea}
                    onChange={(e) => setAddrArea(e.target.value)}
                    className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                  >
                    <option value="">Choose your area…</option>
                    {deliveryAreas.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                  {!addrArea && (
                    <p className="text-[11px] text-zinc-500">
                      Delivery is priced by area — pick yours to see the fee.
                    </p>
                  )}
                </div>
              )}

              {/* Phase AP fix #2 — picker for the lookup results */}
              {needsPostcode && postcodeLookupNote && (
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

              {matchedZone && mode !== "RADIUS" && (
                <p className="text-[11px] text-emerald-700">
                  {mode === "AREA" ? "Delivering to" : "Matched zone"}{" "}
                  <strong>{matchedZone.prefix}</strong> · {money(matchedZone.fee)}{" "}
                  delivery
                  {matchedZone.minOrder ? ` · min ${money(matchedZone.minOrder)}` : ""}
                </p>
              )}
              {/* Distance bands can't be resolved in the browser — measuring
                  needs a geocoder. The cart therefore shows the FURTHEST
                  band, which is the most it can cost, and the server prices
                  the real one at checkout. Quoting high and charging less is
                  the only direction that can't surprise anyone. */}
              {mode === "RADIUS" && matchedZone && (
                <p className="text-[11px] text-zinc-600">
                  {quotedFee != null ? (
                    <>
                      Delivery <strong>{money(quotedFee)}</strong> for this
                      address.
                    </>
                  ) : (
                    <>
                      Delivery up to <strong>{money(matchedZone.fee)}</strong> —
                      the exact fee is worked out from your address.
                    </>
                  )}
                </p>
              )}
              {areaUnserviceable && (
                <p className="text-[11px] text-red-600">
                  Sorry, we don&apos;t deliver to <strong>{addrArea}</strong>.
                  Pick another area, or switch to collection.
                </p>
              )}
              {noZoneMatched && (
                <p className="text-[11px] text-amber-600">
                  No matching delivery zone for this postcode — charging the
                  standard {money(highestZoneFee)} delivery fee.
                </p>
              )}
              {mode !== "AREA" &&
                !matchedZone &&
                !noZoneMatched &&
                addrPostcode.length >= 3 && (
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
                    : `— ${money(promoDiscount)} off`}
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
            <div className="flex flex-wrap gap-2 [&>*]:min-w-0 [&>*]:flex-1">
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
                Pay with Apple Pay, Google Pay or card on the next step. You&apos;ll
                be charged when you pay, and refunded in full if the restaurant
                can&apos;t take your order.
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
          <Row label="Subtotal" value={`${money(subtotal)}`} />
          {multiBuyApplied.map((a) => (
            <Row
              key={a.dealId}
              label={`${a.name}${a.times > 1 ? ` ×${a.times}` : ""}`}
              value={`-${money(a.saving)}`}
            />
          ))}
          {campaignDiscount >= promoDiscount && campaignDiscount > 0 && (
            <Row
              label={`Discount (${campaignName ?? "Promo"})`}
              value={`-${money(campaignDiscount)}`}
            />
          )}
          {loyaltyMoney.amount > 0 && (
            <Row label={`Reward (${loyaltyReward?.label ?? "loyalty"})`} value={`-${money(loyaltyMoney.amount)}`} />
          )}
          {promoDiscount > campaignDiscount && promoDiscount > 0 && (
            <Row
              label={`Discount (${promoApplied?.code ?? ""})`}
              value={`-${money(promoDiscount)}`}
            />
          )}
          {fulfillmentType === "DELIVERY" && (
            <Row
              label="Delivery"
              value={
                freeDelivery
                  ? "Free"
                  : deliveryFee > 0
                    ? `${money(deliveryFee)}`
                    : "—"
              }
            />
          )}
          {serviceCharge > 0 && (
            <Row
              label="Service charge"
              value={`${money(serviceCharge)}`}
            />
          )}
          <Row label="Total" value={`${money(total)}`} bold />
          {belowShopMinimum && (
            <p className="text-[11px] text-amber-700">
              Delivery minimum is {money(minOrderForDelivery!)} — add{" "}
              {money(minOrderForDelivery! - subtotal)} more, or choose collection.
            </p>
          )}
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
  type,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      inputMode={type === "tel" ? "tel" : undefined}
      autoComplete={type === "tel" ? "tel" : undefined}
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
  customerApp,
}: {
  orderId: string;
  storeName: string;
  onReset: () => void;
  storeSlug: string;
  /** The brand's own app, when it's being promoted. */
  customerApp?: CustomerAppLinks | null;
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
      customerApp={customerApp}
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
  customerApp,
}: {
  data: StatusPayload;
  customerApp?: CustomerAppLinks | null;
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
          <div className="mb-8 text-left">
            <LiveDeliveryPanel order={data as any} orderId={data.id} />
          </div>
        )}

        {/* Next time, the restaurant's own app (when it's being promoted). */}
        <AppInstallCard app={customerApp} name={storeName} className="mb-8" />

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
  shopCountry,
  isOpenNow,
  onClose,
  money,
}: {
  locationName: string;
  /** Bound to THIS store's currency by the page — never format money here. */
  money: (n: number | string | null | undefined) => string;

  about: string | null;
  address: string | null;
  openingHours: any;
  deliveryZones: DeliveryZoneRow[];
  /** Drives the labels and the units — postcodes, communities or km/mi. */
  shopCountry: string;
  isOpenNow: boolean;
  onClose: () => void;
}) {
  // Only the outer edge of each band is stored; this fills in the lower edge
  // from the band below so the list reads as ranges rather than ceilings.
  const infoBands = radiusBands(deliveryZones);
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

          {/* WHERE we deliver, not what it costs.
              A customer opening Info wants to know whether their street is
              covered. The price depends on their actual address and is quoted
              in the cart the moment they type it — printing a fee table here
              invites them to read off the wrong row and then argue about it. */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <Bike className="h-4 w-4 text-zinc-500" />
              <h3 className="text-sm font-bold text-zinc-900">Where we deliver</h3>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm">
              {deliveryZones.length === 0 ? (
                <p className="text-zinc-600">
                  Enter your address in the cart and we&apos;ll tell you if
                  we can reach you.
                </p>
              ) : (
                <>
                  <ul className="flex flex-wrap gap-1.5">
                    {deliveryZones.map((z) => {
                      const band = infoBands.find((b) => b.zone === z);
                      const label = z.areaName
                        ? z.areaName
                        : band
                          ? `Up to ${formatDistance(band.to, shopCountry)}`
                          : (z.postcodePrefix ?? "");
                      if (!label) return null;
                      return (
                        <li
                          key={z.id}
                          className={
                            z.areaName
                              ? "rounded-md bg-white px-2 py-1 text-xs text-zinc-700 ring-1 ring-zinc-200"
                              : "rounded-md bg-white px-2 py-1 font-mono text-xs uppercase text-zinc-700 ring-1 ring-zinc-200"
                          }
                        >
                          {label}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-2 text-[11px] leading-snug text-zinc-500">
                    Delivery fee depends on your address — you&apos;ll see it in
                    the cart before you pay.
                  </p>
                </>
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
