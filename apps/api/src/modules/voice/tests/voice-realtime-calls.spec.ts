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

    // Every tool also carries what the caller last said, so a tool that needs
    // their actual words — the saved address, above all — can be held to them.
    expect(sim.toolCalls).toEqual([
      {
        name: "find_order",
        input: {
          reference: "24",
          __heard: "Twenty four.",
          __heardFresh: expect.any(Boolean),
          __heardReadable: expect.any(Boolean),
          __heardItemId: expect.anything(),
        },
      },
    ]);
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

  it("recovers a TOOL's reply that OpenAI refused as one already running", async () => {
    // "Conversation already has an active response." Nothing handled this, so
    // the tool output was never spoken about — and the line only speaks when
    // asked to, so one refusal ended the call.
    //
    // Only a tool's reply is saved for later. A refused WATCHDOG nudge is
    // dropped, because flushing that one made the model answer a question the
    // caller had not been given a chance to answer.
    const sim = new VoiceRealtimeSim({ tools: { add_item: { result: "Got it." } } });
    await sim.answer();
    sim.brain.deliver({ type: "response.created", response: { id: "r1" } });
    sim.brain.sent.length = 0;

    sim.brain.deliver({
      type: "response.function_call_arguments.done",
      name: "add_item",
      call_id: "c1",
      arguments: "{}",
    });
    await new Promise((r) => setTimeout(r, 10));
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

it("listens with silence detection, because semantic detection went deaf", async () => {
  // Semantic detection reads better on paper and stopped detecting turns at
  // all on this phone line: three calls in a row where the caller said hello
  // and not one speech event came back. Too eager was a bug; deaf is worse.
  //
  // The breath problem it was meant to solve is handled on the transcript
  // instead — a turn with no words in it cannot count as an answer, whatever
  // detected it.
  const sim = new VoiceRealtimeSim();
  await sim.answer();
  const vad = sim.session.audio.input.turn_detection;
  expect(vad.type).toBe("server_vad");
  expect(vad.threshold).toBeGreaterThanOrEqual(0.6);
  expect(vad.silence_duration_ms).toBeGreaterThanOrEqual(600);
});

it("hands over even when the menu cannot be read", () => {
  // The handover runs when the caller is ALREADY in silence. Anything it
  // depends on is another way for that silence to become permanent — so the
  // menu terms the new transcriber would like are strictly optional.
  const sim = new VoiceRealtimeSim();
  return sim.answer().then(async () => {
    const moved = jest.spyOn(sim.gateway.telnyx, "startConversationRelay");
    sim.gateway.voice.keytermsFor = () => Promise.reject(new Error("database gone"));

    sim.brain.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(moved).toHaveBeenCalled();
  });
});

describe("what a caller hears when the call changes engine", () => {
  // Reported from a live call: "it is not saying the shop name and it says
  // sorry ... it looks like it switched to the other mode automatically". All
  // three observations were correct, and the apology was the bug.

  it("greets a caller who has not heard anything yet", async () => {
    // The session never became ready, so this caller has heard NOTHING. They
    // are being greeted a second late, not apologised to — and they still need
    // the shop's name and the menu, which the apology skipped entirely.
    const sim = new VoiceRealtimeSim({
      greeting: "Hello and welcome to Pizza Uno. To place an order, press 1.",
    });
    const started = jest.spyOn(sim.gateway.telnyx, "startConversationRelay");
    await sim.gateway.attach(sim.caller, "cc-late");
    // ...and the model never says a word.
    await new Promise((r) => setTimeout(r, 60));
    await sim.gateway.fallbackToRelay("cc-late", { alreadySpoke: false });

    const greeting = started.mock.calls.at(-1)![1].greeting;
    expect(greeting).toContain("Pizza Uno");
    expect(greeting).toContain("press 1");
    expect(greeting).not.toMatch(/sorry/i);
  });

  it("admits the restart to a caller who was mid-conversation", async () => {
    // This one HAS been talking to something that has now gone, and answered
    // questions that were never written down. Pretending to carry on would
    // mean acting on an order we do not have.
    const sim = new VoiceRealtimeSim();
    const started = jest.spyOn(sim.gateway.telnyx, "startConversationRelay");
    await sim.answer("cc-mid");
    await sim.gateway.fallbackToRelay("cc-mid", { alreadySpoke: true });

    const greeting = started.mock.calls.at(-1)![1].greeting;
    expect(greeting).toMatch(/Sorry about that/);
    expect(greeting).toMatch(/collection or delivery/);
  });

  it("still greets when the shop's own greeting cannot be read", async () => {
    const sim = new VoiceRealtimeSim();
    const started = jest.spyOn(sim.gateway.telnyx, "startConversationRelay");
    sim.gateway.voice.realtimeSession = () => Promise.reject(new Error("no database"));
    await sim.gateway.fallbackToRelay("cc-x", { alreadySpoke: false });

    expect(started.mock.calls.at(-1)![1].greeting).toBeTruthy();
  });

  it("says what the model socket did before it gave up", async () => {
    // A socket that never opened, one that opened and heard nothing back, and
    // a session refused in a way we missed all look identical in a log that
    // only says the call was handed over.
    const sim = new VoiceRealtimeSim({ readyMs: 40 });
    await sim.gateway.attach(sim.caller, "cc-quiet");
    sim.brain.emit("open");
    await new Promise((r) => setTimeout(r, 90));

    const line = sim.log.find((l) => l.includes("never became ready"))!;
    expect(line).toMatch(/socket \d/);
    expect(line).toMatch(/\d+ events in \/ \d+ out/);
  });
});

describe("a session OpenAI refuses outright", () => {
  it("hands over at once instead of waiting out the clock", async () => {
    // The real one, from 6 September:
    //   "Instructions cannot be longer than 16384 tokens, you have provided
    //    69319 tokens." — the whole menu was in the prompt.
    // A refusal is not going to become an acceptance by waiting, and until
    // this the readiness timer was the only thing watching: five more seconds
    // of silence on a call where the greeting had not been spoken yet.
    const sim = new VoiceRealtimeSim({ readyMs: 10_000 });
    const moved = jest.spyOn(sim.gateway.telnyx, "startConversationRelay");
    await sim.gateway.attach(sim.caller, "cc-refused");
    sim.brain.emit("open");
    await new Promise((r) => setTimeout(r, 5));

    sim.brain.deliver({ type: "session.created" });
    sim.brain.deliver({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "invalid_value",
        message: "Instructions cannot be longer than 16384 tokens, you have provided 69319 tokens.",
        param: "session.instructions",
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(moved).toHaveBeenCalled();
    expect(sim.log.join(" ")).toMatch(/session refused — handing to the standard engine now/);
  });

  it("does not hand over for an error once the call is running", async () => {
    // Mid-call errors are recoverable and are handled elsewhere. Throwing the
    // caller onto another engine for one would lose the order they are in the
    // middle of placing.
    const sim = new VoiceRealtimeSim();
    await sim.answer("cc-live");
    const moved = jest.spyOn(sim.gateway.telnyx, "startConversationRelay");

    sim.brain.deliver({
      type: "error",
      error: { type: "invalid_request_error", param: "session.instructions" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(moved).not.toHaveBeenCalled();
  });
});

describe("words the model is not allowed to rephrase", () => {
  // The read-back is the promise this whole line rests on: what is said aloud
  // has to BE the basket, priced from the basket. On 6 September the model
  // read back a pepperoni pizza it had never added, the caller said yes, and
  // chips and a garlic sauce reached the kitchen. The chained engine has
  // always spoken these verbatim; this one was dropping the script.

  it("insists on the exact words when a tool provides them", async () => {
    const sim = new VoiceRealtimeSim({
      tools: {
        read_back_order: {
          result: "Read it back.",
          sayNow: "So that's 1 PEPPERONI and 1 CHIPS, for collection. That comes to £10.70. Is that all correct?",
        } as any,
      },
    });
    await sim.answer();
    sim.brain.sent.length = 0;
    await sim.callTool("read_back_order");

    const ask = sim.toModel.find((m) => m.type === "response.create");
    expect(ask.response.instructions).toContain("word for word");
    expect(ask.response.instructions).toContain("£10.70");
    expect(ask.response.instructions).toContain("1 PEPPERONI and 1 CHIPS");
  });

  it("still insists when the words had to wait for a reply to finish", async () => {
    const sim = new VoiceRealtimeSim({
      tools: { place_order: { result: "Placed.", sayNow: "That's all booked in, order number 4, 0, 1, 2." } as any },
    });
    await sim.answer();
    sim.brain.sent.length = 0;

    // The tool is announced while a reply is still being spoken.
    sim.brain.deliver({ type: "response.created", response: { id: "r1" } });
    sim.brain.deliver({
      type: "response.function_call_arguments.done",
      name: "place_order",
      call_id: "p1",
      arguments: "{}",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(sim.toModel.some((m) => m.type === "response.create")).toBe(false);

    sim.brain.deliver({ type: "response.done", response: { id: "r1" } });
    await new Promise((r) => setTimeout(r, 10));

    const ask = sim.toModel.find((m) => m.type === "response.create");
    expect(ask.response.instructions).toContain("order number 4, 0, 1, 2");
  });

  it("leaves ordinary answers to the model", async () => {
    // Only facts about the basket are scripted. Everything else is a
    // conversation, and scripting it would make the line wooden.
    const sim = new VoiceRealtimeSim({ tools: { find_item: { result: "That's a Pepperoni." } } });
    await sim.answer();
    sim.brain.sent.length = 0;
    await sim.callTool("find_item", { said: "pepperoni" });

    const ask = sim.toModel.find((m) => m.type === "response.create");
    expect(ask.response).toBeUndefined();
  });
});

describe("the line never just goes quiet", () => {
  // The operator's rule, in their words: "never stay on silent, always ask or
  // say start over". From the caller's side, silence on a phone is
  // indistinguishable from having been hung up on — and they said no to
  // something and heard nothing at all.

  it("says a sentence they can answer, rather than trying the model again", async () => {
    // Asking a model that has just produced nothing to produce something is
    // asking the question that already failed.
    const sim = new VoiceRealtimeSim({ quietMs: 40 });
    await sim.answer();
    sim.brain.sent.length = 0;

    await sim.say("No.");
    await new Promise((r) => setTimeout(r, 90));

    const ask = sim.toModel.find((m) => m.type === "response.create");
    expect(ask.response.instructions).toMatch(/Sorry, I lost you there/);
    expect(ask.response.instructions).toMatch(/take the order from the top/);
  });

  it("does not wait long enough for it to feel like a dead line", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    await sim.say("Delivery.");
    await new Promise((r) => setTimeout(r, 3400));
    expect(sim.log.join(" ")).toMatch(/nothing came back/);
  }, 10000);
});

describe("pressing a key stops the line talking", () => {
  // "When I press option 1 it still continues reading the options to the end."
  // The whole point of a keypad is that it ends the menu.

  it("cancels the reply that is being spoken", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    // The greeting is playing.
    sim.brain.deliver({ type: "response.created", response: { id: "greeting" } });
    sim.brain.sent.length = 0;

    await sim.press("1");

    const types = sim.toModel.map((m) => m.type);
    expect(types[0]).toBe("response.cancel");
    expect(types).toContain("conversation.item.create");
    expect(types).toContain("response.create");
  });

  it("throws away audio still arriving from the cancelled reply", async () => {
    // Cancelling stops the model generating, but whatever it already produced
    // is still on its way — and playing the rest of a menu the caller has
    // answered is the thing that makes a phone system feel like a phone
    // system.
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.deliver({ type: "response.created", response: { id: "greeting" } });
    await sim.press("1");
    sim.caller.sent.length = 0;

    sim.brain.deliver({ type: "response.output_audio.delta", delta: "TAIL" });
    await new Promise((r) => setTimeout(r, 5));
    expect(sim.audioOut).toHaveLength(0);

    // ...and the NEXT reply plays normally.
    sim.brain.deliver({ type: "response.created", response: { id: "answer" } });
    sim.brain.deliver({ type: "response.output_audio.delta", delta: "NEW" });
    await new Promise((r) => setTimeout(r, 5));
    expect(sim.audioOut).toHaveLength(1);
  });

  it("does not cancel when nothing is being said", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.sent.length = 0;
    await sim.press("2");
    expect(sim.toModel.map((m) => m.type)).not.toContain("response.cancel");
  });
});

describe("silence with nothing to trigger a recovery", () => {
  // The real one, 6 September 22:22. The line asked "would you like the same
  // as last time — chips and garlic sauce, delivered to 11 Follingsby Drive?",
  // the caller said no, and the log records NOTHING after that. No transcript,
  // no reply, no watchdog: it was armed only by a transcription arriving or a
  // tool running, and neither happened. The line sat silent until the caller
  // gave up.
  //
  // A caller is owed words whenever the line has stopped talking, whatever did
  // or did not happen next.

  it("checks in when the caller has gone quiet after a question", async () => {
    const sim = new VoiceRealtimeSim({ idleMs: 60 });
    await sim.answer();
    sim.brain.sent.length = 0;

    // The line asks its question and finishes speaking. Then nothing at all —
    // no transcript, no speech events, no tool.
    await sim.speak("Would you like the same as last time — chips and garlic sauce?");
    await new Promise((r) => setTimeout(r, 140));

    const ask = sim.toModel.find((m) => m.type === "response.create");
    expect(ask).toBeTruthy();
    expect(ask.response.instructions).toMatch(/still there/i);
  });

  it("answers quickly once it knows the caller has finished speaking", async () => {
    // VAD says they stopped talking. From here the line OWES them a reply, and
    // three seconds is the whole budget — this is not the idle case.
    const sim = new VoiceRealtimeSim({ quietMs: 40, idleMs: 10_000 });
    await sim.answer();
    sim.brain.sent.length = 0;

    sim.brain.deliver({ type: "input_audio_buffer.speech_stopped" });
    sim.brain.deliver({ type: "input_audio_buffer.committed" });
    await new Promise((r) => setTimeout(r, 100));

    const ask = sim.toModel.find((m) => m.type === "response.create");
    expect(ask.response.instructions).toMatch(/Sorry, I lost you there/);
  });

  it("does not interrupt a caller who is still thinking", async () => {
    // Somebody deciding between two pizzas is not silence to be filled.
    const sim = new VoiceRealtimeSim({ idleMs: 10_000 });
    await sim.answer();
    sim.brain.sent.length = 0;
    await sim.speak("Which pizza would you like?");
    await new Promise((r) => setTimeout(r, 100));

    expect(sim.toModel.some((m) => m.type === "response.create")).toBe(false);
  });
});

describe("the watchdog answering for the caller", () => {
  // 7 September, 10:07, verbatim:
  //
  //   10:07:05.788  pressed 1
  //   10:07:06.146  nothing came back — asking again (last "response.created"
  //                 217ms ago)
  //   10:07:06.276  reply refused as one was already running — queued
  //   10:07:07.424  said "Would you like the same as last time—chips and
  //                 garlic sauce, delivered to 11 Follingsby Drive?"
  //   10:07:08.959  said "No problem—let's start a fresh order. Is that for
  //                 collection or delivery?"
  //
  // The caller said nothing at all. The nudge fired 217ms into a reply, was
  // refused, queued, and flushed the moment that question finished — so the
  // model answered the question on their behalf, with a no.

  it("says nothing while a reply is being generated", async () => {
    // The real numbers: the nudge fired 217ms into a reply, against a three
    // second budget. A reply in flight IS the line working.
    const sim = new VoiceRealtimeSim({ quietMs: 200 });
    await sim.answer();
    sim.brain.sent.length = 0;

    sim.brain.deliver({ type: "input_audio_buffer.committed" });
    sim.brain.deliver({ type: "response.created", response: { id: "r1" } });
    await new Promise((r) => setTimeout(r, 120));

    expect(sim.toModel.some((m) => m.type === "response.create")).toBe(false);
    expect(sim.log.join(" ")).not.toMatch(/nothing came back/);
  });

  it("never queues a nudge behind the reply it collided with", async () => {
    // The flush is what put words in the caller's mouth. A refused nudge is
    // dropped: the reply it collided with is the line working.
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.deliver({ type: "response.created", response: { id: "r1" } });
    sim.brain.sent.length = 0;

    sim.brain.deliver({
      type: "error",
      error: { type: "invalid_request_error", code: "conversation_already_has_active_response" },
    });
    sim.brain.deliver({ type: "response.done", response: { id: "r1" } });
    await new Promise((r) => setTimeout(r, 10));

    expect(sim.toModel.some((m) => m.type === "response.create")).toBe(false);
    expect(sim.log.join(" ")).toMatch(/refused as one was already running — dropped/);
  });

  it("still queues a reply a TOOL is waiting on", async () => {
    // That queue exists for a reason: a tool announced mid-reply must be
    // spoken about once the reply finishes.
    const sim = new VoiceRealtimeSim({ tools: { add_item: { result: "Got it." } } });
    await sim.answer();
    sim.brain.deliver({ type: "response.created", response: { id: "r1" } });
    sim.brain.sent.length = 0;

    sim.brain.deliver({
      type: "response.function_call_arguments.done",
      name: "add_item",
      call_id: "c1",
      arguments: "{}",
    });
    await new Promise((r) => setTimeout(r, 10));
    sim.brain.deliver({ type: "response.done", response: { id: "r1" } });
    await new Promise((r) => setTimeout(r, 10));

    expect(sim.toModel.filter((m) => m.type === "response.create")).toHaveLength(1);
  });

  it("cancels a reply that has genuinely stalled, rather than talking over it", async () => {
    // Clearing our own bookkeeping was not enough: OpenAI still believed a
    // response was running and refused the next one, which is how the nudge
    // ended up queued behind the thing it was replacing.
    const sim = new VoiceRealtimeSim({ quietMs: 40 });
    await sim.answer();
    sim.brain.deliver({ type: "response.created", response: { id: "stuck" } });
    await new Promise((r) => setTimeout(r, 60));
    sim.brain.sent.length = 0;
    sim.brain.deliver({ type: "input_audio_buffer.committed" });
    await new Promise((r) => setTimeout(r, 90));

    const types = sim.toModel.map((m) => m.type);
    expect(types).toContain("response.cancel");
    expect(sim.log.join(" ")).toMatch(/left half-finished — cancelling it/);
  });
});

describe("audio the caller is still listening to", () => {
  // The model writes a twenty-second greeting in about three seconds and every
  // frame goes straight to Telnyx, which plays it in real time. "The model has
  // finished" and "the caller has finished listening" are twenty seconds
  // apart.

  it("stops the audio already queued when a key is pressed", async () => {
    // Cancelling the model does nothing about what is already at Telnyx, which
    // is why pressing 1 left the options playing to the end.
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.deliver({ type: "response.created", response: { id: "greeting" } });
    sim.caller.sent.length = 0;

    await sim.press("1");

    expect(sim.caller.sent.some((m: any) => m.event === "clear")).toBe(true);
  });

  it("stops when the caller talks over it", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.caller.sent.length = 0;

    sim.brain.deliver({ type: "input_audio_buffer.speech_started" });
    await new Promise((r) => setTimeout(r, 5));

    expect(sim.caller.sent.some((m: any) => m.event === "clear")).toBe(true);
  });

  it("does not ask if they are still there while it is still speaking", async () => {
    // "Sorry, are you still there?" arrived ten seconds after the model
    // finished generating — with the caller still listening to the greeting
    // and still choosing an option.
    const sim = new VoiceRealtimeSim({ idleMs: 50 });
    await sim.answer();
    sim.brain.sent.length = 0;

    // Half a second of μ-law: 4000 bytes at 8kHz.
    const halfSecond = Buffer.alloc(4000).toString("base64");
    sim.brain.deliver({ type: "response.created", response: { id: "greeting" } });
    sim.brain.deliver({ type: "response.output_audio.delta", delta: halfSecond });
    sim.brain.deliver({ type: "response.done", response: { id: "greeting" } });

    // Past the idle window, but not past the audio.
    await new Promise((r) => setTimeout(r, 200));
    expect(sim.toModel.some((m) => m.type === "response.create")).toBe(false);

    // And once it HAS finished playing, the check-in happens.
    await new Promise((r) => setTimeout(r, 450));
    expect(sim.log.join(" ")).toMatch(/nothing came back/);
  }, 10000);
});

describe("a keypress that answers the question just asked", () => {
  // 7 September, 10:19:
  //
  //   said "For your select pizza size, press 1 for 10", 2 for 12", 3 for 14"."
  //   pressed 2
  //   said "Got it. You want an update on an existing order."
  //
  // This engine read EVERY digit as a main-menu choice, for the whole call,
  // however far past the menu it had got — so 2 meant "order status" one
  // sentence after being offered as "12 inch".

  it("answers the numbered question instead of the menu", async () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeDigit = async (_c: string, d: string) =>
      d === "2" ? { say: "Got it — 12 inch. Any notes for the pepperoni?" } : null;
    await sim.answer();
    sim.brain.sent.length = 0;

    await sim.press("2");

    const told = sim.toModel.find((m) => m.type === "conversation.item.create");
    expect(told.item.content[0].text).toMatch(/answered your question/);
    expect(told.item.content[0].text).not.toMatch(/update on an order/);
    // And it is told not to re-add the dish. Doing exactly that is what put a
    // caller through the same size question three times: the press landed, the
    // model added the pizza again, and the answer was thrown away.
    expect(told.item.content[0].text).toMatch(/Do not call add_item/);

    // Said verbatim: the size that was chosen is a fact about the basket.
    const ask = sim.toModel.find((m) => m.type === "response.create");
    expect(ask.response.instructions).toContain("12 inch");
  });

  it("stops the question playing when they answer it", async () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeDigit = async () => ({ say: "Got it — 12 inch." });
    await sim.answer();
    sim.brain.deliver({ type: "response.created", response: { id: "asking" } });
    sim.caller.sent.length = 0;

    await sim.press("2");
    expect(sim.caller.sent.some((m: any) => m.event === "clear")).toBe(true);
  });

  it("does not announce a menu choice once the call is past the menu", async () => {
    // No numbered question outstanding, but an order under way. A stray 2 is
    // an answer to something, not a request for an order update.
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeDigit = async () => null;
    sim.gateway.voice.pastTheMenu = async () => true;
    await sim.answer();
    sim.brain.sent.length = 0;

    await sim.press("2");

    const told = sim.toModel.find((m) => m.type === "conversation.item.create");
    expect(told.item.content[0].text).toMatch(/NOT a main-menu choice/);
    expect(told.item.content[0].text).toMatch(/ask them plainly what they meant/);
  });

  it("still works as a menu at the start of the call", async () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeDigit = async () => null;
    sim.gateway.voice.pastTheMenu = async () => false;
    await sim.answer();
    sim.brain.sent.length = 0;

    await sim.press("2");

    const told = sim.toModel.find((m) => m.type === "conversation.item.create");
    expect(told.item.content[0].text).toMatch(/update on an order/);
  });

  it("puts zero through to a person wherever it is pressed", async () => {
    const sim = new VoiceRealtimeSim({
      tools: { transfer_to_staff: { result: "Putting you through.", turn: { transferTo: "+44191" } } },
    });
    sim.gateway.voice.realtimeDigit = jest.fn(async () => null);
    await sim.answer();
    await sim.press("0");
    await new Promise((r) => setTimeout(r, 3100));

    expect(sim.transfers).toEqual(["+44191"]);
    // Not routed through the question handler at all.
    expect(sim.gateway.voice.realtimeDigit).not.toHaveBeenCalled();
  }, 10000);
});

describe("a noise that is not an answer", () => {
  // 7 September, 10:44:
  //
  //   said  "Would you like the same as last time — chips and garlic sauce,
  //          delivered to 11 Follingsby Drive?"
  //   heard ""
  //   said  "No problem — is that collection or delivery?"
  //
  // Two hundred and twenty-six milliseconds apart. A breath tripped the voice
  // detection, the model was handed a turn with no words in it, and decided
  // that meant no. The caller had not spoken at all.

  it("stops the reply to a turn with no words in it", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.deliver({ type: "response.created", response: { id: "answering" } });
    sim.brain.sent.length = 0;
    sim.caller.sent.length = 0;

    sim.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "",
    });
    await new Promise((r) => setTimeout(r, 10));

    // No words is NOT proof of no speech. The detector committed audio, the
    // transcriber returned nothing for it; the model heard the audio and is
    // the only one who can tell a breath from a short word. So: no cancel, no
    // clear, and the model is told precisely what happened.
    expect(sim.toModel.map((m) => m.type)).not.toContain("response.cancel");
    expect(sim.log.join(" ")).toMatch(/returned nothing for that turn/);
  });

  it("tells the model the caller has not answered", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.sent.length = 0;

    sim.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "  ...  ",
    });
    await new Promise((r) => setTimeout(r, 10));

    const told = sim.toModel.find((m) => m.type === "conversation.item.create");
    expect(told.item.content[0].text).toMatch(/returned no words/);
    expect(told.item.content[0].text).toMatch(/NOT a yes/);
    // And it does not ask for a reply — the caller is still thinking.
    expect(sim.toModel.some((m) => m.type === "response.create")).toBe(false);
  });

  it("does not call mangled speech noise", async () => {
    // "Телигов." was a caller saying yes. Calling that background noise
    // interrupted a model that had heard them correctly and told it they had
    // not spoken — so the call went backwards every time they opened their
    // mouth. Letters in any alphabet mean a person spoke.
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.sent.length = 0;

    sim.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Телигов.",
    });
    await new Promise((r) => setTimeout(r, 10));

    const told = sim.toModel.find((m) => m.type === "conversation.item.create");
    expect(told).toBeUndefined();
    expect(sim.log.join(" ")).toMatch(/could not render/);
  });

  it("leaves a real answer alone", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.sent.length = 0;

    await sim.say("No.");

    expect(sim.toModel.map((m) => m.type)).not.toContain("response.cancel");
    expect(sim.log.join(" ")).not.toMatch(/not speech/);
  });
});

describe("how the line decides the caller has finished talking", () => {
  it("uses the detection that has actually taken orders on this line", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    expect(sim.session.audio.input.turn_detection.type).toBe("server_vad");
  });

  it("falls back to the other one if the account will not take it", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.gateway.attach(sim.caller, "cc-vad");
    sim.brain.emit("open");
    await new Promise((r) => setTimeout(r, 5));

    sim.brain.deliver({
      type: "error",
      error: { type: "invalid_request_error", message: "Unknown parameter: session.audio.input.turn_detection.eagerness" },
    });
    await new Promise((r) => setTimeout(r, 10));

    const second = sim.brain.sent.filter((m: any) => m.type === "session.update").at(-1);
    expect(second.session.audio.input.turn_detection.type).toBe("semantic_vad");
    expect(sim.log.join(" ")).toMatch(/turn detection rejected/);
  });
});

describe("the size question that asked itself three times", () => {
  // 7 September, 11:05:
  //
  //   said "For your select pizza size, press 1 for 10", 2 for 12"…"
  //   pressed 2
  //   calling add_item          ← the model re-added the pizza
  //   said "For your select pizza size, press 1 for 10", 2 for 12"…"
  //   pressed 2
  //   calling add_item
  //   said "Sorry, it looks like I'm having trouble understanding."
  //
  // The keypress never reached the handler that answers numbered questions,
  // because that handler looked for an "outstanding question" slot and NOTHING
  // on this engine had ever set one. add_item recorded the choices and moved
  // on, so a press fell through to the model, which did the only thing it
  // could think of — add the pizza again.

  const { VoiceService } = require("../voice.service");
  const { VoiceAiService } = require("../voice-ai.service");

  const PIZZA = {
    id: "pep",
    name: "PEPPERONI",
    price: 7.8,
    modifierGroups: [
      {
        id: "size",
        name: "select pizza size",
        required: false,
        min: 1,
        options: [
          { id: "s10", name: '10"', price: 0 },
          { id: "s12", name: '12"', price: 2 },
        ],
      },
    ],
  };

  const call = () => {
    const ai: any = Object.create(VoiceAiService.prototype);
    ai.logger = { log() {}, warn() {}, error() {} };
    const items = [PIZZA];
    const ctx: any = { currency: "GBP", items, deliveryZones: [] };
    ctx.itemIndex = new Map([["pep", PIZZA]]);
    ctx.optionIndex = new Map(
      PIZZA.modifierGroups[0].options.map((o: any) => [
        o.id,
        { groupId: "size", itemId: "pep", option: o },
      ]),
    );
    const state: any = {
      cart: { items: [], fulfillmentChosen: true, fulfillmentType: "DELIVERY" },
      turns: [],
    };
    const svc: any = Object.create(VoiceService.prototype);
    svc.logger = { log() {}, warn() {}, error() {} };
    svc.ai = ai;
    svc.save = async () => {};
    svc.prisma = { voiceCall: { update: async () => ({}) } };
    svc.loadByControlId = async () => ({ call: { id: "c1", fromNumber: null }, ctx, state });
    return { svc, state };
  };

  it("records that a numbered question is outstanding", async () => {
    // The missing line. Without it nothing downstream knows a question was
    // asked, however loudly the caller was asked it.
    const { svc, state } = call();
    await svc.realtimeTool("cc1", "add_item", { itemId: "pep" });

    expect(state.choices).toEqual(["s10", "s12"]);
    expect(state.awaiting).toBe("ITEM_OPTION");
  });

  it("answers the press instead of asking again", async () => {
    const { svc, state } = call();
    await svc.realtimeTool("cc1", "add_item", { itemId: "pep" });

    const answered = await svc.realtimeDigit("cc1", "2");
    expect(answered?.say).toMatch(/^12 inch\./);
    expect(state.pendingItem.chosen).toEqual(["s12"]);
    // And the question is closed, so a second press cannot re-open it.
    expect(state.choices).toBeUndefined();
  });

  it("answers even if the slot was never recorded", async () => {
    // Belt and braces: a live list of numbered options IS the question,
    // whatever else did or did not get written down.
    const { svc, state } = call();
    await svc.realtimeTool("cc1", "add_item", { itemId: "pep" });
    state.awaiting = undefined;

    expect((await svc.realtimeDigit("cc1", "1"))?.say).toMatch(/^10 inch\./);
    expect(state.pendingItem.chosen).toEqual(["s10"]);
  });

  it("takes 1 as 'no note' once the choices are done", async () => {
    const { svc, state } = call();
    await svc.realtimeTool("cc1", "add_item", { itemId: "pep" });
    await svc.realtimeDigit("cc1", "2");
    expect(state.awaiting).toBe("ITEM_NOTE");

    const done = await svc.realtimeDigit("cc1", "1");
    expect(done?.say).toMatch(/PEPPERONI/);
    expect(state.cart.items).toHaveLength(1);
    expect(state.cart.items[0].modifiers[0].name).toBe('12"');
  });
});

describe("a transcript that arrives after the tool it belongs to", () => {
  // use_usual ran at 11:22:57.838. The transcript of the answer it was acting
  // on arrived at 11:22:58.086 — 248ms later. Whatever guard sits on that tool
  // would have been judging the PREVIOUS caller turn, or nothing at all.

  it("waits for the sentence already being written down", async () => {
    const sim = new VoiceRealtimeSim({ tools: { use_usual: { result: "loaded" } } });
    await sim.answer();
    // We asked a question.
    sim.brain.deliver({ type: "response.output_audio_transcript.done", transcript: "Same as last time?" });
    // Their answer is being transcribed.
    sim.brain.deliver({ type: "conversation.item.input_audio_transcription.delta" });

    void sim.callTool("use_usual");
    await new Promise((r) => setTimeout(r, 120));
    // Still waiting: the tool has not run on a stale answer.
    expect(sim.toolCalls).toHaveLength(0);

    sim.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "No, not the same as last time.",
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(sim.toolCalls).toHaveLength(1);
    expect(sim.toolCalls[0].input.__heard).toBe("No, not the same as last time.");
    expect(sim.toolCalls[0].input.__heardFresh).toBe(true);
  }, 10000);

  it("does not hold up a tool that needs no yes", async () => {
    const sim = new VoiceRealtimeSim({ tools: { find_item: { result: "That's a Pepperoni." } } });
    await sim.answer();
    sim.brain.deliver({ type: "conversation.item.input_audio_transcription.delta" });

    const started = Date.now();
    await sim.callTool("find_item", { said: "pepperoni" });
    expect(Date.now() - started).toBeLessThan(300);
    expect(sim.toolCalls).toHaveLength(1);
  });

  it("gives up waiting rather than leaving the caller hanging", async () => {
    const sim = new VoiceRealtimeSim({ tools: { use_usual: { result: "loaded" } } });
    await sim.answer();
    sim.brain.deliver({ type: "response.output_audio_transcript.done", transcript: "Same as last time?" });
    sim.brain.deliver({ type: "conversation.item.input_audio_transcription.delta" });

    // The transcript never comes.
    void sim.callTool("use_usual");
    await new Promise((r) => setTimeout(r, 1200));
    expect(sim.toolCalls).toHaveLength(1);
    // And it is marked as answering nothing, so the tool refuses.
    expect(sim.toolCalls[0].input.__heardFresh).toBe(false);
  }, 10000);

  it("marks an answer given before the question as not fresh", async () => {
    const sim = new VoiceRealtimeSim({ tools: { use_usual: { result: "loaded" } } });
    await sim.answer();
    // They said yes to something EARLIER.
    sim.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "yes",
    });
    await new Promise((r) => setTimeout(r, 5));
    // Then we asked a new question.
    sim.brain.deliver({ type: "response.output_audio_transcript.done", transcript: "Same as last time?" });
    await new Promise((r) => setTimeout(r, 5));

    await sim.callTool("use_usual");
    await new Promise((r) => setTimeout(r, 50));
    expect(sim.toolCalls[0].input.__heardFresh).toBe(false);
  });
});
