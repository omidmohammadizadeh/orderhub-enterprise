// Auto ready — move an accepted order to Preparing, then Ready, on a timer
// the shop sets for itself.
//
// Why it exists: Deliveroo (and Uber) read the prep stages we send when an
// order is marked preparing/ready, and that told them when a rider should
// set off. Reaching "ready" needed two deliberate taps after accepting, so
// a kitchen working from a printed ticket never sent them — Deliveroo saw
// "ready for collection" on 1 order in 7 days across our estate.
//
// The timer is an ESTIMATE, not an observation: it says "an order accepted
// now is usually ready in N minutes", which is the same promise the shop
// already makes with its prep time. Staff can still tap Ready early, and
// doing so wins — the cron only ever advances an order still sitting in the
// status before it.
//
// Settings live on Location.settings.autoReady, per shop, off by default.

import { isMarketplaceSource } from "../marketing/receipt-qr-url";

export interface AutoReadySettings {
  enabled: boolean;
  /** Minutes after acceptance to mark Preparing. */
  preparingAfterMinutes: number;
  /** Minutes after acceptance to mark Ready. */
  readyAfterMinutes: number;
  /** Which orders it applies to. */
  scope: "MARKETPLACE" | "ALL";
}

export const AUTO_READY_DEFAULTS: AutoReadySettings = {
  enabled: false,
  preparingAfterMinutes: 2,
  readyAfterMinutes: 15,
  // Marketplace only by default: that is the channel asking for the signal,
  // and a wrong "ready" there moves a rider, while on our own storefront it
  // would tell a customer their food is waiting when it isn't.
  scope: "MARKETPLACE",
};

const MINUTE = 60_000;

/**
 * Read a shop's auto-ready settings, or null when it is off or unusable.
 * Anything malformed reads as OFF: a half-configured timer that silently
 * marks food ready is worse than no timer.
 */
export function readAutoReadySettings(locationSettings: unknown): AutoReadySettings | null {
  const raw =
    locationSettings && typeof locationSettings === "object"
      ? ((locationSettings as Record<string, unknown>).autoReady as
          | Record<string, unknown>
          | undefined)
      : undefined;
  if (!raw || typeof raw !== "object" || raw.enabled !== true) return null;

  const ready = Number(raw.readyAfterMinutes);
  if (!Number.isFinite(ready) || ready <= 0) return null;

  const preparingRaw = Number(raw.preparingAfterMinutes);
  // Preparing can never land after Ready; a shop that sets it that way gets
  // the order marked preparing and ready at the same moment, not never.
  const preparing =
    Number.isFinite(preparingRaw) && preparingRaw >= 0
      ? Math.min(preparingRaw, ready)
      : Math.min(AUTO_READY_DEFAULTS.preparingAfterMinutes, ready);

  return {
    enabled: true,
    preparingAfterMinutes: preparing,
    readyAfterMinutes: ready,
    scope: raw.scope === "ALL" ? "ALL" : "MARKETPLACE",
  };
}

export interface AutoReadyOrder {
  status: string;
  acceptedAt?: Date | null;
  createdAt: Date;
  /** Set when the customer asked for a later time. */
  scheduledFor?: Date | null;
  orderSource?: string | null;
  platform?: string | null;
  fulfillmentType?: string | null;
}

/**
 * The status this order should move to now, or null to leave it alone.
 *
 * Only ever ACCEPTED → PREPARING → READY, one step at a time, and only when
 * the order is still sitting in the step before. An order staff have already
 * moved on is never touched, so tapping Ready early always wins.
 */
export function nextAutoStatus(
  order: AutoReadyOrder,
  settings: AutoReadySettings | null,
  now: Date,
): "PREPARING" | "READY" | null {
  if (!settings) return null;
  if (order.status !== "ACCEPTED" && order.status !== "PREPARING") return null;

  // A dine-in tab sits accepted for the length of the meal — a timer must
  // not close it off.
  if (order.fulfillmentType === "DINE_IN") return null;

  if (
    settings.scope === "MARKETPLACE" &&
    !isMarketplaceSource(order.orderSource, order.platform)
  ) {
    return null;
  }

  const from = order.acceptedAt ?? order.createdAt;
  const gap = (settings.readyAfterMinutes - settings.preparingAfterMinutes) * MINUTE;

  // A scheduled order is timed from when the customer wants it, not from
  // when it was accepted — otherwise an order taken at noon for 7pm is
  // "ready" at ten past twelve.
  const scheduled =
    order.scheduledFor && order.scheduledFor.getTime() > from.getTime()
      ? order.scheduledFor
      : null;
  const readyAt = scheduled
    ? scheduled.getTime()
    : from.getTime() + settings.readyAfterMinutes * MINUTE;
  const preparingAt = scheduled
    ? scheduled.getTime() - gap
    : from.getTime() + settings.preparingAfterMinutes * MINUTE;

  const t = now.getTime();
  if (order.status === "PREPARING") return t >= readyAt ? "READY" : null;
  // Still ACCEPTED: if both are due (a long-forgotten order, or a shop with
  // the two timers close together) go straight to Ready rather than crawling
  // a step a minute.
  if (t >= readyAt) return "READY";
  if (t >= preparingAt) return "PREPARING";
  return null;
}
