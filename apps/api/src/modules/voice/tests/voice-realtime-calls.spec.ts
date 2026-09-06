// The four things a caller actually rings for, driven end to end through the
// real speech-to-speech gateway with both sockets faked.
//
// Written because the last five faults on this engine were all found by
// somebody dialling the number and sending me a log. Every one of them was a
// protocol fault reproducible here in milliseconds.

import { VoiceRealtimeSim } from "./voice-realtime-sim";

describe("placing an order", () => {
  it("gets from the greeting to a placed order without going silent", async () => {
    const sim = new VoiceRealtimeSim({
      tools: {
        resolve_address: { result: "That resolves to 11 Follingsby Drive, Gateshead, NE10 8YH." },
        confirm_delivery_address: { result: "Delivery is £2.50." },
        add_item: { result: "Got it — Garlic Bread." },
        read_back_order: { result: "That's one Garlic Bread, £4.00. Is that right?" },
        place_order: { result: "Order placed. About 45 minutes." },
      },
    });
    await sim.answer();

    // The greeting only goes out once the session is accepted — sending it on
    // session.created spoke 24kHz audio down an 8kHz line.
    expect(sim.toModel.filter((m) => m.type === "response.create")).toHaveLength(1);
    await sim.speak("Hello and welcome to Pizza Uno. To place an order, press 1.");

    await sim.press("1");
    await sim.speak("Sure. Is that collection or delivery?");
    await sim.say("Delivery.");
    await sim.speak("What's the delivery address?");

    await sim.say("Eleven Follingsby Drive");
    await sim.callTool("resolve_address", { said: "Eleven Follingsby Drive" });
    await sim.speak("That's 11 Follingsby Drive — is that right?");
    await sim.say("Yes.");
    await sim.callTool("confirm_delivery_address");

    await sim.say("A garlic bread please.");
    await sim.callTool("add_item", { said: "a garlic bread" });
    await sim.callTool("read_back_order");
    await sim.speak("That's one Garlic Bread, four pounds. Is that right?");
    await sim.say("Yes.");
    await sim.callTool("place_order", { paymentMethod: "CASH" });

    expect(sim.toolCalls.map((t) => t.name)).toEqual([
      "resolve_address",
      "confirm_delivery_address",
      "add_item",
      "read_back_order",
      "place_order",
    ]);
    // Not one of them ran twice, however it was announced.
    expect(new Set(sim.toolCalls.map((t) => t.name)).size).toBe(sim.toolCalls.length);
    // And the line was speaking throughout.
    expect(sim.audioOut.length).toBeGreaterThan(0);
  });

  it("never asks for two replies at once", async () => {
    // A tool is announced while the response containing it is still running.
    // Asking then is asking for two, and the second is refused — which is a
    // line that stops talking mid-order.
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.sent.length = 0;

    sim.brain.deliver({ type: "response.created" });
    sim.brain.deliver({
      type: "response.function_call_arguments.done",
      name: "add_item",
      call_id: "c1",
      arguments: "{}",
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(sim.toModel.some((m) => m.type === "conversation.item.create")).toBe(true);
    expect(sim.toModel.some((m) => m.type === "response.create")).toBe(false);

    sim.brain.deliver({ type: "response.done" });
    await new Promise((r) => setTimeout(r, 5));
    expect(sim.toModel.filter((m) => m.type === "response.create")).toHaveLength(1);
  });
});

describe("chasing an order that was already placed", () => {
  it("takes the reference and reports the stage", async () => {
    const sim = new VoiceRealtimeSim({
      tools: {
        find_order: { result: "Order 24 is being made now, about 20 minutes." },
      },
    });
    await sim.answer();
    await sim.press("2");
    await sim.speak("Of course. What's the order number?");
    await sim.say("Twenty four.");
    await sim.callTool("find_order", { reference: "24" });

    expect(sim.toolCalls).toEqual([{ name: "find_order", input: { reference: "24" } }]);
    // Pressing 2 must not be answered by reading the menu out again.
    const told = sim.toModel.find((m) => m.type === "conversation.item.create");
    expect(told.item.content[0].text).toMatch(/update on an order/);
    expect(told.item.content[0].text).toMatch(/without reading the options out again/);
  });
});

describe("changing an order that was already placed", () => {
  it("adds to the existing order rather than starting a new one", async () => {
    const sim = new VoiceRealtimeSim({
      tools: {
        find_order: { result: "Order 24, one Garlic Bread. It has not been made yet." },
        add_item: { result: "Got it — Coca-Cola." },
        amend_order: { result: "Order 24 updated. Total £5.50." },
      },
    });
    await sim.answer();
    await sim.press("3");
    await sim.say("Order twenty four.");
    await sim.callTool("find_order", { reference: "24" });
    await sim.say("Can you add a coke.");
    await sim.callTool("add_item", { said: "a coke" });
    await sim.callTool("amend_order");

    expect(sim.toolCalls.map((t) => t.name)).toEqual(["find_order", "add_item", "amend_order"]);
  });
});

describe("getting through to a person", () => {
  it("transfers on zero without asking the model to notice", async () => {
    const sim = new VoiceRealtimeSim({
      tools: {
        transfer_to_staff: {
          result: "Putting you through.",
          turn: { transferTo: "+441912312345" },
        },
      },
    });
    await sim.answer();
    await sim.press("0");
    await new Promise((r) => setTimeout(r, 3100));

    expect(sim.toolCalls[0]?.name).toBe("transfer_to_staff");
    expect(sim.transfers).toEqual(["+441912312345"]);
  }, 10000);

  it("transfers when the model asks for it too", async () => {
    const sim = new VoiceRealtimeSim({
      tools: {
        transfer_to_staff: {
          result: "Putting you through.",
          turn: { transferTo: "+441912312345" },
        },
      },
    });
    await sim.answer();
    await sim.say("I want to speak to a person.");
    await sim.callTool("transfer_to_staff", { reason: "They asked for a person." });
    await new Promise((r) => setTimeout(r, 3100));

    expect(sim.transfers).toEqual(["+441912312345"]);
  }, 10000);
});

describe("the session the engine actually asks for", () => {
  it("is the GA shape, in the codec a phone line carries", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    const s = sim.session;

    expect(s.type).toBe("realtime");
    expect(s.audio.input.format).toEqual({ type: "audio/pcmu" });
    expect(s.audio.output.format).toEqual({ type: "audio/pcmu" });
    expect(s.output_modalities).toEqual(["audio"]);
    // The debug transcript is the only way to tell the two engines apart.
    expect(s.audio.input.transcription.language).toBe("en");
    expect(s.tools.length).toBeGreaterThan(0);
  });
});

describe("when the line would otherwise go silent", () => {
  it("hands the call over if the model drops mid-call", async () => {
    // A deploy does exactly this: the old instance shuts down and both sockets
    // go with it. The caller is still holding a phone.
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    const moved = jest.spyOn(sim.gateway.telnyx, "startConversationRelay");

    sim.brain.close();
    await new Promise((r) => setTimeout(r, 5));

    expect(moved).toHaveBeenCalled();
    expect(sim.log.join(" ")).toMatch(/dropped mid-call/);
  });

  it("passes the caller's audio to the model", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.sent.length = 0;
    sim.caller.deliver({ event: "media", stream_id: "s1", media: { payload: "QUJD" } });
    await new Promise((r) => setTimeout(r, 5));

    expect(sim.toModel).toContainEqual({ type: "input_audio_buffer.append", audio: "QUJD" });
  });
});

describe("the ways a live call has actually gone quiet", () => {
  // Each of these is a sequence the API really produces and the caller
  // experiences identically: they answer a question and nothing comes back.

  it("recovers when OpenAI refuses a reply because one is already running", async () => {
    // "Conversation already has an active response." Nothing handled this, so
    // the reply that was refused was simply never asked for again — and every
    // later one was fine, but there were no later ones, because the line only
    // speaks in response to something. One refusal ends the call.
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.sent.length = 0;

    sim.brain.deliver({ type: "response.created", response: { id: "r1" } });
    sim.brain.deliver({
      type: "error",
      error: { type: "invalid_request_error", code: "conversation_already_has_active_response" },
    });
    sim.brain.deliver({ type: "response.done", response: { id: "r1" } });
    await new Promise((r) => setTimeout(r, 10));

    expect(sim.toModel.filter((m) => m.type === "response.create")).toHaveLength(1);
  });

  it("does not lose track of two replies running at once", async () => {
    // __responseActive was a yes/no. Two responses in flight and one finishing
    // flipped it to "nothing is running" while something still was, so the
    // next tool asked for a reply mid-reply, was refused, and the line stopped.
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.sent.length = 0;

    sim.brain.deliver({ type: "response.created", response: { id: "r1" } });
    sim.brain.deliver({ type: "response.created", response: { id: "r2" } });
    sim.brain.deliver({ type: "response.done", response: { id: "r1" } });
    sim.brain.deliver({
      type: "response.function_call_arguments.done",
      name: "add_item",
      call_id: "c9",
      arguments: "{}",
    });
    await new Promise((r) => setTimeout(r, 10));

    // r2 is still speaking, so asking now would be refused.
    expect(sim.toModel.some((m) => m.type === "response.create")).toBe(false);
    sim.brain.deliver({ type: "response.done", response: { id: "r2" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(sim.toModel.filter((m) => m.type === "response.create")).toHaveLength(1);
  });

  it("speaks again by itself if the caller's answer got no reply", async () => {
    // The report that started this: "I said delivery and it went silent."
    // Whatever swallowed the turn, a caller waiting on a silent line has to be
    // answered by something.
    const sim = new VoiceRealtimeSim({ quietMs: 60 });
    await sim.answer();
    sim.brain.sent.length = 0;

    await sim.say("Delivery.");
    // ...and the model says nothing at all.
    await new Promise((r) => setTimeout(r, 120));

    expect(sim.toModel.some((m) => m.type === "response.create")).toBe(true);
    expect(sim.log.join(" ")).toMatch(/nothing came back/);
  });

  it("hands over rather than letting the caller sit through a second silence", async () => {
    const sim = new VoiceRealtimeSim({ quietMs: 60 });
    await sim.answer();
    const moved = jest.spyOn(sim.gateway.telnyx, "startConversationRelay");

    await sim.say("Delivery.");
    await new Promise((r) => setTimeout(r, 400));

    expect(moved).toHaveBeenCalled();
  });

  it("stays quiet when the model is already answering", async () => {
    // The nudge must never talk over a reply that is on its way.
    const sim = new VoiceRealtimeSim({ quietMs: 60 });
    await sim.answer();
    sim.brain.sent.length = 0;

    await sim.say("Delivery.");
    await sim.speak("Sure — what's the address?");
    await new Promise((r) => setTimeout(r, 150));

    expect(sim.toModel.some((m) => m.type === "response.create")).toBe(false);
  });
});

it("keeps talking when a tool answers with nothing", async () => {
  // Reading .result off a tool that returned nothing throws where nobody
  // catches it, and the tool output and the reply are both skipped — silence,
  // from a one-line coding slip three files away.
  const sim = new VoiceRealtimeSim({ tools: { add_item: undefined as any } });
  await sim.answer();
  sim.brain.sent.length = 0;
  await sim.callTool("add_item", { said: "a coke" });

  const out = sim.toModel.find((m) => m.item?.type === "function_call_output");
  expect(typeof out.item.output).toBe("string");
  expect(sim.toModel.some((m) => m.type === "response.create")).toBe(true);
});

describe("a model socket that has died without saying so", () => {
  // The real failure, from the call on 6 September: after "what's the delivery
  // address?" the caller answered and not one event came back — no reply, no
  // tool, no error, not even a rate-limit update — while we carried on
  // appending their audio to it. The socket said OPEN throughout.

  it("notices an unanswered ping and hands the call over", async () => {
    const sim = new VoiceRealtimeSim({ pingMs: 30 });
    await sim.answer();
    const moved = jest.spyOn(sim.gateway.telnyx, "startConversationRelay");

    sim.brain.answersPing = false;
    await new Promise((r) => setTimeout(r, 120));

    expect(moved).toHaveBeenCalled();
    expect(sim.log.join(" ")).toMatch(/stopped answering/);
  });

  it("leaves a healthy socket alone", async () => {
    const sim = new VoiceRealtimeSim({ pingMs: 30 });
    await sim.answer();
    const moved = jest.spyOn(sim.gateway.telnyx, "startConversationRelay");
    await new Promise((r) => setTimeout(r, 120));
    expect(moved).not.toHaveBeenCalled();
  });

  it("says what the silence looked like, not just that there was one", async () => {
    // A log of first-occurrence event types cannot tell a stalled model from a
    // dead socket from a line we stopped feeding, and every one of those has
    // cost a live call to guess at.
    const sim = new VoiceRealtimeSim({ quietMs: 40, pingMs: 10_000 });
    await sim.answer();
    sim.caller.deliver({ event: "media", stream_id: "s1", media: { payload: "QUJD" } });
    await sim.say("Eleven Follingsby Drive.");
    await new Promise((r) => setTimeout(r, 80));

    const line = sim.log.find((l) => l.includes("nothing came back"))!;
    expect(line).toMatch(/last "[\w.]+" \d+ms ago/);
    expect(line).toMatch(/\d+ in \/ \d+ out/);
    expect(line).toMatch(/audio \d+ in \/ \d+ out/);
    expect(line).toMatch(/socket 1/);
  });
});

it("does not let line noise talk over the greeting", async () => {
  // "Mhm." was not the caller. It cut the greeting off mid-sentence and the
  // model answered it, so the caller heard half the options and then a
  // question they had not been asked.
  const sim = new VoiceRealtimeSim();
  await sim.answer();
  const vad = sim.session.audio.input.turn_detection;

  expect(vad.threshold).toBeGreaterThan(0.5);
  expect(vad.prefix_padding_ms).toBeGreaterThanOrEqual(300);
  expect(vad.silence_duration_ms).toBeGreaterThanOrEqual(600);
});
