import { z } from "zod";

// ── Canonical Order ───────────────────────────────────────
// Single normalised shape that ALL platform adapters must map into.
// The API and worker operate on CanonicalOrder, never on raw platform payloads.

// Mirrors the OrderPlatform enum in the Prisma schema — which already carried
// TALABAT, DOORDASH, GRUBHUB and CAREEM while this list did not. The database
// would accept a Careem order that this schema rejected first, so ingest
// failed at validation with an enum error that reads like a bug in the
// transformer. Keep the two lists identical.
export const OrderPlatformSchema = z.enum([
  "UBER_EATS",
  "DELIVEROO",
  "JUST_EAT",
  "HUBRISE",
  "DIRECT",
  "POS",
  "ONLINE",
  "TALABAT",
  "DOORDASH",
  "GRUBHUB",
  "CAREEM",
  "WHATSAPP",
]);
export type OrderPlatform = z.infer<typeof OrderPlatformSchema>;

// The sales channel that originated the order
// Mirrors the OrderSource enum in the Prisma schema — same drift as above.
export const OrderSourceSchema = z.enum([
  "ONLINE",
  "POS",
  "UBER_EATS",
  "DELIVEROO",
  "JUST_EAT",
  "HUBRISE",
  "DIRECT",
  "TALABAT",
  "DOORDASH",
  "GRUBHUB",
  "CAREEM",
  "WHATSAPP",
]);
export type OrderSource = z.infer<typeof OrderSourceSchema>;

// Which adapter delivered the order into our system
export const IntegrationSourceSchema = z.enum(["DIRECT", "HUBRISE"]);
export type IntegrationSource = z.infer<typeof IntegrationSourceSchema>;

// ── OrderStatus ──────────────────────────────────────────
// The status lifecycle. Mirrors the Prisma enum (which is the source of truth).
//
// Forward flow:
//   PENDING → ACCEPTED → PREPARING → READY → ASSIGNED_DRIVER → ACCEPTED_BY_DRIVER
//          → RIDER_ARRIVED → OUT_FOR_DELIVERY → COMPLETED (delivered/collected)
//
// RIDER_ARRIVED is emitted when a platform-rider (Uber Eats / Just Eat /
// Deliveroo / Stuart / Uber Direct) reaches the shop to collect — it signals
// front-of-house "the bag is being handed over right now" so staff can audibly
// react. Mark "Out for delivery" once the rider walks out the door.
//
// Terminal/exception states (any non-terminal status can transition to one):
//   CANCELLED, REJECTED, FAILED
//
// DISPATCHED is kept as a legacy alias for OUT_FOR_DELIVERY — older code,
// outbox events, and platform adapters may still emit it. New code should
// prefer the granular states.
export const OrderStatusSchema = z.enum([
  "PENDING",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "PENDING_DISPATCH", // dispatched to 3rd-party (Uber Direct / Stuart / JET) — no driver accepted yet
  "ASSIGNED_DRIVER",
  "ACCEPTED_BY_DRIVER",
  "RIDER_ARRIVED",    // platform rider physically at the shop, ready to collect
  "OUT_FOR_DELIVERY",
  "DISPATCHED", // legacy alias for OUT_FOR_DELIVERY
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
  "FAILED",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

// More granular than OrderType — captures the courier model
export const FulfillmentTypeSchema = z.enum([
  "PICKUP",
  "DELIVERY",
  "DINE_IN",
  "MERCHANT_DELIVERY",
  "PLATFORM_COURIER",
]);
export type FulfillmentType = z.infer<typeof FulfillmentTypeSchema>;

export const CustomerInfoSchema = z.object({
  name: z.string(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});
export type CustomerInfo = z.infer<typeof CustomerInfoSchema>;

export const OrderModifierSchema = z.object({
  name: z.string(),
  price: z.number(),
  quantity: z.number().default(1),
  /** Nesting level for modifiers that hang off another modifier — a sauce
   *  chosen for the side that was chosen for the meal. The kitchen ticket
   *  indents by it, so a flat list still reads as the tree it came from.
   *  Optional: most marketplaces have no nesting to express. */
  depth: z.number().int().nonnegative().optional(),
});
export type OrderModifier = z.infer<typeof OrderModifierSchema>;

export const OrderItemSchema = z.object({
  externalId: z.string().optional(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  totalPrice: z.number().nonnegative(),
  modifiers: z.array(OrderModifierSchema).default([]),
  notes: z.string().optional(),
  sku: z.string().optional(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const CanonicalOrderSchema = z.object({
  // Platform reference — used for dedup via @@unique([externalId, platform])
  externalId: z.string(),
  platform: OrderPlatformSchema,

  // Source tracking
  orderSource: OrderSourceSchema.default("DIRECT"),
  integrationSource: IntegrationSourceSchema.default("DIRECT"),
  viaHubrise: z.boolean().default(false),

  // Fulfillment
  fulfillmentType: FulfillmentTypeSchema.default("DELIVERY"),

  displayId: z.string().optional(),
  customerInfo: CustomerInfoSchema,
  deliveryAddress: z
    .object({
      line1: z.string(),
      line2: z.string().optional(),
      city: z.string(),
      // Optional: the UAE and most of the Gulf have no postal code in
      // everyday use. Requiring one here rejected every Dubai delivery at
      // ingest, whatever the storefront had collected.
      postcode: z.string().optional(),
      /** The named community — "Dubai Marina", "Business Bay". What delivery
       *  zones price on where there is no postcode, and what a driver
       *  navigates by. */
      area: z.string().optional(),
      country: z.string().default("GB"),
      coordinates: z
        .object({ lat: z.number(), lng: z.number() })
        .optional(),
    })
    .optional(),
  items: z.array(OrderItemSchema),
  subtotal: z.number().nonnegative(),
  taxAmount: z.number().nonnegative().default(0),
  deliveryFee: z.number().nonnegative().default(0),
  discount: z.number().nonnegative().default(0),
  total: z.number().nonnegative(),
  specialInstructions: z.string().optional(),
  scheduledFor: z.date().optional(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type CanonicalOrder = z.infer<typeof CanonicalOrderSchema>;
