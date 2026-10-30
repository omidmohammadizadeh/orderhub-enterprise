import { describe, expect, it } from "vitest";
import type { AnalyticsOverview } from "../api/analytics.client";
import { buildZReport, type ZReportInput } from "./z-report";

const data = {
  generatedAt: "2026-10-30T22:00:00.000Z",
  window: {
    from: "2026-10-30T00:00:00.000Z",
    to: "2026-10-30T23:59:59.000Z",
    prevFrom: "2026-10-29T00:00:00.000Z",
    prevTo: "2026-10-29T23:59:59.000Z",
  },
  summary: {
    grossRevenue: 120,
    netRevenue: 95,
    subtotal: 100,
    discount: 10,
    deliveryFees: 12,
    serviceCharge: 3,
    taxAmount: 5,
    successfulOrders: 6,
    cancelledOrders: 1,
    failedOrders: 0,
    cancelledRevenue: 15,
    failedRevenue: 0,
    avgOrderValue: 15.83,
  },
  paymentMix: {
    cash: { orders: 2, revenue: 40 },
    card: { orders: 4, revenue: 72 },
    pending: { orders: 0, revenue: 0 },
    other: { orders: 0, revenue: 0 },
    paidOrders: 6,
    paidRevenue: 112,
    unpaidOrders: 0,
    unpaidRevenue: 0,
    byMethod: [
      { method: "CARD", group: "CARD", orders: 4, revenue: 72 },
      { method: "CASH", group: "CASH", orders: 2, revenue: 40 },
    ],
  },
  byChannel: [{ name: "JUST_EAT", revenue: 112, orders: 6, share: 1 }],
  byBrand: [{ id: "b", name: "Pizza Uno", revenue: 112, orders: 6 }],
  byLocation: [{ id: "l", name: "Pizza Uno", revenue: 112, orders: 6 }],
  topProducts: [{ name: "Margherita", quantity: 3, revenue: 30 }],
} as unknown as AnalyticsOverview;

const input: ZReportInput = {
  data,
  currency: "GBP",
  scopeName: "Pizza Uno",
  channelLabel: (s) => (s === "JUST_EAT" ? "Just Eat" : s),
  methodLabel: (s) => s,
};

// CP437: 0x9C is the pound sign.
const text = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => (b === 0x9c ? "£" : String.fromCharCode(b))).join("");

describe("buildZReport", () => {
  it("prints a sales block that adds up", () => {
    const t = text(buildZReport(input));
    expect(t).toMatch(/Gross sales\s+£120\.00/);
    expect(t).toMatch(/Discounts\s+-£10\.00/);
    // 120 gross - 10 discount = 110, but the payments total 112.
    expect(t).toMatch(/Tips and other\s+£2\.00/);
    expect(t).toMatch(/TOTAL SALES\s+£112\.00/);
  });

  it("leaves the reconciling line off when the sum already works", () => {
    const exact = {
      ...data,
      summary: { ...data.summary, discount: 8 },
    };
    expect(text(buildZReport({ ...input, data: exact }))).not.toContain("Tips and other");
  });

  it("keeps every text line inside the paper", () => {
    const long = {
      ...data,
      byBrand: [
        { id: "a", name: "A very long brand name that runs well past the edge of the roll", revenue: 60, orders: 3 },
        { id: "b", name: "Short", revenue: 52, orders: 3 },
      ],
    };
    const t = text(buildZReport({ ...input, data: long }));
    // Strip the command bytes, which share a line with the text they format.
    const lines = t.replace(/[\x1b\x1d][\s\S]{1,3}?(?=[ -~£\n]|$)/g, "").split("\n");
    expect(t).toContain("BRANDS");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(46);
  });

  it("says on the paper when the figures are not plain takings", () => {
    const t = text(
      buildZReport({
        ...input,
        includesTestOrders: true,
        mixedCurrencies: ["GBP", "AED"],
        channelFilter: "Just Eat",
      }),
    );
    expect(t).toContain("INCLUDES TEST ORDERS");
    expect(t).toContain("MIXED CURRENCIES: GBP + AED");
    expect(t).toContain("Channels: Just Eat");
  });

  it("prints a Gulf shop in its own money", () => {
    const t = text(buildZReport({ ...input, currency: "AED" }));
    expect(t).toMatch(/TOTAL SALES\s+AED 112\.00/);
    expect(t).not.toContain("£");
  });

  it("speaks Star Line Mode to a Star printer", () => {
    const bytes = buildZReport(input, 80, true);
    // ESC d 3 = Star cut, and never the ESC/POS GS V.
    expect(text(bytes)).toContain("\x1bd\x03");
    expect(text(bytes)).not.toContain("\x1dV");
  });
});
