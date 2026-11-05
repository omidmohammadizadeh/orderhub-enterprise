// Eat For Less — the arithmetic of a shop's Thursday payout, kept free of
// Prisma and Stripe so it can be tested on its own.

import { eflApplicationFeePence } from "./efl-rules";
import { londonWeekStart } from "./efl-ads-rules";

type MoneyOrder = {
  total: unknown;
  subtotal: unknown;
  discount?: unknown;
  eflCommissionPercent?: unknown;
  eflAdRecovered?: unknown;
};

/** The shop's share of a card order before any refund: what the customer paid less what we keep. */
export function fullSharePence(order: MoneyOrder): number {
  const total = Math.max(0, Math.round(Number(order.total ?? 0) * 100));
  return total - Math.min(eflApplicationFeePence(order), total);
}

/**
 * How much of the customer's money went back, 0–1. A full refund is 1
 * whatever was recorded; a partial one is Stripe's running total over the
 * charge.
 */
export function refundedFraction(order: {
  paymentStatus: string;
  total: unknown;
  refundedPence?: number | null;
}): number {
  if (order.paymentStatus === "REFUNDED") return 1;
  if (order.paymentStatus !== "PARTIALLY_REFUNDED") return 0;
  const total = Math.round(Number(order.total ?? 0) * 100);
  if (!(total > 0)) return 0;
  return Math.min(1, Math.max(0, Number(order.refundedPence ?? 0) / total));
}

/** The shop's share now, after what's been refunded: refunds cost each side its own part. */
export function sharePence(order: MoneyOrder & { paymentStatus: string; refundedPence?: number | null }): number {
  return Math.round(fullSharePence(order) * (1 - refundedFraction(order)));
}

/** What to take back on a line paid out earlier, now that more of it is refunded. */
export function clawbackPence(line: { toShopPence: number; clawedBackPence: number }, shareNow: number): number {
  return Math.max(0, line.toShopPence - line.clawedBackPence - shareNow);
}

/** The week's net: positive is paid, negative is carried to next week. */
export function settle(input: { cardPence: number; cashCommissionPence: number; refundsPence: number; carriedInPence: number }) {
  const net = input.cardPence - input.cashCommissionPence - input.refundsPence - input.carriedInPence;
  return { amountPence: Math.max(0, net), carriedOutPence: Math.max(0, -net) };
}

/**
 * The newest week whose payday has come: last week from Thursday 00:00 UK
 * time onward, the week before that until then. Monday–Sunday's card
 * payments have cleared Eat For Less's 3-day hold by Thursday.
 */
export function dueWeekStart(now: Date): Date {
  const thisWeek = londonWeekStart(now);
  const lastWeek = londonWeekStart(new Date(thisWeek.getTime() - 86_400_000));
  // Thursday 00:00 is three days in; an hour either side of a clock change
  // can't move it off Thursday.
  const thursday = thisWeek.getTime() + 3 * 86_400_000;
  return now.getTime() >= thursday ? lastWeek : londonWeekStart(new Date(lastWeek.getTime() - 86_400_000));
}
