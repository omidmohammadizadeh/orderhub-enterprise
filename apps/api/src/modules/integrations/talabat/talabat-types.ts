// Phase TB — Delivery Hero POS Plugin API payload types.
//
// Transcribed from pluginOrder.yaml (the `Order` schema the middleware POSTs
// to /order/{remoteId}) and the plugin spec's other request bodies. Only the
// fields we read are typed; the spec is explicit that "order payload will
// progressively incorporate additional properties" and that plugins must
// ignore what they don't know, so nothing here is closed.
//
// Money is a STRING almost everywhere ("10.00"), except topping `quantity`,
// delivery-fee `value` and coordinates, which are numbers. Read through
// num() in the transformer, never Number() directly on something optional.

export type TalabatExpeditionType = "pickup" | "delivery";

export interface TalabatSponsorship {
  sponsor: "PLATFORM" | "VENDOR" | "THIRD_PARTY" | string;
  amount: string;
}

export interface TalabatDiscount {
  name?: string;
  amount: string;
  type?: string;
  sponsorships?: TalabatSponsorship[];
}

export type TalabatUnavailabilityHandling =
  | "REMOVE"
  | "REDUCE_QUANTITY"
  | "CALL_CUSTOMER_AND_REPLACE"
  | "CANCEL_ORDER"
  | string;

export interface TalabatTopping {
  id?: string;
  name: string;
  price: string;
  quantity: number | string;
  remoteCode?: string | null;
  sku?: string;
  type?: "PRODUCT" | "VARIANT" | "EXTRA" | string;
  itemUnavailabilityHandling?: TalabatUnavailabilityHandling;
  discounts?: TalabatDiscount[];
  /** Nested up to 5 levels per the spec; `[]` when none. */
  children?: TalabatTopping[];
}

export interface TalabatProduct {
  id?: string;
  categoryName?: string;
  name?: string;
  /** The line total as charged. */
  paidPrice?: string;
  quantity?: string | number;
  remoteCode?: string | null;
  sku?: string;
  selectedToppings?: TalabatTopping[];
  /** Base price without toppings. */
  unitPrice?: string;
  comment?: string | null;
  itemUnavailabilityHandling?: TalabatUnavailabilityHandling;
  discounts?: TalabatDiscount[];
}

export interface TalabatAddress {
  building?: string;
  city?: string;
  company?: string;
  deliveryArea?: string;
  deliveryAreaPostcode?: string;
  deliveryInstructions?: string | null;
  deliveryMainArea?: string;
  entrance?: string;
  flatNumber?: string;
  floor?: string;
  intercom?: string;
  latitude?: number;
  longitude?: number;
  number?: string;
  postcode?: string;
  street?: string;
}

export interface TalabatCallbackUrls {
  orderAcceptedUrl?: string | null;
  orderRejectedUrl?: string | null;
  orderProductModificationUrl?: string | null;
  orderPickedUpUrl?: string | null;
  orderPreparedUrl?: string | null;
  orderPreparationTimeAdjustmentUrl?: string | null;
}

export interface TalabatPrepTimeInfo {
  maxPickUpTimestamp?: string;
  /** The spec spells this both ways (`required` vs `properties`). Read both. */
  minPickUpTimestamp?: string;
  minPickupTimestamp?: string;
  preparationTimeChangeIntervalsInMinutes?: number[];
}

export interface TalabatOrder {
  /** The middleware's order id — every callback is keyed on it. */
  token: string;
  /** The platform's order id (what Talabat support quote). */
  code?: string;
  /** Rider-facing code, unique per vendor per day. */
  shortCode?: string | null;
  comments?: { customerComment?: string; vendorComment?: string };
  createdAt?: string;
  /** Accept or reject by then, or the middleware cancels the order. */
  expiryDate?: string;
  customer?: {
    email?: string;
    firstName?: string;
    lastName?: string;
    mobilePhone?: string;
    code?: string;
    id?: string;
    flags?: string[];
  };
  delivery?: {
    address?: TalabatAddress | null;
    expectedDeliveryTime?: string | null;
    expressDelivery?: boolean;
    /** null ⇒ vendor delivery; a time ⇒ a Talabat rider collects. */
    riderPickupTime?: string | null;
  } | null;
  discounts?: TalabatDiscount[];
  expeditionType?: TalabatExpeditionType | string;
  extraParameters?: Record<string, string>;
  localInfo?: {
    countryCode?: string;
    currencySymbol?: string;
    platform?: string;
    platformKey?: string;
  };
  payment?: { status?: "pending" | "paid" | string; type?: string; remoteCode?: string };
  /** Test orders must never be cooked. Only ever true on direct integrations. */
  test?: boolean;
  preOrder?: boolean;
  pickup?: { pickupCode?: string; pickupTime?: string | null } | null;
  platformRestaurant?: { id?: string };
  price?: {
    deliveryFees?: Array<{ name?: string; value?: number }>;
    grandTotal?: string;
    minimumDeliveryValue?: string;
    payRestaurant?: string;
    riderTip?: string;
    subTotal?: string;
    totalNet?: string;
    vatTotal?: string;
    deliveryFee?: string;
    collectFromCustomer?: string;
    discountAmountTotal?: string;
    vatPercent?: string;
  };
  products?: TalabatProduct[];
  corporateTaxId?: string;
  preparationTimeAdjustmentInformation?: TalabatPrepTimeInfo | null;
  callbackUrls?: TalabatCallbackUrls | null;
  [k: string]: unknown;
}

/** PUT /remoteId/{remoteId}/remoteOrder/{remoteOrderId}/posOrderStatus */
export interface TalabatOrderStatusUpdate {
  status:
    | "ORDER_CANCELLED"
    | "ORDER_PICKED_UP"
    | "PRODUCT_ORDER_MODIFICATION_SUCCESSFUL"
    | "PRODUCT_ORDER_MODIFICATION_FAILED"
    | "COURIER_ARRIVED_AT_VENDOR"
    | "SHOW_RIDER_WAITING_WARNING"
    | "HIDE_RIDER_WAITING_WARNING"
    | string;
  message?: string;
  occurredAt?: string;
  riderWaitingWarnings?: { waitingStartsAt?: string; waitingFeeAppliesAt?: string | null } | null;
  updatedOrder?: TalabatOrder;
}

/** PUT /remoteId/{remoteId}/availability */
export interface TalabatVendorAvailabilityUpdate {
  timestamp: string;
  closures?: Array<{ reason: string; start: string; end?: string | null; changeable: boolean }>;
}

/** POST {catalogImportCallback} */
export interface TalabatCatalogCallback {
  catalogImportId?: string;
  status?: "in_progress" | "done" | "done_with_errors" | "failed" | string;
  message?: string;
  details?: Array<{
    status?: string;
    posVendorId?: string;
    platformVendorId?: string;
    globalEntityId?: string;
  }>;
}

/** The reject reasons the middleware accepts, exactly as spelled. */
export const TALABAT_REJECT_REASONS = [
  "ADDRESS_INCOMPLETE_MISSTATED",
  "BAD_WEATHER",
  "BLACKLISTED",
  "CARD_READER_NOT_AVAILABLE",
  "CLOSED",
  "CONTENT_WRONG_MISLEADING",
  "FOOD_QUALITY_SPILLAGE",
  "FRAUD_PRANK",
  "ITEM_UNAVAILABLE",
  "LATE_DELIVERY",
  "MENU_ACCOUNT_SETTINGS",
  "MOV_NOT_REACHED",
  "NO_COURIER",
  "NO_PICKER",
  "NO_RESPONSE",
  "OUTSIDE_DELIVERY_AREA",
  "TECHNICAL_PROBLEM",
  "TEST_ORDER",
  "TOO_BUSY",
  "UNABLE_TO_FIND",
  "UNABLE_TO_PAY",
  "UNPROFESSIONAL_BEHAVIOUR",
  "WILL_NOT_WORK_WITH_PLATFORM",
  "WRONG_ORDER_ITEMS_DELIVERED",
] as const;
export type TalabatRejectReason = (typeof TALABAT_REJECT_REASONS)[number];

/**
 * The reasons their table marks "Applicable: after acceptance". Everything
 * else is before-acceptance only, so cancelling an ACCEPTED order with, say,
 * TOO_BUSY would be refused — and the customer would still be waiting.
 */
export const TALABAT_AFTER_ACCEPT_REASONS: ReadonlySet<string> = new Set([
  "BAD_WEATHER",
  "CARD_READER_NOT_AVAILABLE",
  "CONTENT_WRONG_MISLEADING",
  "FOOD_QUALITY_SPILLAGE",
  "LATE_DELIVERY",
  "UNABLE_TO_FIND",
  "UNABLE_TO_PAY",
  "UNPROFESSIONAL_BEHAVIOUR",
  "WRONG_ORDER_ITEMS_DELIVERED",
]);

/** Closure reasons for PUT availability (VendorClosedReason subset we send). */
export type TalabatClosedReason =
  | "TOO_BUSY_NO_DRIVERS"
  | "TOO_BUSY_KITCHEN"
  | "UPDATES_IN_MENU"
  | "TECHNICAL_PROBLEM"
  | "CLOSED"
  | "OTHER"
  | "BAD_WEATHER"
  | "HOLIDAY_SPECIAL_DAY";
