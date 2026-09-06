// The address is the one field a caller can correct at any time.
//
// From a live call: the line asked "are you still at 11 Sunningdale Drive?",
// nothing came back at all, and ten seconds later it used the saved address
// anyway. The caller then spent the rest of the call saying their address was
// wrong, and was offered a drink each time. The food would have gone to a
// house they had moved out of.

import { VoiceAiService } from "../voice-ai.service";

const ai = () => {
  const a: any = Object.create(VoiceAiService.prototype);
  a.logger = { log() {}, warn() {}, error() {} };
  return a;
};
const ctx = () =>
  ({
    currency: "GBP",
    items: [],
    itemIndex: new Map(),
    optionIndex: new Map(),
    deliveryZones: [{ id: "z", postcodePrefix: "NE37", fee: 3 }],
    locationName: "Pizza Uno",
  }) as any;
const state = () =>
  ({
    cart: { items: [] },
    turns: [],
    savedAddress: { line1: "11 Sunningdale Drive", city: "Washington", postcode: "NE37 2LL" },
  }) as any;

const run = (input: any, st = state()) =>
  ai().runTool("use_saved_address", input, ctx(), st, null);

describe("using the address already on file", () => {
  it("refuses when the caller has said nothing", async () => {
    // The exact failure: no transcript arrived between the question and the
    // tool call, and it went ahead. Silence is the case a model is most likely
    // to fill in for itself, and the one that sends a driver to the wrong door.
    const out = await run({});
    expect(out.result).toMatch(/have not said yes/);
    expect(out.result).toMatch(/Do NOT use it/);
    expect(out.result).toMatch(/what's the delivery address/);
  });

  it("refuses when they said no", async () => {
    const out = await run({ __heard: "No." });
    expect(out.result).toMatch(/have not said yes/);
    expect(out.result).toContain('"No."');
  });

  it("refuses when they said their address is wrong", async () => {
    const out = await run({ __heard: "no that address is wrong I've moved" });
    expect(out.result).toMatch(/Do NOT use it/);
  });

  it("uses it when they actually agreed", async () => {
    for (const yes of ["yes", "yeah that's right", "yep still there"]) {
      const st = state();
      const out = await run({ __heard: yes }, st);
      expect(out.result).toMatch(/Using their saved address/);
      expect(st.cart.deliveryAddress?.line1).toBe("11 Sunningdale Drive");
    }
  });

  it("refuses when something unrelated was the last thing said", async () => {
    // "Can I get a coke" is not consent to an address.
    expect((await run({ __heard: "can I get a coke" })).result).toMatch(/have not said yes/);
  });
});

describe("what the model is told about changing an address", () => {
  it("is told it can happen at any point in the call", () => {
    const p = ai().promptForRealtime(ctx(), state());
    expect(p).toMatch(/THE ADDRESS CAN BE CHANGED AT ANY POINT/);
    expect(p).toMatch(/including in the middle of\s+ordering food/);
  });

  it("is told it is never a menu item", () => {
    // It offered a drink, three times, to somebody telling it the address was
    // wrong.
    const p = ai().promptForRealtime(ctx(), state());
    expect(p).toMatch(/never a menu item/);
    expect(p).toMatch(/do not offer them a drink/);
    expect(p).toMatch(/what's the new address/);
  });

  it("is told that twice means it has not been listening", () => {
    expect(ai().promptForRealtime(ctx(), state())).toMatch(
      /said it twice is a caller you have not listened to/,
    );
  });
});
