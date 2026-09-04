import {
  digitChoice,
  interpretMenuChoice,
  parseSpokenNumber,
  spokenDigits,
  spokenOrderStatus,
} from "../voice-flow";

// The spine of a call. Everything here runs before Claude is involved, so a
// regression is heard by every single caller — which is why it is the part
// that gets the tests.

describe("digitChoice", () => {
  it("routes the two advertised options", () => {
    expect(digitChoice("1")).toEqual({ kind: "ORDER" });
    expect(digitChoice("2")).toEqual({ kind: "STATUS" });
  });

  it("treats 0 as the universal escape to a person", () => {
    expect(digitChoice("0")).toEqual({ kind: "HUMAN" });
  });

  it("ignores keys we never offered rather than guessing", () => {
    expect(digitChoice("7")).toBeNull();
    expect(digitChoice("#")).toBeNull();
    expect(digitChoice("")).toBeNull();
  });
});

describe("interpretMenuChoice", () => {
  it("takes the menu options spoken as well as pressed", () => {
    expect(interpretMenuChoice("one")).toEqual({ kind: "ORDER" });
    expect(interpretMenuChoice("press 1")).toEqual({ kind: "ORDER" });
    expect(interpretMenuChoice("two")).toEqual({ kind: "STATUS" });
    expect(interpretMenuChoice("number two please")).toEqual({ kind: "STATUS" });
  });

  it("does NOT read a quantity as a menu choice", () => {
    // The whole hybrid menu falls apart if "two large pepperoni" is heard as
    // "option two" and the caller gets asked for an order number.
    const out = interpretMenuChoice("yeah can I get two large pepperoni please");
    expect(out.kind).toBe("ORDER");
    expect((out as any).passThrough).toContain("two large pepperoni");
  });

  it("carries the caller's words through when they skip the menu", () => {
    const out = interpretMenuChoice("I'd like a chicken korma for delivery");
    expect(out).toEqual({
      kind: "ORDER",
      passThrough: "I'd like a chicken korma for delivery",
    });
  });

  it("recognises chasing an existing order from the words, not the digit", () => {
    for (const said of [
      "where's my order",
      "I want an update on my delivery",
      "I ordered earlier and it's not arrived",
      "can you track my order",
    ]) {
      expect(interpretMenuChoice(said).kind).toBe("STATUS");
    }
  });

  it("hands over whenever a person is asked for", () => {
    for (const said of [
      "can I speak to someone",
      "put me through to a human",
      "I want to talk to a person",
      "zero",
    ]) {
      expect(interpretMenuChoice(said).kind).toBe("HUMAN");
    }
  });

  it("falls forward into ordering when it cannot tell", () => {
    // Never a dead end, never a repeated menu. Unclear input is an order.
    expect(interpretMenuChoice("erm").kind).toBe("ORDER");
    expect(interpretMenuChoice("").kind).toBe("ORDER");
    expect(interpretMenuChoice("hello are you there").kind).toBe("ORDER");
  });
});

describe("parseSpokenNumber", () => {
  it("reads a number however the engine wrote it down", () => {
    expect(parseSpokenNumber("4012")).toBe("4012");
    expect(parseSpokenNumber("it's four oh one two")).toBe("4012");
    expect(parseSpokenNumber("order number 4012 please")).toBe("4012");
  });

  it("refuses homophones rather than reading out a stranger's order", () => {
    // "for" and "to" are common phone-transcription slips for four and two.
    // Mapping them would hand someone else's order status down the line.
    expect(parseSpokenNumber("it's for delivery")).toBeNull();
    expect(parseSpokenNumber("I want to know")).toBeNull();
  });

  it("returns null when there is no number at all", () => {
    expect(parseSpokenNumber("I don't know")).toBeNull();
  });
});

describe("spokenDigits", () => {
  it("spells a number out so the caller can check it", () => {
    expect(spokenDigits(4012)).toBe("4, 0, 1, 2");
    expect(spokenDigits("#77")).toBe("7, 7");
  });
});

describe("spokenOrderStatus", () => {
  it("answers in words a customer uses, not enum names", () => {
    const out = spokenOrderStatus({ status: "PREPARING", fulfillmentType: "DELIVERY" });
    expect(out.say).toContain("being made");
    expect(out.say).not.toContain("PREPARING");
  });

  it("distinguishes ready-for-collection from ready-for-a-driver", () => {
    expect(
      spokenOrderStatus({ status: "READY", fulfillmentType: "PICKUP" }).say,
    ).toContain("collection");
    expect(
      spokenOrderStatus({ status: "READY", fulfillmentType: "DELIVERY" }).say,
    ).toContain("driver");
  });

  it("never tries to explain a cancellation — it fetches a human", () => {
    for (const status of ["CANCELLED", "REJECTED", "FAILED"]) {
      expect(spokenOrderStatus({ status }).transfer).toBe(true);
    }
  });

  it("hands over on a status it does not recognise", () => {
    expect(spokenOrderStatus({ status: "SOME_NEW_STATUS" }).transfer).toBe(true);
  });

  it("only quotes an ETA when there is one in the future", () => {
    expect(
      spokenOrderStatus({ status: "PREPARING", minutesAway: 20 }).say,
    ).toContain("20 minutes");
    expect(
      spokenOrderStatus({ status: "PREPARING", minutesAway: -5 }).say,
    ).not.toContain("minutes");
  });
});
