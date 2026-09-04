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

describe("read-backs speak themselves", () => {
  it("returns the address read-back as bare speech, not an instruction", async () => {
    // Handing the words to the model so it can repeat them costs a SECOND
    // round trip — about 2.5s of the caller listening to nothing on a real
    // call — and lets it paraphrase the one sentence that must be verbatim.
    const state = withItem();
    const out = await svc().runTool(
      "propose_delivery_address",
      { line1: "11 Follingsby Drive", city: "Gateshead", postcode: "NE10 8YH" },
      ctx(),
      state,
      "+447700900123",
    );
    expect(out.sayNow).toBe(
      "So that's 11 Follingsby Drive, Gateshead, N E 1 0, 8 Y H. Is that correct?",
    );
    expect(out.sayNow).not.toContain("word for word");
    expect(state.addressConfirmed).toBe(false);
  });

  it("repairs a postcode the transcriber clipped, using the shop's zones", async () => {
    // Live call: the caller said "NE10 8YH", the transcript said "E10, 8YH".
    const state = withItem();
    await svc().runTool(
      "propose_delivery_address",
      { line1: "11 Follingsby Drive", postcode: "E10 8YH" },
      ctx(),
      state,
      "+447700900123",
    );
    expect(state.cart.deliveryAddress.postcode).toBe("NE10 8YH");
  });

  it("keeps what it heard when no single zone fits", async () => {
    const state = withItem();
    await svc().runTool(
      "propose_delivery_address",
      { line1: "1 Nowhere Road", postcode: "ZZ99 9ZZ" },
      ctx(),
      state,
      "+447700900123",
    );
    // Not invented, not silently corrected — the caller gets asked again.
    expect(state.cart.deliveryAddress.postcode).toBe("ZZ99 9ZZ");
  });

  it("returns the order read-back as bare speech", async () => {
    const state = withItem();
    state.cart.fulfillmentType = "PICKUP";
    const out = await svc().runTool("read_back_order", {}, ctx(), state, null);
    expect(out.sayNow).toContain("2 Large Pepperoni");
    expect(out.sayNow).toContain("Is that all correct?");
    expect(out.sayNow).not.toContain("Say this");
  });
});

describe("never giving up", () => {
  it("refuses to hand over just because it misheard", async () => {
    // The prompt used to say "transfer if you have misheard them twice in a
    // row", and with transfers failing that became: apologise, hang up. A
    // caller who rang a shop that did not answer, then got cut off by the
    // thing that did, has been failed twice.
    const state = withItem();
    const out = await svc().runTool(
      "transfer_to_staff",
      { reason: "I misheard the address twice" },
      ctx({ transferNumber: "+441912312345" }),
      state,
      null,
    );
    expect(out.turn?.transferTo).toBeUndefined();
    expect(out.result).toContain("DIFFERENT words");
    expect(state.confusion).toBe(1);
  });

  it("always hands over when the caller actually asked for a person", async () => {
    const state = withItem({ askedForHuman: true });
    const out = await svc().runTool(
      "transfer_to_staff",
      { reason: "cannot understand them" },
      ctx({ transferNumber: "+441912312345" }),
      state,
      null,
    );
    expect(out.turn?.transferTo).toBe("+441912312345");
  });

  it("gives up eventually rather than looping forever", async () => {
    const state = withItem({ confusion: 3 });
    const out = await svc().runTool(
      "transfer_to_staff",
      { reason: "misheard repeatedly" },
      ctx({ transferNumber: "+441912312345" }),
      state,
      null,
    );
    expect(out.turn?.transferTo).toBe("+441912312345");
  });

  it("hands over immediately for a reason that is not mishearing", async () => {
    const out = await svc().runTool(
      "transfer_to_staff",
      { reason: "caller is complaining about a previous order" },
      ctx({ transferNumber: "+441912312345" }),
      withItem(),
      null,
    );
    expect(out.turn?.transferTo).toBe("+441912312345");
  });

  it("will not hang up on a basket nobody has placed", async () => {
    // Someone spent that call choosing food.
    const out = await svc().runTool("end_call", {}, ctx(), withItem(), null);
    expect(out.turn?.endCall).toBeUndefined();
    expect(out.result).toContain("Do not hang up");
  });

  it("hangs up happily once the order is in", async () => {
    const out = await svc().runTool(
      "end_call",
      {},
      ctx(),
      withItem({ orderId: "placed" }),
      null,
    );
    expect(out.turn?.endCall).toBe(true);
  });

  it("offers a way out when the address is out of area", async () => {
    const state = withItem();
    state.cart.fulfillmentType = "DELIVERY";
    state.cart.deliveryAddress = { line1: "1 Far Away", postcode: "ZZ99 9ZZ" };
    const say = await svc().confirmAddressAloud(ctx(), state);
    expect(say).toContain("collection");
    expect(say).toContain("another address");
  });
});

describe("get_order_status", () => {
  it("looks the order up as a number, not a string", async () => {
    // Order.orderNumber is an Int. Prisma does not coerce a string here, it
    // throws — and the caller who had just read out their number heard an
    // apology instead of their order.
    const svcWithDb = () => {
      const s = svc();
      s.db = () => ({
        order: {
          findFirst: jest.fn().mockImplementation((args: any) => {
            captured = args;
            return Promise.resolve(null);
          }),
        },
      });
      return s;
    };
    let captured: any;
    await svcWithDb().orderStatus(ctx(), "+447700900123", "24");
    expect(captured.where.orderNumber).toBe(24);
    expect(typeof captured.where.orderNumber).toBe("number");
  });

  it("asks again rather than throwing on something that isn't a number", async () => {
    const s = svc();
    s.db = () => ({ order: { findFirst: jest.fn() } });
    const out = await s.orderStatus(ctx(), "+447700900123", "the big one");
    expect(out).toContain("read it out again");
  });
});

describe("phoneReallyMatches", () => {
  // Reached through the prototype like the rest — this one lives on
  // VoiceService, but the hazard it guards belongs with the order-status work.
  const { VoiceService } = require("../voice.service");
  const vs = () => Object.create(VoiceService.prototype) as any;

  it("matches a caller against their own number", () => {
    expect(vs().phoneReallyMatches("+447700900123", "447700900123")).toBe(true);
    expect(vs().phoneReallyMatches("07700900123", "447700900123")).toBe(true);
  });

  it("will not match a caller against a stored PIN", () => {
    // Marketplace orders store "442033195035 PIN 962535892". A `contains`
    // match on the last nine digits of a caller's number can land on the PIN
    // instead of the phone, which would read a stranger's order out loud.
    expect(vs().phoneReallyMatches("442033195035 PIN 962535892", "962535892")).toBe(
      false,
    );
  });

  it("still matches the phone half of a proxy-plus-PIN string", () => {
    expect(
      vs().phoneReallyMatches("+447533006408 PIN 096959189", "447533006408"),
    ).toBe(true);
  });

  it("refuses when either side is missing", () => {
    expect(vs().phoneReallyMatches(null, "447700900123")).toBe(false);
    expect(vs().phoneReallyMatches("+447700900123", "")).toBe(false);
  });
});

describe("amending an existing order", () => {
  const withExisting = () => {
    const state = withItem();
    state.cart.items = [];
    svc().loadOrderForAmend(state, {
      id: "order-1",
      reference: "24kiod",
      fulfillmentType: "DELIVERY",
      items: [{ name: "Large Pepperoni", quantity: 2, unitPrice: 12 }],
    });
    return state;
  };

  it("brings the whole existing order across, not just the additions", () => {
    // editOrder replaces the item list wholesale — send only the new items
    // and the customer loses the food they actually ordered.
    const state = withExisting();
    expect(state.cart.items).toHaveLength(1);
    expect(state.cart.items[0].name).toBe("Large Pepperoni");
    expect(state.cart.items[0].quantity).toBe(2);
    expect(state.amendOrderId).toBe("order-1");
  });

  it("does not inherit a confirmation from the original order", () => {
    // The caller has to hear the WHOLE order back again, including what they
    // just added.
    expect(withExisting().orderConfirmed).toBe(false);
  });

  it("refuses to place a new order while changing one", () => {
    // Placing here would leave the caller with two: the one they rang about
    // and a duplicate carrying the extras.
    const state = withExisting();
    state.orderConfirmed = true;
    return svc()
      .runTool(
        "place_order",
        { customerName: "Omid", paymentMethod: "CASH" },
        ctx(),
        state,
        "+447700900123",
      )
      .then((out: any) => {
        expect(out.result).toContain("amend_order");
        expect(out.turn?.orderId).toBeUndefined();
      });
  });

  it("refuses to amend without the read-back", async () => {
    const state = withExisting();
    const out = await svc().runTool("amend_order", {}, ctx(), state, null);
    expect(out.result).toContain("read the whole order back");
  });

  it("refuses to amend when there is no order being changed", async () => {
    const out = await svc().runTool("amend_order", {}, ctx(), withItem(), null);
    expect(out.result).toContain("no existing order");
  });

  it("sends the combined order to editOrder and clears the amendment", async () => {
    const state = withExisting();
    state.orderConfirmed = true;
    state.cart.items.push({
      lineId: "new1",
      itemId: "i2",
      name: "Garlic Bread",
      quantity: 1,
      unitBasePrice: 4,
      modifiers: [],
    });

    const s = svc();
    let sent: any;
    s.orders = {
      editOrder: jest.fn(async (_id: string, _t: string, dto: any) => {
        sent = dto;
        return {};
      }),
    };
    const out = await s.runTool("amend_order", {}, ctx(), state, null);

    expect(sent.items.map((i: any) => i.name)).toEqual([
      "Large Pepperoni",
      "Garlic Bread",
    ]);
    expect(sent.subtotal).toBe(28);
    expect(out.turn?.orderId).toBe("order-1");
    expect(state.amendOrderId).toBeUndefined();
  });

  it("explains and hands over when the order can no longer be changed", async () => {
    const state = withExisting();
    state.orderConfirmed = true;
    const s = svc();
    s.logger = { warn: jest.fn(), error: jest.fn() };
    s.orders = {
      editOrder: jest.fn(async () => {
        throw new Error("Order can only be edited before it's marked Ready");
      }),
    };
    const out = await s.runTool(
      "amend_order",
      {},
      ctx({ transferNumber: "+441912312345" }),
      state,
      null,
    );
    expect(out.result).toContain("marked Ready");
    expect(out.turn?.transferTo).toBe("+441912312345");
  });
});
