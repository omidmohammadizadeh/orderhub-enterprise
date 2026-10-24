// Eat For Less — the rules, as pure functions so each can be tested alone.
//
// Nothing here touches the database. The service gathers the facts (the
// order, the customer's history, the platform settings) and asks these.

import { randomInt } from "crypto";

/** The money the platform settings are kept in, as plain numbers. */
export interface EflRulesConfig {
  defaultCommissionPercent: number;
  pinMinOrderTotal: number;
  pinForNewCustomers: boolean;
  firstOrderMaxTotal: number;
  maxOrdersPerHour: number;
}

export const EFL_DEFAULTS: EflRulesConfig = {
  defaultCommissionPercent: 8,
  pinMinOrderTotal: 25,
  pinForNewCustomers: true,
  firstOrderMaxTotal: 60,
  maxOrdersPerHour: 3,
};

/** How far a customer can be from a shop for it to appear at all. Delivery
 *  is then decided by the shop's own zones; this only bounds the search. */
export const EFL_SEARCH_RADIUS_MILES = 10;

/**
 * Our commission on an Eat For Less order, in pence.
 *
 * Charged on the food — subtotal after discounts — and never on the delivery
 * fee or the tip: the delivery fee pays the shop's driver, and the tip is the
 * customer's gift to them. Rounded to the penny, never negative.
 */
export function eflCommissionPence(order: {
  subtotal: unknown;
  discount?: unknown;
  eflCommissionPercent?: unknown;
}): number {
  const pct = Number(order.eflCommissionPercent ?? 0);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  const food = Math.max(0, Number(order.subtotal ?? 0) - Number(order.discount ?? 0));
  return Math.max(0, Math.round(food * pct));
}

/** The commission rate a shop trades at: its own, else the platform default. */
export function commissionPercentFor(
  listing: { commissionPercent?: unknown } | null | undefined,
  config: Pick<EflRulesConfig, "defaultCommissionPercent">,
): number {
  const own = listing?.commissionPercent;
  if (own != null && Number.isFinite(Number(own))) return Number(own);
  return config.defaultCommissionPercent;
}

/** Does this order need a delivery PIN? Collection never does: the customer
 *  is standing at the counter. */
export function needsDeliveryPin(input: {
  fulfillmentType: string;
  total: number;
  isNewCustomer: boolean;
  config: Pick<EflRulesConfig, "pinMinOrderTotal" | "pinForNewCustomers">;
}): boolean {
  if (input.fulfillmentType !== "DELIVERY") return false;
  if (input.config.pinForNewCustomers && input.isNewCustomer) return true;
  return input.total >= input.config.pinMinOrderTotal;
}

/** A 4-digit PIN, from the crypto generator. 0000–9999, kept as text so
 *  leading zeros survive. */
export function generateDeliveryPin(): string {
  return String(randomInt(0, 10000)).padStart(4, "0");
}

/** Why an order is refused before it is created, or null to let it through. */
export function orderRefusal(input: {
  phoneVerified: boolean;
  ordersInLastHour: number;
  isNewCustomer: boolean;
  total: number;
  config: Pick<EflRulesConfig, "maxOrdersPerHour" | "firstOrderMaxTotal">;
}): string | null {
  if (!input.phoneVerified) {
    return "Please confirm your mobile number before you order.";
  }
  if (input.ordersInLastHour >= input.config.maxOrdersPerHour) {
    return "You've placed a lot of orders in the last hour. Please try again a little later.";
  }
  if (input.isNewCustomer && input.total > input.config.firstOrderMaxTotal) {
    return `Your first order can be up to £${input.config.firstOrderMaxTotal.toFixed(2)}. Please remove something to continue.`;
  }
  return null;
}

/** Is a listing visible in the app? Both switches on and nothing hiding it. */
export function isListingLive(listing: {
  listed: boolean;
  status: string;
  hiddenReason?: string | null;
}): boolean {
  return listing.listed && listing.status === "APPROVED" && !listing.hiddenReason;
}

/** A Decimal-or-number config row as plain numbers, with defaults for a
 *  missing row (a fresh database has none until the Console saves one). */
export function toRulesConfig(row: Record<string, unknown> | null | undefined): EflRulesConfig {
  const num = (v: unknown, d: number) => (v == null || !Number.isFinite(Number(v)) ? d : Number(v));
  return {
    defaultCommissionPercent: num(row?.defaultCommissionPercent, EFL_DEFAULTS.defaultCommissionPercent),
    pinMinOrderTotal: num(row?.pinMinOrderTotal, EFL_DEFAULTS.pinMinOrderTotal),
    pinForNewCustomers:
      typeof row?.pinForNewCustomers === "boolean" ? row.pinForNewCustomers : EFL_DEFAULTS.pinForNewCustomers,
    firstOrderMaxTotal: num(row?.firstOrderMaxTotal, EFL_DEFAULTS.firstOrderMaxTotal),
    maxOrdersPerHour: num(row?.maxOrdersPerHour, EFL_DEFAULTS.maxOrdersPerHour),
  };
}
