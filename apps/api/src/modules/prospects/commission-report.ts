// The commission report shown to a shop owner. Pure, so every number can be
// tested, and deliberately cautious, because the owner will check it against
// their own statements and one inflated figure loses the room:
//
// - Commission is compared excluding VAT, since a VAT-registered shop reclaims it.
// - Only commission counts as saved. Marketing and other fees may carry on.
// - Only the share of sales the operator expects to move is counted, never all.
// - A year's figure is only given when the statements say what period they cover.

export type StatementPlatform = "just_eat" | "uber_eats" | "deliveroo" | "other";

export interface ProspectStatement {
  id: string;
  platform: StatementPlatform;
  /** YYYY-MM-DD, or null when the statement doesn't say. */
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  /** What customers paid for food, before anything was taken off. */
  sales: number;
  /** Commission excluding VAT. */
  commission: number;
  commissionVat: number | null;
  orders: number | null;
  otherFees: { label: string; amount: number }[];
  payout: number | null;
  source: "statement" | "manual";
  warnings: string[];
}

export interface ReportAssumptions {
  /** Share of marketplace sales expected to move to direct ordering, 0–100. */
  movedSharePct: number;
  cardPct: number;
  cardFixedPence: number;
  subscriptionPerWeek: number;
  /** The shop's own cost of delivering one moved order. */
  deliveryCostPerOrder: number;
}

// Stripe's standard UK online rate and the advertised EPOS price.
export const DEFAULT_ASSUMPTIONS: ReportAssumptions = {
  movedSharePct: 25,
  cardPct: 1.5,
  cardFixedPence: 20,
  subscriptionPerWeek: 15,
  deliveryCostPerOrder: 0,
};

export interface PlatformLine {
  platform: StatementPlatform;
  sales: number;
  commission: number;
  otherFees: number;
  orders: number | null;
  commissionRatePct: number;
  daysCovered: number | null;
}

export interface CommissionReport {
  currency: string;
  platforms: PlatformLine[];
  /** Exactly what the statements show. */
  sales: number;
  commission: number;
  otherFees: number;
  orders: number | null;
  commissionRatePct: number;
  /** Shortest period among the platforms, in days. */
  shortestPeriodDays: number | null;
  /** Null when any statement has no dates: then there is no honest year. */
  year: {
    sales: number;
    commission: number;
    otherFees: number;
    orders: number | null;
  } | null;
  /** Null without a year's figure. */
  scenario: {
    movedSales: number;
    commissionSaved: number;
    cardFees: number;
    deliveryCosts: number;
    subscription: number;
    /** May be negative, and is then shown as a loss, not hidden. */
    netPerYear: number;
    /** The share of sales that has to move for OrderHub to pay for itself.
     *  Null when moving sales can never pay (direct costs more per order). */
    breakEvenSharePct: number | null;
  } | null;
  assumptions: ReportAssumptions;
  /** Caveats the operator should say out loud. */
  notes: string[];
}

const round = (n: number): number => Math.round(n * 100) / 100;
const DAY_MS = 86_400_000;
/** Under this, a year's figure is mostly a guess about the season. */
const THIN_COVERAGE_DAYS = 28;

const parseDay = (s: string | null): number | null => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
};

/** Days covered by these statements, counting overlaps once. Null if any
 *  statement has no usable dates. */
export function daysCovered(statements: ProspectStatement[]): number | null {
  const ranges: [number, number][] = [];
  for (const s of statements) {
    const from = parseDay(s.periodStart);
    const to = parseDay(s.periodEnd);
    if (from === null || to === null || to < from) return null;
    ranges.push([from, to]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let days = 0;
  let coveredTo = -Infinity;
  for (const [from, to] of ranges) {
    const start = Math.max(from, coveredTo + DAY_MS);
    if (to >= start) days += Math.round((to - start) / DAY_MS) + 1;
    coveredTo = Math.max(coveredTo, to);
  }
  return days;
}

export function mergeAssumptions(saved: unknown): ReportAssumptions {
  const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  const pick = (key: keyof ReportAssumptions): number => {
    const n = Number(s[key]);
    return s[key] !== undefined && s[key] !== null && Number.isFinite(n) && n >= 0
      ? n
      : DEFAULT_ASSUMPTIONS[key];
  };
  return {
    movedSharePct: Math.min(pick("movedSharePct"), 100),
    cardPct: pick("cardPct"),
    cardFixedPence: pick("cardFixedPence"),
    subscriptionPerWeek: pick("subscriptionPerWeek"),
    deliveryCostPerOrder: pick("deliveryCostPerOrder"),
  };
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const feesOf = (s: ProspectStatement): number => sum(s.otherFees.map((f) => f.amount));

export function buildCommissionReport(
  statements: ProspectStatement[],
  savedAssumptions?: unknown,
): CommissionReport | null {
  if (statements.length === 0) return null;
  const assumptions = mergeAssumptions(savedAssumptions);
  const notes: string[] = [];

  const currencies = [...new Set(statements.map((s) => s.currency))];
  if (currencies.length > 1) {
    notes.push(`These statements mix currencies (${currencies.join(", ")}), so the totals are not reliable.`);
  }

  const byPlatform = new Map<StatementPlatform, ProspectStatement[]>();
  for (const s of statements) byPlatform.set(s.platform, [...(byPlatform.get(s.platform) ?? []), s]);

  const platforms: PlatformLine[] = [...byPlatform.entries()].map(([platform, rows]) => {
    const sales = sum(rows.map((r) => r.sales));
    const commission = sum(rows.map((r) => r.commission));
    return {
      platform,
      sales: round(sales),
      commission: round(commission),
      otherFees: round(sum(rows.map(feesOf))),
      orders: rows.every((r) => r.orders !== null) ? sum(rows.map((r) => r.orders!)) : null,
      commissionRatePct: sales > 0 ? round((commission / sales) * 100) : 0,
      daysCovered: daysCovered(rows),
    };
  });

  const sales = sum(platforms.map((p) => p.sales));
  const commission = sum(platforms.map((p) => p.commission));
  const otherFees = sum(platforms.map((p) => p.otherFees));
  const ordersKnown = platforms.every((p) => p.orders !== null);
  const coverage = platforms.map((p) => p.daysCovered);
  const allDated = coverage.every((d): d is number => d !== null && d > 0);
  const shortestPeriodDays = allDated ? Math.min(...(coverage as number[])) : null;

  const report: CommissionReport = {
    currency: currencies[0]!,
    platforms,
    sales: round(sales),
    commission: round(commission),
    otherFees: round(otherFees),
    orders: ordersKnown ? sum(platforms.map((p) => p.orders!)) : null,
    commissionRatePct: sales > 0 ? round((commission / sales) * 100) : 0,
    shortestPeriodDays,
    year: null,
    scenario: null,
    assumptions,
    notes,
  };

  if (!allDated) {
    notes.push("A statement has no dates, so only its own totals are shown, with no yearly figure.");
    return report;
  }
  if (shortestPeriodDays! < THIN_COVERAGE_DAYS) {
    notes.push(
      `The yearly figure is scaled up from ${shortestPeriodDays} days and ignores seasons. More statements make it firmer.`,
    );
  }

  // Each platform scales by its own coverage, as a month of Uber and a year of
  // Just Eat are not the same length.
  const perYear = (p: PlatformLine, value: number): number => (value * 365) / p.daysCovered!;
  const yearSales = sum(platforms.map((p) => perYear(p, p.sales)));
  const yearCommission = sum(platforms.map((p) => perYear(p, p.commission)));
  const yearOrders = ordersKnown ? sum(platforms.map((p) => perYear(p, p.orders!))) : null;
  report.year = {
    sales: round(yearSales),
    commission: round(yearCommission),
    otherFees: round(sum(platforms.map((p) => perYear(p, p.otherFees)))),
    orders: yearOrders === null ? null : Math.round(yearOrders),
  };

  if (yearOrders === null) {
    notes.push("The order count is missing, so the per-order card and delivery costs are left out.");
  }
  if (assumptions.deliveryCostPerOrder === 0) {
    notes.push("No delivery cost is included. Add one if moved orders would need the shop's own drivers.");
  }

  const perOrderCost = assumptions.cardFixedPence / 100 + assumptions.deliveryCostPerOrder;
  const subscription = assumptions.subscriptionPerWeek * 52;
  const cardRate = assumptions.cardPct / 100;
  const commissionRate = yearSales > 0 ? yearCommission / yearSales : 0;

  const share = assumptions.movedSharePct / 100;
  const orders = yearOrders ?? 0;
  const commissionSaved = yearCommission * share;
  const cardFees = yearSales * share * cardRate + orders * share * (assumptions.cardFixedPence / 100);
  const deliveryCosts = orders * share * assumptions.deliveryCostPerOrder;

  // Each 100% of sales moved earns this much before the subscription.
  const marginAtFullShare = yearSales * (commissionRate - cardRate) - orders * perOrderCost;
  report.scenario = {
    movedSales: round(yearSales * share),
    commissionSaved: round(commissionSaved),
    cardFees: round(cardFees),
    deliveryCosts: round(deliveryCosts),
    subscription: round(subscription),
    netPerYear: round(commissionSaved - cardFees - deliveryCosts - subscription),
    breakEvenSharePct:
      marginAtFullShare > 0 && subscription / marginAtFullShare <= 1
        ? round((subscription / marginAtFullShare) * 100)
        : null,
  };
  return report;
}
