// The second engine, and the promise that makes it safe to try.
//
// Speech-to-speech is here to be COMPARED with the chained pipeline on the
// same menu and the same callers — it hears better, and there is less to
// inspect when it is wrong. What must never differ is what the two engines are
// ALLOWED to do: both go through the same tools, so place_order still refuses
// without a read-back and an address outside the delivery area is still
// refused. These hold that line.

import { VoiceAiService } from "../voice-ai.service";

const ctx = () =>
  ({
    tenantId: "t1",
    locationId: "l1",
    locationName: "Pizza Uno",
    country: "GB",
    currency: "GBP",
    address: { city: "Washington", postcode: "NE37 1AA" },
    deliveryZones: [{ id: "z1", postcodePrefix: "NE37", fee: 2.5 }],
    deliveryPrepMinutes: 45,
    collectionPrepMinutes: 20,
    acceptsCash: true,
    acceptsCard: true,
    items: [{ id: "gb", name: "Garlic Bread", price: 4, categoryName: "Sides", modifierGroups: [] }],
    itemIndex: new Map(),
    optionIndex: new Map(),
  }) as any;

const svc = () => {
  const s: any = Object.create(VoiceAiService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  return s;
};

const state = () => ({ cart: { items: [] }, turns: [], stage: "ORDER" }) as any;

describe("the tools the speech-to-speech engine gets", () => {
  it("are the same tools, in the shape that API wants", () => {
    const chained = svc().toolDefs(ctx());
    const realtime = svc().toolsForRealtime(ctx());

    expect(realtime).toHaveLength(chained.length);
    expect(realtime.map((t: any) => t.name).sort()).toEqual(
      chained.map((t: any) => t.name).sort(),
    );
    for (const tool of realtime) {
      expect(tool.type).toBe("function");
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeTruthy();
    }
  });

  it("includes the ones that refuse things", () => {
    const names = svc().toolsForRealtime(ctx()).map((t: any) => t.name);
    expect(names).toContain("place_order");
    expect(names).toContain("read_back_order");
    expect(names).toContain("confirm_delivery_address");
  });

  it("runs them through the same executor, so the same refusals apply", async () => {
    // place_order without a read-back is the single most important refusal on
    // the line. It must not become a matter of persuasion just because the
    // model is listening to audio.
    const s = svc();
    const st = state();
    st.cart.items = [{ lineId: "a", itemId: "gb", name: "Garlic Bread", quantity: 1, unitBasePrice: 4, modifiers: [] }];
    st.cart.fulfillmentType = "PICKUP";
    st.cart.fulfillmentChosen = true;
    st.orderConfirmed = false;

    const out = await s.runToolForRealtime("place_order", { paymentMethod: "CASH" }, ctx(), st, null);

    expect(out.result).toMatch(/read.?back|confirm/i);
    expect(st.orderId).toBeUndefined();
  });
});

describe("what the speech-to-speech engine is told", () => {
  const prompt = () => svc().promptForRealtime(ctx(), state());

  it("carries the whole ordinary prompt", () => {
    // Everything the chained engine is told about this shop, it is told too.
    expect(prompt()).toContain(svc().systemPrompt(ctx(), state()));
  });

  it("is told it is speaking, not writing", () => {
    const p = prompt();
    expect(p).toMatch(/YOU ARE SPEAKING, NOT WRITING/);
    // The failures that are specific to being read aloud.
    expect(p).toMatch(/eight pounds/);
    expect(p).toMatch(/fourteen inch/);
  });

  it("is told to check what it thinks it heard", () => {
    // Its advantage is hearing a mumbled dish name. Its risk is being sure
    // about one.
    expect(prompt()).toMatch(/read(ing)? it back, never by\s+assuming/);
  });

  it("is told not to make them repeat a whole order", () => {
    expect(prompt()).toMatch(/[Nn]ever ask them\s+to repeat a whole order/);
  });

  it("is told that no means no", () => {
    // From a live call: asked "are you still at Sunningdale Drive?", the
    // caller said no — and it called use_saved_address anyway. Proceeding
    // through a no sends a driver to the wrong house.
    const p = prompt();
    expect(p).toMatch(/NO MEANS NO/);
    expect(p).toMatch(/must NOT call use_saved_address/);
    expect(p).toMatch(/Guessing yes\s+is the one guess you can never make/);
  });
});

describe("keypresses on the speech-to-speech engine", () => {
  // The greeting invites them — "to place an order, press 1" — and on this
  // engine they were logged and dropped. The webhook that used to handle them
  // now stands down for realtime calls, correctly, and that left nobody
  // handling them at all: the caller pressed 1, pressed it again, and nothing
  // was listening.
  const { VoiceRealtimeGateway } = require("../voice-realtime.gateway");

  const gw = (over: Record<string, any> = {}) => {
    const g: any = Object.create(VoiceRealtimeGateway.prototype);
    g.logger = { log() {}, warn() {}, error() {} };
    g.voice = { realtimeTool: jest.fn(async () => ({ result: "ok" })) };
    g.telnyx = { transfer: jest.fn(async () => true) };
    Object.assign(g, over);
    return g;
  };

  const brain = () => {
    const sent: any[] = [];
    return {
      sent,
      readyState: 1, // WebSocket.OPEN
      send: (raw: string) => sent.push(JSON.parse(raw)),
    };
  };

  it("tells the model what the caller pressed, and asks it to carry on", async () => {
    const g = gw();
    const b = brain();
    await g.onDigit("1", "cc1", b);

    const [item, response] = b.sent;
    expect(item.type).toBe("conversation.item.create");
    expect(item.item.content[0].text).toMatch(/pressed 1/);
    expect(item.item.content[0].text).toMatch(/place an order/);
    // Reading the menu back at somebody who just answered it is the thing
    // that makes a phone line feel like a machine.
    expect(item.item.content[0].text).toMatch(/without reading the options out again/);
    expect(response.type).toBe("response.create");
  });

  it("knows what each option means", async () => {
    for (const [digit, expected] of [
      ["2", /update on an order/],
      ["3", /change an order/],
      ["4", /problem with an order/],
      ["5", /hear the options again/],
    ] as Array<[string, RegExp]>) {
      const b = brain();
      await gw().onDigit(digit, "cc1", b);
      expect(b.sent[0].item.content[0].text).toMatch(expected);
    }
  });

  it("puts zero through to a person in code, not by asking the model to notice", async () => {
    // "Getting through to someone must always work" is not a promise to
    // delegate.
    const transfer = jest.fn(async () => true);
    const g = gw({
      voice: {
        realtimeTool: jest.fn(async () => ({
          result: "Putting you through.",
          turn: { transferTo: "+441912312345" },
        })),
      },
      telnyx: { transfer },
    });
    const b = brain();
    await g.onDigit("0", "cc1", b);

    expect(g.voice.realtimeTool).toHaveBeenCalledWith(
      "cc1",
      "transfer_to_staff",
      expect.objectContaining({ reason: expect.stringMatching(/pressed 0/) }),
    );
    // Not handed to the model at all.
    expect(b.sent).toHaveLength(0);
  });

  it("says nothing down a socket that has already gone", async () => {
    const b = { ...brain(), readyState: 3 };
    await gw().onDigit("1", "cc1", b as any);
    expect(b.sent).toHaveLength(0);
  });
});

describe("a tool call announced twice is still one tool call", () => {
  // GA emits BOTH response.function_call_arguments.done AND
  // response.output_item.done for the same call. Handling both on the
  // assumption one had replaced the other ran every tool twice, sent two
  // outputs under one call_id, and asked for two responses at once — the
  // second collided with the first and the line went silent mid-order.
  const { VoiceRealtimeGateway } = require("../voice-realtime.gateway");

  const setup = () => {
    const g: any = Object.create(VoiceRealtimeGateway.prototype);
    g.logger = { log() {}, warn() {}, error() {} };
    g.seenEvents = new Set();
    g.telnyx = { transfer: jest.fn(), hangup: jest.fn() };
    g.voice = { realtimeTool: jest.fn(async () => ({ result: "Got it — Garlic Bread." })) };
    const sent: any[] = [];
    const brain: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return { g, brain, sent };
  };

  const argsDone = (callId: string) =>
    JSON.stringify({
      type: "response.function_call_arguments.done",
      name: "add_item",
      call_id: callId,
      arguments: JSON.stringify({ said: "garlic bread" }),
    });
  const itemDone = (callId: string) =>
    JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "add_item",
        call_id: callId,
        arguments: JSON.stringify({ said: "garlic bread" }),
      },
    });

  it("runs the tool once, whichever event announces it first", async () => {
    const { g, brain, sent } = setup();
    await g.onModelEvent(argsDone("call_1"), "cc1", brain, () => {});
    await g.onModelEvent(itemDone("call_1"), "cc1", brain, () => {});

    expect(g.voice.realtimeTool).toHaveBeenCalledTimes(1);
    // One output, one request for a reply. Two of either is the silence.
    expect(sent.filter((m) => m.type === "conversation.item.create")).toHaveLength(1);
    expect(sent.filter((m) => m.type === "response.create")).toHaveLength(1);
  });

  it("works the same way round", async () => {
    const { g, brain, sent } = setup();
    await g.onModelEvent(itemDone("call_2"), "cc1", brain, () => {});
    await g.onModelEvent(argsDone("call_2"), "cc1", brain, () => {});
    expect(g.voice.realtimeTool).toHaveBeenCalledTimes(1);
    expect(sent.filter((m) => m.type === "response.create")).toHaveLength(1);
  });

  it("still runs a genuinely different call", async () => {
    const { g } = setup();
    const brain: any = { readyState: 1, send: () => {} };
    await g.onModelEvent(argsDone("call_a"), "cc1", brain, () => {});
    await g.onModelEvent(argsDone("call_b"), "cc1", brain, () => {});
    expect(g.voice.realtimeTool).toHaveBeenCalledTimes(2);
  });

  it("ignores a finished output item that is not a tool call", async () => {
    const { g, sent } = setup();
    const brain: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    await g.onModelEvent(
      JSON.stringify({ type: "response.output_item.done", item: { type: "message" } }),
      "cc1",
      brain,
      () => {},
    );
    expect(g.voice.realtimeTool).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe("asking for a reply while one is still being spoken", () => {
  // A tool call is announced WHILE the response containing it is still
  // running. Asking for a new response then asks for two at once, and the
  // second is refused — which is a line that stops talking mid-order.
  const { VoiceRealtimeGateway } = require("../voice-realtime.gateway");

  const setup = () => {
    const g: any = Object.create(VoiceRealtimeGateway.prototype);
    g.logger = { log() {}, warn() {}, error() {} };
    g.seenEvents = new Set();
    g.telnyx = { transfer: jest.fn(), hangup: jest.fn() };
    g.voice = { realtimeTool: jest.fn(async () => ({ result: "Using their saved address." })) };
    const sent: any[] = [];
    const brain: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return { g, brain, sent };
  };
  const ev = (o: any) => JSON.stringify(o);

  it("waits for the current reply to finish before asking for the next", async () => {
    const { g, brain, sent } = setup();
    await g.onModelEvent(ev({ type: "response.created" }), "cc1", brain, () => {});
    await g.onModelEvent(
      ev({
        type: "response.function_call_arguments.done",
        name: "use_saved_address",
        call_id: "c1",
        arguments: "{}",
      }),
      "cc1",
      brain,
      () => {},
    );

    // The result goes back straight away; the request for a reply does not.
    expect(sent.some((m) => m.type === "conversation.item.create")).toBe(true);
    expect(sent.some((m) => m.type === "response.create")).toBe(false);

    await g.onModelEvent(ev({ type: "response.done" }), "cc1", brain, () => {});
    expect(sent.filter((m) => m.type === "response.create")).toHaveLength(1);
  });

  it("asks immediately when nothing is being spoken", async () => {
    const { g, brain, sent } = setup();
    await g.onModelEvent(
      ev({ type: "response.function_call_arguments.done", name: "x", call_id: "c2", arguments: "{}" }),
      "cc1",
      brain,
      () => {},
    );
    expect(sent.filter((m) => m.type === "response.create")).toHaveLength(1);
  });

  it("does not ask twice when a reply finishes with nothing queued", async () => {
    const { g, brain, sent } = setup();
    await g.onModelEvent(ev({ type: "response.created" }), "cc1", brain, () => {});
    await g.onModelEvent(ev({ type: "response.done" }), "cc1", brain, () => {});
    expect(sent.filter((m) => m.type === "response.create")).toHaveLength(0);
  });

  it("logs what the line said, so silence can be told from unheard speech", async () => {
    const { g, brain } = setup();
    const said: string[] = [];
    g.logger = { log: (m: string) => said.push(m), warn() {}, error() {} };
    await g.onModelEvent(
      ev({ type: "response.output_audio_transcript.done", transcript: "Is that right?" }),
      "cc1",
      brain,
      () => {},
    );
    expect(said.join(" ")).toContain('said "Is that right?"');
  });
});

describe("the menu is read once a call, not once a tool", () => {
  // From a live call: "what's the delivery address?" came back in 440ms, then
  // the address itself produced nothing for as long as the caller waited.
  // Every tool call re-resolved the WHOLE menu — categories, items, sizes,
  // modifier groups, brands, zones — before the tool even started, and then
  // the geocoder ran. On the chained engine that read hides behind the model's
  // own thinking time; here it is dead air.
  const { VoiceService } = require("../voice.service");

  const svc = (resolve: jest.Mock) => {
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.contexts = { resolve };
    return s;
  };

  it("resolves the menu once for a whole call", async () => {
    const resolve = jest.fn(async () => ({ items: [] }));
    const s = svc(resolve);

    await s.contextFor("call-1", "+441912345678");
    await s.contextFor("call-1", "+441912345678");
    await s.contextFor("call-1", "+441912345678");

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("starts fresh for the next caller", async () => {
    // A menu edited between calls must be picked up; one edited mid-order
    // must not change what is being read back.
    const resolve = jest.fn(async () => ({ items: [] }));
    const s = svc(resolve);

    await s.contextFor("call-1", "+441912345678");
    await s.contextFor("call-2", "+441912345678");

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does not cache a shop it could not resolve", async () => {
    const resolve = jest.fn(async () => null);
    const s = svc(resolve);

    expect(await s.contextFor("call-1", "+441912345678")).toBeNull();
    await s.contextFor("call-1", "+441912345678");
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
