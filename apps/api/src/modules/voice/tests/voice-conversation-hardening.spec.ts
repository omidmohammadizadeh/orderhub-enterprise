// The review of call bvw4lTZA at 6f2ff279: what it asked for, proven.
//
// The call itself was fine — menu question answered, item added, "what else
// would you like?" — and then thirteen seconds of nothing, an idle reminder,
// and no way to tell whether the caller had spoken. Four things fall out:
// silence has to be attributed before it is acted on, the caller's silence
// is never a reason to change engine, a tool-only reply has not answered
// anyone yet, and a yes on this engine needs a real caller turn behind it.

import { VoiceAiService } from '../voice-ai.service';
import { VoiceRealtimeSim } from './voice-realtime-sim';

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const ONE_SECOND = Buffer.alloc(8000).toString('base64');

const conversationSim = (opts: any = {}) => {
  const sim = new VoiceRealtimeSim(opts);
  sim.gateway.voice.realtimeSession = async () => ({
    instructions: 'x',
    greeting: 'Hi',
    tools: [],
    mode: 'CONVERSATION',
  });
  sim.gateway.voice.conversationTool = jest.fn(async () => ({ result: 'ok' }));
  sim.gateway.fallbackToRelay = jest.fn(async () => {});
  sim.gateway.telnyx = { ...(sim.gateway.telnyx ?? {}), hangup: jest.fn(async () => true) };
  return sim;
};
const spoke = (sim: VoiceRealtimeSim, rid: string, delta = 'AAAA') => {
  sim.brain.deliver({ type: 'response.created', response: { id: rid } });
  sim.brain.deliver({
    type: 'response.output_audio.delta',
    response_id: rid,
    item_id: `${rid}-a`,
    delta,
  });
  sim.brain.deliver({
    type: 'response.output_audio_transcript.done',
    transcript: 'What else would you like?',
  });
  sim.brain.deliver({ type: 'response.done', response: { id: rid, status: 'completed' } });
};

describe('3. a quiet caller is not a broken model', () => {
  it('reminds, reminds again, then says goodbye — and never changes engine', async () => {
    const sim = conversationSim({ idleMs: 40 });
    sim.gateway.config = {
      get: (k: string) =>
        k === 'VOICE_CONVERSATION_IDLE_MS'
          ? '40'
          : k === 'VOICE_REALTIME_IDLE_MS'
            ? '40'
            : undefined,
    };
    await sim.answer();
    sim.brain.sent.length = 0;
    spoke(sim, 'r1');
    // The line is up: silence keeps arriving from Telnyx, as it does on a
    // real call. A line delivering nothing at all is a different case, below.
    const keepAlive = setInterval(
      () => sim.caller.deliver({ event: 'media', media: { track: 'inbound', payload: ONE_SECOND } }),
      10,
    );
    await settle(400);
    clearInterval(keepAlive);

    const said = sim.toModel
      .filter((m) => m.type === 'response.create')
      .map((m) => m.response?.instructions ?? '');
    expect(said.some((s) => s.includes('are you still there'))).toBe(true);
    expect(said.some((s) => s.includes('still here whenever'))).toBe(true);
    expect(said.some((s) => s.includes('Bye for now'))).toBe(true);
    expect(sim.gateway.fallbackToRelay).not.toHaveBeenCalled();
    expect(sim.log.join(' ')).toMatch(/caller gone — ending the call politely/);
  });

  it('a model that gives nothing back still gets the fallback', async () => {
    const sim = conversationSim({ quietMs: 40, idleMs: 40 });
    sim.gateway.config = {
      get: (k: string) => (k === 'VOICE_REALTIME_QUIET_MS' ? '40' : undefined),
    };
    await sim.answer();
    // The caller spoke; the server owes a reply and never starts one.
    sim.brain.deliver({ type: 'input_audio_buffer.speech_started' });
    sim.brain.deliver({ type: 'input_audio_buffer.speech_stopped' });
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    await settle(300);
    expect(sim.log.join(' ')).toMatch(/nothing came back/);
    expect(sim.gateway.fallbackToRelay).toHaveBeenCalled();
  });

  it('the caller speaking resets the silence count', async () => {
    const sim = conversationSim({ idleMs: 40 });
    sim.gateway.config = {
      get: (k: string) =>
        k === 'VOICE_CONVERSATION_IDLE_MS'
          ? '40'
          : k === 'VOICE_REALTIME_IDLE_MS'
            ? '40'
            : undefined,
    };
    await sim.answer();
    spoke(sim, 'r1');
    await settle(70); // one reminder
    sim.brain.deliver({ type: 'input_audio_buffer.speech_started' });
    sim.brain.deliver({ type: 'input_audio_buffer.speech_stopped' });
    spoke(sim, 'r2');
    await settle(70);
    const goodbye = sim.toModel.some((m) =>
      String(m.response?.instructions ?? '').includes('Bye for now'),
    );
    expect(goodbye).toBe(false);
    expect(sim.gateway.telnyx.hangup).not.toHaveBeenCalled();
  });
});

describe('4. timing survives a tool call', () => {
  it('stays open across a tool-only reply and closes on the spoken one, tool time reported', async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.deliver({ type: 'input_audio_buffer.speech_stopped' });
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    await sim.callTool('add_item', { said: 'chips' }); // response r? with only a tool call
    expect(sim.log.join(' ')).not.toMatch(/turn timing/); // not closed yet
    await settle(20);
    spoke(sim, 'r2');
    await settle();
    const line = sim.log.find((l) => l.includes('turn timing'))!;
    expect(line).toMatch(/vad\(stop→committed\) \d+ms/);
    expect(line).toMatch(/tool add_item \d+ms/);
    expect(line).toMatch(/stop→first-audio \d+ms/);
  });
});

describe('5. a yes needs a caller turn behind it', () => {
  const ai = () => {
    const a: any = Object.create(VoiceAiService.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    return a;
  };
  const ctx = () =>
    ({
      currency: 'GBP',
      items: [],
      itemIndex: new Map(),
      optionIndex: new Map(),
      deliveryZones: [],
    }) as any;
  const withChips = () =>
    ({
      cart: {
        items: [{ lineId: 'a', name: 'CHIPS', quantity: 1, unitBasePrice: 2, modifiers: [] }],
        fulfillmentType: 'PICKUP',
        fulfillmentChosen: true,
      },
      turns: [],
    }) as any;

  it('refuses order_confirmed when the caller has not spoken since the read-back — in words, no keypad', async () => {
    const a = ai();
    const c = ctx();
    const st = withChips();
    await a.runTool('read_back_order', {}, c, st, null);
    const out = await a.runToolForConversation(
      'order_confirmed',
      { __spokeAfterQuestion: false },
      c,
      st,
      null,
    );
    expect(out.result).toMatch(/haven't answered since you asked/);
    expect(out.result).toMatch(/Ask again in one short sentence/);
    expect(out.sayNow).toBeUndefined();
    expect(st.pendingConfirm).toBeUndefined();
    expect(st.orderConfirmed).toBeFalsy();
  });

  it('confirms when a caller turn followed the question', async () => {
    const a = ai();
    const c = ctx();
    const st = withChips();
    await a.runTool('read_back_order', {}, c, st, null);
    const out = await a.runToolForConversation(
      'order_confirmed',
      { __spokeAfterQuestion: true },
      c,
      st,
      null,
    );
    expect(out.result).toMatch(/Confirmed/);
    expect((st as any).__conversation).toBeUndefined(); // transient, never persisted
  });

  it('the gateway passes the evidence: a committed turn after the question, and only once', async () => {
    const sim = conversationSim();
    await sim.answer();
    const toolIn = (rid: string) => {
      sim.brain.deliver({ type: 'response.created', response: { id: rid } });
      sim.brain.deliver({
        type: 'response.function_call_arguments.done',
        response_id: rid,
        name: 'order_confirmed',
        call_id: `c-${rid}`,
        arguments: '{}',
      });
    };
    // Question asked, nobody spoke.
    sim.brain.deliver({
      type: 'response.output_audio_transcript.done',
      transcript: 'Is that all correct?',
    });
    toolIn('r1');
    await settle(30);
    // Caller spoke after it.
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    toolIn('r2');
    await settle(30);
    // The same turn cannot be spent twice.
    toolIn('r3');
    await settle(30);

    const calls = (sim.gateway.voice.conversationTool as jest.Mock).mock.calls.map(
      (c) => c[2].__spokeAfterQuestion,
    );
    expect(calls).toEqual([false, true, false]);
  });
});

describe('1. the log says what happened', () => {
  it('names the VAD settings, create_response and the mode at session ready, and every reply and turn', async () => {
    const sim = conversationSim();
    await sim.answer();
    expect(sim.log.join(' ')).toMatch(/turn_detection \{"type":"server_vad","threshold":0\.6/);
    expect(sim.log.join(' ')).toMatch(/create_response true, mode CONVERSATION/);
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    spoke(sim, 'r1');
    await settle();
    expect(sim.log.join(' ')).toMatch(/caller turn committed item=u1 askSeq=\d+/);
    expect(sim.log.join(' ')).toMatch(/reply .* created at askSeq/);
    expect(sim.log.join(' ')).toMatch(/reply .* done: status completed, audio true, tool false/);
  });
});

describe('2. the line is metered, the audio is not kept', () => {
  it('flags a loud second with no detection, and never logs a payload', async () => {
    const sim = conversationSim();
    await sim.answer();
    const loud = Buffer.alloc(160, 0x10).toString('base64'); // a loud μ-law byte, 20ms
    const t0 = Date.now();
    for (let i = 0; i < 60; i++)
      sim.caller.deliver({ event: 'media', stream_id: 's1', media: { payload: loud } });
    await settle(1100);
    for (let i = 0; i < 5; i++)
      sim.caller.deliver({ event: 'media', stream_id: 's1', media: { payload: loud } });
    await settle();
    expect(Date.now() - t0).toBeGreaterThan(1000);
    expect(sim.log.join(' ')).toMatch(
      /inbound loud but undetected: peak -?\d+ dBFS over \d+ frames/,
    );
    expect(sim.log.join(' ')).not.toContain(loud);
  }, 10000);
});

describe('a reply the caller talked over', () => {
  it('is cancelled, not a stall', async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.deliver({ type: 'response.created', response: { id: 'r1' } });
    sim.brain.deliver({ type: 'input_audio_buffer.speech_started' });
    sim.brain.deliver({ type: 'response.done', response: { id: 'r1', status: 'cancelled' } });
    await settle();
    expect(sim.log.join(' ')).not.toMatch(/treating as a stall/);
  });
});

// ── call 9-LMxBjQ: an order placed on silence ───────────────────────────────
describe('a reminder may speak; it may not act', () => {
  it('asks for a check-in with no tools, and says what kind of reply it is', async () => {
    const sim = conversationSim({ idleMs: 40 });
    sim.gateway.config = {
      get: (k: string) =>
        k === 'VOICE_CONVERSATION_IDLE_MS' || k === 'VOICE_REALTIME_IDLE_MS' ? '40' : undefined,
    };
    await sim.answer();
    sim.brain.sent.length = 0;
    spoke(sim, 'r1');
    await settle(120);
    const reminder = sim.toModel.find(
      (m) =>
        m.type === 'response.create' &&
        String(m.response?.instructions ?? '').includes('are you still there'),
    );
    expect(reminder).toBeDefined();
    expect(reminder.response.tools).toEqual([]);
    expect(reminder.response.tool_choice).toBe('none');
    expect(reminder.response.metadata).toEqual({ origin: 'reminder' });
  });

  it('the greeting and a scripted read-back are speech-only too', async () => {
    const sim = conversationSim();
    await sim.answer();
    const greet = sim.toModel.find(
      (m) =>
        m.type === 'response.create' &&
        String(m.response?.instructions ?? '').includes('Greet the caller'),
    );
    expect(greet.response.tools).toEqual([]);
    expect(greet.response.metadata).toEqual({ origin: 'greeting' });
    (sim.gateway.voice.conversationTool as jest.Mock).mockResolvedValueOnce({
      result: 'read back',
      sayNow: "So that's chips. Is that all correct?",
    });
    await sim.callTool('read_back_order');
    const script = sim.toModel.find(
      (m) =>
        m.type === 'response.create' &&
        String(m.response?.instructions ?? '').includes("So that's chips"),
    );
    expect(script.response.tools).toEqual([]);
    expect(script.response.metadata).toEqual({ origin: 'script' });
  });

  it('refuses place_order from a reminder reply even if the model tries', async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.deliver({
      type: 'response.created',
      response: { id: 'rem1', metadata: { origin: 'reminder' } },
    });
    sim.brain.deliver({
      type: 'response.function_call_arguments.done',
      response_id: 'rem1',
      name: 'place_order',
      call_id: 'c1',
      arguments: '{"paymentMethod":"CASH"}',
    });
    await settle(30);
    expect(sim.gateway.voice.conversationTool).not.toHaveBeenCalled();
    const out = sim.toModel.find(
      (m) => m.type === 'conversation.item.create' && m.item?.type === 'function_call_output',
    );
    expect(out.item.output).toMatch(/^Refused/);
    expect(sim.log.join(' ')).toMatch(/refused place_order from a reminder reply/);
  });

  it('lets a caller-driven reply use tools as before', async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    sim.brain.deliver({ type: 'response.created', response: { id: 'r1' } }); // no metadata: the server made it for the caller
    sim.brain.deliver({
      type: 'response.function_call_arguments.done',
      response_id: 'r1',
      name: 'place_order',
      call_id: 'c1',
      arguments: '{"paymentMethod":"CASH"}',
    });
    await settle(30);
    expect(sim.gateway.voice.conversationTool).toHaveBeenCalled();
  });
});

describe('the payment question followed by silence cannot place an order', () => {
  const ai = () => {
    const a: any = Object.create(VoiceAiService.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    return a;
  };
  const c = () =>
    ({
      currency: 'GBP',
      items: [],
      itemIndex: new Map(),
      optionIndex: new Map(),
      deliveryZones: [],
    }) as any;
  const confirmed = async (a: any, ctx: any) => {
    const st: any = {
      cart: {
        items: [{ lineId: 'a', name: 'CHIPS', quantity: 1, unitBasePrice: 2, modifiers: [] }],
        fulfillmentType: 'PICKUP',
        fulfillmentChosen: true,
      },
      turns: [],
    };
    await a.runTool('read_back_order', {}, ctx, st, null);
    await a.runToolForConversation(
      'order_confirmed',
      { __spokeAfterQuestion: true },
      ctx,
      st,
      null,
    );
    return st;
  };

  it('no caller turn since the question — not placed', async () => {
    const a = ai();
    const ctx = c();
    const st = await confirmed(a, ctx);
    const out = await a.runToolForConversation(
      'place_order',
      { paymentMethod: 'CASH', __spokeAfterQuestion: false },
      ctx,
      st,
      '+44',
    );
    expect(out.result).toMatch(/hasn't answered since you asked/);
    expect(st.orderId).toBeUndefined();
  });

  it('a caller turn but no payment method — not placed, and never defaulted to cash', async () => {
    const a = ai();
    const ctx = c();
    const st = await confirmed(a, ctx);
    for (const bad of [undefined, '', 'yes', 'later']) {
      const out = await a.runToolForConversation(
        'place_order',
        { paymentMethod: bad, __spokeAfterQuestion: true },
        ctx,
        st,
        '+44',
      );
      expect(out.result).toMatch(/have not said how they'll pay/);
      expect(st.orderId).toBeUndefined();
    }
  });
});

// (the single-retry test that stood here encoded the id-keyed guard that
// let call RDhsJSAg retry sixty-one times; the budgeted engine below replaces it)

// ── call RDhsJSAg: sixty-one retries against a rate limit ───────────────────
import { rateLimitResetMs } from '../voice-realtime.gateway';

describe('a failed reply is retried for its ASK, within a budget, after the wait the API named', () => {
  const RL = (id: string, ms = 20) => ({
    type: 'response.done',
    response: {
      id,
      status: 'failed',
      status_details: {
        type: 'failed',
        error: {
          code: 'rate_limit_exceeded',
          message: `Rate limit reached for gpt-realtime on tokens per min (TPM): Limit 40000, Used 39669, Requested 800. Please try again in ${ms}ms.`,
        },
      },
    },
  });
  const creates = (sim: VoiceRealtimeSim) =>
    sim.toModel.filter((m) => m.type === 'response.create');

  it('reads the reset the API asks for', () => {
    expect(rateLimitResetMs('Please try again in 1.234s. Visit …')).toBe(1234);
    expect(rateLimitResetMs('Please try again in 800ms.')).toBe(800);
    expect(rateLimitResetMs('no hint here')).toBeNull();
  });

  it('stops after the budget even though every retry has a fresh id, then hands over once', async () => {
    const sim = conversationSim();
    await sim.answer();
    (sim.gateway.voice.conversationTool as jest.Mock).mockResolvedValueOnce({
      result: 'Added chips',
    });
    await sim.callTool('add_item', { said: 'chips' }); // one tool follow-up ask
    sim.brain.sent.length = 0;
    const original = { type: 'response.create', response: { metadata: { origin: 'tool' } } };

    // fail → retry 1 (≥400ms) → fail → retry 2 (≥800ms) → fail → give up
    sim.brain.deliver({
      type: 'response.created',
      response: { id: 'f1', metadata: { origin: 'tool' } },
    });
    sim.brain.deliver(RL('f1'));
    await settle(20);
    expect(sim.log.join(' ')).toMatch(/retry 1\/2 of a tool reply in \d+ms \(API asked for 20ms\)/);
    await settle(700);
    expect(creates(sim)).toHaveLength(1);
    expect(creates(sim)[0]).toEqual(original); // the ORIGINAL ask, not something else
    sim.brain.deliver({
      type: 'response.created',
      response: { id: 'f2', metadata: { origin: 'tool' } },
    });
    sim.brain.deliver(RL('f2'));
    await settle(20);
    expect(sim.log.join(' ')).toMatch(/retry 2\/2/);
    await settle(1100);
    expect(creates(sim)).toHaveLength(2);
    sim.brain.deliver({
      type: 'response.created',
      response: { id: 'f3', metadata: { origin: 'tool' } },
    });
    sim.brain.deliver(RL('f3'));
    await settle(20);
    expect(sim.log.join(' ')).toMatch(
      /giving up on a tool reply after 2 retries \(rate_limit_exceeded\)/,
    );
    expect(sim.gateway.fallbackToRelay).toHaveBeenCalledTimes(1);
    await settle(1800);
    expect(creates(sim)).toHaveLength(2); // nothing after giving up
  }, 10000);

  it('holds every other reply while the line is cooling down — a watchdog cannot restart the storm', async () => {
    const sim = conversationSim();
    await sim.answer();
    (sim.gateway.voice.conversationTool as jest.Mock).mockResolvedValueOnce({ result: 'ok' });
    await sim.callTool('add_item', { said: 'chips' });
    sim.brain.sent.length = 0;
    sim.brain.deliver({
      type: 'response.created',
      response: { id: 'f1', metadata: { origin: 'tool' } },
    });
    sim.brain.deliver(RL('f1', 300));
    await settle(20);
    (sim.gateway as any).speakExactly(sim.brain, 'Sorry, are you still there?', {
      origin: 'reminder',
      speechOnly: true,
    });
    expect(creates(sim)).toHaveLength(0);
    expect(sim.log.join(' ')).toMatch(/held a reply \(reminder\) — rate-limit cooldown/);
  });

  it('a hangup cancels the pending retry', async () => {
    const sim = conversationSim();
    await sim.answer();
    (sim.gateway.voice.conversationTool as jest.Mock).mockResolvedValueOnce({ result: 'ok' });
    await sim.callTool('add_item', { said: 'chips' });
    sim.brain.sent.length = 0;
    sim.brain.deliver({
      type: 'response.created',
      response: { id: 'f1', metadata: { origin: 'tool' } },
    });
    sim.brain.deliver(RL('f1'));
    await settle(20);
    sim.caller.close();
    await settle(800);
    expect(creates(sim)).toHaveLength(0);
    expect(sim.log.join(' ')).toMatch(/pending retry dropped — hangup/);
  });

  it('a caller who speaks again cancels it too — the server replies to them', async () => {
    const sim = conversationSim();
    await sim.answer();
    (sim.gateway.voice.conversationTool as jest.Mock).mockResolvedValueOnce({ result: 'ok' });
    await sim.callTool('add_item', { said: 'chips' });
    sim.brain.sent.length = 0;
    sim.brain.deliver({
      type: 'response.created',
      response: { id: 'f1', metadata: { origin: 'tool' } },
    });
    sim.brain.deliver(RL('f1'));
    await settle(20);
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u9' });
    await settle(800);
    expect(creates(sim)).toHaveLength(0);
    expect(sim.log.join(' ')).toMatch(/pending retry dropped — caller spoke/);
  });

  // (a throttled caller reply IS replayed now — see "a throttled caller reply is replayed" below)

  it("logs the API's own remaining budget", async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.deliver({
      type: 'rate_limits.updated',
      rate_limits: [{ name: 'tokens', limit: 40000, remaining: 1200, reset_seconds: 1.8 }],
    });
    await settle();
    expect(sim.log.join(' ')).toMatch(/rate limits: tokens 1200\/40000 \(reset 1\.8s\)/);
  });
});

describe('a recovery announces an order that is already in', () => {
  it('placedOrderFor speaks the number digit by digit', async () => {
    const { VoiceService } = require('../voice.service');
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.loadByControlId = async () => ({
      call: { id: 'c1' },
      ctx: {},
      state: { orderId: 'o1', cart: { items: [] }, turns: [] },
    });
    s.db = () => ({
      order: { findUnique: async () => ({ orderNumber: 1178, displayId: 'JVMX7' }) },
    });
    expect(await s.placedOrderFor('cc1')).toEqual({ reference: '1, 1, 7, 8' });
    s.loadByControlId = async () => ({
      call: { id: 'c1' },
      ctx: {},
      state: { cart: { items: [] }, turns: [] },
    });
    expect(await s.placedOrderFor('cc1')).toBeNull();
  });
});

// ── call RHyj98mQ: two pizzas, no chips, no delivery fee, a lie on recovery ──
describe("parse_order lets the matcher go first", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const G = (id: string, name: string, opts: string[]) => ({ id, name, required: true, min: 1, options: opts.map((o, i) => ({ id: `${id}${i + 1}`, name: o, price: 0 })) });
  const MENU: any[] = [
    { id: "pep12", name: 'Pepperoni (12")', price: 8.9, categoryName: "Pizzas", modifierGroups: [G("cr", "Select Your Pizza Crust", ["Thin", "Deep Pan"])] },
    { id: "chips", name: "Chips", price: 2.9, categoryName: "Sides", modifierGroups: [] },
    { id: "gs", name: "Garlic Sauce", price: 1.3, categoryName: "Sides", modifierGroups: [] },
  ];
  const ctx = () => { const c: any = { currency: "GBP", items: MENU, deliveryZones: [] }; c.itemIndex = new Map(MENU.map((i) => [i.id, i])); c.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])))); return c; };
  const ai = (claude: any = null) => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; a.anthropic = claude; a.model = "m"; return a; };

  it("places the whole sentence without Claude, and does not call Claude when nothing is left over", async () => {
    let claudeCalls = 0;
    const a = ai({ messages: { create: async () => { claudeCalls++; return { content: [{ type: "text", text: "[]" }] }; } } });
    const st: any = { cart: { items: [] }, turns: [] };
    const out = await a.runToolForConversation("parse_order", { said: "twelve inch pepperoni, deep pan, chips and garlic sauce" }, ctx(), st, null);
    expect(st.cart.items.map((l: any) => l.itemId)).toEqual(["pep12", "chips", "gs"]);
    expect(st.cart.items[0].modifiers.map((m: any) => m.name)).toEqual(["Deep Pan"]);
    expect(claudeCalls).toBe(0);
    expect(out.result).not.toMatch(/note: chips/);
  });

  it("sends Claude only the words the matcher could not place", async () => {
    let asked = "";
    const a = ai({ messages: { create: async (req: any) => { asked = req.messages[0].content; return { content: [{ type: "text", text: '[{"itemId":"gs","quantity":1}]' }] }; } } });
    const st: any = { cart: { items: [] }, turns: [] };
    await a.runToolForConversation("parse_order", { said: "chips and a thingy" }, ctx(), st, null);
    expect(asked).toMatch(/CUSTOMER SAID: ".*thingy.*"/);
    expect(asked).not.toMatch(/CUSTOMER SAID: ".*chips.*"/);
  });
});

describe("two pizzas in one sentence each keep their own words", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const { segmentItems, saysOption } = require("../voice-menu-match");
  const G = (id: string, name: string, opts: string[]) => ({ id, name, required: true, min: 1, options: opts.map((o, i) => ({ id: `${id}${i + 1}`, name: o, price: 0 })) });
  const MENU: any[] = [
    { id: "pep10", name: 'Pepperoni (10")', price: 7.9, categoryName: "Pizzas", modifierGroups: [G("cr", "Select Your Pizza Crust", ["Thin", "Deep Pan", "Stuffed"])] },
    { id: "pep12", name: 'Pepperoni (12")', price: 8.9, categoryName: "Pizzas", modifierGroups: [G("cr", "Select Your Pizza Crust", ["Thin", "Deep Pan", "Stuffed"])] },
    { id: "chips", name: "Chips", price: 2.9, categoryName: "Sides", modifierGroups: [] },
  ];
  const ctx = () => { const c: any = { currency: "GBP", items: MENU, deliveryZones: [] }; c.itemIndex = new Map(MENU.map((i) => [i.id, i])); c.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])))); return c; };
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; a.anthropic = null; a.model = "m"; return a; };
  const SAID = "a 12 inch pepperoni deep pan, two chips and a ten inch pepperoni";

  it("leaves a size at the end of one dish's words for the next dish, and hands each dish the words after it", () => {
    const { found, leftovers } = segmentItems(SAID, MENU, { limit: 3 });
    expect(found.map((f: any) => f.phrase)).toEqual(["a 12 inch pepperoni", "two chips and a", "ten inch pepperoni"]);
    expect(found.map((f: any) => f.trailing)).toEqual(["deep pan", "", ""]);
    expect(leftovers).toEqual(["deep", "pan"]);
  });

  it("a choice is taken from the caller's words only when they said it — 'ten inch' is not 'thin'", () => {
    expect(saysOption("ten inch pepperoni", "Thin")).toBe(false);
    expect(saysOption("a 12 inch pepperoni deep pan", "Deep Pan")).toBe(true);
    expect(saysOption("two large chips", "Large")).toBe(true);
    expect(saysOption("pepperoni", "Pepperoni Topping")).toBe(false);
  });

  it("adds the deep pan 12-inch and the chips, and asks the crust of the 10-inch instead of guessing thin", async () => {
    const a = ai(); const st: any = { cart: { items: [] }, turns: [] };
    const out = await a.runToolForConversation("parse_order", { said: SAID }, ctx(), st, null);
    expect(st.cart.items.map((l: any) => `${l.quantity}x${l.itemId}`)).toEqual(["1xpep12", "2xchips"]);
    expect(st.cart.items[0].modifiers.map((m: any) => m.name)).toEqual(["Deep Pan"]);
    expect(out.result).toMatch(/Still to ask: NOT added yet\. The Pepperoni still needs a choice of: pizza crust/);
  });

  it("files a dish that still needs its size under 'still to ask', not under 'added'", async () => {
    const a = ai(); const st: any = { cart: { items: [] }, turns: [] };
    const out = await a.runToolForConversation("parse_order", { said: "chips and a pepperoni" }, ctx(), st, null);
    expect(st.cart.items.map((l: any) => l.itemId)).toEqual(["chips"]);
    expect(out.result).toMatch(/^Added 1 × Chips\.\nStill to ask: Pepperoni comes in more than one size/);
  });
});

describe("the same line twice in one breath is once", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const MENU: any[] = [{ id: "chips", name: "Chips", price: 2.9, modifierGroups: [] }, { id: "gs", name: "Garlic Sauce", price: 1.3, modifierGroups: [] }];
  const ctx = () => { const c: any = { currency: "GBP", items: MENU, deliveryZones: [] }; c.itemIndex = new Map(MENU.map((i) => [i.id, i])); c.optionIndex = new Map(); return c; };
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };

  it("refuses an identical add seconds after the first, allows a different one, and allows it again later", () => {
    const a = ai(); const c = ctx(); const st: any = { cart: { items: [] }, turns: [] };
    expect(a.addItemConversational({ said: "chips" }, c, st).result).toMatch(/^Added/);
    expect(a.addItemConversational({ said: "chips" }, c, st).result).toMatch(/^Already on the order/);
    expect(a.addItemConversational({ said: "garlic sauce" }, c, st).result).toMatch(/^Added/);
    expect(st.cart.items).toHaveLength(2);
    (st as any).__lastAdd.at -= 10_000;
    expect(a.addItemConversational({ said: "garlic sauce" }, c, st).result).toMatch(/^Added/);
    expect(st.cart.items).toHaveLength(3);
  });
});

describe("a throttled caller reply is replayed, not apologised for", () => {
  const RL = (id: string) => ({ type: "response.done", response: { id, status: "failed", status_details: { type: "failed", error: { code: "rate_limit_exceeded", message: "Rate limit reached. Please try again in 20ms." } } } });
  it("re-asks for the caller's reply after the reset, with no script and no tools withheld", async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.sent.length = 0;
    sim.brain.deliver({ type: "input_audio_buffer.committed", item_id: "u1" });
    sim.brain.deliver({ type: "response.created", response: { id: "c1" } });    // the server's own reply to "yes"
    sim.brain.deliver(RL("c1")); await settle(700);
    const creates = sim.toModel.filter((m) => m.type === "response.create");
    expect(creates).toHaveLength(1);
    expect(creates[0].response).toEqual({ metadata: { origin: "caller" } });
    expect(sim.log.join(" ")).toMatch(/retry 1\/2 of a caller reply/);
  });
  it("leaves any other failure of a caller reply to the watchdog", async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.sent.length = 0;
    sim.brain.deliver({ type: "input_audio_buffer.committed", item_id: "u1" });
    sim.brain.deliver({ type: "response.created", response: { id: "c1" } });
    sim.brain.deliver({ type: "response.done", response: { id: "c1", status: "failed", status_details: { type: "failed", error: { code: "server_error", message: "boom" } } } });
    await settle(700);
    expect(sim.toModel.filter((m) => m.type === "response.create")).toHaveLength(0);
  });
});

describe("a reminder may not claim anything happened", () => {
  it("says so in its instructions", async () => {
    const sim = conversationSim({ idleMs: 40 });
    sim.gateway.config = { get: (k: string) => (k === "VOICE_CONVERSATION_IDLE_MS" || k === "VOICE_REALTIME_IDLE_MS" ? "40" : undefined) };
    await sim.answer(); sim.brain.sent.length = 0;
    spoke(sim, "r1"); await settle(120);
    const reminder = sim.toModel.find((m) => m.type === "response.create" && String(m.response?.instructions ?? "").includes("are you still there"));
    expect(reminder.response.instructions).toMatch(/Do not say that anything has been confirmed, placed, sent or done/);
  });
});

describe("what a reply costs", () => {
  it("is reported from the API's own accounting, and the session size once", async () => {
    const sim = conversationSim();
    await sim.answer();
    expect(sim.log.join(" ")).toMatch(/session size: instructions \d+ chars, tools \d+ chars \(~\d+ tokens per reply/);
    sim.brain.deliver({ type: "rate_limits.updated", rate_limits: [{ name: "tokens", limit: 40000, remaining: 30000, reset_seconds: 10 }] });
    sim.brain.deliver({ type: "rate_limits.updated", rate_limits: [{ name: "tokens", limit: 40000, remaining: 24600, reset_seconds: 18 }] });
    await settle();
    expect(sim.log.join(" ")).toMatch(/tokens 24600\/40000 \(reset 18s\) — this reply ≈ 5400 tokens/);
  });
});

describe("a delivery is priced or it is not read back", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };
  const gb = () => ({ currency: "GBP", country: "GB", items: [], itemIndex: new Map(), optionIndex: new Map(), deliveryZones: [{ id: "z", postcodePrefix: "NE37", fee: 3 }], address: { city: "Washington" } }) as any;

  it("propose_delivery_address uses the postcode the lookup found when the model leaves it out", async () => {
    const a = ai(); const st: any = { cart: { items: [] }, turns: [], addr: { postcode: "NE37 2LL", street: "Sunningdale Drive", city: "Washington" } };
    const out = await a.runTool("propose_delivery_address", { line1: "11 Sunningdale Drive", city: "Washington" }, gb(), st, null);
    expect(out.sayNow).toMatch(/So that's 11 Sunningdale Drive/);
    expect(st.cart.deliveryAddress.postcode).toBe("NE37 2LL");
  });

  it("refuses an address with no postcode at all, in a postcode-priced shop", async () => {
    const a = ai(); const st: any = { cart: { items: [] }, turns: [] };
    const out = await a.runTool("propose_delivery_address", { line1: "11 Sunningdale Drive", city: "Washington" }, gb(), st, null);
    expect(out.result).toMatch(/Not taken — there is no postcode/);
    expect(st.cart.deliveryAddress).toBeUndefined();
  });

  it("will not read back a delivery it cannot price", async () => {
    const a = ai(); const st: any = { cart: { items: [{ lineId: "a", name: "CHIPS", quantity: 1, unitBasePrice: 2.9, modifiers: [] }], fulfillmentType: "DELIVERY", fulfillmentChosen: true, deliveryAddress: { line1: "11 Sunningdale Drive", city: "Washington" } }, turns: [] };
    const out = await a.runTool("read_back_order", {}, gb(), st, null);
    expect(out.result).toMatch(/Not read back — the delivery address has no postcode/);
    expect(out.sayNow).toBeUndefined();
  });
});

// ── call R0y7AFEQ: "for delivery to ." — nobody asked, and nobody was remembered ──
describe("nothing is read back until collection or delivery has been asked", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const MENU: any[] = [{ id: "chips", name: "Chips", price: 2.9, modifierGroups: [] }];
  const ctx = () => { const c: any = { currency: "GBP", items: MENU, deliveryZones: [], itemIndex: new Map(MENU.map((i) => [i.id, i])), optionIndex: new Map() }; return c; };
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };
  const chips = () => ({ lineId: "a", name: "CHIPS", quantity: 1, unitBasePrice: 2.9, modifiers: [] });

  it("refuses a cart that was never asked — the default is not an answer", async () => {
    const a = ai(); const st: any = { cart: { items: [chips()], fulfillmentType: "DELIVERY" }, turns: [] };
    const out = await a.runTool("read_back_order", {}, ctx(), st, null);
    expect(out.result).toMatch(/^Not read back — you have not asked whether this is collection or delivery/);
    expect(out.sayNow).toBeUndefined();
    expect(st.readBackOf).toBeUndefined();
  });

  it("refuses a delivery with no address, and points at the one on file when there is one", async () => {
    const a = ai();
    const st: any = { cart: { items: [chips()], fulfillmentType: "DELIVERY", fulfillmentChosen: true }, turns: [] };
    expect((await a.runTool("read_back_order", {}, ctx(), st, null)).result).toMatch(/no address on the order\. Take the address first/);
    st.savedAddress = { line1: "11 Sunningdale Drive", city: "Washington", postcode: "NE37 2LL" };
    expect((await a.runTool("read_back_order", {}, ctx(), st, null)).result).toMatch(/Ask "still at 11 Sunningdale Drive\?"/);
  });

  it("reads back once the choice has been made — collection, or delivery with an address", async () => {
    const a = ai();
    const st: any = { cart: { items: [chips()], fulfillmentType: "DELIVERY" }, turns: [] };
    await a.runTool("set_fulfillment", { type: "PICKUP" }, ctx(), st, null);
    const out = await a.runTool("read_back_order", {}, ctx(), st, null);
    expect(out.sayNow).toMatch(/for collection\. That comes to £2\.90/);
    expect(out.sayNow).not.toMatch(/delivery to \./);
  });

  it("tells the model to ask, and never to assume", () => {
    const p = ai().promptForConversation(ctx(), { cart: { items: [] }, turns: [] }, null);
    expect(p).toMatch(/ask whether it's collection or delivery and call set_fulfillment\. Never assume either/);
    expect(p).toMatch(/read_back_order refuses until you have asked/);
  });
});

describe("the caller is remembered by name, whichever way they ordered", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const ai = (db: any) => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; a.db = () => db; return a; };
  const dbWith = (existing: { id: string; firstName: string | null } | null) => {
    const calls: any[] = [];
    return {
      calls,
      customer: {
        upsert: async (args: any) => { calls.push(["upsert", args]); return existing ?? { id: "new", firstName: args.create.firstName }; },
        update: async (args: any) => { calls.push(["update", args]); return {}; },
      },
    };
  };
  const ctx = () => ({ tenantId: "t1" }) as any;

  it("creates the customer with their first name on a collection order", async () => {
    const db = dbWith(null); const st: any = { cart: { items: [] }, turns: [] };
    await ai(db).rememberCaller(ctx(), "07700900123", st, "Omid Zadeh");
    expect(db.calls.map((c) => c[0])).toEqual(["upsert"]);
    expect(db.calls[0][1].create).toMatchObject({ tenantId: "t1", phone: "+447700900123", firstName: "Omid" });
    expect(st.knownName).toBe("Omid");
  });

  it("fills in a name the record lacks, and never overwrites one it has", async () => {
    const blank = dbWith({ id: "c1", firstName: null }); const st: any = { cart: { items: [] }, turns: [] };
    await ai(blank).rememberCaller(ctx(), "+447700900123", st, "Omid");
    expect(blank.calls.map((c) => c[0])).toEqual(["upsert", "update"]);
    expect(blank.calls[1][1]).toMatchObject({ where: { id: "c1" }, data: { firstName: "Omid" } });
    const named = dbWith({ id: "c1", firstName: "Sara" });
    await ai(named).rememberCaller(ctx(), "+447700900123", { cart: { items: [] }, turns: [], knownName: "Sara" }, "Omid");
    expect(named.calls.map((c) => c[0])).toEqual(["upsert"]);
  });

  it("writes nothing for the placeholder name, or with no number, and survives the database", async () => {
    const db = dbWith(null);
    await ai(db).rememberCaller(ctx(), "+447700900123", { cart: { items: [] }, turns: [] }, "Phone order");
    await ai(db).rememberCaller(ctx(), null, { cart: { items: [] }, turns: [] }, "Omid");
    expect(db.calls).toEqual([]);
    const broken = { customer: { upsert: async () => { throw new Error("db down"); } } };
    await expect(ai(broken).rememberCaller(ctx(), "+447700900123", { cart: { items: [] }, turns: [] }, "Omid")).resolves.toBeUndefined();
  });

  it("place_order remembers the name on every order, and the address only on a delivery", async () => {
    const a = ai({});
    a.orders = { create: async () => ({ id: "o1", orderNumber: 1201, status: "NEW" }) };
    a.textReceipt = async () => "";
    const remembered: string[] = [];
    a.rememberCaller = async (_c: any, _n: any, _s: any, name: string) => { remembered.push(`name:${name}`); };
    a.rememberAddress = async () => { remembered.push("address"); };
    const c: any = { currency: "GBP", items: [], itemIndex: new Map(), optionIndex: new Map(), deliveryZones: [], collectionPrepMinutes: 15, tenantId: "t1", locationId: "l1" };
    const st: any = { cart: { items: [{ lineId: "a", name: "CHIPS", quantity: 1, unitBasePrice: 2.9, modifiers: [] }], fulfillmentType: "PICKUP", fulfillmentChosen: true }, turns: [] };
    await a.runTool("read_back_order", {}, c, st, null);
    await a.runToolForConversation("order_confirmed", { __spokeAfterQuestion: true }, c, st, null);
    const out = await a.runToolForConversation("place_order", { customerName: "Omid", paymentMethod: "CASH", __spokeAfterQuestion: true }, c, st, "+447700900123");
    expect(out.result).toMatch(/^Order placed/);
    expect(remembered).toEqual(["name:Omid"]);
  });
});

describe("a known caller with no address on file is still known", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };
  it("is named in the prompt, and the model is told not to ask their name", () => {
    const p = ai().promptForConversation({ currency: "GBP", items: [], deliveryZones: [] } as any, { cart: { items: [] }, turns: [], knownName: "Omid" }, null);
    expect(p).toMatch(/You know this caller — Omid\. Don't ask their name/);
    expect(p).toMatch(/otherwise ask for a first name, once, before you place it\. Never make one up/);
  });
});

// ── call XpumpnRg: -6 dBFS on the line, nothing detected, "are you still there?" ──
describe("what the line carries, checked against what the model expects", () => {
  const idle = (sim: any) => {
    sim.gateway.config = {
      get: (k: string) => (k === 'VOICE_CONVERSATION_IDLE_MS' || k === 'VOICE_REALTIME_IDLE_MS' ? '40' : undefined),
    };
  };
  const fakeMeter = () => ({
    totals: { windows: 0, loudWindows: 0, loudUndetected: 0 },
    frame: () => null,
    shouldWarn: () => false,
    speechDetected() {},
    speechEnded() {},
    floorDb: () => -40,
  });

  it("logs the inbound format from the start frame, and forwards only the inbound track", async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.caller.deliver({ event: 'start', stream_id: 's1', start: { media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } });
    expect(sim.log.join('\n')).toMatch(/inbound audio: PCMU, 8000Hz, 1ch \(model expects μ-law 8kHz\)/);
    expect(sim.gateway.fallbackToRelay).not.toHaveBeenCalled();
    sim.brain.sent.length = 0;
    sim.caller.deliver({ event: 'media', media: { track: 'outbound', payload: 'AAAA' } });
    sim.caller.deliver({ event: 'media', media: { track: 'inbound', payload: 'BBBB' } });
    sim.caller.deliver({ event: 'media', media: { payload: 'CCCC' } });
    const appended = sim.toModel.filter((m) => m.type === 'input_audio_buffer.append').map((m) => m.audio);
    expect(appended).toEqual(['BBBB', 'CCCC']);
  });

  it("hands over at once when the stream is not μ-law 8kHz — the model would hear noise", async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.caller.deliver({ event: 'start', stream_id: 's1', start: { media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 } } });
    expect(sim.log.join('\n')).toMatch(/ERROR .*inbound audio is PCMA at 8000Hz, not μ-law 8kHz/);
    expect(sim.gateway.fallbackToRelay).toHaveBeenCalledTimes(1);
    sim.brain.sent.length = 0;
    sim.caller.deliver({ event: 'media', media: { track: 'inbound', payload: 'BBBB' } });
    expect(sim.toModel.filter((m) => m.type === 'input_audio_buffer.append')).toHaveLength(0);
  });

  it("logs the turn detection the server accepted, not only the one we asked for", async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.deliver({ type: 'session.updated', session: { audio: { input: { turn_detection: { type: 'server_vad', threshold: 0.6, silence_duration_ms: 600 } } } } });
    expect(sim.log.join('\n')).toMatch(/server accepted turn_detection \{"type":"server_vad","threshold":0\.6,"silence_duration_ms":600\}/);
  });

  it("describes each wait in frames delivered and seconds loud-but-undetected", async () => {
    const sim = conversationSim({ idleMs: 40 }); idle(sim);
    await sim.answer();
    (sim.brain as any).__meter = fakeMeter();
    spoke(sim, 'r1');
    for (let i = 0; i < 5; i++) sim.caller.deliver({ event: 'media', media: { track: 'inbound', payload: ONE_SECOND } });
    await settle(70);
    expect(sim.log.join('\n')).toMatch(/checking in \(.*line 5 frames in \/ 0s loud-undetected this wait/);
  });

  it("a loud line the detector never hears is handed over on the second wait, not asked a third time", async () => {
    const sim = conversationSim({ idleMs: 40 }); idle(sim);
    await sim.answer();
    const meter = fakeMeter();
    (sim.brain as any).__meter = meter;
    spoke(sim, 'r1');
    const keepAlive = setInterval(() => sim.caller.deliver({ event: 'media', media: { track: 'inbound', payload: ONE_SECOND } }), 5);
    await settle(70); // first check-in: "are you still there?"
    expect(sim.log.join(' ')).toMatch(/caller quiet — checking in/);
    meter.totals.loudUndetected += 3; // three loud seconds, no speech_started
    await settle(70);
    clearInterval(keepAlive);
    expect(sim.log.join('\n')).toMatch(/ERROR .*the line was loud for 3s and the detector heard none of it/);
    expect(sim.gateway.fallbackToRelay).toHaveBeenCalledTimes(1);
    expect(sim.gateway.telnyx.hangup).not.toHaveBeenCalled();
    const said = sim.toModel.filter((m) => m.type === 'response.create').map((m) => m.response?.instructions ?? '');
    expect(said.some((s) => s.includes('Bye for now'))).toBe(false);
  });

  it("a line delivering no audio at all across two waits is a dead line, not a quiet caller", async () => {
    const sim = conversationSim({ idleMs: 40 }); idle(sim);
    await sim.answer();
    spoke(sim, 'r1');
    await settle(160); // two waits, not one frame
    expect(sim.log.join('\n')).toMatch(/ERROR .*no inbound audio from the line across two waits/);
    expect(sim.gateway.fallbackToRelay).toHaveBeenCalledTimes(1);
    expect(sim.gateway.telnyx.hangup).not.toHaveBeenCalled();
  });

  it("one early loud window does not move a call, and the caller speaking wipes the slate", async () => {
    const sim = conversationSim({ idleMs: 40 }); idle(sim);
    await sim.answer();
    const meter = fakeMeter();
    (sim.brain as any).__meter = meter;
    spoke(sim, 'r1');
    const keepAlive = setInterval(() => sim.caller.deliver({ event: 'media', media: { track: 'inbound', payload: ONE_SECOND } }), 5);
    meter.totals.loudUndetected += 1;
    await settle(70); // one loud second before the first check-in
    sim.brain.deliver({ type: 'input_audio_buffer.speech_started' });
    sim.brain.deliver({ type: 'input_audio_buffer.speech_stopped' });
    spoke(sim, 'r2');
    meter.totals.loudUndetected += 1;
    await settle(70);
    clearInterval(keepAlive);
    expect(sim.gateway.fallbackToRelay).not.toHaveBeenCalled();
  });
});
