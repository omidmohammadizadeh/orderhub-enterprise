import { EflAdsService } from "../efl-ads.service";
import { EflStatementsService } from "../efl-statements.service";
import { readUnsubscribe } from "../efl-campaigns.service";
import {
  MIN_BID,
  adRecoveryPence,
  londonDateKey,
  londonWeekStart,
  nextWeekStart,
  pacedBudgetLeft,
  predictedOrderChance,
  runAuction,
  validateCampaign,
  weekStartFromKey,
} from "../efl-ads-rules";
import { eflApplicationFeePence } from "../efl-rules";

describe("UK weeks", () => {
  it("start on Monday 00:00 UK time, in summer (BST) and winter (GMT)", () => {
    // Wed 29 Oct 2026, GMT: week starts Mon 26 Oct 00:00 GMT.
    expect(londonWeekStart(new Date("2026-10-29T12:00:00Z")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    // Wed 21 Oct 2026, BST: Mon 19 Oct 00:00 BST = 18 Oct 23:00 UTC.
    expect(londonWeekStart(new Date("2026-10-21T12:00:00Z")).toISOString()).toBe("2026-10-18T23:00:00.000Z");
    // Sunday 23:30 UK still belongs to that week.
    expect(londonWeekStart(new Date("2026-11-01T23:30:00Z")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("step across the October clock change (a 25-hour week)", () => {
    const start = londonWeekStart(new Date("2026-10-21T12:00:00Z"));
    expect(nextWeekStart(start).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("are named by their Monday, and only a Monday is a week", () => {
    expect(weekStartFromKey("2026-10-26")?.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(weekStartFromKey("2026-10-27")).toBeNull();
    expect(weekStartFromKey("nonsense")).toBeNull();
    expect(londonDateKey(new Date("2026-10-18T23:30:00Z"))).toBe("2026-10-19");
  });
});

describe("the auction", () => {
  const b = (listingId: string, bid: number, chance = 0.1, budgetLeft = 100) => ({ listingId, bid, chance, budgetLeft });

  it("ranks by bid × chance, not bid alone", () => {
    const w = runAuction([b("rich", 2, 0.05), b("good", 1, 0.2)], 1);
    expect(w[0]!.listingId).toBe("good");
  });

  it("charges just enough to beat the next shop, never more than the bid", () => {
    // good score 0.2; next (rich) score 0.1 → 0.1/0.2 + 0.01 = 0.51
    const w = runAuction([b("rich", 2, 0.05), b("good", 1, 0.2)], 1);
    expect(w[0]).toEqual({ listingId: "good", price: 0.51 });
    const alone = runAuction([b("solo", 3, 0.3)]);
    expect(alone[0]!.price).toBe(MIN_BID);
  });

  it("skips a shop that can't afford its price, and ignores bids under the minimum", () => {
    const w = runAuction([b("broke", 1, 0.2, 0.05), b("ok", 0.5, 0.1), b("cheap", 0.05, 0.5)]);
    expect(w.map((x) => x.listingId)).toEqual(["ok"]);
  });

  it("fills at most two places", () => {
    expect(runAuction([b("a", 1), b("b", 0.9), b("c", 0.8)])).toHaveLength(2);
  });

  it("predicts from history, starting new shops at one in ten", () => {
    expect(predictedOrderChance(0, 0)).toBeCloseTo(0.1);
    expect(predictedOrderChance(90, 27)).toBeCloseTo(0.28);
  });

  it("paces the budget across the week", () => {
    expect(pacedBudgetLeft(70, 0, 0)).toBe(10); // day one: a day's share
    expect(pacedBudgetLeft(70, 50, 6 / 7)).toBe(20);
    expect(pacedBudgetLeft(70, 70, 1)).toBe(0);
  });

  it("checks what a shop types", () => {
    expect(validateCampaign({ weeklyBudget: 25, maxBid: 0.5 })).toBeNull();
    expect(validateCampaign({ weeklyBudget: 2, maxBid: 0.5 })).toMatch(/between £5/);
    expect(validateCampaign({ weeklyBudget: 25, maxBid: 9 })).toMatch(/per tap/);
  });
});

describe("recovering ad spend from orders", () => {
  it("takes what's owed, up to half the order's food", () => {
    expect(adRecoveryPence(300, 2000)).toBe(300);
    expect(adRecoveryPence(5000, 2000)).toBe(1000);
    expect(adRecoveryPence(0, 2000)).toBe(0);
  });

  it("adds it to our Stripe fee on top of the commission", () => {
    const order = { subtotal: 20, discount: 0, eflCommissionPercent: 8, eflAdRecovered: 3 };
    expect(eflApplicationFeePence(order)).toBe(160 + 300);
    expect(eflApplicationFeePence({ ...order, eflAdRecovered: null })).toBe(160);
  });
});

describe("EflAdsService", () => {
  it("hashes viewers, so no raw id or IP is stored", () => {
    const k = EflAdsService.viewerKey({ installId: "abcdef1234567890" });
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).not.toContain("abcdef");
    expect(EflAdsService.viewerKey({ installId: "abcdef1234567890" })).toBe(k);
    expect(EflAdsService.viewerKey({ customerId: "c1" })).not.toBe(k);
  });

  it("charges a sponsored tap once, at the auction's price", async () => {
    const created: any[] = [];
    const prisma: any = {
      eflAdCampaign: {
        findMany: jest.fn().mockResolvedValue([{ listingId: "L1", active: true, pausedByAdmin: false, maxBid: 1, weeklyBudget: 50 }]),
        findUnique: jest.fn().mockResolvedValue({ listingId: "L1", active: true, pausedByAdmin: false, weeklyBudget: 50 }),
      },
      eflAdShow: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}) },
      eflAdTap: {
        groupBy: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockImplementation(async () => (created.length ? { id: "t" } : null)),
        aggregate: jest.fn().mockResolvedValue({ _sum: { cost: 0 } }),
        create: jest.fn(async ({ data }: any) => created.push(data)),
      },
    };
    const ads = new EflAdsService(prisma);
    const now = new Date("2026-10-28T12:00:00Z");
    const placed = await ads.sponsor([{ id: "L1", isOpen: true, orderable: true }, { id: "L2", isOpen: false, orderable: true }], "viewer", now);
    expect([...placed.keys()]).toEqual(["L1"]);
    const token = placed.get("L1")!.token;

    await expect(ads.tap(token, "someone-else", now)).resolves.toEqual({ charged: false });
    await expect(ads.tap(token, "viewer", now)).resolves.toEqual({ charged: true });
    await expect(ads.tap(token, "viewer", now)).resolves.toEqual({ charged: false });
    expect(created).toEqual([{ listingId: "L1", viewerKey: "viewer", cost: MIN_BID }]);
    await expect(ads.tap(`${token}x`, "viewer", now)).resolves.toEqual({ charged: false });
  });
});

describe("EflStatementsService", () => {
  it("adds up a week: paid, commission, ads taken back, and the shop's share", async () => {
    const prisma: any = {
      eflListing: {
        findUnique: jest.fn().mockResolvedValue({ id: "L1", locationId: "loc", location: { name: "Shop", brand: { name: "Pizza Pizza" } } }),
      },
      order: {
        findMany: jest.fn().mockResolvedValue([
          { id: "o1", displayId: "A1", orderNumber: 1, createdAt: new Date("2026-10-27T18:00:00Z"), fulfillmentType: "DELIVERY", subtotal: 20, discount: 0, deliveryFee: 2.5, tipAmount: 1, total: 23.5, eflCommissionPercent: 8, eflAdRecovered: 3 },
          { id: "o2", displayId: "A2", orderNumber: 2, createdAt: new Date("2026-10-28T18:00:00Z"), fulfillmentType: "PICKUP", subtotal: 10, discount: 0, deliveryFee: 0, tipAmount: 0, total: 10, eflCommissionPercent: 8, eflAdRecovered: null },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const ads: any = {
      weekStats: jest.fn().mockResolvedValue({ shows: 40, taps: 6, spent: 3, orders: 1 }),
      owedPence: jest.fn().mockResolvedValue(0),
    };
    const svc = new EflStatementsService(prisma, ads);
    const s = await svc.build("loc", "2026-10-26");
    expect(s.shopName).toBe("Pizza Pizza");
    expect(s.orders).toBe(2);
    expect(s.customerPaid).toBe(33.5);
    expect(s.commission).toBe(2.4);
    expect(s.ads.recovered).toBe(3);
    expect(s.toShop).toBe(28.1);
    expect(s.refundedOrders).toBe(1);
    expect(s.weekLabel).toBe("26 Oct – 1 Nov 2026");

    const pdf = await svc.pdf(s);
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses a week that isn't a Monday", async () => {
    const svc = new EflStatementsService({} as any, {} as any);
    await expect(svc.build("loc", "2026-10-27")).rejects.toThrow(/Monday/);
  });
});

describe("unsubscribe links", () => {
  it("only accept our own signature", () => {
    expect(readUnsubscribe("bogus")).toBeNull();
    expect(readUnsubscribe("YWJj.tampered")).toBeNull();
  });
});
