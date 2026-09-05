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

describe("postcode-first address capture", () => {
  const lookup = async () => [
    { line1: "11 Follingsby Drive", city: "Gateshead" },
    { line1: "13 Follingsby Drive", city: "Gateshead" },
  ];
  const empty = async () => [];

  it("asks for the postcode alone, not a whole address", async () => {
    // Asking for the lot in one breath asks the transcriber to spell a street
    // it has never heard of. A postcode is six characters from a fixed
    // alphabet, and the street can be looked up from it.
    const state = withItem();
    const out = svc().fulfillmentAloud(ctx(), state, "DELIVERY");
    expect(out.say).toContain("postcode");
    expect(out.say).not.toContain("Follingsby");
    expect(out.next).toBe("ADDR_POSTCODE");
  });

  it("reads the street back off a spelled-out postcode", async () => {
    // "N E 10 8 Y H" is how a postcode actually arrives.
    const state = withItem();
    const out = await svc().postcodeAloud(ctx(), state, "N E 10 8 Y H", lookup);
    expect(out.say).toContain("Follingsby Drive");
    expect(out.say).toContain("Gateshead");
    expect(out.next).toBe("ADDR_STREET");
    expect(state.addr?.postcode).toBe("NE10 8YH");
  });

  it("asks again when it did not hear a postcode", async () => {
    const state = withItem();
    const out = await svc().postcodeAloud(ctx(), state, "erm hang on", lookup);
    expect(out.next).toBe("ADDR_POSTCODE");
    expect(state.confusion).toBe(1);
  });

  it("falls back to asking for the street when the lookup finds nothing", async () => {
    // A new build, or an outage. Neither is a reason to stop taking dinner.
    const state = withItem();
    const out = await svc().postcodeAloud(ctx(), state, "NE10 8YH", empty);
    expect(out.say).toContain("street");
    expect(out.next).toBe("ADDR_HOUSE");
  });

  it("survives the lookup throwing", async () => {
    const state = withItem();
    const out = await svc().postcodeAloud(ctx(), state, "NE10 8YH", async () => {
      throw new Error("places down");
    });
    expect(out.say).toContain("street");
  });

  it("only asks for the number once the street is agreed", () => {
    expect(svc().streetAgreedAloud().next).toBe("ADDR_HOUSE");
    expect(svc().streetAgreedAloud().say).toContain("house number");
  });

  it("hands the street back to the caller when the lookup was wrong", () => {
    // Asking for the postcode again asks for the thing they already got right.
    // They know their own street; the database evidently does not.
    const state = withItem();
    state.addr = { postcode: "NE10 8YH", street: "Wrong Street" };
    const out = svc().streetRejectedAloud(state);
    expect(out.next).toBe("ADDR_HOUSE");
    expect(out.say).toMatch(/street name and house number/i);
    // The postcode they gave is kept — only the wrong street is dropped.
    expect(state.addr.postcode).toBe("NE10 8YH");
    expect(state.addr.street).toBeUndefined();
  });

  it("builds the whole address and reads all of it back", async () => {
    const state = withItem();
    await svc().postcodeAloud(ctx(), state, "NE10 8YH", lookup);
    const out = svc().houseNumberAloud(ctx(), state, "eleven");

    expect(state.cart.deliveryAddress.line1).toBe("11 Follingsby Drive");
    expect(state.cart.deliveryAddress.postcode).toBe("NE10 8YH");
    // The read-back is the WHOLE thing — it's the only version the caller has
    // heard end to end.
    expect(out.say).toContain("11 Follingsby Drive");
    expect(out.say).toContain("N E 1 0");
    expect(out.next).toBe("ADDRESS_CONFIRM");
    expect(state.addressConfirmed).toBe(false);
  });

  it("takes a house name as readily as a number", async () => {
    const state = withItem();
    await svc().postcodeAloud(ctx(), state, "NE10 8YH", lookup);
    svc().houseNumberAloud(ctx(), state, "Rose Cottage");
    expect(state.cart.deliveryAddress.line1).toBe("Rose Cottage Follingsby Drive");
  });

  it("asks again when the house number did not come through", async () => {
    const state = withItem();
    await svc().postcodeAloud(ctx(), state, "NE10 8YH", lookup);
    const out = svc().houseNumberAloud(ctx(), state, "");
    expect(out.next).toBe("ADDR_HOUSE");
  });
});

describe("the prompt cannot ask for a whole address", () => {
  const prompt = () =>
    svc().systemPrompt(
      { ...ctx(), items: [], openingHours: null, timezone: "Europe/London" },
      { turns: [], cart: { items: [] } } as any,
    );

  it("never tells the model to ask for an address in one go", () => {
    // This is where it kept coming back from. The scripted flow was changed to
    // postcode-first, but the prompt still carried the old sentence, so any
    // turn the model drove asked for the lot — and the caller heard the thing
    // that was supposed to have been removed.
    const p = prompt();
    expect(p).not.toMatch(/address, including the postcode/i);
    expect(p).not.toMatch(/take your address/i);
  });

  it("teaches the postcode-first order explicitly", () => {
    const p = prompt();
    expect(p).toMatch(/POSTCODE FIRST/i);
    expect(p).toMatch(/What's your postcode/i);
    expect(p).toMatch(/lookup_postcode/);
    // And the rule that follows from it: never ask twice for the one thing
    // they already got right.
    expect(p).toMatch(/[Nn]ever ask for the postcode a second time/);
  });

  it("gives the model the same lookup the scripted flow uses", () => {
    const names = svc()
      .toolDefs(ctx())
      .map((t: any) => t.name);
    expect(names).toContain("lookup_postcode");
  });
});

describe("lookup_postcode", () => {
  const withLookup = (suggestions: any[], pastDeliveries: any[] = []) => {
    const s = svc();
    s.addresses = { searchByPostcode: async () => ({ suggestions }) };
    s.prisma = { order: { findMany: async () => pastDeliveries } };
    return s;
  };

  // This shop delivers to NE37 — which is what lets a mis-heard letter be
  // repaired rather than accepted.
  const ne37 = () =>
    ctx({
      deliveryZones: [
        {
          id: "z1",
          postcodePrefix: "NE37",
          areaName: null,
          maxDistanceMiles: null,
          fee: 2.5,
          minOrderValue: null,
        },
      ],
    });

  it("finds the postcode inside a whole spoken address", async () => {
    // Real transcript: "Five sounding dead drive, n a three seven two l l."
    // "N E" came back as "n a", which parses as NA37 2LL — a real postcode in
    // a different county. The shop's own zones are what settle it.
    const state: any = { cart: { items: [] } };
    const out = await withLookup([
      { line1: "5 Sunningdale Drive", city: "Washington" },
    ]).lookupPostcode("Five sounding dead drive, n a three seven two l l.", ne37(), state);

    expect(out).toContain("Sunningdale Drive");
    expect(state.addr.postcode).toBe("NE37 2LL");
  });

  it("answers from the shop's own deliveries before it touches the network", async () => {
    // The failure this exists to prevent: overpass-api.de is not reachable
    // from Render at all, so on a live call the lookup came back with nothing
    // and the caller was asked to say a street the shop delivers to weekly.
    const state: any = { cart: { items: [] } };
    const s = svc();
    s.prisma = {
      order: {
        findMany: async () => [
          { addressLine1: "11 Sunningdale Drive", city: "Washington" },
          { addressLine1: "5 Sunningdale Drive", city: "Washington" },
          { addressLine1: "2 Ferndale Avenue", city: "Washington" },
        ],
      },
    };
    // If this is ever reached the point of the test is lost.
    s.addresses = {
      searchByPostcode: async () => {
        throw new Error("the network must not be asked for a postcode we know");
      },
    };

    const out = await s.lookupPostcode("N E three seven two l l.", ne37(), state);

    expect(out).toContain("Sunningdale Drive");
    expect(state.addr.street).toBe("Sunningdale Drive");
  });

  it("prefers the street it has delivered to most on a split postcode", async () => {
    const state: any = { cart: { items: [] } };
    const out = await withLookup(
      [],
      [
        { addressLine1: "2 Ferndale Avenue", city: "Washington" },
        { addressLine1: "11 Sunningdale Drive", city: "Washington" },
        { addressLine1: "5 Sunningdale Drive", city: "Washington" },
      ],
    ).lookupPostcode("N E three seven two l l.", ne37(), state);

    expect(state.addr.street).toBe("Sunningdale Drive");
    expect(out).toContain("Sunningdale Drive");
  });

  it("still goes out to the network for a postcode it has never delivered to", async () => {
    const state: any = { cart: { items: [] } };
    const out = await withLookup(
      [{ line1: "5 Sunningdale Drive", city: "Washington" }],
      [],
    ).lookupPostcode("N E three seven two l l.", ne37(), state);

    expect(out).toContain("Sunningdale Drive");
  });

  it("survives the history query falling over", async () => {
    const state: any = { cart: { items: [] } };
    const s = svc();
    s.prisma = {
      order: {
        findMany: async () => {
          throw new Error("db went away");
        },
      },
    };
    s.addresses = {
      searchByPostcode: async () => ({
        suggestions: [{ line1: "5 Sunningdale Drive", city: "Washington" }],
      }),
    };

    const out = await s.lookupPostcode("N E three seven two l l.", ne37(), state);
    expect(out).toContain("Sunningdale Drive");
  });

  it("does not relocate someone who really is out of area", async () => {
    // A London postcode said clearly must come back as itself, so the caller
    // hears "we don't deliver there" rather than being quietly moved.
    const state: any = { cart: { items: [] } };
    await withLookup([]).lookupPostcode("S W 1 A 1 A A", ne37(), state);
    expect(state.addr.postcode).toBe("SW1A 1AA");
  });

  it("tells the model not to ask for the postcode again when no street comes back", async () => {
    const state: any = { cart: { items: [] } };
    const out = await withLookup([]).lookupPostcode("NE37 2LL", ne37(), state);
    expect(out).toMatch(/street name and house number/i);
    expect(out).toMatch(/do NOT ask for the postcode again/i);
    expect(state.addr.postcode).toBe("NE37 2LL");
  });

  it("asks for the postcode on its own when there wasn't one", async () => {
    const state: any = { cart: { items: [] } };
    const out = await withLookup([]).lookupPostcode("erm hang on", ctx(), state);
    expect(out).toMatch(/didn't contain a postcode/i);
  });
});

describe("a lookup that only knows the town", () => {
  // The postcode chain's last resort returns the town with an EMPTY line1 —
  // "NE37 2LL, Washington — add street". Reading position zero blindly treated
  // that as "no street came back", even when a real street was behind it.
  const townFirst = [
    { line1: "", city: "Washington" },
    { line1: "5 Sunningdale Drive", city: "Washington" },
  ];

  it("looks past a town-only row to a real street", async () => {
    const state = withItem();
    const out = await svc().postcodeAloud(ctx(), state, "NE10 8YH", async () => townFirst);
    expect(out.say).toContain("Sunningdale Drive");
    expect(out.next).toBe("ADDR_STREET");
  });

  it("asks for the street when the town is genuinely all there is", async () => {
    const state = withItem();
    const out = await svc().postcodeAloud(ctx(), state, "NE10 8YH", async () => [
      { line1: "", city: "Washington" },
    ]);
    expect(out.say).toMatch(/street/i);
    expect(out.next).toBe("ADDR_HOUSE");
  });

  it("does not wait longer than a caller will", async () => {
    // A live call spent 5.7s here because nothing bounded the geocoders.
    const state = withItem();
    const started = Date.now();
    const out = await svc().postcodeAloud(
      ctx(),
      state,
      "NE10 8YH",
      () => new Promise(() => {}),
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.say).toMatch(/street/i);
  });
});
