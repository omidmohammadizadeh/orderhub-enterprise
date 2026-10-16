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
