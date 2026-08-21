import { PaymentsService } from "../payments.service";

// Card-present charges used to share applicationFeePenceForBasket with online
// ordering, so a shop couldn't price a counter tap differently from a
// delivery order. Location.posTerminalApplicationFee* overrides that.
//
// The distinction that matters most here is NULL vs 0: unset must inherit the
// old behaviour (otherwise every live location silently stops earning a fee
// the moment this deploys), while an explicit 0 must be honoured.

function makeService(locationRow: any) {
  const prisma = {
    location: { findUnique: jest.fn().mockResolvedValue(locationRow) },
  };
  // Same approach as the other payments specs: skip the constructor (it
  // wants Stripe, sockets, the wallet…) and attach only what's under test.
  const svc = Object.create(PaymentsService.prototype) as any;
  svc.prisma = prisma;
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.applicationFeePenceForBasket = jest.fn().mockResolvedValue(777);
  return { svc, prisma };
}

describe("PaymentsService.terminalApplicationFeePence", () => {
  it("inherits the previous resolution when both fields are unset", async () => {
    const { svc } = makeService({
      posTerminalApplicationFeePercent: null,
      posTerminalApplicationFeeFixedMinor: null,
    });
    await expect(svc.terminalApplicationFeePence("loc-1", 24.5)).resolves.toBe(777);
    expect(svc.applicationFeePenceForBasket).toHaveBeenCalledWith("loc-1", 24.5);
  });

  // The whole point of the feature: "charge nothing on terminal payments" is
  // a real choice and must not fall through to the inherited fee.
  it("honours an explicit zero instead of inheriting", async () => {
    const { svc } = makeService({
      posTerminalApplicationFeePercent: 0,
      posTerminalApplicationFeeFixedMinor: 0,
    });
    await expect(svc.terminalApplicationFeePence("loc-1", 24.5)).resolves.toBe(0);
    expect(svc.applicationFeePenceForBasket).not.toHaveBeenCalled();
  });

  it("charges a percentage of the basket in pence", async () => {
    const { svc } = makeService({
      posTerminalApplicationFeePercent: 2,
      posTerminalApplicationFeeFixedMinor: null,
    });
    // £24.50 at 2% = £0.49 = 49p
    await expect(svc.terminalApplicationFeePence("loc-1", 24.5)).resolves.toBe(49);
  });

  it("adds the fixed amount on top of the percentage", async () => {
    const { svc } = makeService({
      posTerminalApplicationFeePercent: 2,
      posTerminalApplicationFeeFixedMinor: 10,
    });
    await expect(svc.terminalApplicationFeePence("loc-1", 24.5)).resolves.toBe(59);
  });

  // Regression: the payment-link branch once divided by 100 twice, so a 5%
  // fee on a small order rounded away to nothing.
  it("does not round a small-order percentage away to zero", async () => {
    const { svc } = makeService({
      posTerminalApplicationFeePercent: 5,
      posTerminalApplicationFeeFixedMinor: null,
    });
    // £1.20 at 5% = 6p
    await expect(svc.terminalApplicationFeePence("loc-1", 1.2)).resolves.toBe(6);
  });

  it("applies one field even when the other is unset", async () => {
    const { svc } = makeService({
      posTerminalApplicationFeePercent: null,
      posTerminalApplicationFeeFixedMinor: 25,
    });
    await expect(svc.terminalApplicationFeePence("loc-1", 24.5)).resolves.toBe(25);
    expect(svc.applicationFeePenceForBasket).not.toHaveBeenCalled();
  });

  it("never returns a negative fee", async () => {
    const { svc } = makeService({
      posTerminalApplicationFeePercent: -5,
      posTerminalApplicationFeeFixedMinor: -100,
    });
    await expect(svc.terminalApplicationFeePence("loc-1", 24.5)).resolves.toBe(0);
  });
});

// Card-present takes the whole fee from the payout and never adds it to the
// customer's bill, so a small charge is the edge case: Stripe rejects a fee
// larger than the charge, which fails the tap at the counter rather than just
// earning us less. Most reachable on a SPLIT part-payment, where the fixed
// portion applies to each part rather than once per bill.
describe("PaymentsService.terminalApplicationFeePence — fee cannot exceed the charge", () => {
  it("clamps a fixed fee larger than a small counter sale", async () => {
    const { svc } = makeService({
      posTerminalApplicationFeePercent: 0,
      posTerminalApplicationFeeFixedMinor: 30,
    });
    // A 10p sale can't carry a 30p fee.
    await expect(svc.terminalApplicationFeePence("loc-1", 0.1)).resolves.toBe(10);
  });

  it("clamps the inherited online-ordering fee too", async () => {
    const { svc } = makeService({
      posTerminalApplicationFeePercent: null,
      posTerminalApplicationFeeFixedMinor: null,
    });
    svc.applicationFeePenceForBasket = jest.fn().mockResolvedValue(500);
    await expect(svc.terminalApplicationFeePence("loc-1", 1)).resolves.toBe(100);
  });

  it("leaves a fee that fits inside the charge alone", async () => {
    const { svc } = makeService({
      posTerminalApplicationFeePercent: 2,
      posTerminalApplicationFeeFixedMinor: 10,
    });
    await expect(svc.terminalApplicationFeePence("loc-1", 24.5)).resolves.toBe(59);
  });
});
