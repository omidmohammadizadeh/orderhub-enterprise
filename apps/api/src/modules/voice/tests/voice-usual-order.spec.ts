// "Same as last time?" — what the big voice-AI vendors do, and the single
// biggest thing this line can do for the people who ring it most.
//
// Most takeaway calls are a regular ordering the same thing. Every one of
// those is currently a conversation the transcriber can lose: an accent, a
// menu word nova-3 has never seen, half a sentence dropped. One question with
// a one-word answer cannot be misheard, and it turns a three-minute struggle
// into fifteen seconds.
//
// It is also the most dangerous thing here, which is why half these tests are
// about what it must REFUSE to offer. Reading last week's order down the phone
// to whoever dialled — with their address on the end of it — is a data breach
// wearing a friendly voice.

import { VoiceService } from "../voice.service";
import { VoiceAiService } from "../voice-ai.service";

const MENU = [
  { id: "pep", name: "PEPPERONI", price: 7.8, categoryName: "PIZZA", modifierGroups: [] },
  { id: "chp", name: "CHIPS", price: 2.5, categoryName: "SUNDRIES", modifierGroups: [] },
  { id: "gb", name: "GARLIC BREAD", price: 4, categoryName: "GARLIC BREADS", modifierGroups: [] },
];

const ai = () => {
  const a: any = Object.create(VoiceAiService.prototype);
  a.logger = { log() {}, warn() {}, error() {} };
  return a;
};
const ctx = () => {
  const c: any = { currency: "GBP", items: MENU, locationId: "loc1", deliveryZones: [] };
  c.itemIndex = new Map(MENU.map((i: any) => [i.id, i]));
  c.optionIndex = new Map();
  return c;
};
const state = () => ({ cart: { items: [] }, turns: [] }) as any;

const LAST = {
  fulfillmentType: "DELIVERY",
  deliveryAddress: { line1: "5 Sunningdale Drive", city: "Washington", postcode: "NE37 2LL" },
  items: [
    { menuItemId: "pep", name: "PEPPERONI", quantity: 1, notes: null },
    { menuItemId: "chp", name: "CHIPS", quantity: 2, notes: null },
  ],
};

describe("offering the usual", () => {
  it("says the whole order back in one sentence", () => {
    const st = state();
    const out = ai().usualAloud(ctx(), st, LAST);

    expect(out.say).toBe(
      "Would you like the same as last time — PEPPERONI and 2 CHIPS, delivered to 5 Sunningdale Drive?",
    );
    expect(out.next).toBe("USUAL");
  });

  it("loads the basket so a yes is the only thing left to say", () => {
    const st = state();
    ai().usualAloud(ctx(), st, LAST);

    expect(st.cart.items.map((l: any) => `${l.quantity}× ${l.name}`)).toEqual([
      "1× PEPPERONI",
      "2× CHIPS",
    ]);
    expect(st.cart.fulfillmentType).toBe("DELIVERY");
    expect(st.cart.fulfillmentChosen).toBe(true);
    expect(st.cart.deliveryAddress.postcode).toBe("NE37 2LL");
  });

  it("says collection when that is what they had", () => {
    const st = state();
    const out = ai().usualAloud(ctx(), st, { ...LAST, fulfillmentType: "PICKUP" });
    expect(out.say).toMatch(/, for collection\?$/);
    expect(st.cart.fulfillmentType).toBe("PICKUP");
  });

  it("finds the dish again after the shop renamed it", () => {
    // Matched by id first, so a rename does not lose the line.
    const st = state();
    const c = ctx();
    c.itemIndex.set("pep", { ...MENU[0], name: "PEPPERONI CLASSIC" });
    const out = ai().usualAloud(c, st, {
      ...LAST,
      items: [{ menuItemId: "pep", name: "PEPPERONI", quantity: 1 }],
    });
    expect(out.say).toContain("PEPPERONI CLASSIC");
  });

  it("matches by name for an order taken on the till", () => {
    // A POS or website order may carry no menuItemId this line recognises.
    const st = state();
    const out = ai().usualAloud(ctx(), st, {
      ...LAST,
      items: [{ menuItemId: null, name: "garlic bread", quantity: 1 }],
    });
    expect(out.say).toContain("GARLIC BREAD");
  });
});

describe("what it must not offer", () => {
  it("never offers food the shop has stopped selling", () => {
    // Offering last month's menu at last month's price is worse than not
    // offering at all — the caller says yes to something that cannot be made.
    const st = state();
    const out = ai().usualAloud(ctx(), st, {
      ...LAST,
      items: [
        { menuItemId: "pep", name: "PEPPERONI", quantity: 1 },
        { menuItemId: "gone", name: "DISCONTINUED SPECIAL", quantity: 1 },
      ],
    });
    expect(out.say).toContain("PEPPERONI");
    expect(out.say).toMatch(/We're not doing DISCONTINUED SPECIAL any more/);
    expect(st.cart.items).toHaveLength(1);
  });

  it("says nothing at all when most of the order has gone", () => {
    // One item off a three-item order is not "the usual", and reading half of
    // it back invites a yes to something they never had.
    const st = state();
    const out = ai().usualAloud(ctx(), st, {
      ...LAST,
      items: [
        { menuItemId: "pep", name: "PEPPERONI", quantity: 1 },
        { menuItemId: "x", name: "GONE ONE", quantity: 1 },
        { menuItemId: "y", name: "GONE TWO", quantity: 1 },
      ],
    });
    expect(out).toBeNull();
    expect(st.cart.items).toHaveLength(0);
  });

  it("offers nothing when there is nothing to offer", () => {
    expect(ai().usualAloud(ctx(), state(), { ...LAST, items: [] })).toBeNull();
  });
});

describe("the caller's answer", () => {
  const svc = () => {
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.ai = ai();
    s.save = async () => {};
    s.db = () => ({ voiceCall: { update: async () => ({}) } });
    const st = state();
    s.ai.usualAloud(ctx(), st, LAST);
    st.awaiting = "USUAL";
    st.stage = "ORDER";
    return { s, st };
  };

  it("goes straight to the price when they say yes", async () => {
    // They have heard the food. What they have NOT heard is the total, and
    // nothing is placed without a read-back — the usual is no exception.
    const { s, st } = svc();
    const turn = await s.answerSlot({ id: "c1" }, ctx(), st, "yes please");

    expect(turn.say).toMatch(/^So that's PEPPERONI, then 2 CHIPS, for delivery to/);
    expect(turn.say).toMatch(/comes to £12\.80/);
    expect(turn.say).toMatch(/Is that all correct\?$/);
    expect(st.awaiting).toBe("ORDER_CONFIRM");
    expect(st.orderConfirmed).toBe(false);
  });

  it("puts everything back when they say no", async () => {
    // A caller who said no must not end up with last week's dinner attached
    // to this week's order.
    const { s, st } = svc();
    const turn = await s.answerSlot({ id: "c1" }, ctx(), st, "no");

    expect(turn.say).toMatch(/collection or delivery/i);
    expect(st.cart.items).toHaveLength(0);
    expect(st.cart.fulfillmentChosen).toBe(false);
    expect(st.cart.deliveryAddress).toBeUndefined();
    expect(st.awaiting).toBe("FULFILLMENT");
  });

  it("hands anything that is not yes or no to the model", async () => {
    // "Actually can I swap the chips" is a conversation, not an answer.
    const { s, st } = svc();
    expect(await s.answerSlot({ id: "c1" }, ctx(), st, "can I change the chips")).toBeNull();
  });
});

describe("whose order it is allowed to remember", () => {
  // The most dangerous thing on this line. Reading last week's order down the
  // phone to whoever dialled — with their address on the end of it — is a data
  // breach wearing a friendly voice.

  const ORDERS = [
    {
      id: "o-voice",
      displayId: "4012",
      orderNumber: 4012,
      orderSource: "VOICE",
      customerPhone: "+447700900123",
      status: "COMPLETED",
      fulfillmentType: "DELIVERY",
      deliveryAddress: { line1: "5 Sunningdale Drive" },
      items: [{ menuItemId: "pep", name: "PEPPERONI", quantity: 1, notes: null }],
      createdAt: new Date(),
    },
    {
      id: "o-uber",
      displayId: "BA6ED",
      orderNumber: 991,
      orderSource: "UBER_EATS",
      // A marketplace proxy number: shared between strangers, by design.
      customerPhone: "+441388436844 PIN 989 19 055",
      status: "COMPLETED",
      fulfillmentType: "DELIVERY",
      deliveryAddress: { line1: "14 Green Acres" },
      items: [{ menuItemId: "chp", name: "CHIPS", quantity: 1, notes: null }],
      createdAt: new Date(),
    },
  ];

  const look = async (from: string | null, rows = ORDERS) => {
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.prisma = {
      order: {
        findMany: async ({ where }: any) => {
          const wanted = String(where?.customerPhone?.contains ?? "");
          const sources: string[] = where?.orderSource?.in ?? [];
          return rows.filter(
            (o) =>
              sources.includes(o.orderSource) &&
              wanted &&
              (o.customerPhone ?? "").includes(wanted),
          );
        },
      },
    };
    return s.lastOrderFor({ locationId: "loc1" }, from);
  };

  it("remembers an order they placed with this shop", async () => {
    const last = await look("+447700900123");
    expect(last?.reference).toBe("4012");
    expect(last?.items).toHaveLength(1);
  });

  it("NEVER remembers a marketplace order", async () => {
    // Uber Eats and Deliveroo store a SHARED proxy number — one Deliveroo line
    // was two different customers in an evening. "Your usual" off one of those
    // reads a stranger's dinner, and their address, to whoever rang.
    expect(await look("+441388436844")).toBeNull();
  });

  it("asks the database for the shop's own channels only", async () => {
    // Belt and braces: the marketplace order must not even be fetched, so a
    // future change to the filtering below cannot leak one.
    let asked: any = null;
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.prisma = {
      order: {
        findMany: async (args: any) => {
          asked = args.where;
          return [];
        },
      },
    };
    await s.lastOrderFor({ locationId: "loc1" }, "+447700900123");

    expect(asked.orderSource.in).toEqual(["VOICE", "POS", "ONLINE", "DIRECT"]);
    expect(asked.locationId).toBe("loc1");
    expect(asked.status.notIn).toContain("CANCELLED");
    expect(asked.createdAt.gte).toBeInstanceOf(Date);
  });

  it("offers nothing to a withheld number", async () => {
    expect(await look(null)).toBeNull();
    expect(await look("")).toBeNull();
  });

  it("never lets a lookup failure cost the call", async () => {
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn: jest.fn(), error() {} };
    s.prisma = { order: { findMany: async () => { throw new Error("database gone"); } } };

    expect(await s.lastOrderFor({ locationId: "loc1" }, "+447700900123")).toBeNull();
    expect(s.logger.warn).toHaveBeenCalled();
  });

  it("forgets an order older than three months", async () => {
    // Their tastes change, the menu changes, and "the usual" from March is not
    // a usual any more.
    let since: Date | null = null;
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.prisma = {
      order: {
        findMany: async (args: any) => {
          since = args.where.createdAt.gte;
          return [];
        },
      },
    };
    await s.lastOrderFor({ locationId: "loc1" }, "+447700900123");
    const days = (Date.now() - (since as any as Date).getTime()) / 86400000;
    expect(days).toBeGreaterThan(80);
    expect(days).toBeLessThan(100);
  });
});

describe("the same offer on the speech-to-speech engine", () => {
  // A regular ringing back must not get a worse call because of which engine
  // happened to answer. The two differ in how they HEAR; never in what they
  // can do for a caller.

  const svcWith = (rows: any[]) => {
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.ai = ai();
    s.save = jest.fn(async () => {});
    s.prisma = {
      order: {
        findMany: async ({ where }: any) => {
          const wanted = String(where?.customerPhone?.contains ?? "");
          return rows.filter((o) => wanted && (o.customerPhone ?? "").includes(wanted));
        },
      },
    };
    return s;
  };
  const ROW = {
    id: "o1",
    displayId: "4012",
    orderNumber: 4012,
    orderSource: "VOICE",
    customerPhone: "+447700900123",
    fulfillmentType: "DELIVERY",
    deliveryAddress: { line1: "5 Sunningdale Drive" },
    items: [{ menuItemId: "pep", name: "PEPPERONI", quantity: 1, notes: null }],
  };

  it("is given to the model word for word, so a yes cannot be misheard", () => {
    const p = ai().promptForRealtime(
      ctx(),
      state(),
      "Would you like the same as last time — PEPPERONI, delivered to 5 Sunningdale Drive?",
    );
    expect(p).toMatch(/THEY HAVE ORDERED HERE BEFORE/);
    expect(p).toContain(
      'word for\n  word: "Would you like the same as last time — PEPPERONI, delivered to 5 Sunningdale Drive?"',
    );
    expect(p).toMatch(/call use_usual and then read_back_order/);
    // And it must not then ask for things the old order already answers.
    expect(p).toMatch(/not collection or delivery, not the address/);
  });

  it("says nothing about a usual when there isn't one", () => {
    expect(ai().promptForRealtime(ctx(), state())).not.toMatch(/ORDERED HERE BEFORE/);
  });

  it("offers use_usual as a tool", () => {
    const names = ai().toolsForRealtime(ctx()).map((t: any) => t.name);
    expect(names).toContain("use_usual");
  });

  it("fills the basket when the caller says yes", async () => {
    const s = svcWith([ROW]);
    const st = state();
    s.loadByControlId = async () => ({
      call: { id: "c1", fromNumber: "+447700900123" },
      ctx: ctx(),
      state: st,
    });

    // With a yes, because a yes is now required — see voice-consent.spec.ts.
    const out = await s.realtimeTool("cc1", "use_usual", {
      __heard: "yes please",
      __heardFresh: true,
    });

    expect(out.result).toMatch(/Their usual is in the basket: 1 × PEPPERONI/);
    expect(out.result).toMatch(/call read_back_order/);
    expect(st.cart.items).toHaveLength(1);
    expect(st.cart.fulfillmentType).toBe("DELIVERY");
    expect(st.cart.deliveryAddress.line1).toBe("5 Sunningdale Drive");
    // Written down, because the next tool call reads it back off the database.
    expect(s.save).toHaveBeenCalled();
  });

  it("looks it up again rather than trusting the session", async () => {
    // Everything stashed on the state at session time is dropped by the parser
    // that reads it back between turns. Two indexed queries is a cheap price
    // for not depending on that.
    const s = svcWith([]);
    s.loadByControlId = async () => ({
      call: { id: "c1", fromNumber: "+447700900123" },
      ctx: ctx(),
      state: state(),
    });

    const out = await s.realtimeTool("cc1", "use_usual", {
      __heard: "yes",
      __heardFresh: true,
    });
    expect(out.result).toMatch(/no previous order to reuse/);
    expect(out.result).toMatch(/collection or delivery/);
  });

  it("will not reuse a marketplace order here either", async () => {
    const s = svcWith([{ ...ROW, orderSource: "UBER_EATS", customerPhone: "+441388436844 PIN 1" }]);
    s.loadByControlId = async () => ({
      call: { id: "c1", fromNumber: "+441388436844" },
      ctx: ctx(),
      state: state(),
    });
    expect(
      (await s.realtimeTool("cc1", "use_usual", { __heard: "yes", __heardFresh: true })).result,
    ).toMatch(/no previous order/);
  });
});
