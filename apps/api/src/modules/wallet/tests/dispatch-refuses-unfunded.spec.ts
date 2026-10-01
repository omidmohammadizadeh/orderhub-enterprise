import { BadRequestException } from "@nestjs/common";
import { JetGoDispatchService } from "../../integrations/jet-go/jet-go-dispatch.service";
import { UberDirectDispatchService } from "../../integrations/uber-direct/uber-direct-dispatch.service";

// A dispatch that cannot take its fee must not create a courier job.
//
// The fee is OrderHub's and it comes out BEFORE the job exists, because once a
// courier is moving the money is spent and the only remedy left is chasing an
// invoice. These pin the order of operations for the two networks that book a
// single delivery; Stuart's own specs cover its multi-drop run.

type Row = Record<string, any>;

/** A wallet that refuses, exactly as the real one does when the balance is
 *  short — the guard lives inside debitForDispatch. */
function brokeWallet() {
  return {
    dispatchFeeMinor: () => 50,
    dispatchFeeMinorFor: jest.fn().mockResolvedValue(50),
    isDispatchChargeWaived: jest.fn().mockResolvedValue(false),
    debitForDispatch: jest.fn().mockRejectedValue(
      new BadRequestException(
        "Dispatch wallet balance is too low. Top up your wallet to dispatch this order.",
      ),
    ),
    refundDispatch: jest.fn().mockResolvedValue(undefined),
    assertCanAffordDispatch: jest.fn().mockResolvedValue(undefined),
  };
}

function fundedWallet(over: Row = {}) {
  return {
    dispatchFeeMinor: () => 50,
    dispatchFeeMinorFor: jest.fn().mockResolvedValue(50),
    isDispatchChargeWaived: jest.fn().mockResolvedValue(false),
    debitForDispatch: jest.fn().mockResolvedValue({ chargedMinor: 50, balanceAfterMinor: 450 }),
    refundDispatch: jest.fn().mockResolvedValue(undefined),
    assertCanAffordDispatch: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

// ── JET Go ────────────────────────────────────────────────────────────────

function jetGo(wallet: any, client: Row = {}) {
  const s: any = Object.create(JetGoDispatchService.prototype);
  s.prisma = {};
  s.wallet = wallet;
  s.geocoding = { geocode: jest.fn().mockResolvedValue(null) };
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.activity = { record: jest.fn() };
  s.client = {
    estimate: jest.fn().mockResolvedValue({ requestId: "req-1", dynamicDeliveryFee: 350 }),
    createDelivery: jest.fn().mockResolvedValue({}),
    ...client,
  };
  const order = {
    id: "o1",
    tenantId: "t1",
    locationId: "loc1",
    displayId: "A-1",
    customerName: "Sam",
    customerPhone: "+447700900123",
    customerInfo: {},
    deliveryAddress: { line1: "12 High St", city: "London", postcode: "SW1A 1AA" },
    deliveryLat: 51.5,
    deliveryLng: -0.14,
    items: [{ quantity: 1 }],
    total: "20.00",
    metadata: {},
  };
  s.load = jest.fn().mockResolvedValue({
    order,
    location: { id: "loc1", name: "Shop", country: "GB", currency: "GBP", prepTime: 20 },
    cfg: { collectPointId: "cp-1", market: "UK", environment: "sandbox", active: true },
  });
  s.db = () => ({ order: { update: jest.fn().mockResolvedValue({}) } });
  return s;
}

describe("JET Go", () => {
  it("does not create a delivery when the wallet is short", async () => {
    const wallet = brokeWallet();
    const s = jetGo(wallet);
    await expect(s.dispatch({ orderId: "o1", tenantId: "t1" })).rejects.toThrow(/too low/i);
    expect(s.client.createDelivery).not.toHaveBeenCalled();
  });

  it("charges before it books, not after", async () => {
    const wallet = fundedWallet();
    const s = jetGo(wallet);
    const seq: string[] = [];
    wallet.debitForDispatch.mockImplementation(async () => {
      seq.push("debit");
      return { chargedMinor: 50, balanceAfterMinor: 450 };
    });
    s.client.createDelivery.mockImplementation(async () => {
      seq.push("create");
      return {};
    });
    await s.dispatch({ orderId: "o1", tenantId: "t1" });
    expect(seq).toEqual(["debit", "create"]);
  });

  it("refunds the fee when the booking then fails", async () => {
    const wallet = fundedWallet();
    const s = jetGo(wallet, {
      createDelivery: jest.fn().mockRejectedValue(new Error("JET is down")),
    });
    await expect(s.dispatch({ orderId: "o1", tenantId: "t1" })).rejects.toThrow();
    expect(wallet.refundDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o1", amountMinor: 50 }),
    );
  });

  it("dispatches free, and takes nothing, when the location is waived", async () => {
    const wallet = fundedWallet({
      isDispatchChargeWaived: jest.fn().mockResolvedValue(true),
    });
    const s = jetGo(wallet);
    const r = await s.dispatch({ orderId: "o1", tenantId: "t1" });
    expect(wallet.debitForDispatch).not.toHaveBeenCalled();
    expect(s.client.createDelivery).toHaveBeenCalled();
    expect(r.feeChargedMinor).toBe(0);
    expect(r.chargeWaived).toBe(true);
  });

  it("asks about the waiver for the order's own location", async () => {
    const wallet = fundedWallet();
    await jetGo(wallet).dispatch({ orderId: "o1", tenantId: "t1" });
    expect(wallet.isDispatchChargeWaived).toHaveBeenCalledWith("loc1");
  });

  it("charges an admin like anyone else", async () => {
    // Being a PLATFORM_ADMIN used to skip the fee silently. The dispatch call
    // no longer takes a role at all — only the shop's own setting waives it.
    const wallet = fundedWallet();
    const r = await jetGo(wallet).dispatch({ orderId: "o1", tenantId: "t1" });
    expect(wallet.debitForDispatch).toHaveBeenCalled();
    expect(r.feeChargedMinor).toBe(50);
    expect(r.chargeWaived).toBe(false);
  });
});

// ── Uber Direct ───────────────────────────────────────────────────────────

function uber(wallet: any, client: Row = {}) {
  const s: any = Object.create(UberDirectDispatchService.prototype);
  s.prisma = {};
  s.wallet = wallet;
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.client = {
    quote: jest.fn().mockResolvedValue({ id: "q1", fee: 350 }),
    createDelivery: jest.fn().mockResolvedValue({ id: "d1", status: "pending" }),
    ...client,
  };
  s.load = jest.fn().mockResolvedValue({
    order: {
      id: "o1",
      tenantId: "t1",
      locationId: "loc1",
      displayId: "A-1",
      customerName: "Sam",
      customerPhone: "+447700900123",
      deliveryAddress: { line1: "12 High St", city: "London", postcode: "SW1A 1AA" },
      items: [{ name: "Burger", quantity: 1 }],
    },
    location: {
      id: "loc1",
      name: "Shop",
      addressLine1: "1 Shop St",
      city: "London",
      postcode: "E1 1AA",
      phone: "+447700900000",
    },
    cfg: { active: true },
  });
  s.db = () => ({ order: { update: jest.fn().mockResolvedValue({}) } });
  return s;
}

describe("Uber Direct", () => {
  it("does not create a delivery when the wallet is short", async () => {
    const wallet = brokeWallet();
    const s = uber(wallet);
    await expect(s.dispatch({ orderId: "o1", tenantId: "t1" })).rejects.toThrow(/too low/i);
    expect(s.client.createDelivery).not.toHaveBeenCalled();
  });

  it("refunds the fee when the booking then fails", async () => {
    const wallet = fundedWallet();
    const s = uber(wallet, {
      createDelivery: jest.fn().mockRejectedValue(new Error("Uber is down")),
    });
    await expect(s.dispatch({ orderId: "o1", tenantId: "t1" })).rejects.toThrow();
    expect(wallet.refundDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o1", amountMinor: 50 }),
    );
  });

  it("dispatches free, and takes nothing, when the location is waived", async () => {
    const wallet = fundedWallet({
      isDispatchChargeWaived: jest.fn().mockResolvedValue(true),
    });
    const s = uber(wallet);
    const r = await s.dispatch({ orderId: "o1", tenantId: "t1" });
    expect(wallet.debitForDispatch).not.toHaveBeenCalled();
    expect(s.client.createDelivery).toHaveBeenCalled();
    expect(r.feeChargedMinor).toBe(0);
    expect(r.chargeWaived).toBe(true);
  });

  it("charges an admin like anyone else", async () => {
    const wallet = fundedWallet();
    const r = await uber(wallet).dispatch({ orderId: "o1", tenantId: "t1" });
    expect(wallet.debitForDispatch).toHaveBeenCalled();
    expect(r.feeChargedMinor).toBe(50);
  });
});
