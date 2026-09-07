// Stage 1 hardening — the findings from the external review at e445d716.
//
// Each block names the failure it guards against. Where a test could pass by
// accident, there is a control alongside it showing the same scenario fail
// without the fix.

import { VoiceRealtimeSim } from "./voice-realtime-sim";
import { VoiceService } from "../voice.service";
import { VoiceAiService, coerceState } from "../voice-ai.service";

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** Two seconds of μ-law, base64. */
const TWO_SECONDS = Buffer.alloc(16_000).toString("base64");

// ───────────────────────────────────────────────────────────────────────────
// 1. A number is an answer. Nothing is proof of nothing.
// ───────────────────────────────────────────────────────────────────────────
describe("1. what counts as speech", () => {
  it("does not call a numeric answer background noise", async () => {
    // "For your pizza size, press 1 for 10", 2 for 12"…" — heard "12".
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.sent.length = 0;

    sim.brain.deliver({ type: "input_audio_buffer.committed", item_id: "u1" });
    sim.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "12",
    });
    await settle();

    expect(sim.log.join(" ")).not.toMatch(/returned nothing|not speech/);
    expect(sim.toModel.some((m) => m.type === "conversation.item.create")).toBe(false);
  });

  it("does not tell the model the caller was silent when the transcriber returned nothing", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.sent.length = 0;

    sim.brain.deliver({ type: "input_audio_buffer.committed", item_id: "u1" });
    sim.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "",
    });
    await settle();

    const told = sim.toModel.find((m) => m.type === "conversation.item.create");
    expect(told.item.content[0].text).toMatch(/returned no words/);
    expect(told.item.content[0].text).not.toMatch(/has NOT answered/);
    expect(told.item.content[0].text).toMatch(/NOT a yes/);
    // And it does not interrupt anything.
    expect(sim.toModel.some((m) => m.type === "response.cancel")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. A yes belongs to a question, and is spent once.
// ───────────────────────────────────────────────────────────────────────────
describe("2. turn correlation", () => {
  const consentSim = () =>
    new VoiceRealtimeSim({ tools: { use_usual: { result: "loaded" } } });

  const ask = (sim: VoiceRealtimeSim, text: string) =>
    sim.brain.deliver({ type: "response.output_audio_transcript.done", transcript: text });
  const heard = (sim: VoiceRealtimeSim, id: string, text: string) => {
    sim.brain.deliver({ type: "input_audio_buffer.committed", item_id: id });
    sim.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: id,
      transcript: text,
    });
  };
  const toolIn = (sim: VoiceRealtimeSim, responseId: string, name: string) => {
    sim.brain.deliver({ type: "response.created", response: { id: responseId } });
    sim.brain.deliver({
      type: "response.function_call_arguments.done",
      response_id: responseId,
      name,
      call_id: `c-${responseId}`,
      arguments: "{}",
    });
  };

  it("rejects words said BEFORE the question as an answer to it", async () => {
    const sim = consentSim();
    await sim.answer();
    heard(sim, "u1", "yes");                 // said in answer to something earlier
    ask(sim, "Would you like the same as last time?");
    toolIn(sim, "r1", "use_usual");
    await settle(50);

    expect(sim.toolCalls[0].input.__heardFresh).toBe(false);
  });

  it("accepts words said after the question, even if the model spoke first in the same reply", async () => {
    const sim = consentSim();
    await sim.answer();
    ask(sim, "Would you like the same as last time?");
    heard(sim, "u1", "yes");
    // The reply starts, the model says a word, THEN calls the tool.
    sim.brain.deliver({ type: "response.created", response: { id: "r1" } });
    ask(sim, "Lovely.");                     // askSeq moves on inside the reply
    sim.brain.deliver({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      name: "use_usual",
      call_id: "c1",
      arguments: "{}",
    });
    await settle(50);

    expect(sim.toolCalls[0].input.__heard).toBe("yes");
    expect(sim.toolCalls[0].input.__heardFresh).toBe(true);
  });

  it("does not let one yes confirm two things", async () => {
    const sim = new VoiceRealtimeSim({
      tools: { use_usual: { result: "loaded" }, use_saved_address: { result: "used" } },
    });
    await sim.answer();
    ask(sim, "Same as last time?");
    heard(sim, "u1", "yes");
    toolIn(sim, "r1", "use_usual");
    await settle(50);
    sim.brain.deliver({ type: "response.done", response: { id: "r1" } });
    toolIn(sim, "r2", "use_saved_address");
    await settle(50);

    expect(sim.toolCalls[0].input.__heardFresh).toBe(true);
    expect(sim.toolCalls[1].input.__heardFresh).toBe(false); // spent
    expect(sim.toolCalls[1].input.__heardItemId).toBe("u1");
  });

  it("files a transcript under its own turn when it arrives late", async () => {
    // Two turns committed; the FIRST one's transcript arrives last.
    const sim = consentSim();
    await sim.answer();
    ask(sim, "Same as last time?");
    sim.brain.deliver({ type: "input_audio_buffer.committed", item_id: "u1" });
    ask(sim, "Sorry, was that a yes?");
    sim.brain.deliver({ type: "input_audio_buffer.committed", item_id: "u2" });
    sim.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u2",
      transcript: "yes",
    });
    sim.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "no",                       // late
    });
    toolIn(sim, "r1", "use_usual");
    await settle(50);

    // The newest committed turn wins, not the newest transcript.
    expect(sim.toolCalls[0].input.__heard).toBe("yes");
    expect(sim.toolCalls[0].input.__heardItemId).toBe("u2");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Interruption tells the model where it was cut off.
// ───────────────────────────────────────────────────────────────────────────
describe("3. truncation on interruption", () => {
  const playTwoSeconds = (sim: VoiceRealtimeSim, responseId: string, itemId: string) => {
    sim.brain.deliver({ type: "response.created", response: { id: responseId } });
    sim.brain.deliver({ type: "response.output_item.added", item: { id: itemId, type: "message" } });
    sim.brain.deliver({
      type: "response.output_audio.delta",
      response_id: responseId,
      item_id: itemId,
      content_index: 0,
      delta: TWO_SECONDS,
    });
  };
  const truncateSent = (sim: VoiceRealtimeSim) =>
    sim.toModel.find((m) => m.type === "conversation.item.truncate");

  it("truncates at the playback position on a keypress", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    playTwoSeconds(sim, "r1", "a1");
    await settle(60);
    await sim.press("1");

    const t = truncateSent(sim);
    expect(t).toBeDefined();
    expect(t.item_id).toBe("a1");
    expect(t.content_index).toBe(0);
    // Played some, not all: the caller was part-way through.
    expect(t.audio_end_ms).toBeGreaterThanOrEqual(0);
    expect(t.audio_end_ms).toBeLessThan(2000);
    expect(sim.toModel.some((m) => m.type === "response.cancel")).toBe(true);
    expect(sim.caller.sent.some((m: any) => m.event === "clear")).toBe(true);
  });

  it("truncates on the caller starting to speak", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    playTwoSeconds(sim, "r1", "a1");
    await settle(30);
    sim.brain.deliver({ type: "input_audio_buffer.speech_started" });
    await settle();

    expect(truncateSent(sim)?.item_id).toBe("a1");
  });

  it("still truncates when generation has finished but the line is still playing", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    playTwoSeconds(sim, "r1", "a1");
    sim.brain.deliver({ type: "response.done", response: { id: "r1" } }); // generation over
    await settle(30);
    sim.brain.sent.length = 0;
    await sim.press("1");

    expect(truncateSent(sim)?.item_id).toBe("a1");
    // Nothing to cancel — generation is done — and nothing is sent to cancel.
    expect(sim.toModel.some((m) => m.type === "response.cancel")).toBe(false);
  });

  it("drops late audio from the cancelled reply but plays the next reply's first frame", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    playTwoSeconds(sim, "r1", "a1");
    await sim.press("1");
    sim.caller.sent.length = 0;

    // Straggler from r1, and the very first frame of r2, interleaved.
    sim.brain.deliver({ type: "response.created", response: { id: "r2" } });
    sim.brain.deliver({ type: "response.output_audio.delta", response_id: "r2", item_id: "a2", delta: "NEW1" });
    sim.brain.deliver({ type: "response.output_audio.delta", response_id: "r1", item_id: "a1", delta: "OLD" });
    sim.brain.deliver({ type: "response.output_audio.delta", response_id: "r2", item_id: "a2", delta: "NEW2" });
    await settle();

    expect(sim.audioOut.map((m) => m.media.payload)).toEqual(["NEW1", "NEW2"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. One thing at a time, per call.
// ───────────────────────────────────────────────────────────────────────────
describe("4. serialised state changes", () => {
  const PIZZA = {
    id: "gd",
    name: "GRAN DUCA",
    price: 12,
    modifierGroups: [
      { id: "size", name: "Size", required: true, min: 1,
        options: [{ id: "z10", name: '10"', price: 0 }, { id: "z12", name: '12"', price: 2 }] },
      { id: "crust", name: "Crust", required: true, min: 1,
        options: [{ id: "c1", name: "Thin", price: 0 }, { id: "c2", name: "Deep Pan", price: 0 }] },
    ],
  };
  const MENU: any[] = [PIZZA];
  const ctx = () => {
    const c: any = { currency: "GBP", items: MENU };
    c.itemIndex = new Map(MENU.map((i: any) => [i.id, i]));
    c.optionIndex = new Map(MENU.flatMap((i: any) =>
      (i.modifierGroups ?? []).flatMap((g: any) =>
        g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }]))));
    return c;
  };

  /** A service whose "database" hands out COPIES, the way a real one does. */
  const build = () => {
    const ai: any = Object.create(VoiceAiService.prototype);
    ai.logger = { log() {}, warn() {}, error() {} };
    const c = ctx();
    let store: any = { cart: { items: [] }, turns: [], stage: "ORDER" };
    ai.addItem({ itemId: "gd" }, c, store);          // at the size question
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.ai = ai;
    s.db = () => ({ voiceCall: { update: async () => {} } });
    s.loadByControlId = async () => {
      await settle(5);                                 // a real read takes time
      return { call: { id: "c1" }, ctx: c, state: coerceState(JSON.parse(JSON.stringify(store))) };
    };
    s.save = async (_id: string, state: any) => {
      await settle(5);
      store = JSON.parse(JSON.stringify(state));
    };
    return { s, state: () => store };
  };

  it("keeps both answers when two keypresses overlap", async () => {
    const { s, state } = build();
    await Promise.all([s.realtimeDigit("cc1", "2"), s.realtimeDigit("cc1", "2")]);
    // Size chosen, then crust chosen: the second press landed on the state
    // the first one wrote.
    expect(state().pendingItem.chosen).toEqual(["z12", "c2"]);
  });

  it("CONTROL: without the lock the second press overwrites the first", async () => {
    const { s, state } = build();
    await Promise.all([s.realtimeDigitUnlocked("cc1", "2"), s.realtimeDigitUnlocked("cc1", "2")]);
    expect(state().pendingItem.chosen).not.toEqual(["z12", "c2"]);
  });

  it("cannot commit the same pending item twice", async () => {
    const { s, state } = build();
    await s.realtimeDigit("cc1", "2");                 // size
    await s.realtimeDigit("cc1", "2");                 // crust → note question
    expect(state().pendingItem.notesAsked).toBe(true);
    await Promise.all([s.realtimeDigit("cc1", "1"), s.realtimeDigit("cc1", "1")]); // "no note", twice
    expect(state().cart.items).toHaveLength(1);
    expect(state().pendingItem).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. A confirmation is for one version of one thing.
// ───────────────────────────────────────────────────────────────────────────
describe("5. versioned confirmations", () => {
  const ai = () => {
    const a: any = Object.create(VoiceAiService.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    return a;
  };
  const ctx = () => ({
    currency: "GBP", items: [], itemIndex: new Map(), optionIndex: new Map(),
    deliveryZones: [{ id: "z", postcodePrefix: "NE10", fee: 1 }], locationName: "Test",
  }) as any;
  const withChips = () => ({
    cart: { items: [{ lineId: "a", name: "CHIPS", quantity: 1, unitBasePrice: 2, modifiers: [] }] },
    turns: [],
  }) as any;
  const YES = { __heard: "yes", __heardFresh: true, __heardReadable: true };

  it("confirm_delivery_address needs the caller to have said yes", async () => {
    const a = ai();
    const st = withChips();
    st.cart.deliveryAddress = { line1: "1 Test Street", city: "Gateshead", postcode: "NE10 8YH" };

    const silent = await a.runTool("confirm_delivery_address", {}, ctx(), st, null);
    expect(silent.sayNow).toMatch(/Press 1 for yes, or 2 for no/);
    expect(st.addressConfirmed).toBeFalsy();

    const no = await a.runTool("confirm_delivery_address", { __heard: "no that's wrong", __heardFresh: true, __heardReadable: true }, ctx(), st, null);
    expect(no.result).toMatch(/not said that address is right/);
    expect(st.addressConfirmed).toBe(false);

    const yes = await a.runTool("confirm_delivery_address", YES, ctx(), st, null);
    expect(yes.result).toMatch(/Address confirmed/);
    expect(a.addressStillConfirmed(st)).toBe(true);
  });

  it("an address confirmed and then changed is not confirmed", async () => {
    const a = ai();
    const st = withChips();
    st.cart.deliveryAddress = { line1: "1 Test Street", city: "Gateshead", postcode: "NE10 8YH" };
    await a.runTool("confirm_delivery_address", YES, ctx(), st, null);
    st.cart.deliveryAddress.line1 = "2 Test Street";
    expect(st.addressConfirmed).toBe(true);           // the flag lies
    expect(a.addressStillConfirmed(st)).toBe(false);  // the version does not
  });

  it("order_confirmed needs a read-back of the order as it stands", async () => {
    const a = ai();
    const st = withChips();
    const c = ctx();
    const early = await a.runTool("order_confirmed", YES, c, st, null);
    expect(early.result).toMatch(/has not been read back/);
    expect(st.orderConfirmed).toBeFalsy();

    await a.runTool("read_back_order", {}, c, st, null);
    const ok = await a.runTool("order_confirmed", YES, c, st, null);
    expect(ok.result).toMatch(/Confirmed/);
    expect(a.orderStillConfirmed(st)).toBe(true);
  });

  it("a change after the read-back invalidates the confirmation", async () => {
    const a = ai();
    const st = withChips();
    const c = ctx();
    await a.runTool("read_back_order", {}, c, st, null);
    st.cart.items.push({ lineId: "b", name: "COKE", quantity: 1, unitBasePrice: 1.5, modifiers: [] });

    const out = await a.runTool("order_confirmed", YES, c, st, null);
    expect(out.result).toMatch(/has CHANGED since it was read back/);
    expect(st.orderConfirmed).toBeFalsy();
  });

  it("a change after confirmation blocks placing the order", async () => {
    const a = ai();
    const st = withChips();
    const c = ctx();
    await a.runTool("read_back_order", {}, c, st, null);
    await a.runTool("order_confirmed", YES, c, st, null);
    st.cart.items[0].quantity = 2;                     // "actually make that two"
    st.cart.fulfillmentType = "COLLECTION";

    const out = await a.placeOrder({ customerName: "T", paymentMethod: "CASH" }, c, st, "+447700900000");
    expect(out.result).toMatch(/CHANGED since it was confirmed/);
    expect(st.orderId).toBeUndefined();
  });

  it("blocks read-back, confirmation and checkout while an item is unresolved", async () => {
    const a = ai();
    const st = withChips();
    const c = ctx();
    st.pendingItem = { itemId: "x", quantity: 1, chosen: [], walked: true };
    expect((await a.runTool("read_back_order", {}, c, st, null)).result).toMatch(/still being finished/);
    expect((await a.runTool("order_confirmed", YES, c, st, null)).result).toMatch(/still being finished/);
    expect((await a.placeOrder({ paymentMethod: "CASH" }, c, st, "+4477")).result).toMatch(/still being finished/);
  });

  it("a keypad yes about an earlier basket does not confirm the current one", () => {
    const a = ai();
    const st = withChips();
    a.confirmByKeypad(st, "order", "Is that all correct?");
    st.cart.items.push({ lineId: "b", name: "COKE", quantity: 1, unitBasePrice: 1.5, modifiers: [] });
    st.pendingConfirm.answered = "YES";                // pressed 1 — about the OLD basket

    const v = a.agreed({}, st);
    expect(v.ok).toBe(false);
    expect(v.unclear).toBe(true);
    expect(v.why).toMatch(/earlier version/);
  });
});
