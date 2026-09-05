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

// What a geocoder gives back for a whole spoken address — the postcode
// included, which is the part the caller never says and the driver needs.
const GEOCODED = {
  sunningdale: [
    { line1: "Sunningdale Drive", city: "Washington", postcode: "NE37 2LL" },
  ],
};

// A real postcode covers more than one street — NE37 2LL's Overpass answer
// lists nineteen. Which one is a question, not a guess.
const MANY_STREETS = {
  NE372LL: [
    { line1: "Sunningdale Drive", city: "Washington" },
    { line1: "Birkdale Close", city: "Washington" },
    { line1: "Gleneagles Drive", city: "Washington" },
  ],
};

describe("a delivery order, start to address confirmed", () => {
  it("takes the whole address in one question, postcode included", async () => {
    // The caller says what a person says. They never say the postcode, and
    // they should not have to — the geocoder knows it.
    const call = new VoiceCallSim({ postcodes: POSTCODES, geocoded: GEOCODED });

    expect(call.greeting()).toContain("press 1");
    expect(await call.press("1")).toContain("collection or delivery");
    expect(await call.say("Delivery.")).toMatch(/delivery address/i);

    const readback = await call.say("Eleven Sunningdale Drive, Washington.");
    expect(readback).toContain("11 Sunningdale Drive");
    expect(readback).toMatch(/is that right/i);

    const done = await call.say("Yes.");
    expect(done).toMatch(/what would you like to order/i);

    // One question, not three — and still no model call anywhere in it.
    expect(call.modelTurns).toBe(0);
    expect(call.state.cart.deliveryAddress.line1).toBe("11 Sunningdale Drive");
    expect(call.state.cart.deliveryAddress.postcode).toBe("NE37 2LL");
    expect(call.state.addressConfirmed).toBe(true);
  });

  it("keeps the house number the caller gave, not the geocoder's idea of one", async () => {
    const call = new VoiceCallSim({ postcodes: POSTCODES, geocoded: GEOCODED });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");

    const out = await call.say("Twenty two Sunningdale Drive Washington");
    expect(out).toContain("22 Sunningdale Drive");
  });

  it("will not read back an address whose street is not the one they said", async () => {
    // Real Nominatim behaviour: asked for "22 Fellside Road Gateshead" its top
    // hit was a takeaway on Whitewell Road. Position zero is not an answer.
    const call = new VoiceCallSim({
      postcodes: POSTCODES,
      geocoded: {
        "fellside": [
          { line1: "22 Whitewell Road", city: "Blaydon on Tyne", postcode: "NE21 5HH" },
        ],
      },
    });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");

    const out = await call.say("Twenty two Fellside Road, Gateshead.");
    expect(out).not.toContain("Whitewell");
    expect(out).toMatch(/postcode/i);
  });

  it("drops to the postcode ladder when the address will not resolve", async () => {
    // The ladder is slower but nearly unbreakable, and it is the reason the
    // line never has to tell somebody it cannot take their address.
    const call = new VoiceCallSim({ postcodes: POSTCODES, geocoded: {} });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");

    expect(await call.say("Eleven Sunningdale Drive.")).toMatch(/postcode/i);

    const street = await call.say("N E 3 7 2 L L");
    expect(street).toContain("Sunningdale Drive");
    expect(street).toMatch(/is that right/i);

    expect(await call.say("Yes.")).toMatch(/house number/i);
    const readback = await call.say("Eleven.");
    expect(readback).toContain("11 Sunningdale Drive");
    expect(call.modelTurns).toBe(0);
  });

  it("does not ask for a postcode twice when it cannot resolve either", async () => {
    const call = new VoiceCallSim({ postcodes: {}, geocoded: {} });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");
    const first = await call.say("Somewhere it has never heard of.");
    expect(first).toMatch(/postcode/i);

    // The ladder escalates rather than repeating itself. Asking the identical
    // question again is how a caller decides the line is broken — so each miss
    // asks for the same thing a different way, and then for something else
    // entirely. What it must never do is give up.
    const second = await call.say("Still nowhere.");
    expect(second).toMatch(/one character at a time/i);

    const third = await call.say("Nope.");
    expect(third).toMatch(/street and house number/i);
    expect(call.modelTurns).toBe(0);
  });

  it("takes a postcode said inside the address, when that is all that resolves", async () => {
    // "Five sunny dead arrived, and eight three seven two l l" — someone
    // reeling off the whole thing at once. If the sentence doesn't geocode,
    // the postcode inside it must not be thrown away.
    const call = new VoiceCallSim({ postcodes: POSTCODES, geocoded: {} });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");

    await call.say("Five sunny dead arrived, and eight three seven two l l.");
    expect(call.state.addr?.postcode).toBe("NE37 2LL");
  });

  it("lets the caller give the street themselves when the ladder's lookup is wrong", async () => {
    const call = new VoiceCallSim({ postcodes: POSTCODES, geocoded: {} });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");
    await call.say("No idea.");
    await call.say("N E 3 7 2 L L");

    // Saying no must not restart from the postcode — they already gave it.
    const out = await call.say("No.");
    expect(out).toMatch(/street/i);
    expect(out).not.toMatch(/postcode/i);

    const readback = await call.say("11 Fellside Road");
    expect(readback).toContain("11 Fellside Road");
    expect(call.modelTurns).toBe(0);
  });

  it("uses the postcode as the answer, never as a search term", async () => {
    // From a live call: asked for the delivery address, the caller said only
    // "n e three seven two l l". That was sent to a free-text geocoder as
    // though it were a street name, found nothing, and dropped to the ladder.
    // A postcode is a unique key — it does not need searching for.
    const call = new VoiceCallSim({
      postcodes: POSTCODES,
      geocoded: {
        // If this is ever consulted the point of the test is lost: a
        // free-text search for a street name is what produced Salford.
        sunningdale: [{ line1: "Sunningdale Drive", city: "Salford", postcode: "M27 5AB" }],
      },
    });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");

    const out = await call.say("Five Sunningdale Drive, N E 3 7 2 L L");
    expect(out).toContain("5 Sunningdale Drive");
    expect(out).not.toContain("Salford");
    expect(call.state.cart.deliveryAddress.postcode).toBe("NE37 2LL");
    expect(call.modelTurns).toBe(0);
  });

  it("asks only for the number when the postcode gave the street", async () => {
    const call = new VoiceCallSim({ postcodes: POSTCODES, geocoded: {} });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");

    const out = await call.say("N E 3 7 2 L L");
    expect(out).toContain("Sunningdale Drive");
    expect(out).toMatch(/house number/i);

    const readback = await call.say("Eleven.");
    expect(readback).toContain("11 Sunningdale Drive");
    expect(call.modelTurns).toBe(0);
  });

  it("understands 'delivery' even when the transcript arrives split in two", async () => {
    // Real transcript: "De livello." Nothing token-shaped could see the word,
    // so this turn went to the model — and so did every turn after it, which
    // is how the address ended up being driven unfenced.
    const call = new VoiceCallSim({ postcodes: POSTCODES, geocoded: GEOCODED });
    call.greeting();
    await call.press("1");
    const out = await call.say("De livello.");
    expect(out).toMatch(/delivery address/i);
    expect(call.modelTurns).toBe(0);
  });

  it("understands 'delivery' even when the transcript mangles it", async () => {
    // Real transcript: "Very very." for "delivery".
    const call = new VoiceCallSim({ postcodes: POSTCODES, geocoded: GEOCODED });
    call.greeting();
    await call.press("1");
    const out = await call.say("Very very.");
    expect(out).toMatch(/delivery address/i);
    expect(call.modelTurns).toBe(0);
  });

  it("takes a house number offered at the street check", async () => {
    // "Eleven." answering "is that Sunningdale Drive?" is a yes with the next
    // answer already attached. Treating it as neither sent the turn to the
    // model and then asked for the number all over again.
    const call = new VoiceCallSim({ postcodes: MANY_STREETS, geocoded: {} });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");
    await call.say("N E 3 7 2 L L");

    const readback = await call.say("Eleven.");
    expect(readback).toContain("11 Sunningdale Drive");
    expect(call.modelTurns).toBe(0);
  });

  it("does not ask twice for a number they already said", async () => {
    // "Five signing their drive" — the street was too mangled to match, so we
    // fall back to confirming it, but the five was never in doubt.
    const call = new VoiceCallSim({ postcodes: MANY_STREETS, geocoded: {} });
    call.greeting();
    await call.press("1");
    await call.say("Delivery.");
    await call.say("Five signing their drive, n e three seven two l l.");

    const readback = await call.say("Yes.");
    expect(readback).toContain("5 Sunningdale Drive");
    expect(readback).not.toMatch(/house number/i);
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
