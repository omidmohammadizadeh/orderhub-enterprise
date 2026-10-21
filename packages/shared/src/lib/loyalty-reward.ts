// What a loyalty (or referral) reward is worth on an order.
//
// Three kinds, decided by which field the reward carries — frozen onto the
// reward when it was earned, so changing the card tomorrow never changes a
// reward already sitting on someone's phone:
//   • percentOff  → a percentage off the order, optionally capped (maxDiscount)
//   • amountOff   → money off the order (referral rewards)
//   • neither     → a free item, added as a £0 line (the original card)
// Money-off kinds can also need a minimum order (minOrder) before they apply.
//
// ONE function, used by the online checkout (server and storefront), the
// till and salon checkout, so the customer, the till and the receipt agree.
// Pure: no DOM, no Node.

export type LoyaltyRewardKind = "FREE_ITEM" | "PERCENT_OFF" | "AMOUNT_OFF";

/** A number, a numeric string, or a Prisma Decimal straight off the row. */
type MoneyLike = number | string | { toString(): string } | null | undefined;

export interface LoyaltyRewardTerms {
  percentOff?: number | null;
  amountOff?: MoneyLike;
  maxDiscount?: MoneyLike;
  minOrder?: MoneyLike;
}

const num = (v: MoneyLike): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function loyaltyRewardKind(r: LoyaltyRewardTerms): LoyaltyRewardKind {
  if ((num(r.percentOff) ?? 0) > 0) return "PERCENT_OFF";
  if ((num(r.amountOff) ?? 0) > 0) return "AMOUNT_OFF";
  return "FREE_ITEM";
}

/**
 * The discount a money-off reward gives on `base` (what the customer is
 * paying for goods, after any deals and other discounts). Free-item rewards
 * are worth 0 here — their value is the £0 line.
 *
 * `short` is how much more they need to spend when a minimum order is not
 * met yet; the discount is then 0 and the reward stays on their card.
 */
export function loyaltyRewardDiscount(
  r: LoyaltyRewardTerms,
  base: number,
): { amount: number; short: number } {
  const kind = loyaltyRewardKind(r);
  const goods = Math.max(0, round2(Number(base) || 0));
  if (kind === "FREE_ITEM") return { amount: 0, short: 0 };
  const min = num(r.minOrder) ?? 0;
  if (min > 0 && goods < min) return { amount: 0, short: round2(min - goods) };
  let amount =
    kind === "PERCENT_OFF"
      ? round2((goods * Math.min(100, num(r.percentOff)!)) / 100)
      : num(r.amountOff)!;
  const cap = num(r.maxDiscount);
  if (cap !== null && cap > 0) amount = Math.min(amount, cap);
  return { amount: round2(Math.min(goods, Math.max(0, amount))), short: 0 };
}

/** "10% off your order", "10% off your order (up to £5)" — with the shop's money formatter. */
export function describeLoyaltyReward(
  r: LoyaltyRewardTerms & { label?: string | null },
  money: (n: number) => string,
): string {
  const kind = loyaltyRewardKind(r);
  if (kind === "FREE_ITEM") return r.label?.trim() || "Free item";
  const head =
    kind === "PERCENT_OFF" ? `${num(r.percentOff)}% off your order` : `${money(num(r.amountOff)!)} off your order`;
  const cap = num(r.maxDiscount);
  const min = num(r.minOrder);
  const extras = [
    kind === "PERCENT_OFF" && cap ? `up to ${money(cap)}` : null,
    min ? `on orders of ${money(min)} or more` : null,
  ].filter(Boolean);
  return extras.length ? `${head} (${extras.join(", ")})` : head;
}
