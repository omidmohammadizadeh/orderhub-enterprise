import { z } from "zod";
export declare const OrderPlatformSchema: z.ZodEnum<["UBER_EATS", "DELIVEROO", "JUST_EAT", "DIRECT"]>;
export type OrderPlatform = z.infer<typeof OrderPlatformSchema>;
export declare const OrderStatusSchema: z.ZodEnum<["PENDING", "ACCEPTED", "PREPARING", "READY", "DISPATCHED", "COMPLETED", "CANCELLED", "REJECTED"]>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export declare const OrderTypeSchema: z.ZodEnum<["DELIVERY", "COLLECTION", "DINE_IN"]>;
export type OrderType = z.infer<typeof OrderTypeSchema>;
export declare const CustomerInfoSchema: z.ZodObject<{
    name: z.ZodString;
    phone: z.ZodOptional<z.ZodString>;
    email: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    name: string;
    phone?: string | undefined;
    email?: string | undefined;
}, {
    name: string;
    phone?: string | undefined;
    email?: string | undefined;
}>;
export type CustomerInfo = z.infer<typeof CustomerInfoSchema>;
export declare const OrderModifierSchema: z.ZodObject<{
    name: z.ZodString;
    price: z.ZodNumber;
    quantity: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    name: string;
    price: number;
    quantity: number;
}, {
    name: string;
    price: number;
    quantity?: number | undefined;
}>;
export type OrderModifier = z.infer<typeof OrderModifierSchema>;
export declare const OrderItemSchema: z.ZodObject<{
    externalId: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    quantity: z.ZodNumber;
    unitPrice: z.ZodNumber;
    totalPrice: z.ZodNumber;
    modifiers: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        price: z.ZodNumber;
        quantity: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        price: number;
        quantity: number;
    }, {
        name: string;
        price: number;
        quantity?: number | undefined;
    }>, "many">>;
    notes: z.ZodOptional<z.ZodString>;
    sku: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    modifiers: {
        name: string;
        price: number;
        quantity: number;
    }[];
    externalId?: string | undefined;
    notes?: string | undefined;
    sku?: string | undefined;
}, {
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    externalId?: string | undefined;
    modifiers?: {
        name: string;
        price: number;
        quantity?: number | undefined;
    }[] | undefined;
    notes?: string | undefined;
    sku?: string | undefined;
}>;
export type OrderItem = z.infer<typeof OrderItemSchema>;
export declare const CanonicalOrderSchema: z.ZodObject<{
    externalId: z.ZodString;
    platform: z.ZodEnum<["UBER_EATS", "DELIVEROO", "JUST_EAT", "DIRECT"]>;
    type: z.ZodEnum<["DELIVERY", "COLLECTION", "DINE_IN"]>;
    displayId: z.ZodOptional<z.ZodString>;
    customerInfo: z.ZodObject<{
        name: z.ZodString;
        phone: z.ZodOptional<z.ZodString>;
        email: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        phone?: string | undefined;
        email?: string | undefined;
    }, {
        name: string;
        phone?: string | undefined;
        email?: string | undefined;
    }>;
    deliveryAddress: z.ZodOptional<z.ZodObject<{
        line1: z.ZodString;
        line2: z.ZodOptional<z.ZodString>;
        city: z.ZodString;
        postcode: z.ZodString;
        country: z.ZodDefault<z.ZodString>;
        coordinates: z.ZodOptional<z.ZodObject<{
            lat: z.ZodNumber;
            lng: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            lat: number;
            lng: number;
        }, {
            lat: number;
            lng: number;
        }>>;
    }, "strip", z.ZodTypeAny, {
        line1: string;
        city: string;
        postcode: string;
        country: string;
        line2?: string | undefined;
        coordinates?: {
            lat: number;
            lng: number;
        } | undefined;
    }, {
        line1: string;
        city: string;
        postcode: string;
        line2?: string | undefined;
        country?: string | undefined;
        coordinates?: {
            lat: number;
            lng: number;
        } | undefined;
    }>>;
    items: z.ZodArray<z.ZodObject<{
        externalId: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        quantity: z.ZodNumber;
        unitPrice: z.ZodNumber;
        totalPrice: z.ZodNumber;
        modifiers: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            price: z.ZodNumber;
            quantity: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            price: number;
            quantity: number;
        }, {
            name: string;
            price: number;
            quantity?: number | undefined;
        }>, "many">>;
        notes: z.ZodOptional<z.ZodString>;
        sku: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
        modifiers: {
            name: string;
            price: number;
            quantity: number;
        }[];
        externalId?: string | undefined;
        notes?: string | undefined;
        sku?: string | undefined;
    }, {
        name: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
        externalId?: string | undefined;
        modifiers?: {
            name: string;
            price: number;
            quantity?: number | undefined;
        }[] | undefined;
        notes?: string | undefined;
        sku?: string | undefined;
    }>, "many">;
    subtotal: z.ZodNumber;
    taxAmount: z.ZodDefault<z.ZodNumber>;
    deliveryFee: z.ZodDefault<z.ZodNumber>;
    discount: z.ZodDefault<z.ZodNumber>;
    total: z.ZodNumber;
    specialInstructions: z.ZodOptional<z.ZodString>;
    scheduledFor: z.ZodOptional<z.ZodDate>;
    metadata: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    type: "DELIVERY" | "COLLECTION" | "DINE_IN";
    externalId: string;
    platform: "UBER_EATS" | "DELIVEROO" | "JUST_EAT" | "DIRECT";
    customerInfo: {
        name: string;
        phone?: string | undefined;
        email?: string | undefined;
    };
    items: {
        name: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
        modifiers: {
            name: string;
            price: number;
            quantity: number;
        }[];
        externalId?: string | undefined;
        notes?: string | undefined;
        sku?: string | undefined;
    }[];
    subtotal: number;
    taxAmount: number;
    deliveryFee: number;
    discount: number;
    total: number;
    metadata: Record<string, unknown>;
    displayId?: string | undefined;
    deliveryAddress?: {
        line1: string;
        city: string;
        postcode: string;
        country: string;
        line2?: string | undefined;
        coordinates?: {
            lat: number;
            lng: number;
        } | undefined;
    } | undefined;
    specialInstructions?: string | undefined;
    scheduledFor?: Date | undefined;
}, {
    type: "DELIVERY" | "COLLECTION" | "DINE_IN";
    externalId: string;
    platform: "UBER_EATS" | "DELIVEROO" | "JUST_EAT" | "DIRECT";
    customerInfo: {
        name: string;
        phone?: string | undefined;
        email?: string | undefined;
    };
    items: {
        name: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
        externalId?: string | undefined;
        modifiers?: {
            name: string;
            price: number;
            quantity?: number | undefined;
        }[] | undefined;
        notes?: string | undefined;
        sku?: string | undefined;
    }[];
    subtotal: number;
    total: number;
    displayId?: string | undefined;
    deliveryAddress?: {
        line1: string;
        city: string;
        postcode: string;
        line2?: string | undefined;
        country?: string | undefined;
        coordinates?: {
            lat: number;
            lng: number;
        } | undefined;
    } | undefined;
    taxAmount?: number | undefined;
    deliveryFee?: number | undefined;
    discount?: number | undefined;
    specialInstructions?: string | undefined;
    scheduledFor?: Date | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export type CanonicalOrder = z.infer<typeof CanonicalOrderSchema>;
//# sourceMappingURL=order.types.d.ts.map