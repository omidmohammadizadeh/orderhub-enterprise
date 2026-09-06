// "Where's my order?" — option 2, driven end to end.
//
// The second most common reason anybody rings a takeaway, and the one where
// getting it wrong is worst: reading the wrong order out loud tells a stranger
// what somebody else is having for dinner and where it is going. So the tests
// that matter here are as much about what it REFUSES to say as what it says.
//
// Every order number below is one a caller actually has to read down a phone:
// #4012 from this line, #BA6ED off an Uber Eats confirmation, #SIM-I2DC from
// Just Eat.

import { VoiceService } from "../voice.service";

const HOUR = 60 * 60 * 1000;

const ORDERS = [
  {
    id: "cmtq0001voiceorder",
    displayId: "4012",
    orderNumber: 4012,
    collectionCode: null,
    status: "PREPARING",
    fulfillmentType: "DELIVERY",
    estimatedReadyAt: new Date(Date.now() + 25 * 60 * 1000),
    customerPhone: "+447700900123",
    orderSource: "VOICE",
    courierName: null,
    courierEtaAt: null,
    createdAt: new Date(),
  },
  {
    id: "cmtq0002ubereats",
    displayId: "BA6ED",
    orderNumber: 991,
    collectionCode: "BA6ED",
    status: "OUT_FOR_DELIVERY",
    fulfillmentType: "DELIVERY",
    estimatedReadyAt: null,
    // A marketplace proxy number: shared between strangers, by design.
    customerPhone: "+441388436844 PIN 989 19 055",
    orderSource: "UBER_EATS",
    courierName: "Deliveroo Rider",
    courierEtaAt: new Date(Date.now() + 12 * 60 * 1000),
    createdAt: new Date(),
  },
  {
    id: "cmtq0003collection",
    displayId: "Y5BJH",
    orderNumber: 77,
    collectionCode: null,
    status: "READY",
    fulfillmentType: "PICKUP",
    estimatedReadyAt: null,
    customerPhone: "+447700900456",
    orderSource: "POS",
    courierName: null,
    courierEtaAt: null,
    createdAt: new Date(),
  },
];

const svc = (opts: { from?: string | null } = {}) => {
  const saved: any[] = [];
  const s: any = Object.create(VoiceService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  s.prisma = {
    order: {
      findMany: async () => ORDERS,
      findFirst: async ({ where }: any) => {
        const wanted = String(where?.customerPhone?.contains ?? "");
        return (
          ORDERS.find((o) => wanted && (o.customerPhone ?? "").includes(wanted)) ?? null
        );
      },
    },
    voiceCall: { update: async () => ({}) },
  };
  s.save = async (_id: string, st: any) => saved.push(JSON.parse(JSON.stringify(st)));
  s.handOver = async (_c: any, _x: any, _st: any, say: string) => ({ say, transferTo: "+44191" });
  const call = { id: "call1", fromNumber: opts.from ?? "+447700900123" };
  const ctx = { locationId: "loc1", tenantId: "t1", currency: "GBP" };
  const state: any = { stage: "STATUS", cart: { items: [] }, turns: [], confusion: 0 };
  return {
    ask: (said: string) => s.answerOrderStatus(call, ctx, state, said),
    state,
    saved,
  };
};

describe("giving the order number", () => {
  it("finds it from digits read out one at a time", async () => {
    // Which is how everybody reads a number down a phone.
    const { ask } = svc();
    const turn = await ask("four zero one two");
    expect(turn.say).toMatch(/Order 4, 0, 1, 2\./);
    expect(turn.say).toMatch(/being made now/i);
    expect(turn.say).toMatch(/about 25 minutes/);
    expect(turn.outcome).toBe("ORDER_STATUS");
  });

  it("finds it when they just say the number", async () => {
    expect((await svc().ask("4012")).say).toMatch(/Order 4, 0, 1, 2/);
  });

  it("finds a marketplace reference off the customer's confirmation", async () => {
    const turn = await svc({ from: "+447700900999" }).ask("B A six E D");
    expect(turn.say).toMatch(/Uber Eats/);
    expect(turn.say).toMatch(/with the driver now/);
  });

  it("reads back the reference THEY gave, not another number off the row", async () => {
    // The suffix match is forgiving on purpose, so the read-back is what
    // catches it having found the wrong order — the caller hears it against
    // whatever is in front of them.
    const turn = await svc({ from: "+447700900456" }).ask("Y five B J H");
    expect(turn.say).toMatch(/Order Y, 5, B, J, H\./);
    expect(turn.say).toMatch(/ready/i);
  });

  it("does not read out a marketplace driver's placeholder name", async () => {
    // Deliveroo sends the literal string "Deliveroo Rider" when it is
    // withholding the real name. Reading that out sounds like we don't know
    // either — which is true, and not worth saying.
    const turn = await svc({ from: "+447700900999" }).ask("BA6ED");
    expect(turn.say).not.toMatch(/Rider is bringing/i);
    expect(turn.say).toMatch(/about 12 minutes/);
  });
});

describe("when the number does not land", () => {
  it("asks for it a character at a time rather than giving up", async () => {
    // A number misheard by one digit is the likeliest explanation, and this is
    // the question that fixes it.
    const s = svc({ from: "+447700900999" });
    const turn = await s.ask("nine nine nine nine");
    expect(turn.say).toMatch(/one character at a time/);
    expect(s.state.stage).toBe("STATUS");
    expect(s.state.confusion).toBe(1);
  });

  it("hands over rather than asking a fourth time", async () => {
    const s = svc({ from: "+447700900999" });
    await s.ask("nine nine nine nine");
    await s.ask("eight eight eight eight");
    const third = await s.ask("seven seven seven seven");
    expect(third.say).toMatch(/put you through to the shop/);
    expect(third.transferTo).toBeTruthy();
  });

  it("does not let a recited phone number blow up the lookup", async () => {
    // Order numbers are per-tenant Ints. A caller reading their mobile out
    // would overflow the column and 500 the turn.
    const turn = await svc({ from: "+447700900999" }).ask("oh seven seven zero zero nine zero zero one two three");
    expect(turn.say).toMatch(/one character at a time|can't find/i);
  });
});

describe("the number they are ringing from", () => {
  it("finds their own order when they have no reference to hand", async () => {
    const turn = await svc({ from: "+447700900123" }).ask("I don't know, I haven't got it");
    expect(turn.say).toMatch(/Order 4, 0, 1, 2/);
  });

  it("NEVER reaches a marketplace order that way", async () => {
    // Marketplace orders store a SHARED proxy number — one Deliveroo line was
    // two different customers in an evening. Matching on it would read a
    // stranger's dinner, and their address, out to whoever rang.
    const turn = await svc({ from: "+441388436844" }).ask("I don't have the number");
    expect(turn.say).not.toMatch(/Uber Eats/);
    expect(turn.say).toMatch(/one character at a time/);
  });
});

describe("what the caller is actually told", () => {
  const say = async (from: string, said: string) => (await svc({ from }).ask(said)).say;

  it("gives a collection order's caller something they can act on", async () => {
    expect(await say("+447700900456", "seven seven")).toMatch(/ready/i);
  });

  it("sends a marketplace cancellation to the people who can refund it", async () => {
    const { spokenOrderStatus } = require("../voice-flow");
    const out = spokenOrderStatus({
      status: "CANCELLED",
      fulfillmentType: "DELIVERY",
      source: "UBER_EATS",
    });
    expect(out.say).toMatch(/Uber Eats handle the refund/);
    expect(out.transfer).toBe(true);
  });

  it("ends by offering to do something else, so the call can continue", async () => {
    const s = svc();
    const turn = await s.ask("four zero one two");
    expect(turn.say).toMatch(/anything else I can help with\?$/);
    // And the caller can go straight on to order something.
    expect(s.state.stage).toBe("ORDER");
  });
});

describe("what the transcriber does to an order number", () => {
  // Nobody says "four zero one two" cleanly down a phone line. These are the
  // shapes a real transcript takes, and each one is a caller who otherwise
  // gets asked to repeat themselves.
  const found = async (said: string) => (await svc().ask(said)).say;

  it("understands the homophones", async () => {
    expect(await found("for zero one two")).toMatch(/Order 4, 0, 1, 2/);
    expect(await found("four oh one two")).toMatch(/Order 4, 0, 1, 2/);
    expect(await found("four o one two")).toMatch(/Order 4, 0, 1, 2/);
  });

  it("understands it run together or spaced out", async () => {
    expect(await found("40 12")).toMatch(/Order 4, 0, 1, 2/);
    expect(await found("its four thousand and twelve")).toMatch(/Order 4, 0, 1, 2/);
    expect(await found("order number 4012 please")).toMatch(/Order 4, 0, 1, 2/);
  });

  it("understands a hash in front of it", async () => {
    expect(await found("#4012")).toMatch(/Order 4, 0, 1, 2/);
  });
});

describe("an order nobody has paid for yet", () => {
  // Card orders sit at PENDING until Stripe confirms, so the kitchen never
  // cooks food nobody has paid for. The caller rings up an hour later
  // wondering where it is.
  const { spokenOrderStatus } = require("../voice-flow");

  it("points them at the link instead of at the shop", async () => {
    // "The shop hasn't confirmed it yet" sends them to people who can do
    // nothing about it. The answer is already on their phone.
    const out = spokenOrderStatus({
      status: "PENDING",
      fulfillmentType: "DELIVERY",
      awaitingPayment: true,
    });
    expect(out.say).toMatch(/hasn't been paid for yet/);
    expect(out.say).toMatch(/payment link in the text/);
    expect(out.transfer).toBeFalsy();
  });

  it("still says the shop has not confirmed it when that is the truth", async () => {
    const out = spokenOrderStatus({ status: "PENDING", fulfillmentType: "DELIVERY" });
    expect(out.say).toMatch(/haven't confirmed it yet/);
  });

  it("says nothing about payment once it has been paid", async () => {
    const out = spokenOrderStatus({
      status: "PREPARING",
      fulfillmentType: "DELIVERY",
      awaitingPayment: false,
    });
    expect(out.say).toMatch(/being made now/);
  });
});
