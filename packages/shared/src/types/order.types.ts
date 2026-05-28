import { z } from "zod";

// ── Canonical Order ───────────────────────────────────────
// Single normalised shape that ALL platform adapters must map into.
// The API and worker operate on CanonicalOrder, never on raw platform payloads.

export const OrderPlatformSchema = z.enum([
  "UBER_EATS",
  "DELIVEROO",
  "JUST_EAT",
  "HUBRISE",
  "DIRECT",
  "POS",
  "ONLINE",
]);
export type OrderPlatform = z.infer<typeof OrderPlatformSchema>;

// The sales channel that originated the order
export const OrderSourceSchema = z.enum([
  "ONLINE",
  "POS",
  "UBER_EATS",
  "DELIVEROO",
  "JUST_EAT",
  "HUBRISE",
  "DIRECT",
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
//          → OUT_FOR_DELIVERY → COMPLETED (delivered/collected)
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
  "ASSIGNED_DRIVER",
  "ACCEPTED_BY_DRIVER",
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
      postcode: z.string(),
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
