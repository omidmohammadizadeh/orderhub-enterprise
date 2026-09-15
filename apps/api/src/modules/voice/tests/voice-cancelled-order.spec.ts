// Call QZkzFTOw, 15 Sep. A caller read out a real Just Eat order number and
// was told "It looks like there's a problem with that order. Let me put you
// through to the shop."
//
// The lookup was fine — the order was found, by its Just Eat reference, in one
// go. Two other things were not:
//
//   1. The order was MERCHANT_DELIVERY (a Just Eat order the shop delivers
//      itself), and the marketplace wording was gated on the fulfillment type
//      being the bare string "DELIVERY". So none of it was reached.
//   2. The wording it fell through to never said the word "cancelled". The
//      caller was put through to the shop still not knowing what had happened,
//      and a member of staff had to break it to them.

import { VoiceAiService } from "../voice-ai.service";
import { spokenOrderStatus } from "../voice-flow";

// The real shape of a Just Eat direct order: a nine-digit reference, and the
// shop's own driver.
const JUST_EAT_CANCELLED = {
  id: "cmu2zk56i003811kn2qv6utdb",
  displayId: "948451885",
  orderNumber: 4451,
  collectionCode: null,
  status: "CANCELLED",
  fulfillmentType: "MERCHANT_DELIVERY",
  total: 11.05,
  estimatedReadyAt: null,
  customerPhone: "+447700900123",
  orderSource: "JUST_EAT",
  courierName: null,
  courierEtaAt: null,
  paymentMethod: "CARD",
  paymentStatus: "PAID",
  createdAt: new Date(),
};

const ai = (orders: any[] = [JUST_EAT_CANCELLED]) => {
  const a: any = Object.create(VoiceAiService.prototype);
  a.logger = { log() {}, warn() {}, error() {} };
  a.prisma = { order: { findMany: async () => orders } };
  return a;
};
const ctx: any = { locationId: "loc1", tenantId: "t1", currency: "GBP" };

describe("a cancelled Just Eat order", () => {
  it("is found by the reference the customer reads off the app", async () => {
    const said = await ai().orderStatus(ctx, "+447700900123", "948451885");
    expect(said).toMatch(/Order 948451885/);
    expect(said).toMatch(/Status CANCELLED/);
  });

  it("is found when they read the digits one at a time", async () => {
    // Which is how a nine-digit number is always read down a phone.
    const said = await ai().orderStatus(ctx, "+447700900123", "nine four eight four five one eight eight five");
    expect(said).toMatch(/Order 948451885/);
  });

  it("tells the caller it was cancelled, and who refunds it", async () => {
    const said = await ai().orderStatus(ctx, "+447700900123", "948451885");
    expect(said).toMatch(/Just Eat order has been cancelled/);
    expect(said).toMatch(/Just Eat handle the refund/);
    // The sentence that sent a caller to the shop knowing nothing.
    expect(said).not.toMatch(/problem with that order/);
  });

  it("offers a person rather than transferring without being asked", async () => {
    const said = await ai().orderStatus(ctx, "+447700900123", "948451885");
    expect(said).toMatch(/Then offer transfer_to_staff/);
    expect(said).toMatch(/if you'd like a word/);
  });
});

describe("which fulfillment types count as a delivery", () => {
  const jetCancelled = (fulfillmentType: string) =>
    spokenOrderStatus({ status: "CANCELLED", fulfillmentType, source: "JUST_EAT" });

  it("names the platform however the order was being fulfilled", () => {
    // A collection order is cancelled exactly the way a delivery is, and the
    // platform refunds both.
    for (const type of ["DELIVERY", "MERCHANT_DELIVERY", "PLATFORM_COURIER", "PICKUP"]) {
      expect(jetCancelled(type).say).toMatch(/Just Eat order has been cancelled/);
      expect(jetCancelled(type).transfer).toBe(true);
    }
  });

  it("does not claim the platform's driver when the shop drives it itself", () => {
    // MERCHANT_DELIVERY is the shop's own driver on a marketplace order.
    // "It's waiting for their driver" points the caller at Just Eat about a
    // van the shop is driving.
    const ours = spokenOrderStatus({
      status: "READY",
      fulfillmentType: "MERCHANT_DELIVERY",
      source: "JUST_EAT",
    });
    expect(ours.say).toMatch(/Just Eat order/);
    expect(ours.say).toMatch(/we're getting a driver to it/);
    expect(ours.say).not.toMatch(/their driver/);

    const theirs = spokenOrderStatus({
      status: "READY",
      fulfillmentType: "DELIVERY",
      source: "JUST_EAT",
    });
    expect(theirs.say).toMatch(/waiting for their driver/);
  });
});

describe("a cancelled order the shop took itself", () => {
  it("says it was cancelled instead of calling it a problem", () => {
    const out = spokenOrderStatus({ status: "CANCELLED", fulfillmentType: "DELIVERY", source: "VOICE" });
    expect(out.say).toMatch(/That order has been cancelled/);
    expect(out.say).not.toMatch(/problem with that order/);
    // Still a person's job to say why — the line never guesses at a reason.
    expect(out.say).toMatch(/tell you what happened/);
    expect(out.transfer).toBe(true);
  });
});
