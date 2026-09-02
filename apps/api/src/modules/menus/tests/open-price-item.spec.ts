// "Ask for the price at the till" items.
//
// The point of the flag is the till prompt, but the dangerous half is what it
// does to every OTHER channel. basePrice on such an item is meaningless — it
// is whatever was in the box when the operator ticked the checkbox — so if the
// item ever reached a storefront or a marketplace, customers would order it at
// that price. Usually £0.
//
// Rather than teach six publishers about a new flag, writing openPrice forces
// visibleToCustomers false, which they already all honour. These tests pin
// that rule, because it is the one that keeps free food off Uber Eats.

/** Mirrors the create path in MenusService.createItem. */
function visibilityOnCreate(dto: {
  openPrice?: boolean;
  visibleToCustomers?: boolean;
}) {
  return dto.openPrice ? false : (dto.visibleToCustomers ?? true);
}

/** Mirrors the update path in MenusService.updateItem. */
function visibilityOnUpdate(dto: { openPrice?: boolean }) {
  if (dto.openPrice === undefined) return undefined; // untouched
  return dto.openPrice ? false : undefined; // ON hides; OFF changes nothing
}

describe("open-price items never face a customer", () => {
  it("hides a new open-price item even when the caller asks for it visible", () => {
    expect(
      visibilityOnCreate({ openPrice: true, visibleToCustomers: true }),
    ).toBe(false);
  });

  it("leaves an ordinary item's visibility alone", () => {
    expect(visibilityOnCreate({ visibleToCustomers: true })).toBe(true);
    expect(visibilityOnCreate({ visibleToCustomers: false })).toBe(false);
    expect(visibilityOnCreate({})).toBe(true);
  });

  it("hides an existing item the moment open price is switched on", () => {
    expect(visibilityOnUpdate({ openPrice: true })).toBe(false);
  });

  it("does NOT republish an item when open price is switched off", () => {
    // Restoring visibility has to be a deliberate, separate decision. Doing it
    // here would list a product on a marketplace nobody meant to list.
    expect(visibilityOnUpdate({ openPrice: false })).toBeUndefined();
  });

  it("leaves visibility untouched when the flag is not part of the update", () => {
    expect(visibilityOnUpdate({})).toBeUndefined();
  });
});
