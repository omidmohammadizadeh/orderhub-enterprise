// Age-restricted products (Challenge 25).
//
// A product carries MenuItem.minAge: null for anything anyone can buy, else
// 16 or 18 (UK: alcohol, tobacco, vapes, knives, fireworks are 18; energy
// drinks and some solvents 16 by store policy). The till asks the cashier to
// check ID, the storefront asks the customer to confirm their age, and an
// online order carries an "ID CHECK" note so whoever hands it over checks.

export const AGE_LIMITS = [16, 18] as const;
export type AgeLimit = (typeof AGE_LIMITS)[number];

/** The stored minimum age, or null when the product isn't restricted. */
export function normaliseMinAge(v: unknown): AgeLimit | null {
  const n = Math.trunc(Number(v));
  return (AGE_LIMITS as readonly number[]).includes(n) ? (n as AgeLimit) : null;
}

/** The highest minimum age in a basket, or null when nothing is restricted. */
export function basketMinAge(items: Array<{ minAge?: unknown } | null | undefined>): AgeLimit | null {
  let max: AgeLimit | null = null;
  for (const it of items) {
    const a = normaliseMinAge(it?.minAge);
    if (a && (!max || a > max)) max = a;
  }
  return max;
}

/** Printed at the top of an online order's note: every ticket, picker and driver sees it. */
export function ageCheckNote(minAge: number): string {
  return `ID CHECK ${minAge}+ — Challenge 25: ask for photo ID if they look under 25; do not hand over to anyone under ${minAge}.`;
}
