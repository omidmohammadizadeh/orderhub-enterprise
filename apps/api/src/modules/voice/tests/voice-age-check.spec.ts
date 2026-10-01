import { VoiceAiService, emptyState } from "../voice-ai.service";

// Challenge 25 on the phone line. An age-restricted product (MenuItem.minAge)
// can't be placed until the caller says they're old enough; asked once after
// the read-back, enforced in placeOrder where the model can't talk past it,
// and stamped on the order so the hand-over checks ID.

const svc = () => {
  const s = Object.create(VoiceAiService.prototype) as any;
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return s;
};

const ctx = () =>
  ({
    tenantId: "t1",
    locationId: "l1",
    locationName: "Corner Grocer",
    country: "GB",
    currency: "GBP",
    deliveryZones: [],
    deliveryPrepMinutes: 45,
    collectionPrepMinutes: 20,
    address: { city: "Leeds" },
    itemIndex: new Map<string, any>([
      ["lager", { id: "lager", name: "Stella 4 x 440ml", price: 6, minAge: 18, modifierGroups: [] }],
      ["crisps", { id: "crisps", name: "Walkers", price: 1, minAge: null, modifierGroups: [] }],
    ]),
  }) as any;

const confirmedBasket = (s: any) => {
  const state = emptyState() as any;
  state.stage = "ORDER";
  state.cart.fulfillmentType = "PICKUP";
  state.cart.fulfillmentChosen = true;
  state.cart.items = [
    { lineId: "a", itemId: "lager", name: "Stella 4 x 440ml", quantity: 1, unitBasePrice: 6, modifiers: [] },
    { lineId: "b", itemId: "crisps", name: "Walkers", quantity: 2, unitBasePrice: 1, modifiers: [] },
  ];
  state.orderConfirmed = true;
  state.orderConfirmedOf = s.orderFingerprint(state);
  state.readBackOf = state.orderConfirmedOf;
  return state;
};

describe("age check on the phone line", () => {
  it("place_order refuses until the caller has confirmed their age", async () => {
    const s = svc();
    const state = confirmedBasket(s);
    const out = await s.placeOrder({ customerName: "Sam", paymentMethod: "CASH" }, ctx(), state, null);
    expect(out.result).toMatch(/AGE CHECK NEEDED/);
    expect(out.result).toMatch(/18 or over/);
    expect(state.orderId).toBeUndefined();
  });

  it("the yes to the read-back asks for age before payment", async () => {
    const s = svc();
    const out = await s.runTool("order_confirmed", { __heard: "yes that's right", __heardFresh: true }, ctx(), confirmedBasket(s), null);
    expect(out.result).toMatch(/^Confirmed\. Before payment, an age check/);
  });

  it("confirm_age yes records it; no takes the restricted items out", async () => {
    const s = svc();
    const yes = confirmedBasket(s);
    expect((await s.runTool("confirm_age", { confirmed: true }, ctx(), yes, null)).result).toMatch(/Age confirmed/);
    expect(yes.cart.ageConfirmed).toBe(18);

    const no = confirmedBasket(s);
    const out = await s.runTool("confirm_age", { confirmed: false }, ctx(), no, null);
    expect(out.result).toMatch(/Removed Stella/);
    expect(no.cart.items.map((l: any) => l.itemId)).toEqual(["crisps"]);
    expect(no.orderConfirmed).toBe(false);
  });

  it("in code: yes goes to payment, no re-reads what's left", () => {
    const s = svc();
    s.readBackScript = () => "So that's two Walkers. Is that all correct?";
    const a = confirmedBasket(s);
    expect(s.afterOrderConfirmedAloud(ctx(), a)).toMatchObject({ next: "AGE" });
    expect(s.answerAgeAloud(ctx(), a, true)).toMatchObject({ next: "PAYMENT" });
    expect(s.afterOrderConfirmedAloud(ctx(), a)).toMatchObject({ next: "PAYMENT" });

    const b = confirmedBasket(s);
    const out = s.answerAgeAloud(ctx(), b, false);
    expect(out.say).toMatch(/taken off Stella/);
    expect(out.next).toBe("ORDER_CONFIRM");
  });

  it("a basket with nothing restricted is never asked", () => {
    const s = svc();
    const state = confirmedBasket(s);
    state.cart.items = state.cart.items.filter((l: any) => l.itemId === "crisps");
    expect(s.ageStillNeeded(ctx(), state)).toBeNull();
    expect(s.afterOrderConfirmedAloud(ctx(), state)).toMatchObject({ next: "PAYMENT" });
  });

  it("once confirmed, the order goes in with the ID CHECK note and the age record", async () => {
    const s = svc();
    let sent: any;
    s.orders = {
      create: jest.fn(async (dto: any) => {
        sent = dto;
        return { id: "o1", orderNumber: 7, displayId: "PH-7", total: 8 };
      }),
    };
    s.db = () => ({ voiceCall: { updateMany: jest.fn(), update: jest.fn() }, order: { findFirst: async () => null } });
    const state = confirmedBasket(s);
    state.cart.ageConfirmed = 18;
    await s.placeOrder({ customerName: "Sam", paymentMethod: "CASH" }, ctx(), state, "+447700900123");
    expect(sent.specialInstructions).toMatch(/^ID CHECK 18\+ — Challenge 25/);
    expect(sent.specialInstructions).toMatch(/TAKEN BY AI PHONE LINE/);
    expect(sent.ageCheck).toEqual({ minAge: 18, method: "CUSTOMER_CONFIRMED" });
  });
});
