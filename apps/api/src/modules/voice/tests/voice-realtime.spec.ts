// The second engine, and the promise that makes it safe to try.
//
// Speech-to-speech is here to be COMPARED with the chained pipeline on the
// same menu and the same callers — it hears better, and there is less to
// inspect when it is wrong. What must never differ is what the two engines are
// ALLOWED to do: both go through the same tools, so place_order still refuses
// without a read-back and an address outside the delivery area is still
// refused. These hold that line.

import { VoiceAiService } from "../voice-ai.service";

const ctx = () =>
  ({
    tenantId: "t1",
    locationId: "l1",
    locationName: "Pizza Uno",
    country: "GB",
    currency: "GBP",
    address: { city: "Washington", postcode: "NE37 1AA" },
    deliveryZones: [{ id: "z1", postcodePrefix: "NE37", fee: 2.5 }],
    deliveryPrepMinutes: 45,
    collectionPrepMinutes: 20,
    acceptsCash: true,
    acceptsCard: true,
    items: [{ id: "gb", name: "Garlic Bread", price: 4, categoryName: "Sides", modifierGroups: [] }],
    itemIndex: new Map(),
    optionIndex: new Map(),
  }) as any;

const svc = () => {
  const s: any = Object.create(VoiceAiService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  return s;
};

const state = () => ({ cart: { items: [] }, turns: [], stage: "ORDER" }) as any;

describe("the tools the speech-to-speech engine gets", () => {
  it("are the same tools, in the shape that API wants", () => {
    const chained = svc().toolDefs(ctx());
    const realtime = svc().toolsForRealtime(ctx());

    expect(realtime).toHaveLength(chained.length);
    expect(realtime.map((t: any) => t.name).sort()).toEqual(
      chained.map((t: any) => t.name).sort(),
    );
    for (const tool of realtime) {
      expect(tool.type).toBe("function");
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeTruthy();
    }
  });

  it("includes the ones that refuse things", () => {
    const names = svc().toolsForRealtime(ctx()).map((t: any) => t.name);
    expect(names).toContain("place_order");
    expect(names).toContain("read_back_order");
    expect(names).toContain("confirm_delivery_address");
  });

  it("runs them through the same executor, so the same refusals apply", async () => {
    // place_order without a read-back is the single most important refusal on
    // the line. It must not become a matter of persuasion just because the
    // model is listening to audio.
    const s = svc();
    const st = state();
    st.cart.items = [{ lineId: "a", itemId: "gb", name: "Garlic Bread", quantity: 1, unitBasePrice: 4, modifiers: [] }];
    st.cart.fulfillmentType = "PICKUP";
    st.cart.fulfillmentChosen = true;
    st.orderConfirmed = false;

    const out = await s.runToolForRealtime("place_order", { paymentMethod: "CASH" }, ctx(), st, null);

    expect(out.result).toMatch(/read.?back|confirm/i);
    expect(st.orderId).toBeUndefined();
  });
});

describe("what the speech-to-speech engine is told", () => {
  const prompt = () => svc().promptForRealtime(ctx(), state());

  it("carries the whole ordinary prompt", () => {
    // Everything the chained engine is told about this shop, it is told too.
    expect(prompt()).toContain(svc().systemPrompt(ctx(), state()));
  });

  it("is told it is speaking, not writing", () => {
    const p = prompt();
    expect(p).toMatch(/YOU ARE SPEAKING, NOT WRITING/);
    // The failures that are specific to being read aloud.
    expect(p).toMatch(/eight pounds/);
    expect(p).toMatch(/fourteen inch/);
  });

  it("is told to check what it thinks it heard", () => {
    // Its advantage is hearing a mumbled dish name. Its risk is being sure
    // about one.
    expect(prompt()).toMatch(/read(ing)? it back, never by\s+assuming/);
  });

  it("is told not to make them repeat a whole order", () => {
    expect(prompt()).toMatch(/[Nn]ever ask them\s+to repeat a whole order/);
  });
});
