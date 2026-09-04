import {
  digitChoice,
  interpretMenuChoice,
  isLikelyHallucination,
  normalisePostcode,
  parseFulfillment,
  parseOrderReference,
  parsePayment,
  parseYesNo,
  parseSpokenNumber,
  repairPostcode,
  resolveHeardPostcode,
  soundsComplete,
  spokenDigits,
  spokenOrderStatus,
  wantsHuman,
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

describe("soundsComplete", () => {
  it("treats a punctuated sentence as finished", () => {
    // These are real transcripts from a live call. Whisper returns whole
    // punctuated utterances, so waiting 1.5s to see if more is coming is 1.5s
    // of silence the caller sits through on every single turn.
    expect(soundsComplete("delivery.")).toBe(true);
    expect(soundsComplete("11 Follingsby Drive, NE10 8YH.")).toBe(true);
    expect(soundsComplete("Can I get two large pepperoni?")).toBe(true);
  });

  it("waits longer on speech that trails off", () => {
    expect(soundsComplete("I'd like a pizza and")).toBe(false);
    expect(soundsComplete("two large pepperoni and.")).toBe(false);
    expect(soundsComplete("erm")).toBe(false);
    expect(soundsComplete("")).toBe(false);
  });

  it("accepts a one-word answer that is genuinely the whole answer", () => {
    for (const said of ["yes.", "cash.", "collection.", "correct."]) {
      expect(soundsComplete(said)).toBe(true);
    }
    // …but not a punctuated hesitation.
    expect(soundsComplete("Um.")).toBe(false);
  });
});

describe("normalisePostcode", () => {
  it("spaces a UK postcode correctly however it arrives", () => {
    expect(normalisePostcode("ne108yh")).toBe("NE10 8YH");
    expect(normalisePostcode("NE10 8YH")).toBe("NE10 8YH");
    expect(normalisePostcode("n e 1 0 8 y h")).toBe("NE10 8YH");
  });

  it("refuses anything that is not a postcode", () => {
    // A wrong postcode silently prices the wrong delivery zone, which is worse
    // than having none at all.
    expect(normalisePostcode("8YH")).toBeNull();
    expect(normalisePostcode("hello there")).toBeNull();
    expect(normalisePostcode("")).toBeNull();
  });
});

describe("repairPostcode", () => {
  const zones = ["NE10", "NE9"];

  it("restores a leading letter the transcriber dropped", () => {
    // The exact failure from a live call: the caller said "NE10 8YH" and it
    // came back as "E10, 8YH".
    expect(repairPostcode("E10 8YH", zones)).toBe("NE10 8YH");
  });

  it("refuses to choose when two zones would fit", () => {
    // Guessing between two real delivery areas would put a driver in the
    // wrong part of the city. Better to ask again.
    expect(repairPostcode("E9 1AA", ["NE9", "SE9"])).toBeNull();
  });

  it("leaves a postcode that already matches a zone alone", () => {
    expect(repairPostcode("NE10 8YH", zones)).toBeNull();
  });

  it("never edits a character the transcriber did hear", () => {
    // Only ever restores what was clipped from the FRONT.
    expect(repairPostcode("NX10 8YH", zones)).toBeNull();
  });

  it("copes with a shop that has no postcode zones at all", () => {
    expect(repairPostcode("E10 8YH", [])).toBeNull();
    expect(repairPostcode("E10 8YH", [null, undefined])).toBeNull();
  });
});

describe("resolveHeardPostcode", () => {
  const zones = ["NE10", "NE9"];

  it("repairs a valid-LOOKING postcode the shop cannot possibly serve", () => {
    // The trap: "E10 8YH" is a real London postcode and parses perfectly, so
    // asking "did this parse?" never triggers a repair. The question that
    // works is "could this shop deliver there?".
    expect(resolveHeardPostcode("E10 8YH", zones)).toBe("NE10 8YH");
  });

  it("leaves a servable postcode exactly as heard", () => {
    expect(resolveHeardPostcode("ne108yh", zones)).toBe("NE10 8YH");
    expect(resolveHeardPostcode("NE9 5AA", zones)).toBe("NE9 5AA");
  });

  it("keeps an out-of-area postcode so the caller is told, not silently moved", () => {
    // Someone genuinely in London ordering from Gateshead must hear "we don't
    // deliver there", not be quietly relocated to a zone we do serve.
    expect(resolveHeardPostcode("SW1A 1AA", zones)).toBe("SW1A 1AA");
  });

  it("passes everything through for a shop with no postcode zones", () => {
    // Area- and distance-priced shops have nothing to check against.
    expect(resolveHeardPostcode("E10 8YH", [])).toBe("E10 8YH");
  });
});

describe("isLikelyHallucination", () => {
  it("drops the stock phrases Whisper emits on silence", () => {
    // From a real call: "Thank you." arrived during a stretch the caller had
    // not spoken in, and cost a 5.5s model call to answer nobody.
    for (const ghost of [
      "Thank you.",
      "Thanks for watching!",
      "you",
      "Bye.",
      "Um",
      ".",
      "",
    ]) {
      expect(isLikelyHallucination(ghost)).toBe(true);
    }
  });

  it("never drops real speech that merely contains one", () => {
    // Dropping a real sentence is far worse than answering a ghost, so this
    // only matches the WHOLE utterance.
    expect(isLikelyHallucination("thank you, that's all")).toBe(false);
    expect(isLikelyHallucination("yes")).toBe(false);
    expect(isLikelyHallucination("two large pepperoni")).toBe(false);
    expect(isLikelyHallucination("okay so I want chips")).toBe(false);
  });
});

describe("parseYesNo", () => {
  it("answers the plain agreements without a model", () => {
    for (const said of ["yes", "Yeah.", "yep", "that's right", "correct", "spot on"]) {
      expect(parseYesNo(said)).toBe("YES");
    }
  });

  it("answers the plain refusals", () => {
    for (const said of ["no", "Nope.", "not quite", "that's wrong"]) {
      expect(parseYesNo(said)).toBe("NO");
    }
  });

  it("treats a correction as a no, however it opens", () => {
    // "yeah but make it a large" agreeing with the read-back would send the
    // wrong order to the kitchen — the exact failure the read-back exists for.
    expect(parseYesNo("yeah but make it a large")).not.toBe("YES");
    expect(parseYesNo("no actually change that")).toBe("NO");
  });

  it("hands anything longer or ambiguous to the model", () => {
    expect(parseYesNo("yes and can I also add chips please")).toBeNull();
    expect(parseYesNo("hmm let me think")).toBeNull();
    expect(parseYesNo("")).toBeNull();
  });
});

describe("parseFulfillment", () => {
  it("understands the two answers without a model", () => {
    for (const said of ["delivery", "Delivery please", "can you deliver it", "delivered"]) {
      expect(parseFulfillment(said)).toBe("DELIVERY");
    }
    for (const said of ["collection", "I'll collect", "pick up", "takeaway", "collecting"]) {
      expect(parseFulfillment(said)).toBe("PICKUP");
    }
  });

  it("refuses to guess when both or neither are said", () => {
    // Guessing delivery onto someone walking in adds a charge they never
    // agreed to; guessing collection sends a driver nowhere.
    expect(parseFulfillment("do you deliver or is it collection only")).toBeNull();
    expect(parseFulfillment("erm")).toBeNull();
    expect(parseFulfillment("")).toBeNull();
  });

  it("hands a whole sentence to the model", () => {
    expect(
      parseFulfillment("delivery please and can I get two large pepperoni"),
    ).toBeNull();
  });
});

describe("parsePayment", () => {
  it("understands cash and card", () => {
    for (const said of ["cash", "Cash please", "I'll pay on delivery", "cash at the shop"]) {
      expect(parsePayment(said)).toBe("CASH");
    }
    for (const said of ["card", "by card please", "debit card", "send me a link"]) {
      expect(parsePayment(said)).toBe("CARD");
    }
  });

  it("refuses when it cannot tell", () => {
    expect(parsePayment("can I pay by cash or card")).toBeNull();
    expect(parsePayment("what do you take")).toBeNull();
  });
});

describe("wantsHuman", () => {
  it("is heard at any point in the call, not just at the menu", () => {
    // "Asking for a human must always work" is one of the four rules this
    // module was written around, and it was only true on the first turn.
    for (const said of [
      "can I speak to someone",
      "put me through to a human",
      "I want to talk to a person",
      "get me a member of staff",
      "zero",
    ]) {
      expect(wantsHuman(said)).toBe(true);
    }
  });

  it("does not fire on ordinary ordering talk", () => {
    expect(wantsHuman("two large pepperoni")).toBe(false);
    expect(wantsHuman("delivery please")).toBe(false);
    expect(wantsHuman("")).toBe(false);
  });
});

describe("parseSpokenNumber — spoken cardinals", () => {
  it("reads a number said as a number, not as its digits", () => {
    // A live call: the caller said "twenty four" for order 24 and the parser
    // returned "4", because it only knew single digits.
    expect(parseSpokenNumber("twenty four")).toBe("24");
    expect(parseSpokenNumber("it's ninety")).toBe("90");
    expect(parseSpokenNumber("two hundred and forty")).toBe("240");
    expect(parseSpokenNumber("one hundred and thirty three")).toBe("133");
  });

  it("still reads a number said digit by digit", () => {
    expect(parseSpokenNumber("four oh one two")).toBe("4012");
    expect(parseSpokenNumber("one three three")).toBe("133");
  });

  it("prefers digits the engine already wrote as digits", () => {
    expect(parseSpokenNumber("order 24 please")).toBe("24");
    expect(parseSpokenNumber("4012")).toBe("4012");
  });

  it("still refuses homophones", () => {
    // A mis-parsed digit reads a DIFFERENT customer's order down the line.
    expect(parseSpokenNumber("it's for delivery")).toBeNull();
    expect(parseSpokenNumber("I want to know")).toBeNull();
  });
});

describe("parseOrderReference", () => {
  it("reads the id tail a shop reads off its own screen", () => {
    // From a live call: the caller said "24kiod", the last characters of
    // cmtne25lj002dcft06v24kiod — which is what the dashboard shows. The line
    // only ever looked up the sequential orderNumber, so it found nothing.
    const out = parseOrderReference("24kiod");
    expect(out.code).toBe("24kiod");
  });

  it("still reads a plain order number", () => {
    expect(parseOrderReference("twenty four").number).toBe("24");
    expect(parseOrderReference("order 4012").number).toBe("4012");
  });

  it("gives back both readings so the lookup can try each", () => {
    // "0133" is a marketplace displayId; "24kiod" is an id suffix. One
    // utterance can plausibly be either, and they are checked against
    // different columns.
    const out = parseOrderReference("133 a b c");
    expect(out.number).toBe("133");
  });

  it("does not mistake ordinary words for a reference", () => {
    // A code needs letters AND digits — otherwise "delivery please" would be
    // looked up as an order id.
    expect(parseOrderReference("delivery please").code).toBeNull();
    expect(parseOrderReference("I don't know").code).toBeNull();
    expect(parseOrderReference("").code).toBeNull();
  });

  it("ignores something far too long to be a reference", () => {
    expect(
      parseOrderReference(
        "my order was 2 large pepperoni pizzas and a garlic bread on tuesday the 4th",
      ).code,
    ).toBeNull();
  });
});
