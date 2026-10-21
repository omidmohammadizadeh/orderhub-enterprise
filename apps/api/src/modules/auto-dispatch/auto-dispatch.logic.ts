// Auto dispatch — the pure decisions, kept apart from Prisma and the courier
// clients so every rule about WHICH order, WHEN and to WHOM is unit-tested.

export const AUTO_DISPATCH_PROVIDERS = ["STUART", "UBER_DIRECT", "JET_GO", "YANGO"] as const;
export type AutoDispatchProvider = (typeof AUTO_DISPATCH_PROVIDERS)[number];

export const AUTO_DISPATCH_STRATEGIES = ["FIXED", "CHEAPEST"] as const;
export type AutoDispatchStrategy = (typeof AUTO_DISPATCH_STRATEGIES)[number];

export const AUTO_DISPATCH_TRIGGERS = ["ON_ACCEPT", "ON_READY", "BEFORE_READY"] as const;
export type AutoDispatchTrigger = (typeof AUTO_DISPATCH_TRIGGERS)[number];

/** Statuses an order can be auto-dispatched from: the shop has taken it and
 *  nobody has handed it to a courier yet. Same set as bulk dispatch. */
export const DISPATCHABLE_STATUSES = ["ACCEPTED", "PREPARING", "READY"];

/** Delivery fulfillments the SHOP is responsible for getting to the door.
 *  PLATFORM_COURIER is the marketplace's own rider — never ours to book. */
export const SHOP_DELIVERY_FULFILLMENTS = ["DELIVERY", "MERCHANT_DELIVERY"];

const DEFAULT_PREP_MINUTES = 20;

export interface RuleLike {
  id: string;
  enabled: boolean;
  priority: number;
  locationId: string | null;
  brandIds: string[];
  channels: string[];
  strategy: string;
  providers: string[];
  fallback: boolean;
  trigger: string;
  delayMinutes: number;
  maxPriceMinor: number | null;
  dryRun: boolean;
  enabledAt: Date | null;
  createdAt: Date;
}

export interface OrderLike {
  id: string;
  locationId: string;
  brandId: string | null;
  orderSource: string;
  status: string;
  fulfillmentType: string;
  deliveryType: string | null;
  courierJobId: string | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  estimatedReadyAt: Date | null;
  preparationMinutes: number | null;
  scheduledFor: Date | null;
  createdAt: Date;
}

/** Why this order can never be auto-dispatched, or null when it can. */
export function ineligibleReason(o: OrderLike): string | null {
  if (!SHOP_DELIVERY_FULFILLMENTS.includes(o.fulfillmentType)) return "not a shop delivery";
  if (o.deliveryType === "PLATFORM") return "already with a courier";
  if (o.courierJobId) return "already with a courier";
  if (!DISPATCHABLE_STATUSES.includes(o.status)) return `status ${o.status}`;
  return null;
}

export function ruleMatches(rule: RuleLike, o: OrderLike): boolean {
  if (!rule.enabled) return false;
  if (rule.locationId && rule.locationId !== o.locationId) return false;
  if (rule.brandIds.length && !(o.brandId && rule.brandIds.includes(o.brandId))) return false;
  if (rule.channels.length && !rule.channels.includes(o.orderSource)) return false;
  if (!rule.providers.length) return false;
  // A rule only owns orders the shop took after it was switched on.
  const since = rule.enabledAt?.getTime();
  const taken = (o.acceptedAt ?? o.createdAt).getTime();
  if (since != null && taken < since) return false;
  return true;
}

/** The first matching rule: lowest priority number, then the oldest. */
export function pickRule<R extends RuleLike>(rules: R[], o: OrderLike): R | null {
  const sorted = [...rules].sort(
    (a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return sorted.find((r) => ruleMatches(r, o)) ?? null;
}

/**
 * When this rule wants the courier booked, or null while the event it waits
 * for hasn't happened (an ON_READY rule and an order still cooking).
 */
export function dueAt(
  rule: Pick<RuleLike, "trigger" | "delayMinutes">,
  o: OrderLike,
  locationPrepMinutes?: number | null,
): Date | null {
  const delayMs = Math.max(0, rule.delayMinutes || 0) * 60_000;
  const prepMin = o.preparationMinutes ?? locationPrepMinutes ?? DEFAULT_PREP_MINUTES;
  const accepted = o.acceptedAt ?? (o.status !== "PENDING" ? o.createdAt : null);

  let due: Date | null = null;
  if (rule.trigger === "ON_ACCEPT") {
    if (accepted) due = new Date(accepted.getTime() + delayMs);
  } else if (rule.trigger === "ON_READY") {
    const ready = o.readyAt ?? (o.status === "READY" ? new Date() : null);
    if (ready) due = new Date(ready.getTime() + delayMs);
  } else if (rule.trigger === "BEFORE_READY") {
    const readyBy =
      o.estimatedReadyAt ?? (accepted ? new Date(accepted.getTime() + prepMin * 60_000) : null);
    if (readyBy) due = new Date(readyBy.getTime() - delayMs);
  }
  if (!due) return null;

  // A scheduled order is never booked earlier than its own cooking window,
  // whatever the trigger says: accepting a 7pm order at noon must not send a
  // courier at noon.
  if (o.scheduledFor) {
    const cookFrom = o.scheduledFor.getTime() - prepMin * 60_000 - delayMs;
    if (cookFrom > due.getTime()) due = new Date(cookFrom);
  }
  return due;
}

export interface NormalisedQuote {
  provider: AutoDispatchProvider;
  ok: boolean;
  /** The courier's price, minor units. */
  amountMinor: number | null;
  currency: string | null;
  /** Bookable right now (Yango in estimate-only mode prices but can't book). */
  canDispatch: boolean;
  deliverBy?: string | null;
  error?: string | null;
}

/** Providers to try, in order. FIXED keeps the rule's order; CHEAPEST ranks
 *  every bookable quote under the cap by price. Without fallback, only the
 *  first is tried. */
export function rankProviders(
  rule: Pick<RuleLike, "strategy" | "providers" | "fallback" | "maxPriceMinor">,
  quotes: NormalisedQuote[],
): AutoDispatchProvider[] {
  const byProvider = new Map(quotes.map((q) => [q.provider, q]));
  const underCap = (q: NormalisedQuote | undefined) =>
    rule.maxPriceMinor == null || (q?.amountMinor != null && q.amountMinor <= rule.maxPriceMinor);

  let order: AutoDispatchProvider[];
  if (rule.strategy === "CHEAPEST") {
    order = quotes
      .filter((q) => q.ok && q.canDispatch && q.amountMinor != null && underCap(q))
      .sort((a, b) => a.amountMinor! - b.amountMinor!)
      .map((q) => q.provider);
  } else {
    order = rule.providers
      .filter(isProvider)
      .filter((p) => {
        const q = byProvider.get(p);
        // FIXED doesn't need a quote to book, but a quote that says "can't"
        // or "too dear" is still an answer worth honouring.
        if (!q) return rule.maxPriceMinor == null;
        return q.ok && q.canDispatch && underCap(q);
      });
  }
  return rule.fallback ? order : order.slice(0, 1);
}

export function isProvider(p: unknown): p is AutoDispatchProvider {
  return (AUTO_DISPATCH_PROVIDERS as readonly string[]).includes(String(p));
}

/** A provider's major-unit amount as minor units, strictly: null, "" and junk
 *  are "no price", never zero. */
export function toMinor(amount: unknown): number | null {
  const n =
    typeof amount === "number"
      ? amount
      : typeof amount === "string" && amount.trim() !== ""
        ? Number(amount)
        : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
