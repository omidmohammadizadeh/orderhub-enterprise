// The three places a "yes" turns into food in a kitchen.
//
// 7 September, 11:22. The caller said "no, I don't want the same as last time":
//
//   11:22:50  said "Would you like the same as last time — chips and garlic
//                   sauce, delivered to 11 Follingsby Drive?"
//   11:22:57  calling use_usual
//   11:22:57  tool use_usual → Their usual is in the basket: 1 × CHIPS,
//                              1 × Garlic sauce
//   11:22:58  heard "Sienos."
//   11:23:01  said "So that's CHIPS, then Garlic sauce... Is that correct?"
//
// Two faults in five lines. The model read a refusal as agreement, and
// use_usual had nothing to stop it — unlike use_saved_address, which has
// refused without a spoken yes since this morning. And the transcript of the
// answer arrived 248ms AFTER the tool that acted on it, so even a guard would
// have been reading the previous turn.

import { VoiceAiService } from "../voice-ai.service";
import { VoiceService } from "../voice.service";

const ai = () => {
  const a: any = Object.create(VoiceAiService.prototype);
  a.logger = { log() {}, warn() {}, error() {} };
  return a;
};

describe("what counts as agreement", () => {
  const yes = (input: any) => ai().agreed(input).ok;

  it("takes a plain yes", () => {
    for (const said of ["yes", "yeah", "yes please", "yep that's right", "correct"]) {
      expect(yes({ __heard: said, __heardFresh: true })).toBe(true);
    }
  });

  it("does not take a no", () => {
    for (const said of ["no", "no thanks", "nope", "no I don't want that"]) {
      expect(yes({ __heard: said, __heardFresh: true })).toBe(false);
    }
  });

  it("does not take a mangled transcript", () => {
    // The real one. "No, I don't want the same as last time" → "Sienos."
    expect(yes({ __heard: "Sienos.", __heardFresh: true })).toBe(false);
    expect(yes({ __heard: "डिलिवरी", __heardFresh: true })).toBe(false);
  });

  it("does not take silence", () => {
    expect(yes({ __heard: "", __heardFresh: true })).toBe(false);
    expect(yes({})).toBe(false);
  });

  it("does not take words said BEFORE the question", () => {
    // A yes to "are you still at Sunningdale Drive?" is not a yes to "shall I
    // place the order".
    expect(yes({ __heard: "yes", __heardFresh: false })).toBe(false);
  });

  it("says which of those it was, so the model can ask properly", () => {
    expect(ai().agreed({ __heard: "Sienos.", __heardFresh: true }).why).toContain("Sienos.");
    expect(ai().agreed({ __heard: "", __heardFresh: true }).why).toBe("nothing at all");
    expect(ai().agreed({ __heardFresh: false }).why).toMatch(/since you asked/);
  });
});

describe("the order they had last time", () => {
  const svc = () => {
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.ai = ai();
    s.save = async () => {};
    const state: any = { cart: { items: [] }, turns: [] };
    s.loadByControlId = async () => ({
      call: { id: "c1", fromNumber: "+447700900123" },
      ctx: { locationId: "l1", currency: "GBP", items: [], itemIndex: new Map() },
      state,
    });
    s.lastOrderFor = async () => ({
      reference: "4012",
      fulfillmentType: "DELIVERY",
      deliveryAddress: { line1: "11 Follingsby Drive" },
      items: [{ menuItemId: "chp", name: "CHIPS", quantity: 1 }],
    });
    return { s, state };
  };

  it("is NOT loaded when they said no", async () => {
    const { s, state } = svc();
    const out = await s.realtimeTool("cc1", "use_usual", {
      __heard: "no I don't want the same as last time",
      __heardFresh: true,
    });

    expect(out.result).toMatch(/have not said yes/);
    expect(out.result).toMatch(/take the order from the beginning/);
    expect(state.cart.items).toHaveLength(0);
  });

  it("is NOT loaded on a mangled transcript — it moves to the keypad", async () => {
    // "Sienos." was a caller saying no. "Svensk." was another. A transcript
    // nobody can read is not a refusal and not a yes, and asking the same
    // question again just collects another one — so the question changes.
    const { s, state } = svc();
    const out = await s.realtimeTool("cc1", "use_usual", {
      __heard: "Sienos.",
      __heardFresh: true,
      __heardReadable: false,
    });

    expect(out.sayNow).toMatch(/Press 1 for yes, or 2 for no/);
    expect(out.result).toMatch(/do NOT act until it arrives/i);
    expect(state.cart.items).toHaveLength(0);
    expect(state.pendingConfirm).toMatchObject({ intent: "usual", asked: true });
  });

  it("loads it once they press 1, without needing the transcript", async () => {
    const { s, state } = svc();
    await s.realtimeTool("cc1", "use_usual", {
      __heard: "Sienos.",
      __heardFresh: true,
      __heardReadable: false,
    });
    state.pendingConfirm.answered = "YES";

    const out = await s.realtimeTool("cc1", "use_usual", {
      __heard: "Svensk.",
      __heardFresh: true,
      __heardReadable: false,
    });

    // The keypress IS the consent: the tool gets past the gate on a transcript
    // that is still unreadable. What it then finds in the order history is a
    // separate question, and this harness has no menu behind it.
    expect(out.result).not.toMatch(/have not said yes/);
    expect(out.sayNow).toBeUndefined();
  });

  it("never loads it when they press 2", async () => {
    const { s, state } = svc();
    await s.realtimeTool("cc1", "use_usual", {
      __heard: "Svensk.",
      __heardFresh: true,
      __heardReadable: false,
    });
    state.pendingConfirm.answered = "NO";

    const out = await s.realtimeTool("cc1", "use_usual", { __heard: "", __heardFresh: true });

    expect(out.result).toMatch(/have not said yes/);
    expect(state.cart.items).toHaveLength(0);
  });

  it("is NOT loaded on words that predate the question", async () => {
    const { s, state } = svc();
    expect(
      (await s.realtimeTool("cc1", "use_usual", { __heard: "yes", __heardFresh: false })).sayNow,
    ).toMatch(/Press 1 for yes, or 2 for no/);
    expect(state.cart.items).toHaveLength(0);
  });
});

describe("the read-back, which is the last gate before a kitchen starts", () => {
  const confirm = (input: any) => {
    const state: any = {
      cart: { items: [{ lineId: "a", name: "CHIPS", quantity: 1, unitBasePrice: 2, modifiers: [] }] },
      turns: [],
    };
    const a = ai();
    // A yes only counts for an order the caller has heard: this is the
    // read-back having happened, for the order as it stands.
    state.readBackOf = a.orderFingerprint(state);
    const out = a.runTool("order_confirmed", input, { currency: "GBP" } as any, state, null);
    return { out, state };
  };

  it("does not confirm on a misheard yes", async () => {
    const { out, state } = confirm({
      __heard: "Sienos.",
      __heardFresh: true,
      __heardReadable: false,
    });
    expect((await out).sayNow).toMatch(/Press 1 for yes, or 2 for no/);
    expect((await out).result).toMatch(/do NOT act until it arrives/i);
    expect(state.orderConfirmed).toBeFalsy();
  });

  it("does not confirm on silence", async () => {
    const { out, state } = confirm({});
    expect((await out).sayNow).toMatch(/Press 1 for yes, or 2 for no/);
    expect(state.orderConfirmed).toBeFalsy();
  });

  it("confirms on a real yes", async () => {
    const { out, state } = confirm({ __heard: "yes that's right", __heardFresh: true });
    expect((await out).result).toMatch(/Confirmed/);
    expect(state.orderConfirmed).toBe(true);
  });
});
