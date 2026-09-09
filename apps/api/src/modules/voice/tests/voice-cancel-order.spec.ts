// "I want to cancel my order."
//
// The phone line does not cancel orders, and cancel_order does not either.
// It exists so the answer comes from the ORDER rather than from whatever the
// model believes about it, because the two right answers are opposites and
// the wrong one costs real money.
//
// A marketplace order belongs to Just Eat, or Uber, or Deliveroo. The refund
// and the customer relationship both live there, the shop cannot cancel it,
// and a caller told anything else rings back angry an hour later.
//
// Anything of ours is cancelled by a person. Money has usually moved and the
// kitchen may have started, and that is not a decision for a machine ninety
// seconds into a call.

import { VoiceAiService } from "../voice-ai.service";

const ORDER = {
  id: "ord1",
  displayId: "SIM-A60X",
  orderNumber: 4012,
  collectionCode: null,
  status: "PREPARING",
  fulfillmentType: "DELIVERY",
  customerPhone: "+447700900123",
  paymentMethod: "CARD",
  paymentStatus: "PAID",
  items: [],
  createdAt: new Date(),
};

const ctx = (transferNumber: string | null = "0191 231 2345"): any => ({
  tenantId: "t1",
  locationId: "loc1",
  currency: "GBP",
  items: [],
  itemIndex: new Map(),
  optionIndex: new Map(),
  deliveryZones: [],
  transferNumber,
});

const ai = (order: any) => {
  const a: any = Object.create(VoiceAiService.prototype);
  a.logger = { log() {}, warn() {}, error() {} };
  a.orders = { editOrder: jest.fn() };
  a.db = () => ({
    order: {
      findMany: async () => (order ? [order] : []),
      findFirst: async () => order ?? null,
    },
  });
  return a;
};
const state = (): any => ({ cart: { items: [] }, turns: [] });
const call = (a: any, c: any, input: any = {}, from: string | null = "+447700900123") =>
  a.runToolForConversation("cancel_order", input, c, state(), from);

describe("cancelling a marketplace order", () => {
  for (const [source, name] of [
    ["JUST_EAT", "Just Eat"],
    ["UBER_EATS", "Uber Eats"],
    ["DELIVEROO", "Deliveroo"],
    // Lowercase on purpose: that is how talabat writes its own name, and the
    // customer-facing table spells every platform the way the platform does.
    ["TALABAT", "talabat"],
    ["CAREEM", "Careem"],
  ] as const) {
    it(`sends a ${name} order back to ${name}, and never to a person`, async () => {
      const a = ai({ ...ORDER, orderSource: source });
      const out = await call(a, ctx(), { orderNumber: "SIM-A60X" });

      expect(out.result).toMatch(new RegExp(`ONLY ${name} can cancel it`));
      expect(out.result).toMatch(new RegExp(`placed through ${name}, so it has to be cancelled there`));
      expect(out.result).toMatch(new RegExp(`Open the ${name} app`));
      // Never a transfer: a member of staff cannot cancel it either.
      expect(out.turn).toBeUndefined();
      expect(out.result).toMatch(/Do not offer to put them through/);
    });
  }
});

describe("cancelling one of our own orders", () => {
  for (const source of ["POS", "VOICE", "DIRECT", "ONLINE"]) {
    it(`puts a ${source} order through to a member of staff`, async () => {
      const a = ai({ ...ORDER, orderSource: source });
      const out = await call(a, ctx());

      expect(out.result).toMatch(/Only a member of staff can cancel that/);
      expect(out.result).toMatch(/do NOT say it has been cancelled/);
      expect(out.turn?.transferTo).toBe("+441912312345");
      expect(out.turn?.outcome).toBe("TRANSFERRED");
    });
  }

  it("takes a message when there is no number to put them through to", async () => {
    const a = ai({ ...ORDER, orderSource: "POS" });
    const out = await call(a, ctx(null));
    expect(out.result).toMatch(/no number to put them through to/);
    expect(out.result).toMatch(/take a message/);
    expect(out.turn).toBeUndefined();
  });
});

describe("the rule the tool exists to enforce", () => {
  it("never cancels anything, whatever the order is", async () => {
    for (const source of ["JUST_EAT", "POS", "VOICE", "DELIVEROO"]) {
      const a = ai({ ...ORDER, orderSource: source });
      await call(a, ctx(), { orderNumber: "SIM-A60X" });
      expect(a.orders.editOrder).not.toHaveBeenCalled();
    }
  });

  it("asks for a number when it cannot find the order, and still names the platforms", async () => {
    const a = ai(null);
    const out = await call(a, ctx(), {}, null);
    expect(out.result).toMatch(/No order found/);
    expect(out.result).toMatch(/Just Eat, Uber Eats, Deliveroo, Talabat or Careem/);
    expect(out.turn).toBeUndefined();
  });

  it("is offered as a tool, and described as something that cancels nothing", () => {
    const a = ai(null);
    const tool = a.toolsForConversation(ctx()).find((t: any) => t.name === "cancel_order");
    expect(tool.description).toMatch(/never cancels anything/);
    expect(tool.description).toMatch(/you cannot cancel an order and must never say you have/);
  });

  it("the prompt says the same, in the same two halves", () => {
    const a = ai(null);
    const prompt = a.promptForConversation(ctx(), state(), null);
    expect(prompt).toMatch(/You cannot cancel an order and must never say you have/);
    expect(prompt).toMatch(/Just Eat, Uber Eats, Deliveroo, Talabat or Careem is cancelled on that app and nowhere else/);
    expect(prompt).toMatch(/needs a member of staff, so put them through/);
  });
});
