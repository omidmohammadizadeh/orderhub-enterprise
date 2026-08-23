import {
  categoryItemAllowsFulfillment,
  itemAllowsFulfillment,
  itemAllowsMode,
  isOrderableNowhere,
  modesFor,
  serviceModeFor,
} from "@orderhub/shared";

// One resolver shared by every surface, because the failure mode for a rule
// like this is not getting it wrong — it is one screen out of a dozen quietly
// not applying it, and nobody noticing until a customer orders a 20" sharing
// pizza for delivery on a moped.

describe("serviceModeFor", () => {
  it("treats counter walk-ins as collection", () => {
    // PICKUP carries both booked collection and someone at the counter — the
    // KDS buckets them together and so does this.
    expect(serviceModeFor("PICKUP")).toBe("COLLECTION");
  });

  it("keeps dine-in separate", () => {
    expect(serviceModeFor("DINE_IN")).toBe("DINE_IN");
  });

  it("counts every courier flavour as delivery", () => {
    for (const t of ["DELIVERY", "MERCHANT_DELIVERY", "PLATFORM_COURIER"]) {
      expect(serviceModeFor(t)).toBe("DELIVERY");
    }
  });

  it("falls to delivery for anything unrecognised", () => {
    // The cautious end: an item marked not-for-delivery stays hidden rather
    // than slipping through on a type a marketplace invented.
    expect(serviceModeFor("SOMETHING_NEW")).toBe("DELIVERY");
    expect(serviceModeFor(null)).toBe("DELIVERY");
  });

  it("is case-insensitive", () => {
    expect(serviceModeFor("dine_in")).toBe("DINE_IN");
  });
});

describe("itemAllowsMode", () => {
  it("hides a no-delivery item from delivery only", () => {
    const item = { availableDelivery: false };
    expect(itemAllowsMode(item, "DELIVERY")).toBe(false);
    expect(itemAllowsMode(item, "COLLECTION")).toBe(true);
    expect(itemAllowsMode(item, "DINE_IN")).toBe(true);
  });

  it("allows everything when the flags were never fetched", () => {
    // Plenty of callers select only the columns they need. An item vanishing
    // because a field was missing from a SELECT would be far worse than one
    // showing when it should not.
    expect(itemAllowsMode({}, "DELIVERY")).toBe(true);
    expect(itemAllowsMode(undefined, "DELIVERY")).toBe(true);
    expect(itemAllowsMode({ availableDelivery: null }, "DELIVERY")).toBe(true);
  });

  it("leaves every existing item available in all three", () => {
    // The columns default true, so the migration changes no menu.
    const legacy = {
      availableCollection: true,
      availableDelivery: true,
      availableDineIn: true,
    };
    expect(modesFor(legacy)).toEqual(["COLLECTION", "DELIVERY", "DINE_IN"]);
  });
});

describe("itemAllowsFulfillment", () => {
  it("blocks a dine-in-only platter on every delivery flavour", () => {
    const platter = {
      availableCollection: false,
      availableDelivery: false,
      availableDineIn: true,
    };
    expect(itemAllowsFulfillment(platter, "DELIVERY")).toBe(false);
    expect(itemAllowsFulfillment(platter, "PLATFORM_COURIER")).toBe(false);
    expect(itemAllowsFulfillment(platter, "PICKUP")).toBe(false);
    expect(itemAllowsFulfillment(platter, "DINE_IN")).toBe(true);
  });
});

describe("isOrderableNowhere", () => {
  it("spots an item nobody can order", () => {
    // Almost always a mistake rather than an intention, and invisible on a
    // menu — the item simply never appears anywhere.
    expect(
      isOrderableNowhere({
        availableCollection: false,
        availableDelivery: false,
        availableDineIn: false,
      }),
    ).toBe(true);
  });

  it("does not flag a normal item", () => {
    expect(isOrderableNowhere({ availableDelivery: false })).toBe(false);
  });
});

// A category switched off for a mode takes everything inside it, whatever the
// individual items say. That is the whole point of having the switch at the
// level people think in — nobody unticks thirty items one at a time.
describe("categoryItemAllowsFulfillment", () => {
  const on = {
    availableCollection: true,
    availableDelivery: true,
    availableDineIn: true,
  };

  it("hides every item in a category that is off for delivery", () => {
    const cat = { ...on, availableDelivery: false };
    expect(categoryItemAllowsFulfillment(cat, on, "DELIVERY")).toBe(false);
    // …including an item explicitly marked available for delivery.
    expect(
      categoryItemAllowsFulfillment(cat, { availableDelivery: true }, "DELIVERY"),
    ).toBe(false);
  });

  it("still allows that category on collection", () => {
    const cat = { ...on, availableDelivery: false };
    expect(categoryItemAllowsFulfillment(cat, on, "PICKUP")).toBe(true);
  });

  it("lets one item opt out inside a category that is on", () => {
    expect(
      categoryItemAllowsFulfillment(on, { availableDelivery: false }, "DELIVERY"),
    ).toBe(false);
    expect(categoryItemAllowsFulfillment(on, on, "DELIVERY")).toBe(true);
  });

  it("allows everything when neither carries the flags", () => {
    expect(categoryItemAllowsFulfillment(undefined, undefined, "DELIVERY")).toBe(
      true,
    );
  });
});
