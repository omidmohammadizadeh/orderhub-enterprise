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

/**
 * Our whole Stripe application fee on an Eat For Less order: the commission,
 * plus any sponsored-listing spend recovered on it.
 */
export function eflApplicationFeePence(order: {
  subtotal: unknown;
  discount?: unknown;
  eflCommissionPercent?: unknown;
  eflAdRecovered?: unknown;
}): number {
  const ads = Math.max(0, Math.round(Number(order.eflAdRecovered ?? 0) * 100));
  return eflCommissionPence(order) + (Number.isFinite(ads) ? ads : 0);
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

/** City driving, door to door, including parking and finding the door. A
 *  rough figure on purpose: it's shown as a range, never a promise. */
const CITY_MPH = 12;
const DOORSTEP_MINUTES = 3;

/** Minutes to drive a straight-line distance in town. */
export function travelMinutes(miles: number): number {
  return Math.max(1, Math.round((miles / CITY_MPH) * 60) + DOORSTEP_MINUTES);
}

/** "25–35 min": the shop's prep time plus the drive, as a 10-minute window. */
export function deliveryWindow(prepMinutes: number, miles: number): { min: number; max: number } {
  const mid = prepMinutes + travelMinutes(miles);
  const min = Math.max(10, Math.round((mid - 5) / 5) * 5);
  return { min, max: min + 10 };
}

/** Wrong PINs before a handover locks. After that only the shop can close
 *  the order, from the board: a driver guessing at a door is the attack. */
export const MAX_PIN_ATTEMPTS = 3;

export type PinCheck =
  | { ok: true }
  | { ok: false; locked: boolean; attemptsLeft: number; message: string };

/**
 * The driver's PIN at the door, against the one the customer was given.
 *
 * Called before the attempt is counted: `attempts` is how many wrong ones
 * were already made. A verified order always passes, so a retried request
 * after a dropped signal doesn't lock a handover that already happened.
 */
export function checkDeliveryPin(input: {
  expected: string | null;
  given: string | null | undefined;
  attempts: number;
  verified: boolean;
}): PinCheck {
  if (!input.expected || input.verified) return { ok: true };
  if (input.attempts >= MAX_PIN_ATTEMPTS) {
    return { ok: false, locked: true, attemptsLeft: 0, message: lockedMessage() };
  }
  const given = String(input.given ?? "").replace(/\D/g, "");
  if (!given) {
    return {
      ok: false,
      locked: false,
      attemptsLeft: MAX_PIN_ATTEMPTS - input.attempts,
      message: "This order needs the customer's 4-digit PIN. Ask them for it at the door.",
    };
  }
  if (given === input.expected) return { ok: true };
  const left = MAX_PIN_ATTEMPTS - input.attempts - 1;
  return left <= 0
    ? { ok: false, locked: true, attemptsLeft: 0, message: lockedMessage() }
    : {
        ok: false,
        locked: false,
        attemptsLeft: left,
        message: `That PIN isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`,
      };
}

function lockedMessage(): string {
  return "Too many wrong PINs, so this handover is locked. Call the shop: they can close the order once they've spoken to the customer.";
}

/** How long a private line stays open after the food is handed over, for
 *  "you forgot the drinks". Then neither side can reach the other again. */
export const CALL_LINE_HOURS_AFTER = 2;

const LINE_DEAD_STATUSES = ["CANCELLED", "REJECTED", "FAILED"];
const LINE_DONE_STATUSES = ["COMPLETED"];

/** Can this order's private line still connect a call? */
export function callLineOpen(
  order: { status: string; deliveredAt?: Date | null; updatedAt?: Date | null },
  now: Date,
): boolean {
  if (LINE_DEAD_STATUSES.includes(order.status)) return false;
  if (!LINE_DONE_STATUSES.includes(order.status)) return true;
  const doneAt = order.deliveredAt ?? order.updatedAt;
  if (!doneAt) return false;
  return now.getTime() - doneAt.getTime() < CALL_LINE_HOURS_AFTER * 3600_000;
}

/** A 6-digit code for one side of a private line. Six, not four: it's the
 *  only thing between a stranger with our number and a customer's phone. */
export function generateCallCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Digits a caller keyed, as the code they meant: the # that ends entry, and
 *  anything that isn't a digit, are dropped. */
export function normaliseKeyedCode(digits: unknown): string {
  return String(digits ?? "").replace(/\D/g, "");
}
