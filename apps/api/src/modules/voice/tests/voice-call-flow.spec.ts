import { VoiceCallSim } from "./voice-call-sim";

// The delivery call, end to end, offline.
//
// The transcripts here are the real ones from live calls, mis-hearings and
// all. If the flow is right, it is right against what the transcriber actually
// produces — not against what a caller meant to say.

const POSTCODES = {
  NE372LL: [
    { line1: "5 Sunningdale Drive", city: "Washington" },
    { line1: "7 Sunningdale Drive", city: "Washington" },
  ],
};

describe("a delivery order, start to address confirmed", () => {
  it("asks postcode, street, house number — in that order, no model", async () => {
    const call = new VoiceCallSim({ postcodes: POSTCODES });

    expect(call.greeting()).toContain("press 1");
    expect(await call.press("1")).toContain("collection or delivery");
    expect(await call.say("Delivery.")).toContain("postcode");

    // The street comes back off the postcode — the caller never says it.
    const street = await call.say("N E 3 7 2 L L");
    expect(street).toContain("Sunningdale Drive");
    expect(street).toMatch(/is that right/i);

    expect(await call.say("Yes.")).toMatch(/house number/i);

    const readback = await call.say("Eleven.");
    expect(readback).toContain("11 Sunningdale Drive");
    expect(readback).toMatch(/is that correct/i);

    const done = await call.say("Yes.");
    expect(done).toMatch(/what would you like to order/i);

    // The whole address exchange must not touch the model — that is the
    // difference between four seconds a question and half of one.
    expect(call.modelTurns).toBe(0);
    expect(call.state.cart.deliveryAddress.line1).toBe("11 Sunningdale Drive");
    expect(call.state.cart.deliveryAddress.postcode).toBe("NE37 2LL");
    expect(call.state.addressConfirmed).toBe(true);
  });

  it("takes the postcode out of a caller who gives the whole address", async () => {
    // Real transcript: "Five sunny dead arrived, and eight three seven two l l"
    // — someone reeling off "5 Sunningdale Drive, NE37 2LL" in one go. Asking
    // them to repeat just the postcode after that is infuriating.
    const call = new VoiceCallSim({ postcodes: POSTCODES });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");

    const out = await call.say("Five sunny dead arrived, and eight three seven two l l.");
    expect(out).toContain("Sunningdale Drive");
    expect(call.state.addr?.postcode).toBe("NE37 2LL");
  });

  it("lets the caller give the street themselves when the lookup is wrong", async () => {
    const call = new VoiceCallSim({ postcodes: POSTCODES });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");
    await call.say("N E 3 7 2 L L");

    // Saying no must not restart from the postcode — they already gave it.
    const out = await call.say("No.");
    expect(out).toMatch(/street/i);
    expect(out).not.toMatch(/postcode/i);

    const readback = await call.say("11 Fellside Road");
    expect(readback).toContain("11 Fellside Road");
    expect(readback).toMatch(/is that correct/i);
    expect(call.modelTurns).toBe(0);
  });

  it("asks for the street when the postcode is not in the database", async () => {
    const call = new VoiceCallSim({ postcodes: {} });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");
    const out = await call.say("N E 3 7 2 L L");
    expect(out).toMatch(/street/i);
  });

  it("understands 'delivery' even when the transcript mangles it", async () => {
    // Real transcript: "Very very." for "delivery".
    const call = new VoiceCallSim({ postcodes: POSTCODES });
    call.greeting();
    await call.press("1");
    const out = await call.say("Very very.");
    expect(out).toContain("postcode");
    expect(call.modelTurns).toBe(0);
  });

  it("goes straight to the order for collection", async () => {
    const call = new VoiceCallSim({ postcodes: POSTCODES });
    call.greeting();
    await call.press("1");
    const out = await call.say("Collection please.");
    expect(out).toMatch(/what would you like to order/i);
    expect(call.modelTurns).toBe(0);
  });
});
