"use client";

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
  ChevronDown,
  CheckCircle,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { MenuItem, MenuCategory } from "@/lib/api/menus.client";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Storefront {
  location: {
    id: string;
    name: string;
    slug: string;
    phone?: string;
    // Phase AN — surfaced for the customer-facing header card
    about?: string | null;
    logoUrl?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    postcode?: string | null;
    country?: string | null;
    // Legacy JSON address kept for old locations that haven't been
    // migrated to the structured columns yet
    address?: { line1?: string; city?: string; postcode?: string } | null;
    openingHours: any;
    deliveryConfig?: { deliveryFeeFixed?: number; minimumOrder?: number };
    busyMode?: boolean;
    currentPrepTime?: number;
  };
  brand: { id: string; name: string; logoUrl?: string | null };
  menu: { id: string; categories: MenuCategory[] } | null;
  isOpen: boolean;
  // Phase AP — set by the API so the storefront can decide which
  // payment methods + order types to show + how to advertise prep
  // times. Permissive defaults are filled in server-side for any
  // location that never visited the admin tab.
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

interface CartItem {
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  modifiers: Array<{ name: string; price: number }>;
  notes: string;
}

type CartAction =
  | { type: "ADD"; item: Omit<CartItem, "quantity"> & { quantity?: number } }
  | { type: "INCREMENT"; menuItemId: string }
  | { type: "DECREMENT"; menuItemId: string }
  | { type: "REMOVE"; menuItemId: string }
  | { type: "CLEAR" };

function cartReducer(state: CartItem[], action: CartAction): CartItem[] {
  switch (action.type) {
    case "ADD": {
      const existing = state.find((i) => i.menuItemId === action.item.menuItemId);
      if (existing) {
        return state.map((i) =>
          i.menuItemId === action.item.menuItemId
            ? { ...i, quantity: i.quantity + (action.item.quantity ?? 1) }
            : i,
        );
      }
      return [...state, { ...action.item, quantity: action.item.quantity ?? 1 }];
    }
    case "INCREMENT":
      return state.map((i) => i.menuItemId === action.menuItemId ? { ...i, quantity: i.quantity + 1 } : i);
    case "DECREMENT":
      return state
        .map((i) => i.menuItemId === action.menuItemId ? { ...i, quantity: i.quantity - 1 } : i)
        .filter((i) => i.quantity > 0);
    case "REMOVE":
      return state.filter((i) => i.menuItemId !== action.menuItemId);
    case "CLEAR":
      return [];
    default:
      return state;
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OrderPage() {
  const { slug } = useParams<{ slug: string }>();
  const [cart, dispatch] = useReducer(cartReducer, []);
  const [cartOpen, setCartOpen] = useState(false);
  const [fulfillmentType, setFulfillmentType] = useState<"PICKUP" | "DELIVERY">("PICKUP");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [deliveryLine1, setDeliveryLine1] = useState("");
  const [deliveryCity, setDeliveryCity] = useState("");
  const [deliveryPostcode, setDeliveryPostcode] = useState("");
  const [notes, setNotes] = useState("");
  const [checkoutStep, setCheckoutStep] = useState<"menu" | "checkout" | "confirmed">("menu");
  const [confirmedOrderId, setConfirmedOrderId] = useState<string | null>(null);

  const { data: storefront, isLoading, error } = useQuery<Storefront>({
    queryKey: ["storefront", slug],
    queryFn: () =>
      axios.get(`${API_BASE}/v1/ordering/store/${slug}`).then((r) => r.data),
  });

  const checkoutMutation = useMutation({
    mutationFn: (payload: object) =>
      axios.post(`${API_BASE}/v1/ordering/store/${slug}/checkout`, payload).then((r) => r.data),
    onSuccess: (order) => {
      setConfirmedOrderId(order.id);
      setCheckoutStep("confirmed");
      dispatch({ type: "CLEAR" });
    },
  });

  const cartTotal = cart.reduce((s, i) => s + (i.unitPrice + i.modifiers.reduce((ms, m) => ms + m.price, 0)) * i.quantity, 0);
  const deliveryFee =
    fulfillmentType === "DELIVERY"
      ? (storefront?.location.deliveryConfig?.deliveryFeeFixed ?? 0)
      : 0;
  const orderTotal = cartTotal + deliveryFee;
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);

  const handleCheckout = () => {
    const payload = {
      idempotencyKey: `order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      fulfillmentType,
      customerInfo: { name: customerName, phone: customerPhone || undefined, email: customerEmail || undefined },
      deliveryAddress: fulfillmentType === "DELIVERY"
        ? { line1: deliveryLine1, city: deliveryCity, postcode: deliveryPostcode }
        : undefined,
      items: cart.map((i) => ({
        menuItemId: i.menuItemId,
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        modifiers: i.modifiers,
        notes: i.notes || undefined,
      })),
      subtotal: cartTotal,
      deliveryFee,
      total: orderTotal,
      specialInstructions: notes || undefined,
    };
    checkoutMutation.mutate(payload);
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <Loader2 className="h-8 w-8 text-orange-500 animate-spin" />
      </div>
    );
  }

  if (error || !storefront) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <div className="text-center px-4">
          <p className="text-2xl font-bold text-zinc-900 mb-2">Store not found</p>
          <p className="text-zinc-500 text-sm">This ordering link doesn&apos;t exist or has been deactivated.</p>
        </div>
      </div>
    );
  }

  if (checkoutStep === "confirmed" && confirmedOrderId) {
    return <OrderConfirmed orderId={confirmedOrderId} storeName={storefront.location.name} />;
  }

  // Compose the address for the header card — prefer the Phase AN
  // structured columns then fall back to legacy address JSON.
  const headerAddress = [
    storefront.location.addressLine1 ?? storefront.location.address?.line1,
    storefront.location.city ?? storefront.location.address?.city,
    storefront.location.postcode ?? storefront.location.address?.postcode,
  ]
    .filter(Boolean)
    .join(", ");
  const logoUrl = storefront.location.logoUrl ?? storefront.brand.logoUrl ?? null;
  const headerTitle = storefront.location.name || storefront.brand.name;

  return (
    <div className="min-h-screen bg-zinc-50 pb-32">
      {/* Store header — Glovo / Uber Eats style hero card */}
      <div className="bg-gradient-to-b from-orange-50 to-white border-b border-zinc-200">
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="flex items-start gap-4">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                className="h-20 w-20 rounded-xl object-cover shadow-md"
              />
            ) : (
              <div className="h-20 w-20 rounded-xl bg-orange-500 text-white grid place-items-center text-2xl font-bold shadow-md">
                {headerTitle?.slice(0, 1).toUpperCase() ?? "•"}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold text-zinc-900 leading-tight">
                {headerTitle}
              </h1>
              {storefront.brand.name && storefront.brand.name !== headerTitle && (
                <p className="text-sm text-zinc-500">by {storefront.brand.name}</p>
              )}
              {headerAddress && (
                <p className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
                  <MapPin className="h-3 w-3" />
                  {headerAddress}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-xs font-semibold px-2 py-1 rounded-full",
                    storefront.isOpen
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-red-100 text-red-700",
                  )}
                >
                  <div
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      storefront.isOpen ? "bg-emerald-500" : "bg-red-500",
                    )}
                  />
                  {storefront.isOpen ? "Open" : "Closed"}
                </span>
                {storefront.location.busyMode && (
                  <span className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full bg-amber-100 text-amber-700">
                    <Clock className="h-3 w-3" /> Kitchen busy
                  </span>
                )}
                {storefront.location.currentPrepTime ? (
                  <span className="text-xs text-zinc-500">
                    ~{storefront.location.currentPrepTime}m prep
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          {storefront.location.about && (
            <p className="mt-4 text-sm text-zinc-700">
              {storefront.location.about}
            </p>
          )}

          <OpeningHoursSummary hours={storefront.location.openingHours} />
        </div>
      </div>

      {/* Sticky fulfillment + categories nav (Phase AP).
          The categories strip scrolls horizontally and updates as the
          user scrolls down the page. Clicking a chip scrolls smoothly
          to that category's anchor. */}
      <div className="bg-white border-b border-zinc-200 sticky top-0 z-30">
        <div className="max-w-2xl mx-auto px-4 py-3">
          {/* Fulfillment type */}
          <div className="flex gap-2 mt-3">
            {(["PICKUP", "DELIVERY"] as const).map((type) => (
              <button
                key={type}
                onClick={() => setFulfillmentType(type)}
                className={cn(
                  "flex-1 py-2 rounded-lg text-sm font-medium transition-all",
                  fulfillmentType === type
                    ? "bg-orange-500 text-white"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
                )}
              >
                {type === "PICKUP" ? "Pickup" : "Delivery"}
                {type === "DELIVERY" && deliveryFee > 0 && (
                  <span className="ml-1 text-xs opacity-80">+£{deliveryFee.toFixed(2)}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Sticky horizontal category nav */}
        {storefront.menu && storefront.menu.categories.length > 0 && (
          <CategoryStrip
            categories={storefront.menu.categories.filter((c) => c.items.length > 0)}
          />
        )}
      </div>

      <div className="max-w-2xl mx-auto px-4 pt-4">
        {!storefront.isOpen && (
          <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-700">
            This store is currently closed. You can still browse the menu.
          </div>
        )}

        {checkoutStep === "menu" && storefront.menu ? (
          storefront.menu.categories.map((cat) => (
            cat.items.length > 0 && (
              // id used by CategoryStrip's smooth scroll + scrollMargin
              // pushes the heading clear of the sticky header height
              <div
                key={cat.id}
                id={`category-${cat.id}`}
                data-category-id={cat.id}
                className="mb-8 scroll-mt-40"
              >
                <h2 className="text-lg font-bold text-zinc-900 mb-3">{cat.name}</h2>
                <div className="space-y-3">
                  {cat.items
                    .filter((link) => link.item.isAvailable)
                    .map((link) => (
                      <MenuItemCard
                        key={link.itemId}
                        item={link.item}
                        onAdd={() =>
                          dispatch({
                            type: "ADD",
                            item: {
                              menuItemId: link.item.id,
                              name: link.item.name,
                              unitPrice: link.priceOverride ?? Number(link.item.basePrice),
                              modifiers: [],
                              notes: "",
                            },
                          })
                        }
                      />
                    ))}
                </div>
              </div>
            )
          ))
        ) : checkoutStep === "checkout" ? (
          <CheckoutForm
            fulfillmentType={fulfillmentType}
            customerName={customerName} setCustomerName={setCustomerName}
            customerPhone={customerPhone} setCustomerPhone={setCustomerPhone}
            customerEmail={customerEmail} setCustomerEmail={setCustomerEmail}
            deliveryLine1={deliveryLine1} setDeliveryLine1={setDeliveryLine1}
            deliveryCity={deliveryCity} setDeliveryCity={setDeliveryCity}
            deliveryPostcode={deliveryPostcode} setDeliveryPostcode={setDeliveryPostcode}
            notes={notes} setNotes={setNotes}
            onBack={() => setCheckoutStep("menu")}
            onSubmit={handleCheckout}
            isSubmitting={checkoutMutation.isPending}
            error={checkoutMutation.error ? "Failed to place order. Please try again." : undefined}
            cart={cart} dispatch={dispatch}
            cartTotal={cartTotal} deliveryFee={deliveryFee} orderTotal={orderTotal}
          />
        ) : (
          <div className="text-center py-16 text-zinc-400">No menu available</div>
        )}
      </div>

      {/* Floating cart */}
      {checkoutStep === "menu" && cart.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 p-4 bg-gradient-to-t from-zinc-50 to-transparent">
          <div className="max-w-2xl mx-auto">
            {cartOpen && (
              <div className="mb-3 bg-white rounded-2xl shadow-xl border border-zinc-200 p-4 space-y-2">
                {cart.map((item) => (
                  <div key={item.menuItemId} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-zinc-700 flex-1 truncate">{item.name}</span>
                    <div className="flex items-center gap-2">
                      <button onClick={() => dispatch({ type: "DECREMENT", menuItemId: item.menuItemId })} className="h-6 w-6 rounded-full bg-zinc-100 flex items-center justify-center hover:bg-zinc-200">
                        <Minus className="h-3 w-3 text-zinc-600" />
                      </button>
                      <span className="text-sm font-semibold w-5 text-center">{item.quantity}</span>
                      <button onClick={() => dispatch({ type: "INCREMENT", menuItemId: item.menuItemId })} className="h-6 w-6 rounded-full bg-zinc-100 flex items-center justify-center hover:bg-zinc-200">
                        <Plus className="h-3 w-3 text-zinc-600" />
                      </button>
                    </div>
                    <span className="text-sm font-medium text-zinc-700 w-14 text-right">
                      £{((item.unitPrice + item.modifiers.reduce((s, m) => s + m.price, 0)) * item.quantity).toFixed(2)}
                    </span>
                  </div>
                ))}
                <div className="border-t pt-2 flex justify-between font-bold text-sm">
                  <span>Total</span>
                  <span>£{orderTotal.toFixed(2)}</span>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setCartOpen((p) => !p)}
                className="flex items-center justify-center h-14 w-14 rounded-2xl bg-zinc-800 text-white flex-shrink-0"
              >
                <ShoppingBag className="h-5 w-5" />
                <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center">
                  {cartCount}
                </span>
              </button>
              <button
                onClick={() => {
                  if (!storefront.isOpen) return;
                  setCheckoutStep("checkout");
                  setCartOpen(false);
                }}
                disabled={!storefront.isOpen}
                className="flex-1 h-14 rounded-2xl bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-bold text-base flex items-center justify-center gap-2 shadow-orange-200 shadow-lg transition-colors"
              >
                Go to checkout · £{orderTotal.toFixed(2)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Menu item card ────────────────────────────────────────────────────────────

function MenuItemCard({ item, onAdd }: { item: MenuItem; onAdd: () => void }) {
  return (
    <div className="bg-white rounded-xl border border-zinc-200 p-4 flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-zinc-900">{item.name}</p>
        {item.description && (
          <p className="text-sm text-zinc-500 mt-0.5 line-clamp-2">{item.description}</p>
        )}
        <p className="text-sm font-medium text-zinc-700 mt-2">£{Number(item.basePrice).toFixed(2)}</p>
        {item.calories && (
          <p className="text-xs text-zinc-400 mt-0.5">{item.calories} kcal</p>
        )}
      </div>
      <button
        onClick={onAdd}
        className="flex-shrink-0 h-9 w-9 rounded-full bg-orange-500 text-white flex items-center justify-center hover:bg-orange-600 transition-colors shadow-sm"
      >
        <Plus className="h-5 w-5" />
      </button>
    </div>
  );
}

// ── Checkout form ─────────────────────────────────────────────────────────────

interface CheckoutFormProps {
  fulfillmentType: "PICKUP" | "DELIVERY";
  customerName: string; setCustomerName: (v: string) => void;
  customerPhone: string; setCustomerPhone: (v: string) => void;
  customerEmail: string; setCustomerEmail: (v: string) => void;
  deliveryLine1: string; setDeliveryLine1: (v: string) => void;
  deliveryCity: string; setDeliveryCity: (v: string) => void;
  deliveryPostcode: string; setDeliveryPostcode: (v: string) => void;
  notes: string; setNotes: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  error?: string;
  cart: CartItem[];
  dispatch: React.Dispatch<CartAction>;
  cartTotal: number;
  deliveryFee: number;
  orderTotal: number;
}

function CheckoutForm({
  fulfillmentType,
  customerName, setCustomerName,
  customerPhone, setCustomerPhone,
  customerEmail, setCustomerEmail,
  deliveryLine1, setDeliveryLine1,
  deliveryCity, setDeliveryCity,
  deliveryPostcode, setDeliveryPostcode,
  notes, setNotes,
  onBack, onSubmit, isSubmitting, error,
  cart, dispatch, cartTotal, deliveryFee, orderTotal,
}: CheckoutFormProps) {
  const canSubmit = customerName.trim() &&
    (fulfillmentType === "PICKUP" || (deliveryLine1.trim() && deliveryCity.trim() && deliveryPostcode.trim()));

  return (
    <div className="space-y-5 pb-32">
      <button onClick={onBack} className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-800 transition-colors">
        <ChevronDown className="h-4 w-4 rotate-90" />
        Back to menu
      </button>

      {/* Order summary */}
      <div className="bg-white rounded-xl border border-zinc-200 p-4">
        <p className="font-semibold text-zinc-900 mb-3">Order summary</p>
        <div className="space-y-2">
          {cart.map((item) => (
            <div key={item.menuItemId} className="flex items-center justify-between text-sm">
              <span className="text-zinc-700">{item.quantity}× {item.name}</span>
              <span className="text-zinc-600">£{((item.unitPrice + item.modifiers.reduce((s, m) => s + m.price, 0)) * item.quantity).toFixed(2)}</span>
            </div>
          ))}
          {deliveryFee > 0 && (
            <div className="flex justify-between text-sm text-zinc-500">
              <span>Delivery fee</span>
              <span>£{deliveryFee.toFixed(2)}</span>
            </div>
          )}
          <div className="border-t pt-2 flex justify-between font-bold text-sm">
            <span>Total</span>
            <span>£{orderTotal.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Contact details */}
      <div className="bg-white rounded-xl border border-zinc-200 p-4 space-y-3">
        <p className="font-semibold text-zinc-900">Your details</p>
        <div>
          <Label className="text-xs text-zinc-500 mb-1">Name *</Label>
          <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Full name" className="h-10" />
        </div>
        <div>
          <Label className="text-xs text-zinc-500 mb-1">Phone</Label>
          <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="+44 7700 900000" type="tel" className="h-10" />
        </div>
        <div>
          <Label className="text-xs text-zinc-500 mb-1">Email</Label>
          <Input value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="email@example.com" type="email" className="h-10" />
        </div>
      </div>

      {/* Delivery address */}
      {fulfillmentType === "DELIVERY" && (
        <div className="bg-white rounded-xl border border-zinc-200 p-4 space-y-3">
          <p className="font-semibold text-zinc-900">Delivery address</p>
          <div>
            <Label className="text-xs text-zinc-500 mb-1">Address line 1 *</Label>
            <Input value={deliveryLine1} onChange={(e) => setDeliveryLine1(e.target.value)} placeholder="123 High Street" className="h-10" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs text-zinc-500 mb-1">City *</Label>
              <Input value={deliveryCity} onChange={(e) => setDeliveryCity(e.target.value)} placeholder="London" className="h-10" />
            </div>
            <div>
              <Label className="text-xs text-zinc-500 mb-1">Postcode *</Label>
              <Input value={deliveryPostcode} onChange={(e) => setDeliveryPostcode(e.target.value)} placeholder="EC1A 1BB" className="h-10" />
            </div>
          </div>
        </div>
      )}

      {/* Notes */}
      <div className="bg-white rounded-xl border border-zinc-200 p-4">
        <Label className="text-xs text-zinc-500 mb-1">Special instructions (optional)</Label>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Allergies, requests, etc." className="h-10 mt-1" />
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
      )}

      <button
        onClick={onSubmit}
        disabled={!canSubmit || isSubmitting}
        className="w-full h-14 rounded-2xl bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-bold text-base flex items-center justify-center gap-2 transition-colors"
      >
        {isSubmitting ? <Loader2 className="h-5 w-5 animate-spin" /> : "Place order · £" + orderTotal.toFixed(2)}
      </button>
    </div>
  );
}

// ── Order confirmed ───────────────────────────────────────────────────────────

function OrderConfirmed({ orderId, storeName }: { orderId: string; storeName: string }) {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center">
      <div className="h-20 w-20 rounded-full bg-emerald-100 flex items-center justify-center mb-6">
        <CheckCircle className="h-10 w-10 text-emerald-500" />
      </div>
      <h1 className="text-2xl font-bold text-zinc-900 mb-2">Order placed!</h1>
      <p className="text-zinc-500 mb-6">Your order has been sent to {storeName}.</p>
      <div className="bg-zinc-100 rounded-xl px-6 py-4 mb-8">
        <p className="text-xs text-zinc-400 mb-1">Order reference</p>
        <p className="font-mono text-sm font-semibold text-zinc-700">{orderId.slice(-8).toUpperCase()}</p>
      </div>
      <p className="text-sm text-zinc-400">You&apos;ll receive updates as your order is prepared.</p>
    </div>
  );
}

// ── Opening hours summary (Phase AN) ─────────────────────────────────────────
// Renders the 7-day schedule beneath the hero card. Handles both the new
// Phase AN map shape and the legacy array shape from older locations.

const DAY_LABELS: Array<[string, string]> = [
  ["monday", "Mon"],
  ["tuesday", "Tue"],
  ["wednesday", "Wed"],
  ["thursday", "Thu"],
  ["friday", "Fri"],
  ["saturday", "Sat"],
  ["sunday", "Sun"],
];

function OpeningHoursSummary({ hours }: { hours: any }) {
  if (!hours) return null;
  const days = normaliseHours(hours);
  if (!days.length) return null;
  return (
    <details className="mt-3 text-xs text-zinc-600">
      <summary className="cursor-pointer font-semibold text-zinc-700">
        Opening hours
      </summary>
      <ul className="mt-2 space-y-0.5">
        {days.map(([label, summary]) => (
          <li key={label} className="flex justify-between gap-3">
            <span className="text-zinc-500">{label}</span>
            <span>{summary}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function normaliseHours(hours: any): Array<[string, string]> {
  // Phase AN map shape
  if (!Array.isArray(hours) && typeof hours === "object" && hours) {
    return DAY_LABELS.map(([key, label]) => {
      const day = hours[key];
      if (!day || !day.enabled) return [label, "Closed"] as [string, string];
      const slots = Array.isArray(day.slots) ? day.slots : [];
      if (!slots.length) return [label, "Closed"] as [string, string];
      return [
        label,
        slots
          .map((s: any) => `${s.from ?? "??"}–${s.to ?? "??"}`)
          .join(", "),
      ] as [string, string];
    });
  }
  // Legacy array shape — Sunday is day 0
  if (Array.isArray(hours)) {
    const byDay = new Map<number, Array<{ open: string; close: string }>>();
    for (const h of hours) {
      const list = byDay.get(h.day) ?? [];
      list.push({ open: h.open, close: h.close });
      byDay.set(h.day, list);
    }
    return DAY_LABELS.map(([, label], idx) => {
      const dayIdx = (idx + 1) % 7; // Mon=1, … Sun=0
      const slots = byDay.get(dayIdx);
      if (!slots || slots.length === 0) return [label, "Closed"] as [string, string];
      return [label, slots.map((s) => `${s.open}–${s.close}`).join(", ")] as [string, string];
    });
  }
  return [];
}

// ── Phase AP — Sticky category nav ──────────────────────────────────────────
//
// Horizontal scrollable strip pinned at the top of the menu. Clicking a
// chip smooth-scrolls the page to that category's anchor; as the user
// scrolls manually, an IntersectionObserver flips the active chip and
// keeps it visible inside the strip.

function CategoryStrip({
  categories,
}: {
  categories: Array<{ id: string; name: string }>;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string>(categories[0]?.id ?? "");

  // Watch for the section currently dominating the viewport.
  useEffect(() => {
    const sections = categories
      .map((c) => document.getElementById(`category-${c.id}`))
      .filter((el): el is HTMLElement => !!el);
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the topmost intersecting entry — IntersectionObserver
        // delivers them out of order so sort by boundingClientRect.top.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          );
        const first = visible[0];
        if (!first) return;
        const id = first.target.getAttribute("data-category-id");
        if (id) setActiveId(id);
      },
      { rootMargin: "-180px 0px -50% 0px", threshold: 0 },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, [categories]);

  // Keep the active chip in view inside the horizontal strip.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const chip = strip.querySelector<HTMLElement>(`[data-chip="${activeId}"]`);
    if (!chip) return;
    const stripRect = strip.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    if (chipRect.left < stripRect.left || chipRect.right > stripRect.right) {
      strip.scrollTo({
        left: chip.offsetLeft - 16,
        behavior: "smooth",
      });
    }
  }, [activeId]);

  const onPick = (id: string) => {
    const el = document.getElementById(`category-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
  };

  return (
    <div
      ref={stripRef}
      className="flex gap-1.5 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {categories.map((c) => {
        const active = c.id === activeId;
        return (
          <button
            key={c.id}
            data-chip={c.id}
            onClick={() => onPick(c.id)}
            className={
              "flex-shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition " +
              (active
                ? "border-orange-500 bg-orange-500 text-white"
                : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300")
            }
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );
}
