// "Can I speak to someone?"
//
// Most callers who ask for a person want one of three things this line does
// in seconds — add to an order, hear where it is, leave the kitchen a note —
// and a transfer makes them hold for someone who will only ask them the same
// question. A complaint is different. So is anybody who has been offered
// help and still wants a human.
//
// The escape hatch matters more than the gate. This holds a transfer back
// ONCE. Ask twice and it goes through whatever the reason, because a caller
// trapped in a loop by a machine is the failure that gets a phone line
// switched off.

import { VoiceAiService } from "../voice-ai.service";

const ctx = (): any => ({
  tenantId: "t1",
  locationId: "loc1",
  currency: "GBP",
  items: [],
  itemIndex: new Map(),
  optionIndex: new Map(),
  deliveryZones: [],
  transferNumber: "0191 231 2345",
});
const ai = () => {
  const a: any = Object.create(VoiceAiService.prototype);
  a.logger = { log() {}, warn() {}, error() {} };
  return a;
};
const state = (over: any = {}): any => ({ cart: { items: [] }, turns: [], ...over });
const ask = (a: any, st: any, input: any) =>
  a.runToolForConversation("transfer_to_staff", input, ctx(), st, null);

describe("a complaint goes straight through", () => {
  it("no questions, no holding it back", async () => {
    const a = ai(); const st = state();
    const out = await ask(a, st, { about: "complaint", reason: "the pizza was cold" });
    expect(out.turn?.transferTo).toBe("+441912312345");
    expect(out.turn?.outcome).toBe("TRANSFERRED");
  });
});

describe("things the line can do itself", () => {
  const cases = [
    ["add_to_order", /find_order_to_change/],
    ["order_update", /get_order_status/],
    ["note_for_order", /note_for_kitchen/],
    ["cancel", /cancel_order, not a transfer/],
  ] as const;

  for (const [about, expected] of cases) {
    it(`does not transfer for ${about}, and names the tool that does it`, async () => {
      const a = ai(); const st = state();
      const out = await ask(a, st, { about, reason: "they asked for someone" });
      expect(out.turn).toBeUndefined();
      expect(out.result).toMatch(/Don't put them through/);
      expect(out.result).toMatch(expected);
    });
  }

  it("asks what it is about when the model does not say", async () => {
    const a = ai(); const st = state();
    const out = await ask(a, st, { reason: "wants a person" });
    expect(out.turn).toBeUndefined();
    expect(out.result).toMatch(/Ask what it is about first/);
  });
});

describe("the escape hatch", () => {
  it("goes through the second time, whatever the reason", async () => {
    const a = ai(); const st = state();
    const first = await ask(a, st, { about: "add_to_order", reason: "wants a person" });
    expect(first.turn).toBeUndefined();

    const second = await ask(a, st, { about: "add_to_order", reason: "still wants a person" });
    expect(second.turn?.transferTo).toBe("+441912312345");
  });

  it("goes through the first time when they have insisted", async () => {
    const a = ai(); const st = state();
    const out = await ask(a, st, { about: "insisted", reason: "no, a person please" });
    expect(out.turn?.transferTo).toBe("+441912312345");
  });

  it("never holds back a caller who already asked for a human", async () => {
    // askedForHuman is set when the caller says it plainly. They are not
    // asked to justify themselves.
    const a = ai(); const st = state({ askedForHuman: true });
    const out = await ask(a, st, { reason: "wants a person" });
    expect(out.turn?.transferTo).toBe("+441912312345");
  });

  it("and anything genuinely for a human still goes", async () => {
    const a = ai(); const st = state();
    const out = await ask(a, st, { about: "other", reason: "wants to speak to the owner" });
    expect(out.turn?.transferTo).toBe("+441912312345");
  });
});

describe("what the model is told", () => {
  it("the tool says to ask first, and lists what it can do itself", () => {
    const a = ai();
    const tool = a.toolsForConversation(ctx()).find((t: any) => t.name === "transfer_to_staff");
    expect(tool.description).toMatch(/ASK WHAT IT IS ABOUT FIRST, unless they are complaining or upset/);
    expect(tool.parameters.properties.about.enum).toEqual(
      expect.arrayContaining(["complaint", "add_to_order", "order_update", "note_for_order", "insisted"]),
    );
  });

  it("the prompt says the same, including not arguing the second time", () => {
    const a = ai();
    const prompt = a.promptForConversation(ctx(), state(), null);
    expect(prompt).toMatch(/ask what it is about BEFORE transferring, unless they are complaining or upset/);
    expect(prompt).toMatch(/If they ask a second time, put them through without arguing/);
  });
});
