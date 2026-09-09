// "I can't change it, but I can tell the kitchen."
//
// A caller rings about an order placed on Just Eat. They cannot edit it and
// neither can the shop — that part does not change, and the line still sends
// them to the app. But "make sure my pizza is thin crust" was never an edit.
// It is a sentence the kitchen needs before the food goes out, and until now
// the only answer was to hang up and hope.
//
// Nothing here touches the order's items, its price, or the marketplace. It
// prints a chit and writes the words on the order so the screen shows them
// too.

import { VoiceAiService } from "../voice-ai.service";

const ORDER = {
  id: "ord1",
  displayId: "SIM-A60X",
  orderNumber: 4012,
  collectionCode: null,
  orderSource: "JUST_EAT",
  status: "PREPARING",
  fulfillmentType: "DELIVERY",
  customerPhone: "+447700900123",
  paymentMethod: "CARD",
  paymentStatus: "PAID",
  items: [],
  createdAt: new Date(),
};

const ctx = (): any => ({
  tenantId: "t1",
  locationId: "loc1",
  currency: "GBP",
  timezone: "Europe/London",
  items: [],
  itemIndex: new Map(),
  optionIndex: new Map(),
  deliveryZones: [],
});

const ai = (over: any = {}) => {
  const a: any = Object.create(VoiceAiService.prototype);
  a.logger = { log() {}, warn() {}, error() {} };
  a.printing = { createCustomerNoteChit: jest.fn(async () => ["job1"]), ...over.printing };
  const updates: any[] = [];
  a.prisma = {
    order: {
      findMany: async () => [over.order ?? ORDER],
      findUnique: async () => ({ specialInstructions: over.existingInstructions ?? null }),
      update: async (args: any) => { updates.push(args); return {}; },
    },
  };
  a.updates = updates;
  return a;
};
const state = (): any => ({ cart: { items: [] }, turns: [] });

describe("an order the shop cannot change", () => {
  it("still sends them to the app, and now offers the kitchen a note", async () => {
    const a = ai();
    const st = state();
    const out = await a.runToolForConversation("find_order_to_change", { orderNumber: "SIM-A60X" }, ctx(), st, "+447700900123");

    // Unchanged: the caller is told to use Just Eat.
    expect(out.result).toMatch(/Not ours to change/);
    expect(out.result).toMatch(/has to be changed there/);
    // Added: the offer, and the order remembered so a note can land on it.
    expect(out.result).toMatch(/you CAN pass an instruction to the kitchen/);
    expect(st.noteOrder).toEqual({ id: "ord1", reference: "SIM-A60X", via: "Just Eat" });
  });

  it("prints the note with the order behind it, and says nothing was changed", async () => {
    const a = ai();
    const st = state();
    await a.runToolForConversation("find_order_to_change", { orderNumber: "SIM-A60X" }, ctx(), st, null);
    const out = await a.runToolForConversation(
      "note_for_kitchen",
      { note: "make sure my pizza is thin crust" },
      ctx(),
      st,
      null,
    );

    expect(a.printing.createCustomerNoteChit).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "ord1", note: "make sure my pizza is thin crust" }),
    );
    expect(out.result).toMatch(/printed in the kitchen for order SIM-A60X/);
    expect(out.result).toMatch(/changes nothing on the order itself/);
    expect(out.sayNow).toMatch(/gone through to the kitchen for order S, I, M/);
  });

  it("writes it on the order too, marked as a phone note so it is not mistaken for the platform's", async () => {
    const a = ai({ existingInstructions: "Leave at door" });
    const st = state();
    await a.runToolForConversation("find_order_to_change", { orderNumber: "SIM-A60X" }, ctx(), st, null);
    await a.runToolForConversation("note_for_kitchen", { note: "thin crust please" }, ctx(), st, null);

    const saved = a.updates[0].data.specialInstructions;
    expect(saved).toMatch(/^Leave at door \| PHONE NOTE \d{2}:\d{2}: thin crust please$/);
  });

  it("will not attach a note to nothing", async () => {
    const a = ai();
    const out = await a.runToolForConversation("note_for_kitchen", { note: "thin crust" }, ctx(), state(), null);
    expect(out.result).toMatch(/No order to attach a note to yet/);
    expect(a.printing.createCustomerNoteChit).not.toHaveBeenCalled();
  });

  it("asks what they want said rather than printing an empty chit", async () => {
    const a = ai();
    const st = state();
    await a.runToolForConversation("find_order_to_change", { orderNumber: "SIM-A60X" }, ctx(), st, null);
    const out = await a.runToolForConversation("note_for_kitchen", { note: "  " }, ctx(), st, null);
    expect(out.result).toMatch(/Ask them what they would like the kitchen to know/);
    expect(a.printing.createCustomerNoteChit).not.toHaveBeenCalled();
  });

  it("does not claim the kitchen has it when no printer took the job", async () => {
    // The worst version of this feature is one that says "that's gone to the
    // kitchen" to a shop whose printer is off.
    const a = ai({ printing: { createCustomerNoteChit: jest.fn(async () => []) } });
    const st = state();
    await a.runToolForConversation("find_order_to_change", { orderNumber: "SIM-A60X" }, ctx(), st, null);
    const out = await a.runToolForConversation("note_for_kitchen", { note: "thin crust" }, ctx(), st, null);

    expect(out.result).toMatch(/NOTHING PRINTED/);
    expect(out.result).toMatch(/offer to put them through/);
    expect(out.sayNow).toBeUndefined();
  });

  it("offers the same for an order the kitchen has already started", async () => {
    const a = ai({ order: { ...ORDER, orderSource: "POS", status: "READY", paymentMethod: "CASH", paymentStatus: "UNPAID" } });
    const st = state();
    const out = await a.runToolForConversation("find_order_to_change", {}, ctx(), st, "+447700900123");
    expect(out.result).toMatch(/Too late to change/);
    expect(out.result).toMatch(/pass a note to the kitchen with note_for_kitchen/);
    expect(st.noteOrder?.id).toBe("ord1");
  });

  it("and for one already paid by card", async () => {
    const a = ai({ order: { ...ORDER, orderSource: "POS", status: "PREPARING", paymentMethod: "CARD", paymentStatus: "PAID" } });
    const st = state();
    const out = await a.runToolForConversation("find_order_to_change", {}, ctx(), st, "+447700900123");
    expect(out.result).toMatch(/already been paid by card/);
    expect(out.result).toMatch(/note_for_kitchen/);
    expect(st.noteOrder?.id).toBe("ord1");
  });

  it("a marketplace order is still never found by phone number alone", async () => {
    // Just Eat and Uber store a SHARED proxy number on the order. Matching a
    // caller to one by phone would read a stranger their neighbour's dinner,
    // and offering a kitchen note is no reason to relax that — they have to
    // read the order number out.
    const a = ai();
    const st = state();
    const out = await a.runToolForConversation("find_order_to_change", {}, ctx(), st, "+447700900123");
    expect(out.result).toMatch(/No recent order from this number/);
    expect(st.noteOrder).toBeUndefined();
  });

  it("the tool and the prompt are clear that it changes nothing", () => {
    const a = ai();
    const tool = a.toolsForConversation(ctx()).find((t: any) => t.name === "note_for_kitchen");
    expect(tool.description).toMatch(/does NOT change the order, add anything or cost anything/);
    expect(a.promptForConversation(ctx(), state(), null)).toMatch(
      /cannot be changed here, and you must not pretend otherwise/,
    );
  });
});
