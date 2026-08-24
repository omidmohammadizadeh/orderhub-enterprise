import { MARKETING_ROLES } from "../decorators/roles.decorator";

// Phase AR's Team Roles sit OUTSIDE the RolesGuard hierarchy, so OWNER and
// DARK_KITCHEN_MANAGER only ever pass by EXACT match. A route listing just the
// legacy names silently locks out the very people the Team Roles UI creates —
// which is precisely what happened on the till routes, mid-service, with a
// customer waiting. This list is the defence, so it is pinned.
describe("MARKETING_ROLES", () => {
  const roles = MARKETING_ROLES as readonly string[];

  it("admits both generations of every rank it allows", () => {
    // Legacy and Phase AR names for the same three real jobs.
    expect(roles).toEqual(
      expect.arrayContaining([
        "MANAGER",
        "DARK_KITCHEN_MANAGER",
        "TENANT_OWNER",
        "OWNER",
        "PLATFORM_ADMIN",
      ]),
    );
  });

  it("admits a shop manager", () => {
    // The owner's decision: a manager is who notices Tuesdays are quiet.
    expect(roles).toContain("MANAGER");
    expect(roles).toContain("DARK_KITCHEN_MANAGER");
  });

  it("keeps the shop floor out", () => {
    // Marketing gives money away. A cashier, a driver, a kitchen screen and a
    // kiosk bolted to a wall have no business launching an offer.
    for (const r of ["CASHIER", "STAFF", "DRIVER", "KITCHEN_STAFF", "VIEWER", "KIOSK", "KITCHEN_DISPLAY"]) {
      expect(roles).not.toContain(r);
    }
  });

  it("keeps the money-out agent out", () => {
    // FINANCIAL_AGENT handles payouts and credit, which is a different job
    // from deciding what the shop advertises.
    expect(roles).not.toContain("FINANCIAL_AGENT");
  });
});

import { DELIVERY_PRICING_ROLES } from "../decorators/roles.decorator";

// Delivery pricing is margin — the difference between a £2 fee that loses
// money on every order across town and a £5 one that stops the phone ringing.
// The brand settings drawer has always kept it with owners; the server used to
// disagree and let managers through, which is the kind of split that only
// surfaces when someone changes a fee nobody meant them to touch.
describe("DELIVERY_PRICING_ROLES", () => {
  const roles = DELIVERY_PRICING_ROLES as readonly string[];

  it("admits owners under both naming generations", () => {
    expect(roles).toEqual(
      expect.arrayContaining(["TENANT_OWNER", "OWNER", "PLATFORM_ADMIN"]),
    );
  });

  it("keeps managers out under both naming generations", () => {
    // Deliberate, and the pair is asserted together so adding one back without
    // the other cannot happen quietly.
    expect(roles).not.toContain("MANAGER");
    expect(roles).not.toContain("DARK_KITCHEN_MANAGER");
  });

  it("is narrower than marketing", () => {
    // Marketing discounts an order; delivery pricing sets the floor under
    // every order. The second is the tighter permission of the two.
    expect(roles).not.toContain("MANAGER");
  });
});
