// What a push says, before any restaurant has changed it.
//
// Pure on purpose: the order path, the review cron and the dashboard preview
// all need the same answer to "what will the customer read?", and a function
// with no database behind it is the only way to keep those three agreeing.

/** Order statuses worth interrupting someone's evening for. Every other status
 *  is internal bookkeeping — buzzing a phone for PENDING_DISPATCH teaches
 *  people to turn notifications off. */
export const ORDER_TRIGGERS = [
  "ACCEPTED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "RIDER_ARRIVED",
  "COMPLETED",
  "CANCELLED",
] as const;

export const REVIEW_TRIGGER = "REVIEW_REQUEST" as const;

export const PUSH_TRIGGERS = [...ORDER_TRIGGERS, REVIEW_TRIGGER] as const;
export type PushTrigger = (typeof PUSH_TRIGGERS)[number];

export const DEFAULT_REVIEW_DELAY_MINUTES = 45;
/** Long enough to have eaten; short enough that they still remember it. */
export const REVIEW_DELAY_RANGE = { min: 10, max: 24 * 60 } as const;

export const TITLE_MAX = 65;
export const BODY_MAX = 240;

type Message = { title: string; body: string };

export const DEFAULT_MESSAGES: Record<PushTrigger, Message> = {
  ACCEPTED: { title: "Order confirmed", body: "The restaurant has accepted your order." },
  PREPARING: { title: "Your food is being made", body: "The kitchen has started on your order." },
  READY: { title: "Ready for collection", body: "Your order is ready to pick up." },
  OUT_FOR_DELIVERY: { title: "On its way", body: "Your driver is heading to you now." },
  RIDER_ARRIVED: { title: "Your driver has arrived", body: "They're outside with your order." },
  COMPLETED: { title: "Delivered", body: "Enjoy your food. Thanks for ordering!" },
  CANCELLED: {
    title: "Order cancelled",
    body: "Your order has been cancelled. Contact the restaurant if this is unexpected.",
  },
  REVIEW_REQUEST: {
    title: "How was your food?",
    body: "Tap to rate your order from {shop}. It takes ten seconds.",
  },
};

/** READY means different things depending on how the food is leaving. */
const DELIVERY_READY: Message = {
  title: "Ready — waiting for a driver",
  body: "Your order is made and waiting to be collected by a driver.",
};

export type AutomationRow = {
  trigger: string;
  enabled: boolean;
  title: string | null;
  body: string | null;
  delayMinutes: number | null;
};

export function isPushTrigger(value: string): value is PushTrigger {
  return (PUSH_TRIGGERS as readonly string[]).includes(value);
}

/** The review ask is new behaviour, so it is off until a restaurant turns it
 *  on. Every order stage keeps the behaviour it had before rows existed: on. */
export function isEnabled(trigger: PushTrigger, row?: AutomationRow | null): boolean {
  if (row) return row.enabled;
  return trigger !== REVIEW_TRIGGER;
}

export function reviewDelayMinutes(row?: AutomationRow | null): number {
  const raw = row?.delayMinutes;
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_REVIEW_DELAY_MINUTES;
  return Math.min(REVIEW_DELAY_RANGE.max, Math.max(REVIEW_DELAY_RANGE.min, Math.round(raw)));
}

/** {order} and {shop}; anything else is left alone so a typo shows up in the
 *  preview rather than vanishing. */
export function fillTokens(text: string, vars: { order?: string | null; shop?: string | null }): string {
  return text
    .replace(/\{order\}/g, vars.order ?? "")
    .replace(/\{shop\}/g, vars.shop ?? "the restaurant")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The text for one push, or null when it should not be sent.
 *
 * The order reference goes on the title, as it always has, unless the
 * restaurant placed {order} somewhere themselves.
 */
export function resolveMessage(args: {
  trigger: PushTrigger;
  fulfillmentType?: string | null;
  row?: AutomationRow | null;
  orderRef?: string | null;
  shopName?: string | null;
}): Message | null {
  const { trigger, row } = args;
  if (!isEnabled(trigger, row)) return null;

  const fallback =
    trigger === "READY" && args.fulfillmentType === "DELIVERY" ? DELIVERY_READY : DEFAULT_MESSAGES[trigger];
  const titleTemplate = row?.title?.trim() || fallback.title;
  const bodyTemplate = row?.body?.trim() || fallback.body;

  const vars = { order: args.orderRef, shop: args.shopName };
  let title = fillTokens(titleTemplate, vars);
  const body = fillTokens(bodyTemplate, vars);
  const placedRef = titleTemplate.includes("{order}") || bodyTemplate.includes("{order}");
  if (args.orderRef && !placedRef && trigger !== REVIEW_TRIGGER) {
    title = `${title} · ${args.orderRef}`;
  }
  return { title: title.slice(0, TITLE_MAX + 12), body: body.slice(0, BODY_MAX) };
}

/** The storefront a subscription belongs to, read off the tracking path a page
 *  told us about: "/order/demo/status/abc" → "/order/demo". A brand custom
 *  domain tracks at "/status/abc", which gives "/" — its storefront root. */
export function storefrontRootFrom(trackPath?: string | null): string | null {
  if (!trackPath || !trackPath.startsWith("/") || trackPath.startsWith("//")) return null;
  const cut = trackPath.indexOf("/status/");
  if (cut < 0) return null;
  return cut === 0 ? "/" : trackPath.slice(0, cut);
}

/** Native app tokens look like ExponentPushToken[xxxx] (or ExpoPushToken[…]). */
export function isExpoToken(token: unknown): token is string {
  return typeof token === "string" && /^Expo(nent)?PushToken\[[^\]]{10,200}\]$/.test(token);
}

/** One location's own review-ask settings (push_location_reviews). */
export type LocationReviewRow = {
  enabled: boolean;
  delayMinutes: number | null;
  title: string | null;
  body: string | null;
  sendFromHour: number | null;
  sendUntilHour: number | null;
};

/** The review settings that apply to an order: the location's own row when
 *  it has one, its blank text falling back to the business text. */
export function effectiveReviewRow(
  business?: AutomationRow | null,
  location?: LocationReviewRow | null,
): AutomationRow | null {
  if (!location) return business ?? null;
  return {
    trigger: REVIEW_TRIGGER,
    enabled: location.enabled,
    title: location.title ?? business?.title ?? null,
    body: location.body ?? business?.body ?? null,
    delayMinutes: location.delayMinutes ?? business?.delayMinutes ?? null,
  };
}

/** The hour (0–23) it is at `at` on the wall clock in `timeZone`. */
export function localHour(at: Date, timeZone: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).format(at);
    return Number(h) % 24;
  } catch {
    return at.getUTCHours();
  }
}

/** Is `hour` inside [from, until)? A window like 18–2 runs over midnight. */
export function inSendWindow(hour: number, from: number, until: number): boolean {
  if (from === until) return true;
  return from < until ? hour >= from && hour < until : hour >= from || hour < until;
}

/**
 * When an ask due at `due` may actually go out: unchanged inside the
 * location's sending hours, otherwise the next time its clock reads
 * sendFromHour:00. An order finished at 23:30 asks at 11:00 the next morning,
 * not at a quarter past midnight.
 */
export function fitSendWindow(
  due: Date,
  timeZone: string,
  sendFromHour: number | null,
  sendUntilHour: number | null,
): Date {
  if (sendFromHour == null || sendUntilHour == null) return due;
  if (inSendWindow(localHour(due, timeZone), sendFromHour, sendUntilHour)) return due;
  const hour = 60 * 60_000;
  const startOfHour = Math.floor(due.getTime() / hour) * hour;
  for (let i = 1; i <= 48; i++) {
    const candidate = new Date(startOfHour + i * hour);
    if (localHour(candidate, timeZone) === sendFromHour) return candidate;
  }
  return due;
}
