import { managerForbiddenLocationFields } from "../locations.service";

// PATCH /locations/:id is one endpoint covering the shop's address, its
// opening hours, the dine-in toggle, booking rules, and the Stripe account
// and platform fees. A MANAGER needs the day-to-day parts and must not reach
// the rest — and hiding the buttons isn't a control, the same PATCH is one
// curl away.

describe("managerForbiddenLocationFields", () => {
  it("allows ordinary day-to-day edits", () => {
    expect(
      managerForbiddenLocationFields({ name: "Pizza Uno", phone: "0191" } as any),
    ).toEqual([]);
  });

  it("blocks the dine-in toggle", () => {
    expect(
      managerForbiddenLocationFields({
        settings: { tableService: { enabled: true } },
      }),
    ).toContain("settings.tableService");
  });

  // Booking rules live under the SAME key as the toggle
  // (settings.tableService.reservations), so one check covers both.
  it("blocks booking settings", () => {
    expect(
      managerForbiddenLocationFields({
        settings: { tableService: { reservations: { onlineEnabled: true } } },
      }),
    ).toContain("settings.tableService");
  });

  it("leaves other settings keys alone", () => {
    expect(
      managerForbiddenLocationFields({
        settings: { posBrandId: "brand-1", smsSenderName: "PizzaUno" },
      }),
    ).toEqual([]);
  });

  it("blocks every Stripe and platform-fee field", () => {
    const out = managerForbiddenLocationFields({
      stripeConnectedAccountId: "acct_x",
      applicationFeeMode: "fixed_only",
      applicationFeeFixedAmount: 1,
      applicationFeePercentage: 2,
      posStripeAccountId: "acct_y",
      posApplicationFeePercent: 3,
      posApplicationFeeFixedMinor: 20,
      posTerminalApplicationFeePercent: 1.5,
      posTerminalApplicationFeeFixedMinor: 10,
    } as any);
    expect(out).toHaveLength(9);
  });

  // An explicit null/0 is still a change — only "absent" is untouched.
  it("treats an explicit null or zero as an attempted change", () => {
    expect(
      managerForbiddenLocationFields({ posTerminalApplicationFeePercent: 0 } as any),
    ).toContain("posTerminalApplicationFeePercent");
    expect(
      managerForbiddenLocationFields({ stripeConnectedAccountId: null } as any),
    ).toContain("stripeConnectedAccountId");
  });

  it("reports every offending field, not just the first", () => {
    const out = managerForbiddenLocationFields({
      posStripeAccountId: "acct_y",
      settings: { tableService: { enabled: false } },
    } as any);
    expect(out).toEqual(
      expect.arrayContaining(["posStripeAccountId", "settings.tableService"]),
    );
  });
});
