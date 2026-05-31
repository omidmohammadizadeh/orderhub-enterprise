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
  const [cart, dispatch] = useReducer(cartReducer, []);
  const [cartOpen, setCartOpen] = useState(false);
  const [search, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [fulfillmentType, setFulfillmentType] = useState<"PICKUP" | "DELIVERY">(
    "PICKUP",
  );
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null); // ISO
  const [modalItem, setModalItem] = useState<MenuItem | null>(null);
  const [confirmedOrderId, setConfirmedOrderId] = useState<string | null>(null);

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
    queryKey: ["storefront", slug],
    queryFn: () =>
      axios.get(`${API_BASE}/v1/ordering/store/${slug}`).then((r) => r.data),
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
  const total = Math.max(0, subtotal - promoDiscount) + deliveryFee;
  const cartCount = cart.reduce((s, l) => s + l.quantity, 0);

  // Categories + search filter
  const allCategories = useMemo(
    () =>
      (storefront?.menu?.categories ?? []).filter((c) => c.items.length > 0),
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
      if (items.length > 0) lists.push({ cat, items });
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
        discount: promoDiscount,
        promoCode: promoApplied?.code,
        discountType: promoApplied
          ? promoApplied.freeDelivery
            ? "FREE_DELIVERY"
            : "PROMO_CODE"
          : undefined,
      };
      return axios
        .post(`${API_BASE}/v1/ordering/store/${slug}/checkout`, payload)
        .then((r) => r.data);
    },
    onSuccess: (order) => {
      setConfirmedOrderId(order.id);
      setCartOpen(false);
      dispatch({ type: "CLEAR" });
    },
  });

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
        {/* Restaurant info card (overlapping the hero) */}
        <div className="-mt-12 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
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
              <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl">
                {headerTitle}
              </h1>
              {headerAddress && (
                <p className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
                  <MapPin className="h-3 w-3" /> {headerAddress}
                </p>
              )}
              {storefront.location.about && (
                <p className="mt-2 text-sm text-zinc-700">
                  {storefront.location.about}
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
              <section key={cat.id}>
                {activeCategory === "all" && (
                  <h2 className="mb-3 text-lg font-bold text-zinc-900">
                    {cat.name}
                  </h2>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {items.map((item) => (
                    <ProductCard
                      key={item.id}
                      item={item}
                      onClick={() => handleProductClick(item)}
                    />
                  ))}
                </div>
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
          onPlace={() => checkout.mutate()}
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
            dispatch({
              type: "ADD",
              line: {
                menuItemId: line.menuItemId,
                displayName: line.displayName,
                unitPrice: line.unitPrice,
                quantity: line.quantity,
                modifiers: line.modifiers,
                selectedSku: line.selectedSku,
                notes: line.notes,
                plu: line.plu,
              },
            });
            setCartOpen(true);
          }}
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
    </div>
  );

  function handleProductClick(item: MenuItem) {
    const hasMods = (item.modifierGroupLinks?.length ?? 0) > 0;
    const multiSku = !!item.hasMultipleSkus;
    if (hasMods || multiSku) {
      setModalItem(item);
      return;
    }
    dispatch({
      type: "ADD",
      line: {
        menuItemId: item.id,
        displayName: item.name,
        unitPrice: Number(item.basePrice),
        quantity: 1,
        modifiers: [],
        selectedSku: null,
        notes: "",
        plu: item.plu ?? null,
      },
    });
    setCartOpen(true);
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
  onClick,
}: {
  item: MenuItem;
  onClick: () => void;
}) {
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
          <span className="text-base font-bold text-orange-600">
            £{Number(item.basePrice).toFixed(2)}
          </span>
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
    freeDelivery,
    postcodeSuggestions,
    postcodeLookupNote,
    postcodeLookupLoading,
    onPostcodeLookup,
    onPickPostcodeSuggestion,
    dispatch,
    subtotal,
    deliveryFee,
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
          {promoDiscount > 0 && (
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

// ── Confirmation ───────────────────────────────────────────────────────────

function OrderConfirmed({
  orderId,
  storeName,
  onReset,
}: {
  orderId: string;
  storeName: string;
  onReset: () => void;
}) {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center">
      <div className="h-20 w-20 rounded-full bg-emerald-100 grid place-items-center mb-6">
        <CheckCircle className="h-10 w-10 text-emerald-500" />
      </div>
      <h1 className="text-2xl font-bold text-zinc-900 mb-2">Order placed!</h1>
      <p className="text-zinc-500 mb-6">
        Your order has been sent to {storeName}. You&apos;ll get updates as it
        progresses.
      </p>
      <div className="bg-zinc-100 rounded-xl px-6 py-4 mb-8">
        <p className="text-xs text-zinc-400 mb-1">Order reference</p>
        <p className="font-mono text-sm font-semibold text-zinc-700">
          {orderId.slice(-8).toUpperCase()}
        </p>
      </div>
      <button
        onClick={onReset}
        className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600"
      >
        Order again
      </button>
    </div>
  );
}
