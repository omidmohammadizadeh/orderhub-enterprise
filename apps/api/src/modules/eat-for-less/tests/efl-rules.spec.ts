import {
  EFL_DEFAULTS,
  commissionPercentFor,
  eflCommissionPence,
  generateDeliveryPin,
  isListingLive,
  needsDeliveryPin,
  orderRefusal,
  toRulesConfig,
} from "../efl-rules";

describe("eflCommissionPence", () => {
  it("charges the rate on the food only", () => {
    // £20 basket, £2 off: 8% of £18 = £1.44. Delivery fee and tip are not
    // on the order fields this reads, so they can't be charged.
    expect(eflCommissionPence({ subtotal: 20, discount: 2, eflCommissionPercent: 8 })).toBe(144);
  });

  it("reads Prisma Decimal-shaped values", () => {
    expect(eflCommissionPence({ subtotal: "12.50", discount: "0", eflCommissionPercent: "10" })).toBe(125);
  });

  it("is zero with no rate, a zero rate, or a discount bigger than the food", () => {
    expect(eflCommissionPence({ subtotal: 20 })).toBe(0);
    expect(eflCommissionPence({ subtotal: 20, eflCommissionPercent: 0 })).toBe(0);
    expect(eflCommissionPence({ subtotal: 5, discount: 9, eflCommissionPercent: 8 })).toBe(0);
  });
});

describe("commissionPercentFor", () => {
  it("uses the shop's own rate, including a 0% trial", () => {
    expect(commissionPercentFor({ commissionPercent: "6" }, EFL_DEFAULTS)).toBe(6);
    expect(commissionPercentFor({ commissionPercent: 0 }, EFL_DEFAULTS)).toBe(0);
  });

  it("falls back to the platform default", () => {
    expect(commissionPercentFor({ commissionPercent: null }, EFL_DEFAULTS)).toBe(8);
    expect(commissionPercentFor(null, EFL_DEFAULTS)).toBe(8);
  });
});

describe("needsDeliveryPin", () => {
  const config = { pinMinOrderTotal: 25, pinForNewCustomers: true };

  it("never asks on collection", () => {
    expect(needsDeliveryPin({ fulfillmentType: "PICKUP", total: 90, isNewCustomer: true, config })).toBe(false);
  });

  it("asks a new customer on any delivery", () => {
    expect(needsDeliveryPin({ fulfillmentType: "DELIVERY", total: 8, isNewCustomer: true, config })).toBe(true);
  });

  it("asks a regular only from the threshold up", () => {
    expect(needsDeliveryPin({ fulfillmentType: "DELIVERY", total: 24.99, isNewCustomer: false, config })).toBe(false);
    expect(needsDeliveryPin({ fulfillmentType: "DELIVERY", total: 25, isNewCustomer: false, config })).toBe(true);
  });

  it("can stop asking new customers", () => {
    const off = { ...config, pinForNewCustomers: false };
    expect(needsDeliveryPin({ fulfillmentType: "DELIVERY", total: 8, isNewCustomer: true, config: off })).toBe(false);
  });
});

describe("generateDeliveryPin", () => {
  it("is always four digits", () => {
    for (let i = 0; i < 200; i++) expect(generateDeliveryPin()).toMatch(/^\d{4}$/);
  });
});

describe("orderRefusal", () => {
  const base = {
    phoneVerified: true,
    ordersInLastHour: 0,
    isNewCustomer: false,
    total: 30,
    config: { maxOrdersPerHour: 3, firstOrderMaxTotal: 60 },
  };

  it("lets an ordinary order through", () => {
    expect(orderRefusal(base)).toBeNull();
  });

  it("needs a verified phone first", () => {
    expect(orderRefusal({ ...base, phoneVerified: false })).toMatch(/mobile number/);
  });

  it("stops the fourth order in an hour", () => {
    expect(orderRefusal({ ...base, ordersInLastHour: 2 })).toBeNull();
    expect(orderRefusal({ ...base, ordersInLastHour: 3 })).toMatch(/last hour/);
  });

  it("caps a new customer's first order, and only theirs", () => {
    expect(orderRefusal({ ...base, isNewCustomer: true, total: 60 })).toBeNull();
    expect(orderRefusal({ ...base, isNewCustomer: true, total: 60.01 })).toMatch(/first order/);
    expect(orderRefusal({ ...base, isNewCustomer: false, total: 200 })).toBeNull();
  });
});

describe("isListingLive", () => {
  it("needs the shop's switch, our approval, and nothing hiding it", () => {
    expect(isListingLive({ listed: true, status: "APPROVED" })).toBe(true);
    expect(isListingLive({ listed: false, status: "APPROVED" })).toBe(false);
    expect(isListingLive({ listed: true, status: "PENDING" })).toBe(false);
    expect(isListingLive({ listed: true, status: "APPROVED", hiddenReason: "HYGIENE" })).toBe(false);
  });
});

describe("toRulesConfig", () => {
  it("gives the defaults when there is no settings row yet", () => {
    expect(toRulesConfig(null)).toEqual(EFL_DEFAULTS);
  });

  it("reads Decimal strings and keeps a deliberate false", () => {
    expect(
      toRulesConfig({ defaultCommissionPercent: "7.5", pinForNewCustomers: false, maxOrdersPerHour: 5 }),
    ).toEqual({ ...EFL_DEFAULTS, defaultCommissionPercent: 7.5, pinForNewCustomers: false, maxOrdersPerHour: 5 });
  });
});
