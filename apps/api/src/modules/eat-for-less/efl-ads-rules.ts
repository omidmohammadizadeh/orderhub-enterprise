// Eat For Less — sponsored listings and weekly statements, as pure rules.
//
// Ads work like Uber Eats': a shop sets a weekly budget and the most it will
// pay for one tap. Every time a customer's shop list is built, shops with
// budget left bid for the top slots. Rank = bid × how likely a tap is to
// become an order, so a shop can't simply buy its way past better shops; the
// winner pays just enough to beat the next one (never more than its own
// bid). Shows are capped per customer per day so the list never feels sold.
//
// Spend is not charged to a card. It is recovered from the shop's own Eat For
// Less orders, added to our Stripe application fee — up to a share of each
// order's food, so no single order is wiped out — and shown on the weekly
// statement.

/** The least a tap can cost, in pounds. */
export const MIN_BID = 0.1;
/** Most a shop may bid for one tap. */
export const MAX_BID = 5;
/** Sponsored places at the top of the list. */
export const SPONSORED_SLOTS = 2;
/** A customer sees a given shop sponsored at most this often a day. */
export const MAX_SHOWS_PER_DAY = 3;
/** Taps by the same customer on the same shop inside this window count once. */
export const TAP_DEDUPE_MINUTES = 30;
/** Most of one order's food that can go to paying off ads, in percent. */
export const AD_RECOVERY_MAX_PERCENT = 50;

/** Before a shop has history, assume one tap in ten becomes an order, with
 *  the weight of ten taps — enough to start fair, little enough to move. */
const PRIOR_RATE = 0.1;
const PRIOR_WEIGHT = 10;

/** How likely a tap on this shop is to become an order (0–1). */
export function predictedOrderChance(taps: number, orders: number): number {
  const t = Math.max(0, taps);
  const o = Math.min(Math.max(0, orders), t + PRIOR_WEIGHT);
  return (o + PRIOR_RATE * PRIOR_WEIGHT) / (t + PRIOR_WEIGHT);
}

/**
 * How much of the weekly budget may be spent by now. Budget is paced over the
 * week so Monday lunch doesn't swallow it: by any moment, the share of the
 * week gone plus one day's worth.
 */
export function pacedBudgetLeft(weeklyBudget: number, spentThisWeek: number, weekFraction: number): number {
  const fraction = Math.min(1, Math.max(0, weekFraction) + 1 / 7);
  return Math.max(0, round2(weeklyBudget * fraction - spentThisWeek));
}

export type AdBidder = { listingId: string; bid: number; chance: number; budgetLeft: number };
export type AdWinner = { listingId: string; price: number };

/**
 * The second-price auction for the sponsored slots. Each winner pays the
 * least that would still have beaten the next bidder's score, rounded up to
 * the penny, and never more than its own bid or less than MIN_BID. A shop
 * that couldn't afford its price is skipped, not shown for free.
 */
export function runAuction(bidders: AdBidder[], slots = SPONSORED_SLOTS): AdWinner[] {
  const ranked = bidders
    .filter((b) => b.bid >= MIN_BID && b.chance > 0)
    .map((b) => ({ ...b, score: b.bid * b.chance }))
    .sort((a, b) => b.score - a.score || a.listingId.localeCompare(b.listingId));
  const winners: AdWinner[] = [];
  for (let i = 0; i < ranked.length && winners.length < slots; i++) {
    const me = ranked[i]!;
    const next = ranked[i + 1];
    const toBeat = next ? next.score / me.chance + 0.01 : MIN_BID;
    const price = Math.min(me.bid, Math.max(MIN_BID, Math.ceil(toBeat * 100) / 100));
    if (price > me.budgetLeft) continue;
    winners.push({ listingId: me.listingId, price: round2(price) });
  }
  return winners;
}

/**
 * Pence of ad spend to recover from one order: what the shop still owes,
 * capped at AD_RECOVERY_MAX_PERCENT of the order's food.
 */
export function adRecoveryPence(owedPence: number, foodPence: number, capPercent = AD_RECOVERY_MAX_PERCENT): number {
  if (owedPence <= 0 || foodPence <= 0) return 0;
  return Math.max(0, Math.min(Math.round(owedPence), Math.floor((foodPence * capPercent) / 100)));
}

/** A budget and bid as a shop typed them, checked. */
export function validateCampaign(input: { weeklyBudget: number; maxBid: number }): string | null {
  const { weeklyBudget, maxBid } = input;
  if (!Number.isFinite(weeklyBudget) || weeklyBudget < 5 || weeklyBudget > 1000) {
    return "Weekly budget must be between £5 and £1,000.";
  }
  if (!Number.isFinite(maxBid) || maxBid < MIN_BID || maxBid > MAX_BID) {
    return `The most per tap must be between £${MIN_BID.toFixed(2)} and £${MAX_BID.toFixed(2)}.`;
  }
  if (maxBid > weeklyBudget) return "The most per tap can't be more than the weekly budget.";
  return null;
}

// ── Weeks (Monday 00:00 UK time) ──────────────────────────────────────────

function londonParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    h: Number(get("hour")),
    min: Number(get("minute")),
    s: Number(get("second")),
    weekday: get("weekday"),
  };
}

/** The instant UK local midnight starts on the given calendar day. */
function londonMidnight(y: number, m: number, d: number): Date {
  // Guess at noon UTC that day, read London's offset there, step back.
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const p = londonParts(noon);
  const offsetMs = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - noon.getTime();
  return new Date(Date.UTC(y, m - 1, d) - offsetMs);
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday 00:00 UK time of the week `at` falls in. */
export function londonWeekStart(at: Date): Date {
  const p = londonParts(at);
  const back = WEEKDAYS.indexOf(p.weekday);
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d - Math.max(0, back)));
  return londonMidnight(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
}

/** The Monday after `weekStart`, UK time (23 or 25 hours across a clock change). */
export function nextWeekStart(weekStart: Date): Date {
  return londonWeekStart(new Date(weekStart.getTime() + 8 * 86_400_000));
}

/** How far through its week `at` is, 0–1. */
export function weekFraction(at: Date): number {
  const start = londonWeekStart(at);
  const end = nextWeekStart(start);
  return (at.getTime() - start.getTime()) / (end.getTime() - start.getTime());
}

/** "2026-10-26" for the UK calendar day `at` falls on. */
export function londonDateKey(at: Date): string {
  const p = londonParts(at);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** A week named by its Monday ("2026-10-26"), as the instant it starts. */
export function weekStartFromKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const start = londonMidnight(Number(m[1]), Number(m[2]), Number(m[3]));
  return londonWeekStart(start).getTime() === start.getTime() ? start : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
