import { buildCommissionReport, daysCovered, type ProspectStatement } from "../commission-report";
import { toStatement } from "../statement-reader.service";
import { hygieneWorthShowing, mergeStatements, nameFromLink } from "../prospects.service";

const statement = (over: Partial<ProspectStatement> = {}): ProspectStatement => ({
  id: "s1",
  platform: "just_eat",
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  currency: "GBP",
  sales: 100_000,
  commission: 14_000,
  commissionVat: 2_800,
  orders: 4_000,
  otherFees: [],
  payout: null,
  source: "statement",
  warnings: [],
  ...over,
});

describe("commission report", () => {
  it("has nothing to show without statements", () => {
    expect(buildCommissionReport([])).toBeNull();
  });

  it("works out a year's saving from the moved share alone", () => {
    const r = buildCommissionReport([statement()], {
      movedSharePct: 25,
      cardPct: 1.5,
      cardFixedPence: 20,
      subscriptionPerWeek: 15,
      deliveryCostPerOrder: 0,
    })!;
    expect(r.commission).toBe(14_000);
    expect(r.commissionRatePct).toBe(14);
    expect(r.year!.commission).toBe(14_000);
    expect(r.scenario!.movedSales).toBe(25_000);
    expect(r.scenario!.commissionSaved).toBe(3_500);
    // 1.5% of £25,000 + 20p on 1,000 orders.
    expect(r.scenario!.cardFees).toBe(575);
    expect(r.scenario!.subscription).toBe(780);
    expect(r.scenario!.netPerYear).toBe(2_145);
  });

  it("gives the share that pays for the subscription", () => {
    const r = buildCommissionReport([statement()])!;
    // £780 / (£14,000 − £1,500 − £800) = 6.67%.
    expect(r.scenario!.breakEvenSharePct).toBeCloseTo(6.67, 1);
  });

  it("scales each platform by its own period", () => {
    const r = buildCommissionReport([
      statement(),
      statement({
        id: "s2",
        platform: "uber_eats",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        sales: 10_000,
        commission: 3_000,
        orders: 300,
      }),
    ])!;
    expect(r.year!.commission).toBeCloseTo(14_000 + (3_000 * 365) / 30, 0);
    expect(r.shortestPeriodDays).toBe(30);
  });

  it("refuses to invent a year when a statement has no dates", () => {
    const r = buildCommissionReport([statement({ periodEnd: null })])!;
    expect(r.commission).toBe(14_000);
    expect(r.year).toBeNull();
    expect(r.scenario).toBeNull();
    expect(r.notes.join(" ")).toMatch(/no dates/);
  });

  it("says when a year is scaled up from a short period", () => {
    const r = buildCommissionReport([statement({ periodEnd: "2026-01-07" })])!;
    expect(r.notes.join(" ")).toMatch(/scaled up from 7 days/);
  });

  it("counts delivery as a cost, and shows a loss rather than hiding it", () => {
    const r = buildCommissionReport([statement()], { deliveryCostPerOrder: 5 })!;
    expect(r.scenario!.deliveryCosts).toBe(5_000);
    expect(r.scenario!.netPerYear).toBeLessThan(0);
    // Moving orders loses money per order, so no share can ever pay.
    expect(r.scenario!.breakEvenSharePct).toBeNull();
  });

  it("leaves per-order costs out when the order count is missing, and says so", () => {
    const r = buildCommissionReport([statement({ orders: null })])!;
    expect(r.orders).toBeNull();
    expect(r.scenario!.cardFees).toBe(375);
    expect(r.notes.join(" ")).toMatch(/order count is missing/);
  });

  it("counts overlapping days once", () => {
    expect(
      daysCovered([
        statement({ periodStart: "2026-01-01", periodEnd: "2026-01-10" }),
        statement({ periodStart: "2026-01-05", periodEnd: "2026-01-14" }),
      ]),
    ).toBe(14);
  });
});

describe("reading a statement", () => {
  it("drops a statement with no sales or no commission", () => {
    expect(toStatement({ platform: "just_eat", sales: null, commission: 5 }, "statement")).toBeNull();
    expect(toStatement({ platform: "just_eat", sales: 100, commission: null }, "statement")).toBeNull();
  });

  it("warns when the figures don't reach the payout", () => {
    const s = toStatement({ platform: "deliveroo", sales: 1000, commission: 300, payout: 900 }, "statement")!;
    expect(s.warnings.join(" ")).toMatch(/don't add up/);
  });

  it("stays quiet when the figures reach the payout", () => {
    const s = toStatement(
      { platform: "deliveroo", sales: 1000, commission: 300, commissionVat: 60, payout: 640 },
      "statement",
    )!;
    expect(s.warnings).toEqual([]);
  });

  it("warns on a commission that can't be right", () => {
    const s = toStatement({ platform: "just_eat", sales: 100, commission: 140 }, "statement")!;
    expect(s.warnings.join(" ")).toMatch(/bigger than sales/);
  });

  it("drops malformed dates and an unknown platform", () => {
    const s = toStatement({ platform: "x", sales: 100, commission: 10, periodStart: "Jan 2026" }, "manual")!;
    expect(s.platform).toBe("other");
    expect(s.periodStart).toBeNull();
  });
});

describe("prospect helpers", () => {
  it("replaces a re-uploaded statement instead of counting it twice", () => {
    const merged = mergeStatements([statement({ id: "old" })], [statement({ id: "new" })]);
    expect(merged.map((s) => s.id)).toEqual(["new"]);
  });

  it("keeps two undated statements, as nothing says they are the same one", () => {
    const merged = mergeStatements(
      [statement({ id: "a", periodStart: null, periodEnd: null })],
      [statement({ id: "b", periodStart: null, periodEnd: null })],
    );
    expect(merged).toHaveLength(2);
  });

  it("names a prospect from its marketplace link", () => {
    expect(nameFromLink("https://www.just-eat.co.uk/restaurants-mama-mia-pizzeria-south-shields-ne33/menu")).toBe(
      "Mama Mia Pizzeria South Shields",
    );
    expect(nameFromLink("https://deliveroo.co.uk/menu/London/clapham-junction/pepes-piri-piri-clapham-junction")).toBe(
      "Pepes Piri Piri Clapham Junction",
    );
    expect(nameFromLink("not a link")).toBeNull();
  });

  it("only shows a hygiene score worth showing", () => {
    expect(hygieneWorthShowing({ rating: "5" })).toBe(true);
    expect(hygieneWorthShowing({ rating: "Pass" })).toBe(true);
    expect(hygieneWorthShowing({ rating: "1" })).toBe(false);
    expect(hygieneWorthShowing({ rating: "AwaitingInspection" })).toBe(false);
    expect(hygieneWorthShowing(null)).toBe(false);
  });
});
