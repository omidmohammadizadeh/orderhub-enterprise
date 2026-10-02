import type { TalabatDiscount, TalabatOrder, TalabatTopping } from "./talabat-types";

// Phase TB-6 — who paid for the discount.
//
// Talabat's certification lists "Item-Level Discounts Enhancement — payload
// carries discount sponsor + ratio" as MANDATORY. The restaurant API has no
// endpoint to CREATE a promotion (restaurants set those up in Talabat's own
// portal); what it gives the POS is the breakdown, on every order:
//
//   order.discounts[]                      every discount, order-wide
//   products[].discounts[]                 the share that landed on a line
//   products[].selectedToppings[].discounts[]   …or on an add-on
//
// each with `sponsorships: [{ sponsor: PLATFORM | VENDOR | THIRD_PARTY, amount }]`.
//
// Per the spec, item-level amounts are INCLUDED in the top-level ones ("They
// can be mapped by the discount name"), so summing both would double-count.
// The top level is the total; the item level says where it fell.
//
// Why it matters to a restaurant: a 20% promotion Talabat funds costs the shop
// nothing, the same promotion VENDOR-funded comes straight off its payout. The
// order total looks identical either way. This is the only place the
// difference is visible, so it is kept on every order and summed in reports.

export interface TalabatDiscountLine {
  name: string;
  amount: number;
  platform: number;
  vendor: number;
  thirdParty: number;
  /** Amount no sponsorship accounts for — sponsorships are optional. */
  unattributed: number;
}

export interface TalabatItemDiscount {
  /** The product (or "product › add-on") the discount landed on. */
  target: string;
  name: string;
  amount: number;
}

export interface TalabatDiscountSummary {
  total: number;
  platformFunded: number;
  vendorFunded: number;
  thirdPartyFunded: number;
  unattributed: number;
  discounts: TalabatDiscountLine[];
  itemLevel: TalabatItemDiscount[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Their money is strings ("9.00"); anything unparseable is 0, never NaN. */
export function num(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

export function summarizeDiscountLine(d: TalabatDiscount): TalabatDiscountLine {
  // Discounts are positive amounts in their payloads. abs() so a platform that
  // ever sends them negative (as the grocery API does) can't flip the sign of
  // a report.
  const amount = round2(Math.abs(num(d.amount)));
  let platform = 0;
  let vendor = 0;
  let thirdParty = 0;
  for (const s of d.sponsorships ?? []) {
    const a = Math.abs(num(s.amount));
    const who = String(s.sponsor ?? "").toUpperCase();
    if (who === "PLATFORM") platform += a;
    else if (who === "VENDOR") vendor += a;
    else if (who === "THIRD_PARTY") thirdParty += a;
  }
  platform = round2(platform);
  vendor = round2(vendor);
  thirdParty = round2(thirdParty);
  return {
    name: String(d.name ?? "").trim() || "Discount",
    amount,
    platform,
    vendor,
    thirdParty,
    unattributed: round2(Math.max(0, amount - platform - vendor - thirdParty)),
  };
}

/** The whole order's promotion picture. Pure; used at ingest and in reports. */
export function summarizeTalabatDiscounts(order: Pick<TalabatOrder, "discounts" | "products">): TalabatDiscountSummary {
  const discounts = (order.discounts ?? []).map(summarizeDiscountLine).filter((d) => d.amount > 0);

  const itemLevel: TalabatItemDiscount[] = [];
  const walkToppings = (product: string, toppings: TalabatTopping[] | undefined) => {
    for (const t of toppings ?? []) {
      for (const d of t.discounts ?? []) {
        const amount = round2(Math.abs(num(d.amount)));
        if (amount > 0) {
          itemLevel.push({ target: `${product} › ${t.name}`, name: String(d.name ?? "Discount"), amount });
        }
      }
      walkToppings(product, t.children);
    }
  };
  for (const p of order.products ?? []) {
    const product = String(p.name ?? "Item");
    for (const d of p.discounts ?? []) {
      const amount = round2(Math.abs(num(d.amount)));
      if (amount > 0) itemLevel.push({ target: product, name: String(d.name ?? "Discount"), amount });
    }
    walkToppings(product, p.selectedToppings);
  }

  const sum = (k: keyof Omit<TalabatDiscountLine, "name">) => round2(discounts.reduce((a, d) => a + d[k], 0));
  return {
    total: sum("amount"),
    platformFunded: sum("platform"),
    vendorFunded: sum("vendor"),
    thirdPartyFunded: sum("thirdParty"),
    unattributed: sum("unattributed"),
    discounts,
    itemLevel,
  };
}

export interface TalabatPromotionReportRow {
  name: string;
  orders: number;
  amount: number;
  platform: number;
  vendor: number;
  thirdParty: number;
  unattributed: number;
}

/**
 * Roll many orders' summaries up by promotion name — the "what did Talabat's
 * promotions cost us this week" table.
 */
export function rollUpPromotions(
  summaries: Array<Pick<TalabatDiscountSummary, "discounts">>,
): { rows: TalabatPromotionReportRow[]; totals: Omit<TalabatPromotionReportRow, "name"> } {
  const byName = new Map<string, TalabatPromotionReportRow>();
  for (const s of summaries) {
    const seenOnOrder = new Set<string>();
    for (const d of s.discounts ?? []) {
      const row =
        byName.get(d.name) ??
        { name: d.name, orders: 0, amount: 0, platform: 0, vendor: 0, thirdParty: 0, unattributed: 0 };
      if (!seenOnOrder.has(d.name)) {
        row.orders += 1;
        seenOnOrder.add(d.name);
      }
      row.amount = round2(row.amount + d.amount);
      row.platform = round2(row.platform + d.platform);
      row.vendor = round2(row.vendor + d.vendor);
      row.thirdParty = round2(row.thirdParty + d.thirdParty);
      row.unattributed = round2(row.unattributed + d.unattributed);
      byName.set(d.name, row);
    }
  }
  const rows = [...byName.values()].sort((a, b) => b.amount - a.amount);
  const totals = rows.reduce(
    (t, r) => ({
      orders: t.orders + r.orders,
      amount: round2(t.amount + r.amount),
      platform: round2(t.platform + r.platform),
      vendor: round2(t.vendor + r.vendor),
      thirdParty: round2(t.thirdParty + r.thirdParty),
      unattributed: round2(t.unattributed + r.unattributed),
    }),
    { orders: 0, amount: 0, platform: 0, vendor: 0, thirdParty: 0, unattributed: 0 },
  );
  return { rows, totals };
}
