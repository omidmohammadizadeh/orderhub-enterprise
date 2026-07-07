import { UberEatsPromotionsService } from "../ubereats-promotions.service";

// buildPromotionBody maps every MarketingCampaign type onto Uber's
// Promotions API shapes. Money here is PENCE ({amount}), items are
// referenced by the menu payload's merchant item ids.

function svc() {
  return new UberEatsPromotionsService({} as any, {} as any);
}

const base = {
  id: "camp-1",
  audience: "ALL",
  startsAt: new Date("2026-07-10T00:00:00Z"),
  endsAt: new Date("2026-07-20T00:00:00Z"),
  minOrder: 20,
  metadata: {},
  itemIds: [],
  channels: ["UBER_EATS"],
  status: "ACTIVE",
};

describe("UberEatsPromotionsService.buildPromotionBody", () => {
  it("always includes the fields Uber's runtime requires (budget, currency, allow_unlimited_apply)", () => {
    // Uber 400s one missing field at a time (budget → min_basket_constraint
    // → …); these are present in every one of Uber's own create examples.
    for (const t of [
      { type: "PERCENTAGE_OFF", percentageOff: 20 },
      { type: "AMOUNT_OFF_ORDER", amountOff: 5 },
      { type: "FREE_DELIVERY" },
    ]) {
      const body: any = svc().buildPromotionBody({ ...base, ...t });
      expect(body.budget).toEqual({ unlimited_budget: true });
      expect(body.allow_unlimited_apply).toBe(true);
      expect(body.currency_code).toBe("GBP");
    }
  });

  it("percent-off always carries min_basket_constraint + max_discount_value (even with no minimum)", () => {
    const body: any = svc().buildPromotionBody({
      ...base,
      minOrder: null, // no minimum
      type: "PERCENTAGE_OFF",
      percentageOff: 20,
    });
    const d = body.promotion_discount.percent_off_discount;
    // Uber rejects a zero min_spend ("request should have a positive
    // min_spend value"), so with no minimum we floor at 1 penny.
    expect(d.min_basket_constraint.min_spend.amount).toBe(1);
    expect(d.max_discount_value).toEqual({ amount: 100_000 });
  });

  it("uses a WEEKLY periodic budget (pence) when the campaign has a spend cap", () => {
    const body: any = svc().buildPromotionBody({
      ...base,
      type: "PERCENTAGE_OFF",
      percentageOff: 20,
      budget: 50, // £50/week cap
    });
    expect(body.budget).toEqual({
      unlimited_budget: false,
      periodic_budget: {
        budget_amount: { amount: 5000 },
        budget_period: "WEEKLY",
      },
    });
  });

  it("PERCENTAGE_OFF → PERCENTOFF with min basket in pence", () => {
    const body: any = svc().buildPromotionBody({
      ...base,
      type: "PERCENTAGE_OFF",
      percentageOff: 20,
    });
    expect(body.promo_type).toBe("PERCENTOFF");
    expect(body.external_promotion_id).toBe("camp-1");
    expect(body.user_group).toBe("ALL_CUSTOMERS");
    expect(body.start_time).toBe("2026-07-10T00:00:00.000Z");
    expect(
      body.promotion_discount.percent_off_discount.percent_value,
    ).toBe(20);
    expect(
      body.promotion_discount.percent_off_discount.min_basket_constraint
        .min_spend.amount,
    ).toBe(2000);
  });

  it("HAPPY_HOUR adds the daypart schedule", () => {
    const body: any = svc().buildPromotionBody({
      ...base,
      type: "HAPPY_HOUR",
      percentageOff: 15,
      dailyStartTime: "14:00",
      dailyEndTime: "17:30",
    });
    expect(body.promo_type).toBe("PERCENTOFF");
    const custom = body.promotion_customization;
    expect(custom.marketing_experience_type).toBe("HAPPY_HOUR");
    expect(custom.custom_schedule.daypart_constraints[0].hours[0]).toEqual({
      start_hour: 14,
      start_minute: 0,
      end_hour: 17,
      end_minute: 30,
    });
  });

  it("AMOUNT_OFF_ORDER → FLATOFF with pence discount_value", () => {
    const body: any = svc().buildPromotionBody({
      ...base,
      type: "AMOUNT_OFF_ORDER",
      amountOff: 5,
    });
    expect(body.promo_type).toBe("FLATOFF");
    expect(
      body.promotion_discount.flat_off_discount.discount_value.amount,
    ).toBe(500);
  });

  it("PERCENT_OFF_ITEMS → MENU_ITEM_DISCOUNT per item", () => {
    const body: any = svc().buildPromotionBody({
      ...base,
      type: "PERCENT_OFF_ITEMS",
      percentageOff: 30,
      itemIds: ["item-a", "item-b"],
    });
    expect(body.promo_type).toBe("MENU_ITEM_DISCOUNT");
    const d = body.promotion_discount.menu_item_discount.item_discounts;
    expect(d).toEqual([
      {
        item: { item_external_id: "item-a" },
        discount_amount: { percent_discount: { percent_value: 30 } },
      },
      {
        item: { item_external_id: "item-b" },
        discount_amount: { percent_discount: { percent_value: 30 } },
      },
    ]);
  });

  it("BOGO → target items from trigger metadata + itemIds", () => {
    const body: any = svc().buildPromotionBody({
      ...base,
      type: "BOGO",
      metadata: { trigger_item_id: "item-burger" },
    });
    expect(body.promo_type).toBe("BOGO");
    expect(body.promotion_discount.bogo_discount.target_items).toEqual([
      { item_external_id: "item-burger" },
    ]);
  });

  it("FREE_ITEM → FREEITEM_MINBASKET with free_item_id", () => {
    const body: any = svc().buildPromotionBody({
      ...base,
      type: "FREE_ITEM",
      freeItemId: "item-nuggets",
    });
    expect(body.promo_type).toBe("FREEITEM_MINBASKET");
    expect(body.promotion_discount.free_item_discount.free_items).toEqual([
      { free_item_id: "item-nuggets" },
    ]);
    expect(
      body.promotion_discount.free_item_discount.min_basket_constraint
        .min_spend.amount,
    ).toBe(2000);
  });

  it("FREE_DELIVERY → FREEDELIVERY with min basket", () => {
    const body: any = svc().buildPromotionBody({
      ...base,
      type: "FREE_DELIVERY",
    });
    expect(body.promo_type).toBe("FREEDELIVERY");
    expect(
      body.promotion_discount.free_delivery_discount.min_basket_constraint
        .min_spend.amount,
    ).toBe(2000);
  });

  it("NEW audience → FIRST_TIME_CUSTOMER", () => {
    const body: any = svc().buildPromotionBody({
      ...base,
      type: "FREE_DELIVERY",
      audience: "NEW",
    });
    expect(body.user_group).toBe("FIRST_TIME_CUSTOMER");
  });

  it("rejects unconfigured campaigns", () => {
    expect(() =>
      svc().buildPromotionBody({ ...base, type: "PERCENTAGE_OFF" }),
    ).toThrow(/percentage/);
    expect(() =>
      svc().buildPromotionBody({ ...base, type: "FREE_ITEM" }),
    ).toThrow(/free item/);
  });
});
