// Option 3 — changing an order that has already been placed.
//
// The riskiest of the three, because unlike the other two this one WRITES. An
// order that has been paid for, or that belongs to Uber Eats, or that the
// kitchen has already made, must not be edited by a phone line — and the ways
// of getting that wrong are all silent: the caller is told it is done, and the
// shop finds out when the food goes out wrong.
//
// editOrder REPLACES the item list, so everything already on the order has to
// come across into the cart. Miss that and "add a coke" delivers a coke and
// nothing else.

import { VoiceService } from "../voice.service";
import { VoiceAiService } from "../voice-ai.service";

const ORDER = {
  id: "cmtqamend0001",
  displayId: "4012",
  orderNumber: 4012,
  collectionCode: null,
  orderSource: "VOICE",
  status: "PREPARING",
  fulfillmentType: "DELIVERY",
  items: [
    { name: "PEPPERONI", quantity: 1, unitPrice: 7.8, notes: null },
    { name: "GARLIC BREAD", quantity: 2, unitPrice: 4, notes: "well done" },
  ],
  createdAt: new Date(),
};

const svc = (over: Partial<typeof ORDER> = {}) => {
  const order = { ...ORDER, ...over };
  const handovers: string[] = [];
  const s: any = Object.create(VoiceService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  s.ai = Object.create(VoiceAiService.prototype);
  s.ai.logger = s.logger;
  s.prisma = {
    order: { findMany: async () => [order] },
    voiceCall: { update: async () => ({}) },
  };
  s.save = async () => {};
  s.handOver = async (_c: any, _x: any, _st: any, say: string) => {
    handovers.push(say);
    return { say, transferTo: "+44191" };
  };
  const state: any = { stage: "AMEND", cart: { items: [] }, turns: [], confusion: 0 };
  return {
    ask: (said: string) =>
      s.answerAmendLookup({ id: "c1", fromNumber: "+447700900123" }, { locationId: "loc1", tenantId: "t1" }, state, said),
    state,
    handovers,
  };
};

describe("finding the order to change", () => {
  it("brings the whole order across, not just what they add to it", async () => {
    // editOrder REPLACES the item list. An order that arrives here with an
    // empty cart is an order about to lose everything on it.
    const s = svc();
    const turn = await s.ask("four zero one two");

    expect(turn.say).toMatch(/order 4, 0, 1, 2/i);
    expect(turn.say).toMatch(/What would you like to add\?/);
    expect(s.state.amendOrderId).toBe("cmtqamend0001");
    expect(s.state.cart.items.map((i: any) => `${i.quantity}× ${i.name}`)).toEqual([
      "1× PEPPERONI",
      "2× GARLIC BREAD",
    ]);
    // Including the note the kitchen was given the first time.
    expect(s.state.cart.items[1].notes).toBe("well done");
  });

  it("keeps the delivery it was placed as", async () => {
    const s = svc();
    await s.ask("4012");
    expect(s.state.cart.fulfillmentType).toBe("DELIVERY");
    expect(s.state.cart.fulfillmentChosen).toBe(true);
  });

  it("makes them read the whole thing back again before it saves", async () => {
    // The addition is not the order. What goes to the kitchen is the whole
    // ticket, so the whole ticket is what gets agreed to.
    const s = svc();
    await s.ask("4012");
    expect(s.state.orderConfirmed).toBe(false);
  });

  it("hands the ordering brain the same tools it always has", async () => {
    const s = svc();
    await s.ask("4012");
    expect(s.state.stage).toBe("ORDER");
  });
});

describe("orders this line must not change", () => {
  it("refuses a marketplace order and says whose it is", async () => {
    // Uber Eats owns the basket, the payment and the refund. Editing our copy
    // would put a ticket in the kitchen that Uber Eats has never heard of.
    const s = svc({ orderSource: "UBER_EATS" });
    await s.ask("4012");
    expect(s.handovers[0]).toMatch(/Uber Eats/);
  });

  it("refuses one placed on the shop's own website", async () => {
    // The caller placed it themselves through a basket with its own refund
    // path. A person should handle that change.
    const s = svc({ orderSource: "ONLINE" });
    await s.ask("4012");
    expect(s.handovers).toHaveLength(1);
  });

  it("refuses one the kitchen has already finished", async () => {
    // Saying yes and failing at the end is worse than saying no now: the
    // caller has spent the call believing their change landed.
    const s = svc({ status: "READY" });
    await s.ask("4012");
    expect(s.handovers[0]).toMatch(/already been made up/);
    expect(s.state.amendOrderId).toBeUndefined();
  });

  it("refuses one that is out with a driver", async () => {
    const s = svc({ status: "OUT_FOR_DELIVERY" });
    await s.ask("4012");
    expect(s.handovers[0]).toMatch(/already been made up/);
  });

  it("allows the stages where the kitchen can still take a change", async () => {
    for (const status of ["PENDING", "ACCEPTED", "PREPARING"]) {
      const s = svc({ status });
      await s.ask("4012");
      expect(s.state.amendOrderId).toBe("cmtqamend0001");
    }
  });
});

describe("when the number is wrong", () => {
  it("asks again rather than ending the call", async () => {
    const s = svc();
    const turn = await s.ask("nine nine nine nine");
    expect(turn.say).toMatch(/one character at a time/);
    expect(s.state.stage).toBe("AMEND");
  });

  it("hands over after three", async () => {
    const s = svc();
    await s.ask("nine nine nine");
    await s.ask("eight eight eight");
    await s.ask("seven seven seven");
    expect(s.handovers.at(-1)).toMatch(/still can't find that order/);
  });
});

describe("saving the change", () => {
  const ai = (state: any, editOrder: any, transferNumber: string | null = "+441912312345") => {
    const a: any = Object.create(VoiceAiService.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    a.orders = { editOrder };
    return a.amendOrder(
      { tenantId: "t1", locationId: "loc1", currency: "GBP", deliveryZones: [], transferNumber },
      state,
    );
  };
  const loaded = () => {
    const a: any = Object.create(VoiceAiService.prototype);
    const st: any = { cart: { items: [] }, turns: [] };
    a.loadOrderForAmend(st, {
      id: "cmtqamend0001",
      reference: "4012",
      fulfillmentType: "DELIVERY",
      items: ORDER.items,
    });
    return st;
  };

  it("refuses to save until the whole order has been read back", async () => {
    const st = loaded();
    const edit = jest.fn();
    const out = await ai(st, edit);
    expect(out.result).toMatch(/not read the whole order back/);
    expect(edit).not.toHaveBeenCalled();
  });

  it("sends the existing lines AND the new one", async () => {
    const st = loaded();
    st.orderConfirmed = true;
    st.cart.items.push({
      lineId: "x",
      itemId: "coke",
      name: "CAN COKE",
      quantity: 1,
      unitBasePrice: 1.2,
      modifiers: [],
    });
    const edit = jest.fn().mockResolvedValue({});
    const out = await ai(st, edit);

    const [id, tenant, payload, who] = edit.mock.calls[0];
    expect(id).toBe("cmtqamend0001");
    expect(tenant).toBe("t1");
    expect(payload.items.map((i: any) => i.name)).toEqual([
      "PEPPERONI",
      "GARLIC BREAD",
      "CAN COKE",
    ]);
    expect(payload.total).toBeCloseTo(7.8 + 8 + 1.2, 2);
    // The audit trail should say the phone line did this, not a member of staff.
    expect(who).toBe("voice-ai");
    expect(out.turn?.orderId).toBe("cmtqamend0001");
  });

  it("tells the caller the truth when the kitchen refuses it", async () => {
    // editOrder says no for good reasons — past Ready, already paid by card.
    // Say what it said rather than inventing an explanation, and get them a
    // person, because from here only a person can help.
    const st = loaded();
    st.orderConfirmed = true;
    const out = await ai(st, jest.fn().mockRejectedValue(new Error("Order already paid")));

    expect(out.result).toMatch(/Order already paid/);
    expect(out.turn?.transferTo).toBe("+441912312345");
    expect(out.turn?.outcome).toBe("TRANSFERRED");
  });

  it("does not promise a transfer to a shop that has no number", async () => {
    // "Let me put you through" and then nothing leaves the caller on a line
    // that has stopped talking to them — and marks the call TRANSFERRED on the
    // dashboard, so nobody ever finds out it happened.
    const st = loaded();
    st.orderConfirmed = true;
    const out = await ai(st, jest.fn().mockRejectedValue(new Error("Order already paid")), null);

    expect(out.result).toMatch(/do NOT offer to/);
    expect(out.result).toMatch(/leave a message/);
    expect(out.turn?.transferTo).toBeUndefined();
    expect(out.turn?.outcome).toBeUndefined();
  });

  it("cannot be run twice on the same order", async () => {
    const st = loaded();
    st.orderConfirmed = true;
    const edit = jest.fn().mockResolvedValue({});
    await ai(st, edit);
    const second = await ai(st, edit);

    expect(edit).toHaveBeenCalledTimes(1);
    expect(second.result).toMatch(/no existing order being changed/);
  });
});
