// Wire shapes of the Eat For Less endpoints (apps/api/src/modules/eat-for-less)
// and the storefront payload they wrap (OrderingService.getStorefrontBySlug).
// Only the fields the app reads are typed; money arrives as number OR string
// (Prisma Decimal), so every price goes through toNumber() in lib/money.

export type Money = number | string;

/** GET efl/shops — one nearby listing. */
export type Shop = {
  id: string;
  name: string;
  area: string | null;
  logoUrl: string | null;
  heroImageUrl: string | null;
  description?: string | null;
  cuisines: string[];
  distanceMiles: number;
  isOpen: boolean;
  /** Published review average; null until the shop has reviews. */
  rating: { value: number; count: number } | null;
  delivery: {
    available: boolean;
    fee: number | null;
    /** From the delivery zone that matched this address. */
    minOrder: number | null;
    /** Shop prep time + driving time for this distance. */
    etaMinutes: { min: number; max: number } | null;
  };
  collection: { available: boolean; readyInMinutes: number | null };
  /** NOT SENT BY THE API YET (gap): a headline offer. Only the dev sample
   *  data fills it; cards hide it when absent. */
  deal?: string | null;
};

export type ModifierOption = {
  id: string;
  name: string;
  priceAdjustment: Money;
  pricesBySize?: Record<string, number> | null;
  skuPlus?: Record<string, string> | null;
  plu?: string | null;
  isDefault?: boolean;
  isAvailable?: boolean;
  visibleToCustomers?: boolean;
  /** Groups this option opens when chosen (nested modifiers). */
  nestedGroupIds?: string[] | null;
};

export type ModifierGroup = {
  id: string;
  name: string;
  description?: string | null;
  minSelections?: number | null;
  maxSelections?: number | null;
  isRequired?: boolean;
  selectionType?: "VARIANT" | "ADDON" | null;
  allowDuplicateSelections?: boolean | null;
  visibleToCustomers?: boolean;
  options: ModifierOption[];
};

export type ProductSku = {
  name: string;
  plu: string;
  price: number;
  /** Group ids that apply to this size. Resolved against brandModifierGroups. */
  modifierGroups: string[];
};

export type MenuItem = {
  id: string;
  name: string;
  description?: string | null;
  basePrice: Money;
  imageUrl?: string | null;
  plu?: string | null;
  isAvailable?: boolean;
  visibleToCustomers?: boolean;
  outOfStock?: boolean;
  availableDelivery?: boolean;
  availableCollection?: boolean;
  allergens?: string[];
  hasMultipleSkus?: boolean;
  productSkus?: ProductSku[];
  /** The storefront sends ids only; the group lives in brandModifierGroups. */
  modifierGroupLinks?: Array<{ groupId: string; group?: ModifierGroup }>;
};

export type MenuCategory = {
  id: string;
  name: string;
  items: Array<{ itemId: string; priceOverride?: Money | null; item: MenuItem }>;
};

export type Storefront = {
  location: {
    id: string;
    name: string;
    addressLine1?: string | null;
    city?: string | null;
    postcode?: string | null;
    currency?: string | null;
    phone?: string | null;
    about?: string | null;
  };
  brand: { id: string; name: string; logoUrl?: string | null; primaryColor?: string | null };
  menu: { id: string; heroImage?: string | null; bannerImage?: string | null; categories: MenuCategory[] } | null;
  brandModifierGroups?: ModifierGroup[];
  isOpen: boolean;
  closed?: { brandName: string; resumeAt: string | null; reason: string | null } | null;
  busy?: { extraPrepTime: number | null } | null;
  directConfig?: {
    deliveryPrepMinutes: number;
    collectionPrepMinutes: number;
    acceptsDelivery: boolean;
    acceptsCollection: boolean;
    minOrderForDelivery: Money | null;
  };
};

/** GET efl/shops/:listingId/menu */
export type ShopMenu = {
  listing: {
    id: string;
    heroImageUrl: string | null;
    logoUrl: string | null;
    description: string | null;
    cuisines: string[];
    acceptsDelivery: boolean;
    acceptsCollection: boolean;
  };
  store: Storefront;
};

/** POST efl/shops/:listingId/checkout — body (subset of CheckoutDto the app may set). */
export type CheckoutBody = {
  idempotencyKey: string;
  fulfillmentType: "DELIVERY" | "PICKUP";
  deliveryAddress?: {
    line1: string;
    line2?: string;
    city: string;
    postcode?: string;
    latitude?: number;
    longitude?: number;
  };
  items: Array<{
    menuItemId: string;
    name: string;
    quantity: number;
    unitPrice: number;
    modifiers: Array<{
      name: string;
      price: number;
      optionId?: string | null;
      depth?: number;
      path?: string[];
      parentOptionId?: string | null;
    }>;
    skuPlu?: string | null;
    skuName?: string | null;
    notes?: string;
  }>;
  subtotal: number;
  deliveryFee?: number;
  tipAmount?: number;
  total: number;
  specialInstructions?: string;
  scheduledFor?: string;
};

export type CheckoutResult = {
  orderId: string;
  displayId: string | null;
  total: number;
  clientSecret: string | null;
  stripeAccountId: string | null;
  amountPence: number | null;
  checkoutUrl: string | null;
};

export type OrderStatusName =
  | "PENDING"
  | "RECEIVED"
  | "ACCEPTED"
  | "PREPARING"
  | "READY"
  | "OUT_FOR_DELIVERY"
  | "RIDER_ARRIVED"
  | "DELIVERED"
  | "COLLECTED"
  | "COMPLETED"
  | "CANCELLED"
  | "REJECTED"
  | "FAILED"
  | (string & {});

export type LatLng = { lat: number; lng: number };

/** GET efl/me/orders/:orderId — the public order status plus the PIN. */
export type OrderDetail = {
  id: string;
  displayId: string | null;
  orderNumber?: number | null;
  status: OrderStatusName;
  paymentStatus?: string;
  fulfillmentType: "DELIVERY" | "PICKUP" | string;
  estimatedReadyAt?: string | null;
  receivedAt?: string | null;
  acceptedAt?: string | null;
  preparingAt?: string | null;
  readyAt?: string | null;
  outForDeliveryAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  total: Money;
  location?: { name?: string; currency?: string | null } | null;
  items: Array<{ id: string; name: string; quantity: number; unitPrice: Money; modifiers?: any }>;
  destination: LatLng | null;
  shop: LatLng | null;
  /** Never carries a phone number: calls go through Eat For Less (Phase 4). */
  driver: { name?: string | null; lat?: number | null; lng?: number | null; lastPingAt?: string | null } | null;
  /** Driving minutes from the driver's last position to the door. */
  driverEtaMinutes: number | null;
  deliveryPin: string | null;
  handedOver: boolean;
  /** Our private-line number and this customer's code, while the line is
   *  open (until 2h after delivery). Null before calls are set up. */
  privateLine?: { number: string; code: string } | null;
};

/** GET/POST efl/me/orders/:id/messages — one message with the driver. */
export type OrderMessage = {
  id: string;
  senderType: "CUSTOMER" | "DRIVER" | "OPERATOR";
  senderName: string | null;
  body: string;
  createdAt: string;
};

/** GET efl/me/orders — one row. */
export type OrderSummary = {
  id: string;
  displayId: string | null;
  status: OrderStatusName;
  total: Money;
  createdAt: string;
  fulfillmentType: string;
  location: { name: string; eflListing: { id: string } | null } | null;
  brand: { name: string } | null;
};

/** customer-auth — the account. */
export type Customer = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  avatarUrl?: string | null;
  isVerified?: boolean;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressCity?: string | null;
  addressPostcode?: string | null;
};

export type AuthResult = { accessToken: string; customer: Customer };

/** GET efl/config (public). */
export type AppConfig = { stripePublishableKey: string | null };

/** GET efl/me — the customer's Eat For Less flags. */
export type EflMe = { phone: string | null; phoneVerified: boolean; marketingOptIn: boolean };

/** efl/me/addresses — a saved address on the account. */
export type SavedAddress = {
  id: string;
  label: string | null;
  line1: string;
  line2: string | null;
  city: string;
  postcode: string;
  latitude: number | null;
  longitude: number | null;
  instructions: string | null;
  isDefault: boolean;
};

export type AddressBody = {
  label?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  postcode: string;
  latitude?: number | null;
  longitude?: number | null;
  instructions?: string | null;
  isDefault?: boolean;
};
