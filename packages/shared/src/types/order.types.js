"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CanonicalOrderSchema = exports.OrderItemSchema = exports.OrderModifierSchema = exports.CustomerInfoSchema = exports.OrderTypeSchema = exports.OrderStatusSchema = exports.OrderPlatformSchema = void 0;
const zod_1 = require("zod");
// ── Canonical Order ───────────────────────────────────────
// This is the single normalised shape that all platform adapters
// (Uber Eats, Deliveroo, Just Eat, Direct) must map their payloads into.
// The API and worker both operate on this type, never on raw platform types.
exports.OrderPlatformSchema = zod_1.z.enum([
    "UBER_EATS",
    "DELIVEROO",
    "JUST_EAT",
    "DIRECT",
]);
exports.OrderStatusSchema = zod_1.z.enum([
    "PENDING",
    "ACCEPTED",
    "PREPARING",
    "READY",
    "DISPATCHED",
    "COMPLETED",
    "CANCELLED",
    "REJECTED",
]);
exports.OrderTypeSchema = zod_1.z.enum(["DELIVERY", "COLLECTION", "DINE_IN"]);
exports.CustomerInfoSchema = zod_1.z.object({
    name: zod_1.z.string(),
    phone: zod_1.z.string().optional(),
    email: zod_1.z.string().email().optional(),
});
exports.OrderModifierSchema = zod_1.z.object({
    name: zod_1.z.string(),
    price: zod_1.z.number(),
    quantity: zod_1.z.number().default(1),
});
exports.OrderItemSchema = zod_1.z.object({
    externalId: zod_1.z.string().optional(),
    name: zod_1.z.string(),
    quantity: zod_1.z.number().int().positive(),
    unitPrice: zod_1.z.number().nonnegative(),
    totalPrice: zod_1.z.number().nonnegative(),
    modifiers: zod_1.z.array(exports.OrderModifierSchema).default([]),
    notes: zod_1.z.string().optional(),
    sku: zod_1.z.string().optional(),
});
exports.CanonicalOrderSchema = zod_1.z.object({
    externalId: zod_1.z.string(),
    platform: exports.OrderPlatformSchema,
    type: exports.OrderTypeSchema,
    displayId: zod_1.z.string().optional(),
    customerInfo: exports.CustomerInfoSchema,
    deliveryAddress: zod_1.z
        .object({
        line1: zod_1.z.string(),
        line2: zod_1.z.string().optional(),
        city: zod_1.z.string(),
        postcode: zod_1.z.string(),
        country: zod_1.z.string().default("GB"),
        coordinates: zod_1.z
            .object({ lat: zod_1.z.number(), lng: zod_1.z.number() })
            .optional(),
    })
        .optional(),
    items: zod_1.z.array(exports.OrderItemSchema),
    subtotal: zod_1.z.number().nonnegative(),
    taxAmount: zod_1.z.number().nonnegative().default(0),
    deliveryFee: zod_1.z.number().nonnegative().default(0),
    discount: zod_1.z.number().nonnegative().default(0),
    total: zod_1.z.number().nonnegative(),
    specialInstructions: zod_1.z.string().optional(),
    scheduledFor: zod_1.z.date().optional(),
    metadata: zod_1.z.record(zod_1.z.unknown()).default({}),
});
//# sourceMappingURL=order.types.js.map