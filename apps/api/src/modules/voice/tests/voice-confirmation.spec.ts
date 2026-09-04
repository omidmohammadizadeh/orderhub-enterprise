import { VoiceAiService, coerceState, emptyState } from "../voice-ai.service";

// The two locks on place_order.
//
// The system prompt has always ASKED for both read-backs. A prompt is a
// request, and these are the two failures that get an AI phone line switched
// off for good: food nobody ordered, and a driver at the wrong door. So they
// are enforced in code, where the model cannot talk its way past them.
//
// Private methods reached through the prototype — the constructor pulls in
// Anthropic, Stripe and the orders pipeline, none of which these touch.

const svc = () => Object.create(VoiceAiService.prototype) as any;

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    tenantId: "t1",
    locationId: "l1",
    locationName: "Pizza Uno",
    country: "GB",
    currency: "GBP",
    deliveryZones: [
      {
        id: "z1",
        postcodePrefix: "NE10",
        areaName: null,
        maxDistanceMiles: null,
        fee: 2.5,
        minOrderValue: null,
      },
    ],
    deliveryPrepMinutes: 45,
    collectionPrepMinutes: 20,
    address: { city: "Gateshead" },
    ...over,
  }) as any;

const withItem = (over: Partial<any> = {}) => {
  const state = emptyState() as any;
  state.stage = "ORDER";
  state.cart.items = [
    {
      lineId: "a1",
      itemId: "i1",
      name: "Large Pepperoni",
      quantity: 2,
      unitBasePrice: 12,
      modifiers: [],
    },
  ];
  return Object.assign(state, over);
};

describe("place_order gates", () => {
  it("refuses to place an order that was never read back", async () => {
    const out = await svc().placeOrder(
      { customerName: "Omid", paymentMethod: "CASH" },
      ctx(),
      withItem({ cart: { ...withItem().cart, fulfillmentType: "PICKUP" } }),
      "+447700900123",
    );
    expect(out.result).toContain("not read the order back");
    expect(out.turn).toBeUndefined();
  });

  it("refuses a delivery whose address was never confirmed aloud", async () => {
    const state = withItem({ orderConfirmed: true });
    state.cart.fulfillmentType = "DELIVERY";
    state.cart.deliveryAddress = {
      line1: "11 Follingsby Drive",
      city: "Gateshead",
      postcode: "NE10 8YH",
      country: "GB",
    };
    state.addressConfirmed = false;

    const out = await svc().placeOrder(
      { customerName: "Omid", paymentMethod: "CASH" },
      ctx(),
      state,
      "+447700900123",
    );
    expect(out.result).toContain("read back and confirmed");
  });

  it("refuses an empty order before either lock is even considered", async () => {
    const out = await svc().placeOrder(
      { customerName: "Omid", paymentMethod: "CASH" },
      ctx(),
      emptyState(),
      "+447700900123",
    );
    expect(out.result).toContain("empty");
  });

  it("never places the same order twice on a re-ask", async () => {
    const out = await svc().placeOrder(
      { customerName: "Omid", paymentMethod: "CASH" },
      ctx(),
      withItem({ orderId: "already-placed", orderConfirmed: true }),
      "+447700900123",
    );
    expect(out.result).toContain("Already placed");
  });
});

describe("spokenAddress", () => {
  it("spaces the postcode out so a speech engine says the letters", () => {
    // "NE10 8YH" read as one word is unintelligible, and the whole point of
    // the read-back is that the caller can check it.
    const out = svc().spokenAddress({
      line1: "11 Follingsby Drive",
      city: "Gateshead",
      postcode: "NE10 8YH",
    });
    expect(out).toContain("11 Follingsby Drive");
    expect(out).toContain("N E 1 0");
    expect(out).not.toContain("NE10");
  });

  it("copes with an address that has no postcode at all", () => {
    // Gulf shops deliver by named community; there is no postcode to read.
    const out = svc().spokenAddress({ line1: "Marina Tower 3", area: "Dubai Marina" });
    expect(out).toBe("Marina Tower 3, Dubai Marina");
  });
});

describe("readBackScript", () => {
  const money = (s: string) => expect(s);

  it("reads every line, the delivery charge and the real total", () => {
    const state = withItem();
    state.cart.fulfillmentType = "DELIVERY";
    state.cart.deliveryAddress = {
      line1: "11 Follingsby Drive",
      city: "Gateshead",
      postcode: "NE10 8YH",
      country: "GB",
    };
    const out = svc().readBackScript(ctx(), state);
    expect(out).toContain("2 Large Pepperoni");
    expect(out).toContain("11 Follingsby Drive");
    expect(out).toContain("2.50"); // the zone fee, not a guess
    expect(out).toContain("26.50"); // 2 × 12 + 2.50
    expect(out).toContain("Is that all correct?");
  });

  it("does not invent a delivery charge on a collection order", () => {
    const state = withItem();
    state.cart.fulfillmentType = "PICKUP";
    const out = svc().readBackScript(ctx(), state);
    expect(out).toContain("for collection");
    expect(out).not.toContain("delivery");
    expect(out).toContain("24.00");
  });
});

describe("coerceState", () => {
  it("resumes a call that was mid-order when this deployed", () => {
    // Calls in flight have no stage on their stored transcript. Sending them
    // back to a menu they have already answered would be worse than useless.
    expect(coerceState({ turns: [], cart: {} }).stage).toBe("ORDER");
  });

  it("starts a fresh call at the menu", () => {
    expect(emptyState().stage).toBe("MENU");
  });

  it("does not inherit a confirmation from a malformed transcript", () => {
    const s = coerceState({ turns: [], cart: {}, orderConfirmed: "yes" });
    expect(s.orderConfirmed).toBe(false);
  });
});
