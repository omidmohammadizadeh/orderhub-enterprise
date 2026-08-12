"use client";

// Phase AM — POS cart panel. The big right-hand sidebar that runs the
// operational checkout flow: customer, fulfilment, address+postcode fee
// lookup, expected time, schedule, discounts, promo, payment.
//
// This component is intentionally self-contained — the parent POS page
// owns the cart line state, but every other piece of order metadata
// (customer, address, schedule, discounts, etc.) is local here. On submit
// we hand the parent a fully-shaped Order payload via onPlaceOrder.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trash2, ShoppingBag, Loader2, Clock, Calendar, Tag, Phone, CheckCircle2, Search, XCircle, WifiOff, UtensilsCrossed } from "lucide-react";
import { round2 } from "@orderhub/shared";
import {
  deliveryZonesClient,
  promoCodesClient,
  addressLookupClient,
  type AddressSuggestion,
  type AddressProvider,
  type PromoCode,
  type PromoValidateResult,
} from "@/lib/api/pos.client";
import { useOnlineStatus } from "@/lib/pos/use-online-status";

// ── Types the parent feeds in ────────────────────────────────────────────────
export interface CartLine {
  id: string;
  menuItemId: string;
  displayName: string;
  unitPrice: number;
  quantity: number;
  plu?: string | null;
  modifiers: Array<{ name: string; price: number }>;
  notes?: string;
}

export type FulfillmentType = "PICKUP" | "DELIVERY";
export type PaymentMethod =
  | "CASH"
  | "CARD_TERMINAL"
  | "ONLINE_CARD"
  | "EXTERNAL"
  // Phase — POS Payment Link: order placed as "pending payment", a Stripe
  // checkout link is shown (QR / copy / SMS) for the customer to pay
  // remotely; the order auto-flips to PAID when they do.
  | "PAYMENT_LINK"
  // QR code — identical flow to Payment Link (unpaid until scanned), but the
  // POS pops the QR prominently for the customer to scan at the counter.
  | "QR_CODE"
  // Phone collection — the customer isn't in the shop yet, so cash-vs-card is
  // a guess at placement and was routinely recorded wrong. Order sits as
  // "waiting for payment"; staff settle it from the order card when the
  // customer arrives. Walk-in and delivery are unaffected: a walk-in customer
  // is standing there, and delivery is settled by the driver.
  | "PAY_ON_COLLECTION";
export type DiscountType = null | "PROMO_CODE" | "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_DELIVERY";

// What the panel hands the parent when "Place order" is clicked.
export interface PlaceOrderPayload {
  /** Counter trade — no customer details taken. Drives walk-in reporting. */
  isWalkIn?: boolean;
  customerName: string;
  customerPhone: string;
  callerId?: string;
  fulfillmentType: FulfillmentType;
  notes?: string;
  address?: {
    line1: string;
    line2?: string;
    city: string;
    postcode: string;
  };
  preparationMinutes: number;
  scheduledFor?: string; // ISO
  isScheduled: boolean;
  discountType: DiscountType;
  discountAmount: number;
  promoCode?: string;
  paymentMethod: PaymentMethod;
  paymentStatus: "PENDING" | "PAID";
  subtotal: number;
  deliveryFee: number;
  total: number;
  // SMS-marketing consent captured at the till ("Send me offers by SMS").
  // undefined = consent wasn't asked (dine-in) — leave it untouched server-side.
  marketingConsent?: boolean;
}

export interface CartPanelProps {
  locationId: string;
  cart: CartLine[];
  onRemoveLine: (id: string) => void;
  onChangeQty: (id: string, qty: number) => void;
  onClearCart: () => void;
  onPlaceOrder: (payload: PlaceOrderPayload) => Promise<void> | void;
  submitting: boolean;
  feedback?: string | null;
  // Phase AW-22 — when set, the panel renders "Save changes" instead
  // of "Place order" so the operator knows the action will amend the
  // existing ticket rather than create a new one.
  submitButtonLabel?: string;
  // Persistence callbacks — the parent owns the draft store key (per
  // location) so it can purge on successful submit.
  initialDraft?: PartialDraft;
  onDraftChange?: (draft: PartialDraft) => void;
  // Table Tabs — dine-in mode. The panel drops every takeaway concept
  // (Collection/Delivery toggle, timing & scheduling, caller ID, SMS
  // consent, payment method — settled later via "Pay & close") and instead
  // shows the table identity, a kitchen-first submit button, and the
  // running-tab arithmetic in the footer.
  dineIn?: {
    tableName: string;
    /** Items already sent on the tab (0 = tab not opened yet). */
    tabItemCount: number;
    /** Total already on the tab before this round. */
    tabTotal: number;
  } | null;
}

export interface PartialDraft {
  customerName?: string;
  customerPhone?: string;
  callerId?: string;
  fulfillmentType?: FulfillmentType;
  /** Counter customer — no name, no phone, no address. Set on the start
   *  screen and mirrored here so both steps agree on the order type. */
  walkIn?: boolean;
  notes?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postcode?: string;
  preparationMinutes?: number;
  scheduledFor?: string;
  isScheduled?: boolean;
  discountType?: DiscountType;
  promoCode?: string;
  paymentMethod?: PaymentMethod;
}

const PREP_PRESETS: Array<{ label: string; mins: number }> = [
  { label: "ASAP", mins: 0 },
  { label: "15", mins: 15 },
  { label: "30", mins: 30 },
  { label: "45", mins: 45 },
  { label: "60", mins: 60 },
];

export function PosCartPanel(props: CartPanelProps) {
  const {
    locationId,
    cart,
    onRemoveLine,
    onChangeQty,
    onClearCart,
    onPlaceOrder,
    submitting,
    feedback,
    initialDraft,
    onDraftChange,
    dineIn,
  } = props;

  // ── Cart-adjacent state ────────────────────────────────────────────────────
  const [customerName, setCustomerName] = useState(initialDraft?.customerName ?? "");
  // Counter trade: skip the name/phone boxes entirely.
  const [walkIn, setWalkIn] = useState(initialDraft?.walkIn ?? false);
  const [customerPhone, setCustomerPhone] = useState(initialDraft?.customerPhone ?? "");
  // Ticked by default — the customer can decline SMS offers at the till.
  const [smsConsent, setSmsConsent] = useState(true);
  const [callerId, setCallerId] = useState(initialDraft?.callerId ?? "");
  const [fulfillmentType, setFulfillmentType] = useState<FulfillmentType>(
    initialDraft?.fulfillmentType ?? "PICKUP",
  );
  const [notes, setNotes] = useState(initialDraft?.notes ?? "");

  // Address
  const [addrLine1, setAddrLine1] = useState(initialDraft?.addressLine1 ?? "");
  const [addrLine2, setAddrLine2] = useState(initialDraft?.addressLine2 ?? "");
  const [city, setCity] = useState(initialDraft?.city ?? "");
  const [postcode, setPostcode] = useState(initialDraft?.postcode ?? "");
  const [addrQuery, setAddrQuery] = useState("");
  const [addrSuggestions, setAddrSuggestions] = useState<AddressSuggestion[]>([]);
  const [addrSearching, setAddrSearching] = useState(false);
  const [addrProvider, setAddrProvider] = useState<AddressProvider>("manual");
  const [postcodeProvider, setPostcodeProvider] = useState<AddressProvider>("manual");

  // Postcode lookup (UK-style: enter postcode → pick from list of houses)
  const [pcLookupResults, setPcLookupResults] = useState<AddressSuggestion[]>([]);
  const [pcLookupLoading, setPcLookupLoading] = useState(false);
  const [pcLookupNote, setPcLookupNote] = useState<string | null>(null);

  // Caller-ID autofill: the incoming-call popup (caller-id-popup.tsx)
  // dispatches "pos:callerid-fill" when the operator taps "Start order" —
  // prefill the caller number, name, and (for known customers) the chosen
  // previous delivery address.
  useEffect(() => {
    const applyFill = (d: {
      phone?: string;
      name?: string | null;
      address?: {
        line1: string;
        line2: string | null;
        city: string | null;
        postcode: string | null;
      } | null;
    }) => {
      if (!d?.phone) return;
      setCallerId(d.phone);
      setCustomerPhone(d.phone);
      if (d.name) setCustomerName(d.name);
      if (d.address) {
        setFulfillmentType("DELIVERY");
        setAddrLine1(d.address.line1);
        setAddrLine2(d.address.line2 ?? "");
        setCity(d.address.city ?? "");
        setPostcode(d.address.postcode ?? "");
      }
    };
    const onFill = (e: Event) => applyFill((e as CustomEvent).detail);
    window.addEventListener("pos:callerid-fill", onFill);
    // Apply a caller stashed by the incoming-call popup when the operator tapped
    // "Start order" from another screen (Orders tab) and we navigated here.
    try {
      const raw = sessionStorage.getItem("pos:pending-callerid-fill");
      if (raw) {
        sessionStorage.removeItem("pos:pending-callerid-fill");
        applyFill(JSON.parse(raw));
      }
    } catch {
      /* ignore */
    }
    return () => window.removeEventListener("pos:callerid-fill", onFill);
  }, []);

  // Delivery fee lookup
  const [deliveryFee, setDeliveryFee] = useState<number>(0);
  const [deliveryFeeOverride, setDeliveryFeeOverride] = useState<number | null>(null);
  const [deliveryLookupNote, setDeliveryLookupNote] = useState<string | null>(null);
  const [deliveryMinSpend, setDeliveryMinSpend] = useState<number | null>(null);

  // Timing
  const [prepMinutes, setPrepMinutes] = useState<number>(
    initialDraft?.preparationMinutes ?? 0,
  );
  const [customPrep, setCustomPrep] = useState<string>("");
  const [isScheduled, setIsScheduled] = useState<boolean>(
    initialDraft?.isScheduled ?? false,
  );
  const [scheduledDate, setScheduledDate] = useState<string>(() => {
    if (initialDraft?.scheduledFor) {
      return initialDraft.scheduledFor.slice(0, 10);
    }
    return new Date().toISOString().slice(0, 10);
  });
  const [scheduledTime, setScheduledTime] = useState<string>(() => {
    if (initialDraft?.scheduledFor) {
      return initialDraft.scheduledFor.slice(11, 16);
    }
    return "19:00";
  });

  // Discounts + promo
  const [discountType, setDiscountType] = useState<DiscountType>(
    initialDraft?.discountType ?? null,
  );
  // Phase AM — when a configured quick-promo is applied it remembers
  // which one so the cart can display its label + recompute its discount.
  const [activeQuickPromo, setActiveQuickPromo] = useState<PromoCode | null>(null);

  // Phase AM — load the configured promos for this location. The cart's
  // Discounts section renders these as quick-tap buttons. When the list
  // is empty the section shows nothing at all.
  const promosQuery = useQuery<PromoCode[]>({
    queryKey: ["pos-cart-promos", locationId],
    queryFn: () => promoCodesClient.list(locationId),
    staleTime: 60_000,
    enabled: !!locationId,
  });
  const activePromos = useMemo(
    () => (promosQuery.data ?? []).filter((p) => p.isActive),
    [promosQuery.data],
  );
  const [promoCodeInput, setPromoCodeInput] = useState<string>(
    initialDraft?.promoCode ?? "",
  );
  const [promoApplied, setPromoApplied] = useState<PromoValidateResult | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);

  // Payment
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    initialDraft?.paymentMethod ?? "CASH",
  );
  // A phone collection order: PICKUP, customer not in the shop. Walk-in and
  // delivery are deliberately excluded — a walk-in is at the counter, and a
  // delivery is settled by the driver.
  const isPhoneCollection =
    !dineIn && fulfillmentType === "PICKUP" && !walkIn;
  // A phone collection order (PICKUP, not walk-in) can't know how the
  // customer will pay — they're not here yet. Default those to
  // PAY_ON_COLLECTION so the order sits as "waiting for payment" instead of
  // recording a guess. Only ever moves OFF the default automatically; once
  // the operator picks something themselves it's left alone, and walk-in and
  // delivery keep their existing behaviour untouched.
  const autoPickedRef = useRef(false);
  useEffect(() => {
    if (dineIn) return;
    if (isPhoneCollection && paymentMethod === "CASH" && !autoPickedRef.current) {
      autoPickedRef.current = true;
      setPaymentMethod("PAY_ON_COLLECTION");
    }
    if (!isPhoneCollection && paymentMethod === "PAY_ON_COLLECTION") {
      // Switched to walk-in or delivery — that default no longer applies.
      autoPickedRef.current = false;
      setPaymentMethod("CASH");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fulfillmentType, walkIn, dineIn]);

  /** What this order type can actually be paid by. */
  const allowedPayments: PaymentMethod[] = dineIn
    ? ["CASH", "CARD_TERMINAL", "PAYMENT_LINK", "QR_CODE", "ONLINE_CARD", "EXTERNAL"]
    : isPhoneCollection
      ? ["PAY_ON_COLLECTION", "PAYMENT_LINK"]
      : walkIn
        ? ["CASH", "CARD_TERMINAL", "QR_CODE", "PAYMENT_LINK"]
        : ["CASH", "CARD_TERMINAL", "PAYMENT_LINK", "QR_CODE"];

  // Never leave a method selected that this order type can't use — switching
  // collection→walk-in with PAY_ON_COLLECTION still set would place an order
  // nobody can settle at the counter.
  useEffect(() => {
    const fallback = allowedPayments[0];
    if (fallback && !allowedPayments.includes(paymentMethod)) {
      setPaymentMethod(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fulfillmentType, walkIn, dineIn]);

  // Network state
  const online = useOnlineStatus();

  // ── Draft autosave ─────────────────────────────────────────────────────────
  useEffect(() => {
    onDraftChange?.({
      customerName,
      customerPhone,
      walkIn,
      callerId,
      fulfillmentType,
      notes,
      addressLine1: addrLine1,
      addressLine2: addrLine2,
      city,
      postcode,
      // NOTE: timing (preparationMinutes / scheduledFor / isScheduled) is
      // deliberately NOT persisted to the draft. Each order is its own
      // decision — carrying a schedule over meant the next order stayed
      // locked to the previous order's time. New orders always start ASAP.
      discountType,
      promoCode: promoCodeInput,
      paymentMethod,
    });
  }, [
    customerName,
    customerPhone,
    walkIn,
    callerId,
    fulfillmentType,
    notes,
    addrLine1,
    addrLine2,
    city,
    postcode,
    prepMinutes,
    isScheduled,
    scheduledDate,
    scheduledTime,
    discountType,
    promoCodeInput,
    paymentMethod,
    onDraftChange,
  ]);

  // ── Address provider detect (once) ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    addressLookupClient
      .status()
      .then((r) => {
        if (cancelled) return;
        setAddrProvider(r.searchProvider);
        setPostcodeProvider(r.postcodeProvider);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Address autocomplete (debounced) ──────────────────────────────────────
  useEffect(() => {
    if (fulfillmentType !== "DELIVERY") return;
    if (addrQuery.trim().length < 3) {
      setAddrSuggestions([]);
      return;
    }
    if (addrProvider === "manual") return; // no remote, skip
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setAddrSearching(true);
      try {
        const res = await addressLookupClient.search(addrQuery, "gb", 5);
        if (!cancelled) setAddrSuggestions(res.suggestions);
      } catch {
        if (!cancelled) setAddrSuggestions([]);
      } finally {
        if (!cancelled) setAddrSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [addrQuery, fulfillmentType, addrProvider]);

  // ── Postcode → delivery fee lookup ────────────────────────────────────────
  useEffect(() => {
    if (fulfillmentType !== "DELIVERY") {
      setDeliveryFee(0);
      setDeliveryFeeOverride(null);
      setDeliveryLookupNote(null);
      setDeliveryMinSpend(null);
      return;
    }
    if (!postcode.trim() || postcode.trim().length < 2) {
      setDeliveryLookupNote(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const lookup = await deliveryZonesClient.lookup(locationId, postcode);
        if (cancelled) return;
        if (lookup.matched) {
          setDeliveryFee(lookup.fee);
          setDeliveryMinSpend(
            lookup.minOrderValue != null ? Number(lookup.minOrderValue) : null,
          );
          setDeliveryLookupNote(
            `Zone ${lookup.postcodePrefix} — £${lookup.fee.toFixed(2)}` +
              (lookup.minOrderValue
                ? ` (min order £${Number(lookup.minOrderValue).toFixed(2)})`
                : ""),
          );
        } else {
          setDeliveryFee(0);
          setDeliveryMinSpend(null);
          setDeliveryLookupNote(
            `No delivery zone matches "${postcode}". Set a manual fee or add a zone.`,
          );
        }
      } catch {
        if (!cancelled) setDeliveryLookupNote("Delivery fee lookup failed");
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [postcode, fulfillmentType, locationId]);

  // ── Totals ────────────────────────────────────────────────────────────────
  const subtotal = useMemo(
    () => round2(cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0)),
    [cart],
  );

  const freeDeliveryActive =
    discountType === "FREE_DELIVERY" ||
    activeQuickPromo?.type === "FREE_DELIVERY" ||
    promoApplied?.freeDelivery === true;

  const effectiveDeliveryFee = useMemo(() => {
    if (fulfillmentType !== "DELIVERY") return 0;
    if (freeDeliveryActive) return 0;
    if (deliveryFeeOverride != null) return round2(deliveryFeeOverride);
    return round2(deliveryFee);
  }, [fulfillmentType, freeDeliveryActive, deliveryFeeOverride, deliveryFee]);

  const discountAmount = useMemo(() => {
    let amount = 0;
    // Configured quick-promo (Phase AM dynamic list)
    if (activeQuickPromo) {
      if (activeQuickPromo.type === "PERCENTAGE") {
        amount = subtotal * (Number(activeQuickPromo.value) / 100);
      } else if (activeQuickPromo.type === "FIXED_AMOUNT") {
        amount = Math.min(Number(activeQuickPromo.value), subtotal);
      }
      // FREE_DELIVERY contributes via effectiveDeliveryFee instead
    }
    // Manual promo-code entry (server-validated)
    if (discountType === "PROMO_CODE" && promoApplied?.valid) {
      amount = promoApplied.discountAmount ?? 0;
    }
    return round2(amount);
  }, [activeQuickPromo, discountType, subtotal, promoApplied]);

  const total = useMemo(
    () => round2(Math.max(0, subtotal - discountAmount + effectiveDeliveryFee)),
    [subtotal, discountAmount, effectiveDeliveryFee],
  );

  // ── Validation gates ──────────────────────────────────────────────────────
  const minSpendShortfall =
    deliveryMinSpend && subtotal < deliveryMinSpend
      ? deliveryMinSpend - subtotal
      : 0;

  const errors: string[] = [];
  if (cart.length === 0) errors.push("Cart is empty");
  if (fulfillmentType === "DELIVERY") {
    if (!addrLine1.trim()) errors.push("Delivery address required");
    if (!postcode.trim()) errors.push("Postcode required");
    if (minSpendShortfall > 0) {
      errors.push(`Min order £${deliveryMinSpend!.toFixed(2)} (need £${minSpendShortfall.toFixed(2)} more)`);
    }
  }
  if (paymentMethod === "ONLINE_CARD" && !online) {
    errors.push("Online card payment unavailable offline");
  }

  const canSubmit = errors.length === 0 && !submitting;

  // ── Actions ───────────────────────────────────────────────────────────────
  const applyPromo = async () => {
    setPromoError(null);
    const code = promoCodeInput.trim();
    if (!code) {
      setPromoError("Enter a code first");
      return;
    }
    setPromoChecking(true);
    try {
      const res = await promoCodesClient.validate({
        code,
        locationId,
        subtotal,
      });
      if (!res.valid) {
        setPromoApplied(null);
        setPromoError(res.reason ?? "Promo code invalid");
        setDiscountType(null);
      } else {
        setPromoApplied(res);
        setDiscountType("PROMO_CODE");
        setPromoError(null);
      }
    } catch (err: any) {
      setPromoError(err?.response?.data?.message ?? "Lookup failed");
    } finally {
      setPromoChecking(false);
    }
  };

  const clearPromo = () => {
    setPromoApplied(null);
    setPromoCodeInput("");
    setPromoError(null);
    if (discountType === "PROMO_CODE") setDiscountType(null);
  };

  const applySuggestion = (s: AddressSuggestion) => {
    // Only overwrite line1 if the suggestion provides one. The postcodes.io
    // fallback returns an empty line1 (it can only resolve town + postcode),
    // and we don't want clicking that to wipe a building name the operator
    // already typed.
    if (s.line1) setAddrLine1(s.line1);
    if (s.line2) setAddrLine2(s.line2);
    else if (s.line1) setAddrLine2("");
    if (s.city) setCity(s.city);
    if (s.postcode) setPostcode(s.postcode);
    setAddrQuery("");
    setAddrSuggestions([]);
    setPcLookupResults([]);
    setPcLookupNote(null);
  };

  /**
   * Google autocomplete only returns lightweight predictions — line1/city/
   * postcode are blank until we resolve the place_id with /details. Other
   * providers (Mapbox, getaddress.io, postcodes.io) return fully-structured
   * suggestions in one hop, so the resolver short-circuits for them.
   */
  const pickAddressSuggestion = async (s: AddressSuggestion) => {
    if (s.provider !== "google") {
      applySuggestion(s);
      return;
    }
    // Optimistically fill what we have so the UI doesn't go blank during
    // the details fetch.
    applySuggestion(s);
    try {
      const res = await addressLookupClient.details(s.id);
      if (res.suggestion) applySuggestion(res.suggestion);
    } catch {
      // Details failed — leave the operator with the optimistic fill, they
      // can edit the fields by hand.
    }
  };

  /**
   * UK postcode → list of houses at that postcode (getaddress.io). The
   * operator types or pastes the postcode then hits "Find" — we render the
   * results as a clickable list. Picking one fills line1/line2/city/postcode
   * so the operator only has to add a flat number or buzzer code.
   */
  const runPostcodeLookup = async () => {
    const pc = postcode.trim();
    if (pc.length < 5) {
      setPcLookupNote("Enter a full postcode first");
      setPcLookupResults([]);
      return;
    }
    setPcLookupLoading(true);
    setPcLookupNote(null);
    try {
      const res = await addressLookupClient.postcode(pc);
      if (res.suggestions.length === 0) {
        setPcLookupResults([]);
        setPcLookupNote(
          res.provider === "manual"
            ? "Postcode lookup unavailable. Enter address manually."
            : res.provider === "postcodes_io"
              ? "Postcode not recognised. Enter address manually."
              : "No addresses found for this postcode.",
        );
      } else {
        setPcLookupResults(res.suggestions);
        if (res.provider === "postcodes_io") {
          // The free postcodes.io fallback can only give us the town +
          // postcode — not house-level addresses.
          setPcLookupNote(
            "Free lookup (town + postcode only). For street names, allow Nominatim or set GETADDRESS_API_KEY.",
          );
        } else if (res.provider === "osm") {
          // OSM gives street + town but not house numbers — the operator
          // still has to type the door number.
          setPcLookupNote(
            `${res.suggestions.length} street${res.suggestions.length === 1 ? "" : "s"} found nearby — pick one, then add the house/flat number.`,
          );
        } else {
          setPcLookupNote(
            `${res.suggestions.length} address${res.suggestions.length === 1 ? "" : "es"} — tap one to use`,
          );
        }
      }
    } catch (err: any) {
      setPcLookupResults([]);
      setPcLookupNote(
        err?.response?.data?.message ?? "Postcode lookup failed",
      );
    } finally {
      setPcLookupLoading(false);
    }
  };

  const handlePlaceOrder = async () => {
    if (!canSubmit) return;
    const scheduledFor = isScheduled
      ? new Date(`${scheduledDate}T${scheduledTime}:00`).toISOString()
      : undefined;
    await onPlaceOrder({
      isWalkIn: walkIn,
      customerName: walkIn ? "Walk-in" : customerName.trim() || "Walk-in",
      customerPhone: walkIn ? "" : customerPhone.trim(),
      callerId: callerId.trim() || undefined,
      fulfillmentType,
      notes: notes.trim() || undefined,
      address:
        fulfillmentType === "DELIVERY"
          ? {
              line1: addrLine1.trim(),
              line2: addrLine2.trim() || undefined,
              city: city.trim() || "Unknown",
              postcode: postcode.trim(),
            }
          : undefined,
      preparationMinutes: prepMinutes,
      scheduledFor,
      isScheduled,
      // For server-side bookkeeping: tag the type even when the operator
      // used a quick-button promo (not a free-text code entry). The promo
      // code itself is sent so usedCount can increment.
      discountType: activeQuickPromo
        ? "PROMO_CODE"
        : discountType === "PROMO_CODE"
          ? "PROMO_CODE"
          : discountType,
      discountAmount,
      promoCode: activeQuickPromo
        ? activeQuickPromo.code
        : discountType === "PROMO_CODE" && promoApplied?.valid
          ? promoApplied.code
          : undefined,
      paymentMethod,
      // Card-terminal orders start PENDING; the reader charge (or the manual
      // "mark paid" fallback) settles them to PAID after placement.
      paymentStatus: "PENDING",
      subtotal,
      deliveryFee: effectiveDeliveryFee,
      total,
      // Dine-in never captures SMS consent (the checkbox isn't shown), so a
      // guest's phone number must not silently opt them into marketing.
      // undefined = "not asked, leave consent untouched" on the server.
      marketingConsent: dineIn ? undefined : smsConsent,
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white">
      {!online && (
        <div className="flex items-center gap-2 bg-amber-100 px-3 py-1.5 text-[11px] font-medium text-amber-900">
          <WifiOff className="h-3 w-3" />
          Offline mode — cart saved locally, card-online disabled
        </div>
      )}
      <div className="border-b border-zinc-200 px-3 py-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900">Current order</h2>
        <button
          type="button"
          onClick={onClearCart}
          disabled={cart.length === 0}
          className="text-xs text-zinc-400 hover:text-red-600 disabled:opacity-30"
        >
          Clear
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        {/* Cart lines */}
        <div className="px-3 py-2">
          {cart.length === 0 ? (
            <div className="py-8 text-center">
              <ShoppingBag className="mx-auto mb-1 h-7 w-7 text-zinc-300" />
              <p className="text-xs text-zinc-400">Tap items on the left</p>
            </div>
          ) : (
            <ul className="space-y-1">
              {cart.map((line) => (
                <li
                  key={line.id}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-50"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-900 leading-snug">
                      {line.displayName}
                    </p>
                    {line.modifiers.length > 0 && (
                      <p className="mt-0.5 text-[10px] text-zinc-500 leading-snug">
                        {line.modifiers.map((m) => m.name).join(", ")}
                      </p>
                    )}
                    <div className="mt-1 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onChangeQty(line.id, Math.max(1, line.quantity - 1))}
                        className="h-5 w-5 rounded border border-zinc-200 text-xs hover:bg-zinc-100"
                      >
                        −
                      </button>
                      <span className="min-w-[1.5rem] text-center text-[11px]">
                        {line.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => onChangeQty(line.id, line.quantity + 1)}
                        className="h-5 w-5 rounded border border-zinc-200 text-xs hover:bg-zinc-100"
                      >
                        +
                      </button>
                      <span className="ml-auto text-[11px] text-zinc-600">
                        £{(line.unitPrice * line.quantity).toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveLine(line.id)}
                    className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Table Tabs — dine-in identity card replaces the takeaway
            Order-type toggle. The table IS the order type. */}
        {dineIn && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-indigo-600 text-white">
                <UtensilsCrossed className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-indigo-900">
                  {dineIn.tableName}
                </p>
                <p className="text-[11px] text-indigo-700">
                  Dine-in
                  {dineIn.tabItemCount > 0
                    ? ` — ${dineIn.tabItemCount} item${
                        dineIn.tabItemCount === 1 ? "" : "s"
                      } on the tab (£${dineIn.tabTotal.toFixed(2)})`
                    : " — new tab, nothing sent yet"}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Customer / Guest */}
        <Section title={dineIn ? "Guest (optional)" : "Customer"}>
          {/* Walk-in — the counter case. Name and phone were already
              optional for collection, but staff still tabbed through two
              empty boxes on every order. One tap now skips them, and the
              order is filed as "Walk-in" so reporting can separate counter
              trade from phone and online. */}
          {!dineIn && (
            <button
              type="button"
              onClick={() => {
                const next = !walkIn;
                setWalkIn(next);
                if (next) {
                  setCustomerName("");
                  setCustomerPhone("");
                  setCallerId("");
                  setSmsConsent(false);
                }
              }}
              className={
                "mb-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold " +
                (walkIn
                  ? "bg-zinc-900 text-white"
                  : "border border-zinc-200 text-zinc-700 hover:bg-zinc-50")
              }
            >
              {walkIn ? "✓ Walk-in — no details needed" : "🚶 Walk-in customer"}
            </button>
          )}
          {!walkIn && (
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={customerName}
              onChange={setCustomerName}
              placeholder={dineIn ? "Guest name (optional)" : "Name"}
            />
            <Input
              value={customerPhone}
              onChange={setCustomerPhone}
              placeholder={dineIn ? "Phone (optional)" : "Phone"}
              type="tel"
            />
          </div>
          )}
          {/* Caller ID + SMS consent are phone-order concepts — a seated
              guest never rings in, and consent capture happens online. */}
          {!dineIn && !walkIn && (
            <>
              <div className="mt-2 flex items-center gap-1.5">
                <Phone className="h-3 w-3 text-zinc-400" />
                <Input
                  value={callerId}
                  onChange={setCallerId}
                  placeholder="Caller ID (auto-populated by CTI integration)"
                />
              </div>
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-zinc-600">
                <input
                  type="checkbox"
                  checked={smsConsent}
                  onChange={(e) => setSmsConsent(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300"
                />
                <span>
                  Customer agrees to receive offers &amp; updates by SMS
                  <span className="block text-[10px] text-zinc-400">
                    Untick if they decline. Adds them to your SMS marketing list.
                  </span>
                </span>
              </label>
            </>
          )}
          <div className="mt-2">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                dineIn
                  ? "Kitchen notes for this round (allergies, cooking preferences…)"
                  : "Order notes (e.g. allergies, instructions)"
              }
              rows={2}
              className="w-full resize-none rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
            />
          </div>
        </Section>

        {/* Order type — hidden for dine-in (the table card above owns it) */}
        {!dineIn && (
          <Section title="Order type">
            <Toggle
              value={fulfillmentType}
              onChange={(v) => setFulfillmentType(v as FulfillmentType)}
              options={[
                { value: "PICKUP", label: "Collection" },
                { value: "DELIVERY", label: "Delivery" },
              ]}
            />
          </Section>
        )}

        {/* Delivery address */}
        {fulfillmentType === "DELIVERY" && (
          <Section title="Delivery address">
            {addrProvider !== "manual" && (
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-400" />
                <input
                  value={addrQuery}
                  onChange={(e) => setAddrQuery(e.target.value)}
                  placeholder={`Search address (${addrProvider})`}
                  className="w-full rounded-md border border-zinc-200 px-7 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                />
                {addrSearching && (
                  <Loader2 className="absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-zinc-400" />
                )}
                {addrSuggestions.length > 0 && (
                  <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
                    {addrSuggestions.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => pickAddressSuggestion(s)}
                          className="w-full px-2 py-1.5 text-left text-[11px] hover:bg-zinc-50"
                        >
                          {s.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              {/* Phase AP fix #3 — House/flat number gets its own row
                  above line 1 so the operator never accidentally puts
                  it on the street line. We use line2 as the canonical
                  storage so the existing print payload / API doesn't
                  need a new column. The placeholder is enough hint. */}
              <Input value={addrLine2} onChange={setAddrLine2} placeholder="House / flat number" />
              <Input value={addrLine1} onChange={setAddrLine1} placeholder="Street name" />
              <div className="grid grid-cols-2 gap-2">
                <Input value={city} onChange={setCity} placeholder="City" />
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={postcode}
                    onChange={(e) => setPostcode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      // Pressing Enter inside the postcode field should
                      // fire the lookup, like a search bar would.
                      if (e.key === "Enter") {
                        e.preventDefault();
                        runPostcodeLookup();
                      }
                    }}
                    placeholder="Postcode"
                    className="flex-1 rounded-md border border-zinc-200 px-2 py-1.5 text-xs uppercase focus:border-zinc-900 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={runPostcodeLookup}
                    disabled={pcLookupLoading || postcode.trim().length < 5}
                    title={
                      postcodeProvider === "manual"
                        ? "Postcode lookup unavailable (set GETADDRESS_API_KEY)"
                        : "Find addresses at this postcode"
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-[10px] font-medium hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {pcLookupLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Search className="h-3 w-3" />
                    )}
                    Find
                  </button>
                </div>
              </div>

              {/* Postcode lookup results */}
              {pcLookupNote && (
                <p className="text-[10px] text-zinc-500">{pcLookupNote}</p>
              )}
              {pcLookupResults.length > 0 && (
                <ul className="max-h-44 overflow-y-auto rounded-md border border-zinc-200 bg-white">
                  {pcLookupResults.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => pickAddressSuggestion(s)}
                        className="w-full px-2 py-1.5 text-left text-[11px] leading-snug hover:bg-zinc-50"
                      >
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {deliveryLookupNote && (
                <p className="text-[10px] text-zinc-500">{deliveryLookupNote}</p>
              )}
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-zinc-500">
                  Manual fee override (£):
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={deliveryFeeOverride ?? ""}
                  onChange={(e) =>
                    setDeliveryFeeOverride(
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                  className="w-20 rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px]"
                  placeholder="auto"
                />
              </div>
            </div>
          </Section>
        )}

        {/* Expected time / schedule — takeaway-only. Dine-in food fires to
            the kitchen the moment the round is sent; there is nothing to
            time or schedule. */}
        {!dineIn && (
        <Section title="Timing">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3 text-zinc-400" />
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              Expected time
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {PREP_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setPrepMinutes(p.mins);
                  setCustomPrep("");
                }}
                className={`rounded-md border px-2 py-1 text-[11px] ${
                  prepMinutes === p.mins && !customPrep
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                }`}
              >
                {p.label === "ASAP" ? "ASAP" : `${p.label} min`}
              </button>
            ))}
            <input
              type="number"
              min="0"
              value={customPrep}
              onChange={(e) => {
                setCustomPrep(e.target.value);
                setPrepMinutes(Number(e.target.value) || 0);
              }}
              placeholder="custom"
              className="w-16 rounded-md border border-zinc-200 px-1.5 py-1 text-[11px]"
            />
          </div>
          <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-700">
            <input
              type="checkbox"
              checked={isScheduled}
              onChange={(e) => setIsScheduled(e.target.checked)}
              className="h-3 w-3"
            />
            <Calendar className="h-3 w-3" />
            Schedule for later
          </label>
          {isScheduled && (
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <input
                type="date"
                value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
                className="rounded-md border border-zinc-200 px-2 py-1 text-[11px]"
              />
              <input
                type="time"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="rounded-md border border-zinc-200 px-2 py-1 text-[11px]"
              />
            </div>
          )}
        </Section>
        )}

        {/* Discounts — only render the section when promos are configured
            for this location. Quiet locations have zero buttons. */}
        {activePromos.length > 0 && (
          <Section title="Discounts">
            <div className="grid grid-cols-2 gap-1.5">
              {activePromos.map((p) => {
                const isActive = activeQuickPromo?.id === p.id;
                const disabled =
                  p.type === "FREE_DELIVERY" && fulfillmentType !== "DELIVERY";
                return (
                  <DiscountButton
                    key={p.id}
                    active={isActive}
                    disabled={disabled}
                    onClick={() => {
                      if (isActive) {
                        setActiveQuickPromo(null);
                        setDiscountType(null);
                      } else {
                        setActiveQuickPromo(p);
                        setDiscountType(p.type);
                      }
                    }}
                  >
                    {promoButtonLabel(p)}
                  </DiscountButton>
                );
              })}
            </div>
          </Section>
        )}

        {/* Promo code */}
        <Section title="Promo code">
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Tag className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-400" />
              <input
                value={promoCodeInput}
                onChange={(e) => setPromoCodeInput(e.target.value.toUpperCase())}
                placeholder="ENTER CODE"
                className="w-full rounded-md border border-zinc-200 px-7 py-1 text-[11px] uppercase focus:border-zinc-900 focus:outline-none"
              />
            </div>
            {promoApplied?.valid ? (
              <button
                type="button"
                onClick={clearPromo}
                className="rounded-md border border-red-200 bg-red-50 px-2 text-[11px] text-red-700 hover:bg-red-100"
              >
                <XCircle className="inline h-3 w-3" /> Remove
              </button>
            ) : (
              <button
                type="button"
                onClick={applyPromo}
                disabled={promoChecking || !promoCodeInput.trim()}
                className="rounded-md border border-zinc-300 bg-white px-2 text-[11px] hover:bg-zinc-50 disabled:opacity-50"
              >
                {promoChecking ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Apply"
                )}
              </button>
            )}
          </div>
          {promoApplied?.valid && (
            <p className="mt-1 flex items-center gap-1 text-[10px] text-emerald-700">
              <CheckCircle2 className="h-3 w-3" />
              {promoApplied.freeDelivery
                ? "Free delivery applied"
                : `−£${(promoApplied.discountAmount ?? 0).toFixed(2)} off (${promoApplied.code})`}
            </p>
          )}
          {promoError && (
            <p className="mt-1 text-[10px] text-red-600">{promoError}</p>
          )}
        </Section>

        {/* Payment — takeaway-only. A dine-in tab settles once, at the end,
            via the "Pay & close" button (card terminal / cash), never per
            round. */}
        {!dineIn && (
        <Section title="Payment">
          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                { value: "PAY_ON_COLLECTION", label: "Pay on collection" },
                { value: "CASH", label: "Cash" },
                { value: "CARD_TERMINAL", label: "Card terminal" },
                { value: "ONLINE_CARD", label: "Online card" },
                { value: "PAYMENT_LINK", label: "Payment link" },
                { value: "QR_CODE", label: "QR code" },
                { value: "EXTERNAL", label: "External" },
              ] as const
            )
              // One allowlist per order type, rather than a pile of
              // subtractions. What can actually be taken depends entirely on
              // whether the customer is standing there:
              //
              //  Collection — they're not here yet, so nothing can be taken
              //    at the counter. Offering Cash and Card terminal is what
              //    produced orders recorded as "cash" that were paid by card.
              //    Both come back on the order card when they arrive.
              //  Walk-in   — they're at the till, so everything works.
              //  Delivery  — settled by the driver or remotely.
              .filter((opt) => allowedPayments.includes(opt.value))
              .map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setPaymentMethod(opt.value)}
                disabled={opt.value === "ONLINE_CARD" && !online}
                className={`rounded-md border px-2 py-1.5 text-[11px] ${
                  paymentMethod === opt.value
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                } disabled:opacity-40`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-zinc-500">
            Online card &amp; Payment link require Stripe. Payment link places the
            order as pending and shows a QR/link for the customer to pay.
          </p>
        </Section>
        )}
      </div>

      {/* Footer totals + submit */}
      <div className="border-t border-zinc-200 bg-zinc-50 px-3 py-2 space-y-1.5">
        <Row
          label={dineIn ? "This round" : "Subtotal"}
          value={`£${subtotal.toFixed(2)}`}
        />
        {discountAmount > 0 && (
          <Row label="Discount" value={`−£${discountAmount.toFixed(2)}`} accent="text-emerald-700" />
        )}
        {fulfillmentType === "DELIVERY" && !dineIn && (
          <Row
            label={`Delivery${(discountType === "FREE_DELIVERY" || promoApplied?.freeDelivery) ? " (free)" : ""}`}
            value={`£${effectiveDeliveryFee.toFixed(2)}`}
          />
        )}
        {/* Dine-in: show what's already on the tab and what the bill
            becomes once this round is sent — the number staff quote when
            the guest asks "what are we at?". */}
        {dineIn && dineIn.tabItemCount > 0 && (
          <>
            <Row label="Already on tab" value={`£${dineIn.tabTotal.toFixed(2)}`} />
            <Row
              label="Tab after this round"
              value={`£${(dineIn.tabTotal + total).toFixed(2)}`}
              bold
            />
          </>
        )}
        {!(dineIn && dineIn.tabItemCount > 0) && (
          <Row label="Total" value={`£${total.toFixed(2)}`} bold />
        )}
        {errors.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {errors.map((e) => (
              <li key={e} className="text-[10px] text-red-600">
                • {e}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={handlePlaceOrder}
          disabled={!canSubmit}
          className={`mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed ${
            dineIn
              ? "bg-indigo-600 hover:bg-indigo-700"
              : "bg-emerald-500 hover:bg-emerald-600"
          }`}
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {dineIn && <UtensilsCrossed className="h-3.5 w-3.5" />}
          {props.submitButtonLabel ??
            (dineIn
              ? dineIn.tabItemCount > 0
                ? "Send round to kitchen"
                : "Open tab — send to kitchen"
              : isScheduled
                ? "Save scheduled order"
                : "Place order")}
        </button>
        {feedback && (
          <p className="text-center text-[11px] text-zinc-600">{feedback}</p>
        )}
      </div>
    </div>
  );
}

// ── Local atoms ──────────────────────────────────────────────────────────────

function promoButtonLabel(p: PromoCode): string {
  if (p.type === "FREE_DELIVERY") return `${p.code} · Free delivery`;
  if (p.type === "PERCENTAGE") return `${p.code} · ${Number(p.value)}% off`;
  return `${p.code} · £${Number(p.value).toFixed(2)} off`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-zinc-100 px-3 py-2">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </p>
      {children}
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
    />
  );
}

function Toggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="flex rounded-md border border-zinc-200 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-sm px-2 py-1 text-xs ${
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

function DiscountButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-2 py-1.5 text-[11px] ${
        active
          ? "border-emerald-600 bg-emerald-50 text-emerald-700"
          : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
      } disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function Row({
  label,
  value,
  bold,
  accent,
}: {
  label: string;
  value: string;
  bold?: boolean;
  accent?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between text-xs ${
        bold ? "font-semibold text-zinc-900" : "text-zinc-600"
      } ${accent ?? ""}`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
