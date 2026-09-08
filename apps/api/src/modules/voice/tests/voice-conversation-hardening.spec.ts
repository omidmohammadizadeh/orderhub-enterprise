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
    expect(await s.placedOrderFor('cc1')).toEqual({ reference: 'J, V, M, X, 7' }); // what the board shows
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
    expect(out.result).toMatch(/^Added 1 × Chips — £2\.90\.\nStill to ask: Pepperoni comes in more than one size/);
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
    expect(sim.log.join(" ")).toMatch(/tokens 24600\/40000 \(reset 18s\) — budget moved ≈ 5400 tokens \(estimate; see usage\)/);
  });

  it("logs each reply's real usage from the response itself", async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.deliver({ type: "response.created", response: { id: "u1" } });
    sim.brain.deliver({ type: "response.done", response: { id: "u1", status: "completed", usage: { total_tokens: 5415, input_tokens: 5200, output_tokens: 215, input_token_details: { text_tokens: 4100, audio_tokens: 1100, cached_tokens: 3900 }, output_token_details: { text_tokens: 15, audio_tokens: 200 } } } });
    await settle();
    expect(sim.log.join("\n")).toMatch(/reply u1 usage: 5415 tokens — in 5200 \(text 4100, audio 1100, cached 3900\), out 215 \(text 15, audio 200\)/);
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

// ── calls 7de77pbA / lVMD0vUw: no credits, handed over twice, start frame lost ──
describe("a call is handed to the other engine once, whichever watcher noticed first", () => {
  it("the model dropping before the session was ready does not also trip the readiness timer", async () => {
    const sim = new VoiceRealtimeSim({ readyMs: 40 });
    const started = jest.spyOn(sim.gateway.telnyx, 'startConversationRelay');
    await sim.gateway.attach(sim.caller, 'cc-drop');
    sim.brain.emit('open');
    await settle(5);
    sim.brain.deliver({ type: 'error', error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'You have no credits remaining.' } });
    sim.brain.close();
    await settle(90);
    expect(started).toHaveBeenCalledTimes(1);
    expect(sim.log.join('\n')).toMatch(/dropped mid-call/);
    expect(sim.log.join('\n')).not.toMatch(/never became ready/);
    expect(sim.log.join('\n')).not.toMatch(/could not be moved/);
  });

  it("a second hand-over of the same call is declined, not attempted", async () => {
    const sim = new VoiceRealtimeSim();
    const started = jest.spyOn(sim.gateway.telnyx, 'startConversationRelay');
    await sim.answer('cc-twice');
    await sim.gateway.fallbackToRelay('cc-twice', { alreadySpoke: true });
    await sim.gateway.fallbackToRelay('cc-twice', { alreadySpoke: true });
    expect(started).toHaveBeenCalledTimes(1);
    expect(sim.log.join('\n')).toMatch(/already handed to the standard engine — not again/);
  });
});

describe("an account with no credits stands the engine down", () => {
  it("answers the next calls on the standard engine, says why, and comes back after the wait", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    expect(sim.gateway.available()).toEqual({ ok: true });
    sim.brain.deliver({ type: 'error', error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'You have no credits remaining. Add credits…' } });
    const a = sim.gateway.available();
    expect(a.ok).toBe(false);
    expect(a.why).toMatch(/no credits \(credit_balance_exhausted\) — standing down for 10 minutes/);
    expect(sim.log.join('\n')).toMatch(/ERROR realtime the OpenAI account has no credits/);
    sim.gateway.standDown.until = Date.now() - 1;
    expect(sim.gateway.available()).toEqual({ ok: true });
  });

  it("a rate limit is not a reason to stand down", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.deliver({ type: 'error', error: { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded', message: 'Rate limit reached' } });
    expect(sim.gateway.available()).toEqual({ ok: true });
  });
});

describe("the start frame that arrives before the session lookup returns", () => {
  it("is kept and read once the listener is in place — and a wrong codec still hands over", async () => {
    const sim = conversationSim();
    const slow = sim.gateway.voice.realtimeSession;
    sim.gateway.voice.realtimeSession = async (...args: any[]) => { await settle(30); return slow(...args); };
    const attaching = sim.gateway.attach(sim.caller, 'cc-early');
    // Telnyx does not wait for us.
    sim.caller.deliver({ event: 'start', stream_id: 's-early', start: { media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 } } });
    sim.caller.deliver({ event: 'media', media: { track: 'inbound', payload: 'AAAA' } });
    await attaching;
    expect(sim.log.join('\n')).toMatch(/inbound audio: PCMA, 8000Hz, 1ch/);
    expect(sim.gateway.fallbackToRelay).toHaveBeenCalledTimes(1);
  });

  it("a μ-law start frame that arrived early is logged and nothing is handed over", async () => {
    const sim = conversationSim();
    const slow = sim.gateway.voice.realtimeSession;
    sim.gateway.voice.realtimeSession = async (...args: any[]) => { await settle(30); return slow(...args); };
    const attaching = sim.gateway.attach(sim.caller, 'cc-early-ok');
    sim.caller.deliver({ event: 'start', stream_id: 's-early', start: { media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } });
    await attaching;
    expect(sim.log.join('\n')).toMatch(/inbound audio: PCMU, 8000Hz, 1ch/);
    expect(sim.gateway.fallbackToRelay).not.toHaveBeenCalled();
  });
});

// ── call aqbbdSDA: OK to the read-back, cash to the payment question, and place_order refused ──
describe("a yes answers the question it followed, not the last thing said", () => {
  const toolIn = (sim: any, rid: string, name: string, args: any = {}) => {
    sim.brain.deliver({ type: 'response.created', response: { id: rid } });
    sim.brain.deliver({ type: 'response.function_call_arguments.done', response_id: rid, name, call_id: `c-${rid}`, arguments: JSON.stringify(args) });
  };
  const said = (sim: any, rid: string, text: string, origin = 'caller') => {
    sim.brain.deliver({ type: 'response.created', response: { id: rid, metadata: { origin } } });
    sim.brain.deliver({ type: 'response.output_audio_transcript.done', response_id: rid, transcript: text });
    sim.brain.deliver({ type: 'response.done', response: { id: rid, status: 'completed' } });
  };

  it("read-back → OK → 'cash or card?' → cash: order_confirmed takes the OK, place_order takes the cash", async () => {
    const sim = conversationSim();
    (sim.gateway.voice.conversationTool as jest.Mock).mockImplementation(async (_c: string, name: string) =>
      name === 'read_back_order'
        ? { result: 'Order read back to the caller. Wait for their answer.', sayNow: "So that's chips. Is that all correct?" }
        : { result: 'ok' },
    );
    await sim.answer();
    // The model calls read_back_order; the script is spoken as its own reply.
    toolIn(sim, 'r1', 'read_back_order');
    await settle(30);
    sim.brain.deliver({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    await settle(10);
    const script = sim.toModel.filter((m) => m.type === 'response.create').at(-1);
    expect(script.response.instructions).toMatch(/Is that all correct\?/);
    said(sim, 's1', "So that's chips. Is that all correct?", 'script');
    // "OK"
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u-ok' });
    // The model skips order_confirmed and asks about payment.
    said(sim, 'r2', 'Great. Cash or card for payment?');
    // "Cash"
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u-cash' });
    // Now it remembers: order_confirmed, then place_order, both in reply to the cash turn.
    toolIn(sim, 'r3', 'order_confirmed');
    await settle(30);
    toolIn(sim, 'r4', 'place_order', { paymentMethod: 'CASH', customerName: 'Omid' });
    await settle(30);

    const calls = (sim.gateway.voice.conversationTool as jest.Mock).mock.calls.map((c) => [c[1], c[2].__spokeAfterQuestion]);
    expect(calls).toEqual([
      ['read_back_order', false],
      ['order_confirmed', true],
      ['place_order', true],
    ]);
  });

  it("without an answer to the read-back, a later cash turn is not a yes", async () => {
    const sim = conversationSim();
    (sim.gateway.voice.conversationTool as jest.Mock).mockImplementation(async (_c: string, name: string) =>
      name === 'read_back_order' ? { result: 'read back', sayNow: 'Is that all correct?' } : { result: 'ok' },
    );
    await sim.answer();
    toolIn(sim, 'r1', 'read_back_order');
    await settle(30);
    sim.brain.deliver({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    await settle(10);
    said(sim, 's1', 'Is that all correct?', 'script');
    // Nobody answered; the model asks about payment anyway, and the caller answers THAT.
    said(sim, 'r2', 'Cash or card?');
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u-cash' });
    toolIn(sim, 'r3', 'order_confirmed');
    await settle(30);
    const calls = (sim.gateway.voice.conversationTool as jest.Mock).mock.calls.map((c) => [c[1], c[2].__spokeAfterQuestion]);
    // The cash turn came after the read-back too, so by turn order it IS the first
    // unspent answer to it — the gate is about turns, not words. What matters is
    // that it is spent once: place_order then has nothing.
    expect(calls).toEqual([['read_back_order', false], ['order_confirmed', true]]);
    toolIn(sim, 'r4', 'place_order', { paymentMethod: 'CASH' });
    await settle(30);
    expect((sim.gateway.voice.conversationTool as jest.Mock).mock.calls.at(-1)![2].__spokeAfterQuestion).toBe(false);
  });
});

describe("the watchdog stands back while the API's own cooldown is running", () => {
  const RL = (id: string, ms: number) => ({
    type: 'response.done',
    response: { id, status: 'failed', status_details: { type: 'failed', error: { code: 'rate_limit_exceeded', message: `Rate limit reached for gpt-realtime on tokens per min (TPM): Limit 40000, Used 39864, Requested 5688. Please try again in ${ms}ms.` } } },
  });

  it("a cooldown longer than the quiet clock is not a stall, and the call is not handed over", async () => {
    const sim = conversationSim({ quietMs: 40 });
    sim.gateway.config = { get: (k: string) => (k === 'VOICE_REALTIME_QUIET_MS' ? '40' : undefined) };
    await sim.answer();
    (sim.gateway.voice.conversationTool as jest.Mock).mockResolvedValueOnce({ result: 'Confirmed. Now ask how they would like to pay.' });
    // As on the live call: the tool runs inside a reply, its follow-up reply
    // is created, and THAT reply is refused with a wait longer than the clock.
    sim.brain.deliver({ type: 'response.created', response: { id: 'r1' } });
    sim.brain.deliver({ type: 'response.function_call_arguments.done', response_id: 'r1', name: 'order_confirmed', call_id: 'c1', arguments: '{}' });
    await settle(15);
    sim.brain.deliver({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    sim.brain.deliver({ type: 'response.created', response: { id: 't1', metadata: { origin: 'tool' } } });
    sim.brain.deliver(RL('t1', 850)); // "try again in 850ms": far past two quiet clocks
    await settle(400);
    expect(sim.log.join('\n')).toMatch(/retry 1\/2 of a tool reply in \d+ms \(API asked for 850ms\)/);
    expect(sim.log.join('\n')).toMatch(/a retry is scheduled \(cooldown \d+ms more\) — the watchdog stands back/);
    expect(sim.log.join('\n')).not.toMatch(/silent twice over/);
    expect(sim.log.join('\n')).not.toMatch(/nothing came back/);
    expect(sim.gateway.fallbackToRelay).not.toHaveBeenCalled();
    await settle(800);
    // The retry went out when the API said it could.
    const retries = sim.toModel.filter((m) => m.type === 'response.create' && m.response?.metadata?.origin === 'tool');
    expect(retries.length).toBeGreaterThanOrEqual(2);
  });
});

describe("handing over mid-order picks up where the call was", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const { VoiceService } = require("../voice.service");
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };
  const ctx = () => ({ currency: "GBP", items: [], itemIndex: new Map(), optionIndex: new Map(), deliveryZones: [{ id: "z", postcodePrefix: "NE10", fee: 1 }] }) as any;
  const chips = () => ({ lineId: "a", name: "CHIPS", quantity: 1, unitBasePrice: 2.9, modifiers: [] });

  it("asks only for what is missing", () => {
    const a = ai();
    const empty = a.resumeAloud(ctx(), { cart: { items: [] }, turns: [] });
    expect(empty.say).toMatch(/take it from the top — what would you like to order\?/);
    expect(empty.next).toBeUndefined();
    expect(a.resumeAloud(ctx(), { cart: { items: [chips()], fulfillmentType: "DELIVERY" }, turns: [] })).toMatchObject({ say: expect.stringMatching(/still got your order\. Is this collection or delivery\?/), next: "FULFILLMENT" });
    expect(a.resumeAloud(ctx(), { cart: { items: [chips()], fulfillmentType: "DELIVERY", fulfillmentChosen: true }, turns: [] })).toMatchObject({ say: expect.stringMatching(/What's the delivery address\?/), next: "ADDR_FULL" });
    const addr = { line1: "11 Follingsby Drive", city: "Gateshead", postcode: "NE10 8YH" };
    expect(a.resumeAloud(ctx(), { cart: { items: [chips()], fulfillmentType: "DELIVERY", fulfillmentChosen: true, deliveryAddress: addr }, turns: [] })).toMatchObject({ say: expect.stringMatching(/Is the delivery address 11 Follingsby Drive/), next: "ADDRESS_CONFIRM" });
  });

  it("reads the order back when everything but the yes is there, and asks for payment once it is confirmed", async () => {
    const a = ai();
    const c = ctx();
    const addr = { line1: "11 Follingsby Drive", city: "Gateshead", postcode: "NE10 8YH" };
    const st: any = { cart: { items: [chips()], fulfillmentType: "DELIVERY", fulfillmentChosen: true, deliveryAddress: addr }, turns: [] };
    await a.runToolForConversation("confirm_delivery_address", { __spokeAfterQuestion: true }, c, st, null);
    const readBack = a.resumeAloud(c, st);
    expect(readBack.next).toBe("ORDER_CONFIRM");
    expect(readBack.say).toMatch(/I've still got everything\. So that's CHIPS, for delivery to 11 Follingsby Drive.*plus £1\.00 delivery.*£3\.90\. Is that all correct\?/);
    expect(st.readBackOf).toBeDefined();
    await a.runToolForConversation("order_confirmed", { __spokeAfterQuestion: true }, c, st, null);
    expect(a.resumeAloud(c, st)).toMatchObject({ say: expect.stringMatching(/Your order's confirmed\. How would you like to pay — cash, or card\?/), next: "PAYMENT" });
  });

  it("the service records what the engine is now waiting for", async () => {
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.ai = ai();
    const state: any = { cart: { items: [chips()], fulfillmentType: "PICKUP", fulfillmentChosen: true }, turns: [], stage: "MENU" };
    const saved: any[] = [];
    s.loadByControlId = async () => ({ call: { id: "c1" }, ctx: ctx(), state });
    s.save = async (_id: string, st: any) => { saved.push(JSON.parse(JSON.stringify(st))); };
    const say = await s.resumeGreeting("cc1");
    expect(say).toMatch(/I've still got everything\. So that's CHIPS, for collection\. That comes to £2\.90\. Is that all correct\?/);
    expect(saved[0].awaiting).toBe("ORDER_CONFIRM");
    expect(saved[0].stage).toBe("ORDER");
    expect(saved[0].turns.at(-1)).toEqual({ role: "assistant", text: say });
    s.loadByControlId = async () => null;
    expect(await s.resumeGreeting("cc-gone")).toBeNull();
  });

  it("the gateway uses it for a mid-call hand-over, and the old apology only when it cannot", async () => {
    const sim = new VoiceRealtimeSim();
    const started = jest.spyOn(sim.gateway.telnyx, 'startConversationRelay');
    await sim.answer('cc-resume');
    sim.gateway.voice.resumeGreeting = async () => "Sorry about that — I lost you for a moment. Your order's confirmed. How would you like to pay — cash, or card?";
    await sim.gateway.fallbackToRelay('cc-resume', { alreadySpoke: true });
    expect(started.mock.calls.at(-1)![1].greeting).toMatch(/Your order's confirmed/);
    expect(started.mock.calls.at(-1)![1].greeting).not.toMatch(/take it from the top/);
  });
});

// ── call laylhxjw: the number read out was not the one on the board; amendments; closing ──
describe("one reference for an order, everywhere", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };
  const c = () => ({ currency: "GBP", items: [], itemIndex: new Map(), optionIndex: new Map(), deliveryZones: [], collectionPrepMinutes: 15, tenantId: "t1", locationId: "l1", locationName: "Pizza Uno" }) as any;

  it("the caller is told what the board shows, spelled out", async () => {
    const a = ai();
    a.orders = { create: async () => ({ id: "o1", orderNumber: 1201, displayId: "4J79Y", status: "NEW" }) };
    a.textReceipt = async () => ""; a.rememberCaller = async () => {}; a.rememberAddress = async () => {};
    const st: any = { cart: { items: [{ lineId: "a", name: "CHIPS", quantity: 1, unitBasePrice: 2.9, modifiers: [] }], fulfillmentType: "PICKUP", fulfillmentChosen: true }, turns: [] };
    await a.runTool("read_back_order", {}, c(), st, null);
    await a.runToolForConversation("order_confirmed", { __spokeAfterQuestion: true }, c(), st, null);
    const out = await a.runToolForConversation("place_order", { customerName: "Omid", paymentMethod: "CASH", __spokeAfterQuestion: true }, c(), st, "+447700900123");
    expect(out.sayNow).toMatch(/order number 4, J, 7, 9, Y\./);
    expect(out.sayNow).not.toMatch(/1, 2, 0, 1/);
    expect(out.result).toMatch(/Order number 4, J, 7, 9, Y/);
  });
});

describe("changing an order that is already in — on this call or a later one", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const G = (id: string, name: string, opts: string[]) => ({ id, name, required: true, min: 1, options: opts.map((o, i) => ({ id: `${id}${i + 1}`, name: o, price: 0 })) });
  const MENU: any[] = [
    { id: "pep12", name: 'Pepperoni (12")', price: 8.9, categoryName: "Pizzas", modifierGroups: [G("cr", "Select Your Pizza Crust", ["Thin", "Deep Pan"])] },
    { id: "chips", name: "Chips", price: 2.9, categoryName: "Sides", modifierGroups: [] },
  ];
  const c = (over: any = {}) => { const x: any = { tenantId: "t1", locationId: "l1", currency: "GBP", country: "GB", items: MENU, deliveryZones: [{ id: "z", postcodePrefix: "NE10", fee: 1 }], transferNumber: "+441912312345", ...over }; x.itemIndex = new Map(MENU.map((i) => [i.id, i])); x.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])))); return x; };
  const PLACED = (over: any = {}) => ({
    id: "o1", displayId: "4J79Y", collectionCode: null, orderNumber: 1201, orderSource: "VOICE", status: "ACCEPTED",
    fulfillmentType: "DELIVERY", paymentMethod: "CASH", paymentStatus: "PENDING", customerPhone: "+447700900123",
    deliveryAddress: { line1: "11 Follingsby Drive", city: "Gateshead", postcode: "NE10 8YH", country: "GB" },
    deliveryFee: 1, discount: 2, taxAmount: 0, tipAmount: 0, serviceCharge: 0, updatedAt: new Date("2026-09-08T10:00:00Z"), createdAt: new Date(),
    items: [{ name: 'Pepperoni (12")', quantity: 1, unitPrice: 8.9, notes: "no onions", modifiers: [{ name: "Deep Pan", price: 0 }], menuItemId: "pep12" }],
    ...over,
  });
  const ai = (order: any, recheck: any = order) => {
    const a: any = Object.create(VoiceAiService.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    let calls = 0;
    a.db = () => ({ order: { findFirst: async () => (calls++ === 0 ? order : recheck), findMany: async () => (order ? [order] : []) } });
    a.orders = { editOrder: jest.fn(async () => ({})) };
    return a;
  };

  it("loads the order placed on this call with its choices, note, address and charges, and adds chips to it", async () => {
    const a = ai(PLACED());
    const st: any = { cart: { items: [] }, turns: [], orderId: "o1" };
    const found = await a.runToolForConversation("find_order_to_change", {}, c(), st, "+447700900123");
    expect(found.result).toMatch(/^Loaded order 4J79Y to change \(ACCEPTED, delivery to 11 Follingsby Drive\)/);
    expect(st.cart.items).toHaveLength(1);
    expect(st.cart.items[0].modifiers.map((m: any) => m.name)).toEqual(["Deep Pan"]);
    expect(st.cart.items[0].notes).toBe("no onions");
    expect(st.cart.deliveryAddress.line1).toBe("11 Follingsby Drive");
    expect(a.addressStillConfirmed(st)).toBe(true);
    expect(st.amendLoaded).toMatchObject({ status: "ACCEPTED", deliveryFee: 1, discount: 2 });

    a.addItemConversational({ said: "chips" }, c(), st);
    const rb = await a.runTool("read_back_order", {}, c(), st, null);
    expect(rb.sayNow).toMatch(/Pepperoni \(12 inch\) with Deep Pan, no onions, then Chips, for delivery to 11 Follingsby Drive.*plus £1\.00 delivery less £2\.00 discount That comes to £10\.80/);
    // The yes to the read-back saves it there and then.
    const saved = await a.runToolForConversation("order_confirmed", { __spokeAfterQuestion: true }, c(), st, "+447700900123");
    expect(saved.result).toMatch(/^Order 4J79Y saved with the change — new total £10\.80/);
    expect(saved.sayNow).toMatch(/^Done — order 4, J, 7, 9, Y is updated, and it now comes to £10\.80\./);
    const [id, tenant, dto, who] = a.orders.editOrder.mock.calls[0];
    expect([id, tenant, who]).toEqual(["o1", "t1", "voice-ai"]);
    expect(dto.items.map((i: any) => [i.name, i.modifiers?.map((m: any) => m.name), i.notes])).toEqual([
      ['Pepperoni (12")', ["Deep Pan"], "no onions"],
      ["Chips", undefined, undefined],
    ]);
    // The KDS routes by menuItemId: the loaded line keeps the order's, the new line carries the menu's.
    expect(dto.items.map((i: any) => i.menuItemId)).toEqual(["pep12", "chips"]);
    expect(dto).toMatchObject({ subtotal: 11.8, deliveryFee: 1, discount: 2, total: 10.8, deliveryAddress: { line1: "11 Follingsby Drive", postcode: "NE10 8YH" } });
    expect(st.amendOrderId).toBeUndefined();
  });

  it("finds an earlier order by the reference the caller reads, letters and all", async () => {
    const a = ai(PLACED({ status: "PENDING" }));
    const st: any = { cart: { items: [] }, turns: [] };
    const found = await a.runToolForConversation("find_order_to_change", { orderNumber: "four J seven nine Y" }, c(), st, "+447700900123");
    expect(found.result).toMatch(/^Loaded order 4J79Y/);
    expect(st.amendOrderId).toBe("o1");
  });

  it("refuses, with the reason, an order the kitchen has finished, one paid by card, and one that is not ours", async () => {
    const st = () => ({ cart: { items: [] }, turns: [] }) as any;
    const ready = await ai(PLACED({ status: "READY" })).runToolForConversation("find_order_to_change", { orderNumber: "4J79Y" }, c(), st(), null);
    expect(ready.result).toMatch(/Too late to change order 4J79Y — it is READY\. Say: "Sorry, that one's already made up and waiting for a driver/);
    const paid = await ai(PLACED({ paymentMethod: "CARD", paymentStatus: "PAID" })).runToolForConversation("find_order_to_change", { orderNumber: "4J79Y" }, c(), st(), null);
    expect(paid.result).toMatch(/already been paid by card/);
    const je = await ai(PLACED({ orderSource: "JUST_EAT", displayId: "SIM-I2DC" })).runToolForConversation("find_order_to_change", { orderNumber: "S I M I 2 D C" }, c(), st(), null);
    expect(je.result).toMatch(/Not ours to change — order SIM-I2DC came through Just Eat/);
  });

  it("a kitchen that moved on while the caller was choosing is caught before anything is written", async () => {
    const a = ai(PLACED(), PLACED({ status: "READY" }));
    const st: any = { cart: { items: [] }, turns: [], orderId: "o1" };
    await a.runToolForConversation("find_order_to_change", {}, c(), st, "+447700900123");
    a.addItemConversational({ said: "chips" }, c(), st);
    await a.runTool("read_back_order", {}, c(), st, null);
    const out = await a.runToolForConversation("order_confirmed", { __spokeAfterQuestion: true }, c(), st, null);
    expect(out.result).toMatch(/already made up and waiting for a driver.*The kitchen moved on while we were talking/);
    expect(out.turn?.transferTo).toBe("+441912312345");
    expect(a.orders.editOrder).not.toHaveBeenCalled();
    expect(st.amendOrderId).toBeUndefined();
  });

  it("a change after the read-back needs a fresh yes, and place_order is refused while changing", async () => {
    const a = ai(PLACED());
    const st: any = { cart: { items: [] }, turns: [], orderId: "o1" };
    await a.runToolForConversation("find_order_to_change", {}, c(), st, "+447700900123");
    await a.runTool("read_back_order", {}, c(), st, null);
    a.addItemConversational({ said: "chips" }, c(), st);
    // A line added after the read-back: nothing is saved until it is read back again.
    expect((await a.runToolForConversation("amend_order", {}, c(), st, null)).result).toMatch(/CHANGED since it was read back/);
    expect(a.orders.editOrder).not.toHaveBeenCalled();
    expect((await a.runToolForConversation("place_order", { paymentMethod: "CASH", __spokeAfterQuestion: true }, c(), st, null)).result).toMatch(/Use amend_order, not place_order/);
  });

  it("the prompt tells the model the route", () => {
    const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} };
    const p = a.promptForConversation(c(), { cart: { items: [] }, turns: [] }, null);
    expect(p).toMatch(/AN ORDER ALREADY PLACED/);
    expect(p).toMatch(/find_order_to_change \(with the number if they read one\)/);
    expect(p).toMatch(/pass it exactly as said, letters included/);
  });
});

describe("a call ends without asking the model for one more reply", () => {
  const RL = (id: string) => ({ type: 'response.done', response: { id, status: 'failed', status_details: { type: 'failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 7.369s.' } } } });

  it("after a goodbye has already been said, end_call hangs up with no further reply and no retry", async () => {
    const sim = conversationSim();
    (sim.gateway.voice.conversationTool as jest.Mock).mockResolvedValue({ result: 'Ending call.', turn: { endCall: true } });
    await sim.answer();
    sim.brain.deliver({ type: 'response.created', response: { id: 'p1', metadata: { origin: 'script' } } });
    sim.brain.deliver({ type: 'response.output_audio_transcript.done', response_id: 'p1', transcript: "That's all booked in, order number 4, J, 7, 9, Y. Thanks for calling, goodbye." });
    sim.brain.deliver({ type: 'response.done', response: { id: 'p1', status: 'completed' } });
    sim.brain.sent.length = 0;
    await sim.callTool('end_call');
    await settle(700);
    expect(sim.toModel.filter((m) => m.type === 'response.create')).toHaveLength(0);
    expect(sim.log.join('\n')).toMatch(/closing — goodbye already said, no further reply/);
    expect(sim.gateway.telnyx.hangup).toHaveBeenCalledTimes(1);
    expect(sim.log.join('\n')).not.toMatch(/retry 1\/2/);
  });

  it("otherwise one scripted goodbye — and if the API refuses it, hang up anyway rather than retry", async () => {
    const sim = conversationSim();
    (sim.gateway.voice.conversationTool as jest.Mock).mockResolvedValue({ result: 'Ending call.', turn: { endCall: true } });
    await sim.answer();
    sim.brain.sent.length = 0;
    await sim.callTool('end_call');
    const creates = sim.toModel.filter((m) => m.type === 'response.create');
    expect(creates).toHaveLength(1);
    expect(creates[0].response.instructions).toMatch(/bye for now/);
    expect(creates[0].response.tool_choice).toBe('none');
    sim.brain.deliver({ type: 'response.created', response: { id: 'g1', metadata: { origin: 'script' } } });
    sim.brain.deliver(RL('g1'));
    await settle(20);
    expect(sim.log.join('\n')).toMatch(/closing — the goodbye was refused \(rate_limit_exceeded\); hanging up without it/);
    expect(sim.log.join('\n')).not.toMatch(/retry 1\/2/);
    expect(sim.gateway.telnyx.hangup).toHaveBeenCalled();
  });
});

// ── call r4tWUGIg: "we've got the pizza and drink" — and add_item had kept neither ──
describe("a deal is chosen across turns, and what is chosen is kept", () => {
  const { VoiceAiService, coerceState } = require("../voice-ai.service");
  const { matchOption } = require("../voice-menu-match");
  const G = (id: string, name: string, opts: string[], over: any = {}) => ({ id, name, required: true, min: 1, max: 1, selectionType: "VARIANT", options: opts.map((o, i) => ({ id: `${id}${i + 1}`, name: o, price: 0 })), ...over });
  const MENU: any[] = [
    { id: "deal2", name: "MEAL DEAL 2", price: 25, categoryName: "Deals", modifierGroups: [
      G("dp", "Pizza", ["Margherita", "Pepperoni"]),
      G("dk", "Kebab", ["Donner Kebab", "Chicken Kebab"]),
      G("dd", "Drink", ["CAN CKOE", "CAN SPRITE", "CAN FANTA", "CAN DIET COKE"]),
      G("ds", "Sauce", ["Garlic", "Chilli", "No Sauce"], { required: false, min: 0 }),
      G("dc", "CHIPS OR SALAD", ["Chips", "Salad"], { required: false, min: 1 }),
    ] },
    { id: "two", name: "TWO PIZZA DEAL", price: 18, categoryName: "Deals", modifierGroups: [G("tp", "Pizzas", ["Margherita", "Pepperoni"], { min: 2, max: 2, selectionType: "ADDON" })] },
    { id: "coke", name: "CAN COKE", price: 1.2, categoryName: "Drinks", modifierGroups: [] },
    { id: "gb", name: "Garlic Bread", price: 3.5, categoryName: "Sides", modifierGroups: [] },
  ];
  const c = () => { const x: any = { currency: "GBP", items: MENU, deliveryZones: [] }; x.itemIndex = new Map(MENU.map((i) => [i.id, i])); x.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])))); return x; };
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };
  const fresh = () => ({ cart: { items: [], fulfillmentType: "PICKUP", fulfillmentChosen: true }, turns: [] }) as any;
  const mods = (st: any) => st.cart.items[0].modifiers.map((m: any) => m.name);

  it("all the choices in one sentence: added once, at the deal's price, nothing standalone", () => {
    const a = ai(); const st = fresh();
    const out = a.addItemConversational({ said: "meal deal 2", modifierNames: ["pepperoni", "donner", "coke", "chips"] }, c(), st);
    expect(out.result).toMatch(/^Added 1 × MEAL DEAL 2 with Pepperoni, Donner Kebab, CAN CKOE, Chips — £25\.00\./);
    expect(st.cart.items).toHaveLength(1);
    expect(st.cart.items[0].itemId).toBe("deal2");
    expect(mods(st)).toEqual(["Pepperoni", "Donner Kebab", "CAN CKOE", "Chips"]);
    expect(st.draft).toBeUndefined();
  });

  it("choices across several turns are kept, each reply says what is still missing, and 'coke' is the deal's drink", () => {
    const a = ai(); const st = fresh(); const ctx = c();
    const one = a.addItemConversational({ said: "meal deal 2", modifierNames: ["pepperoni"] }, ctx, st);
    expect(one.result).toMatch(/^NOT added yet\. The MEAL DEAL 2 \(so far: pizza: Pepperoni\) still needs a choice of: kebab \(Donner Kebab, Chicken Kebab\); drink \(CAN CKOE, CAN SPRITE, CAN FANTA, CAN DIET COKE\); chips or salad \(Chips, Salad\)\./);
    expect(one.result).toMatch(/what is chosen is kept/);
    expect(st.draft).toMatchObject({ itemId: "deal2", picks: [{ g: "dp", o: "dp2" }] });
    // "donner" — no modifierNames, just the caller's word, while a deal is open
    const two = a.addItemConversational({ said: "donner" }, ctx, st);
    expect(two.result).toMatch(/so far: pizza: Pepperoni; kebab: Donner Kebab\) still needs a choice of: drink/);
    expect(two.result).not.toMatch(/kebab \(/);
    // "coke" is on the menu as a can of its own; here it is the deal's drink
    const three = a.addItemConversational({ said: "coke" }, ctx, st);
    expect(three.result).toMatch(/drink: CAN CKOE\) still needs a choice of: chips or salad/);
    expect(st.cart.items).toHaveLength(0);
    const four = a.addItemConversational({ said: "chips" }, ctx, st);
    expect(four.result).toMatch(/^Added 1 × MEAL DEAL 2 with Pepperoni, Donner Kebab, CAN CKOE, Chips/);
    expect(st.cart.items).toHaveLength(1);
    expect(st.cart.items.map((l: any) => l.itemId)).toEqual(["deal2"]);
    expect(st.draft).toBeUndefined();
  });

  it("changing only the drink replaces that one choice and keeps the rest", () => {
    const a = ai(); const st = fresh(); const ctx = c();
    a.addItemConversational({ said: "meal deal 2", modifierNames: ["pepperoni", "donner", "coke"] }, ctx, st);
    const out = a.addItemConversational({ said: "actually make it fanta", modifierNames: ["fanta"] }, ctx, st);
    expect(out.result).toMatch(/drink: CAN FANTA/);
    expect(out.result).toMatch(/Replaced: CAN CKOE/);
    expect(st.draft.picks.map((p: any) => p.o)).toEqual(["dp2", "dk1", "dd3"]);
  });

  it("two of the same where the group allows it", () => {
    const a = ai(); const st = fresh();
    const out = a.addItemConversational({ said: "two pizza deal", modifierNames: ["two pepperoni"] }, c(), st);
    expect(out.result).toMatch(/^Added 1 × TWO PIZZA DEAL with Pepperoni, Pepperoni/);
    expect(mods(st)).toEqual(["Pepperoni", "Pepperoni"]);
    const b = ai(); const st2 = fresh();
    const half = b.addItemConversational({ said: "two pizza deal", modifierNames: ["pepperoni"] }, c(), st2);
    expect(half.result).toMatch(/still needs a choice of: pizzas \(Margherita, Pepperoni\) — 1 more/);
    b.addItemConversational({ said: "margherita" }, c(), st2);
    expect(st2.cart.items[0].modifiers.map((m: any) => m.name)).toEqual(["Pepperoni", "Margherita"]);
  });

  it("a menu question midway leaves the draft where it was", async () => {
    const a = ai(); const st = fresh(); const ctx = c();
    a.addItemConversational({ said: "meal deal 2", modifierNames: ["pepperoni", "donner"] }, ctx, st);
    await a.runTool("find_item", { said: "garlic bread" }, ctx, st, null);
    expect(st.draft).toMatchObject({ itemId: "deal2" });
    expect(st.draft.picks).toHaveLength(2);
    expect(a.cartForModel(st, ctx)).toMatch(/\(still choosing, not on the order\) 1× MEAL DEAL 2 — pizza: Pepperoni; kebab: Donner Kebab — still needs: drink, chips or salad/);
  });

  it("'that's it' with a required choice missing does not finish; with everything required it does", () => {
    const a = ai(); const st = fresh(); const ctx = c();
    a.addItemConversational({ said: "meal deal 2", modifierNames: ["pepperoni", "donner", "chips"] }, ctx, st);
    const early = a.addItemConversational({ done: true }, ctx, st);
    expect(early.result).toMatch(/^NOT added yet\..*still needs a choice of: drink/);
    expect(early.result).toMatch(/They said that's it, but this is required, so it is not finished/);
    expect(st.cart.items).toHaveLength(0);
    expect(st.draft.picks).toHaveLength(3);
    const done = a.addItemConversational({ said: "sprite", done: true }, ctx, st);
    expect(done.result).toMatch(/^Added 1 × MEAL DEAL 2 with Pepperoni, Donner Kebab, Chips, CAN SPRITE/);
    expect(st.cart.items).toHaveLength(1);
  });

  it("says only what it actually kept, and what it could not place", () => {
    const a = ai(); const st = fresh();
    const out = a.addItemConversational({ said: "meal deal 2", modifierNames: ["pepperoni", "thingamajig"] }, c(), st);
    expect(out.result).toMatch(/so far: pizza: Pepperoni/);
    expect(out.result).toMatch(/Could not place: "thingamajig"/);
  });

  it("CAN CKOE: the caller's 'coke' finds it, 'diet coke' finds the diet one", () => {
    const drinks = MENU[0].modifierGroups[2].options;
    expect(matchOption("coke", drinks, "Drink")?.item.name).toBe("CAN CKOE");
    expect(matchOption("diet coke", drinks, "Drink")?.item.name).toBe("CAN DIET COKE");
    expect(matchOption("a can of coke", drinks, "Drink")?.item.name).toBe("CAN CKOE");
    expect(matchOption("fanta", drinks, "Drink")?.item.name).toBe("CAN FANTA");
  });

  it("a second dish while a deal is open is added on its own, and the deal stays open", () => {
    const a = ai(); const st = fresh(); const ctx = c();
    a.addItemConversational({ said: "meal deal 2", modifierNames: ["pepperoni"] }, ctx, st);
    const out = a.addItemConversational({ said: "garlic bread" }, ctx, st);
    expect(out.result).toMatch(/^Added 1 × Garlic Bread/);
    expect(out.result).toMatch(/still choosing, not on the order\) 1× MEAL DEAL 2/);
    expect(st.draft).toMatchObject({ itemId: "deal2" });
  });

  it("forgetting the deal, clearing the order, and surviving a reload", async () => {
    const a = ai(); const st = fresh(); const ctx = c();
    a.addItemConversational({ said: "meal deal 2", modifierNames: ["pepperoni"] }, ctx, st);
    const saved = coerceState(JSON.parse(JSON.stringify(st)));
    expect(saved.draft).toMatchObject({ itemId: "deal2", picks: [{ g: "dp", o: "dp2" }] });
    const dropped = a.removeItemConversational({ said: "the meal deal" }, ctx, st);
    expect(dropped.result).toMatch(/Dropped the MEAL DEAL 2 that was being chosen/);
    expect(st.draft).toBeUndefined();
    a.addItemConversational({ said: "meal deal 2", modifierNames: ["pepperoni"] }, ctx, st);
    await a.runToolForConversation("clear_order", {}, ctx, st, null);
    expect(st.draft).toBeUndefined();
  });

  it("the prompt and the tool say how it works", () => {
    const a = ai();
    const p = a.promptForConversation(c(), fresh(), null);
    expect(p).toMatch(/add_item keeps what is chosen so far/);
    expect(p).toMatch(/call add_item with done: true/);
    expect(p).toMatch(/Never add a deal's drink, side or sauce as a separate item/);
    const add = a.toolsForConversation(c()).find((t: any) => t.name === "add_item");
    expect(add.parameters.properties.done).toBeDefined();
    expect(add.description).toMatch(/KEEPS what has been chosen so far/);
  });
});

// ── call F88Nz_EQ: "that's fine", "okay", "yes, that's fine" — and the order read back three times ──
describe("the caller's yes to an amended read-back saves it", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const G = (id: string, name: string, opts: string[]) => ({ id, name, required: true, min: 1, max: 1, selectionType: "VARIANT", options: opts.map((o, i) => ({ id: `${id}${i + 1}`, name: o, price: 0 })) });
  const MENU: any[] = [
    { id: "kp12", name: 'KEBAB PIZZA (12")', price: 8.9, categoryName: "Pizzas", modifierGroups: [G("cr", "Select Your Pizza Crust", ["thin base", "deep pan"])] },
    { id: "chips", name: "Chips", price: 2.9, categoryName: "Sides", modifierGroups: [] },
  ];
  const c = () => { const x: any = { tenantId: "t1", locationId: "l1", currency: "GBP", country: "GB", items: MENU, deliveryZones: [], transferNumber: "+441912312345", collectionPrepMinutes: 15 }; x.itemIndex = new Map(MENU.map((i) => [i.id, i])); x.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])))); return x; };
  const PLACED = (over: any = {}) => ({
    id: "o58", displayId: "58EAU", collectionCode: null, orderNumber: 1210, orderSource: "VOICE", status: "ACCEPTED",
    fulfillmentType: "PICKUP", paymentMethod: "CASH", paymentStatus: "PENDING", customerPhone: "+447700900123",
    deliveryAddress: null, deliveryFee: 0, discount: 0, taxAmount: 0, tipAmount: 0, serviceCharge: 0, updatedAt: new Date(), createdAt: new Date(),
    items: [{ name: "MEAL DEAL 2", quantity: 1, unitPrice: 25, notes: null, modifiers: [
      { name: "DONNER KEBAB", price: 0 }, { name: "+CHIPS", price: 0 }, { name: '10"KEBAB PIZZA ', price: 0 }, { name: "+GARLIC", price: 0 }, { name: "CAN CKOE", price: 0 }, { name: "CAN CKOE", price: 0 },
    ] }],
    ...over,
  });
  const ai = (order: any = PLACED()) => {
    const a: any = Object.create(VoiceAiService.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    a.db = () => ({ order: { findFirst: async () => order, findMany: async () => [order] } });
    a.orders = { editOrder: jest.fn(async () => ({})) };
    return a;
  };
  const readBack = async (a: any) => {
    const st: any = { cart: { items: [] }, turns: [], orderId: "o58" };
    await a.runToolForConversation("find_order_to_change", {}, c(), st, "+447700900123");
    a.addItemConversational({ said: "chips" }, c(), st);
    const rb = await a.runTool("read_back_order", {}, c(), st, null);
    return { st, rb };
  };
  const yes = (heard: string) => ({ __conversation: true, __spokeAfterQuestion: true, __heard: heard });

  it("reads the loaded order back cleanly — no plus signs, no quote marks, identical choices counted", async () => {
    const { rb } = await readBack(ai());
    expect(rb.sayNow).toBe("So that's MEAL DEAL 2 with DONNER KEBAB, CHIPS, 10 inch KEBAB PIZZA, GARLIC and 2 CAN CKOE, then Chips, for collection. That comes to £27.90. Is that all correct?");
  });

  it("'that's fine' after the read-back saves the change once, with no second read-back", async () => {
    const a = ai(); const { st } = await readBack(a);
    const out = await a.runToolForConversation("amend_order", yes("That's fine."), c(), st, "+447700900123");
    expect(out.result).toMatch(/^Order 58EAU saved with the change — new total £27\.90/);
    expect(out.sayNow).toMatch(/^Done — order 5, 8, E, A, U is updated, and it now comes to £27\.90\./);
    expect(a.orders.editOrder).toHaveBeenCalledTimes(1);
    expect(a.orders.editOrder.mock.calls[0][2].items.map((i: any) => i.name)).toEqual(["MEAL DEAL 2", "Chips"]);
    const again = await a.runToolForConversation("amend_order", yes("Okay."), c(), st, "+447700900123");
    expect(again.result).toMatch(/no existing order being changed/);
    expect(a.orders.editOrder).toHaveBeenCalledTimes(1);
  });

  it("'okay' does too, and so does a turn the transcriber could not read", async () => {
    const a = ai(); const { st } = await readBack(a);
    expect((await a.runToolForConversation("amend_order", yes("Okay."), c(), st, null)).result).toMatch(/^Order 58EAU saved/);
    const b = ai(); const two = await readBack(b);
    expect((await b.runToolForConversation("amend_order", { __conversation: true, __spokeAfterQuestion: true, __heard: null }, c(), two.st, null)).result).toMatch(/^Order 58EAU saved/);
  });

  it("a no, or a yes-but, is not a yes", async () => {
    const a = ai(); const { st } = await readBack(a);
    const no = await a.runToolForConversation("amend_order", yes("No, change the drink."), c(), st, null);
    expect(no.result).toMatch(/^Not saved — they did not simply agree, they said "No, change the drink\."/);
    const but = await a.runToolForConversation("amend_order", yes("Yes, but change the drink to Fanta"), c(), st, null);
    expect(but.result).toMatch(/^Not saved — they did not simply agree/);
    expect(a.orders.editOrder).not.toHaveBeenCalled();
    expect(st.amendOrderId).toBe("o58");
  });

  it("silence after the read-back waits, and says not to read it again", async () => {
    const a = ai(); const { st } = await readBack(a);
    const out = await a.runToolForConversation("amend_order", { __conversation: true, __spokeAfterQuestion: false }, c(), st, null);
    expect(out.result).toMatch(/hasn't answered since\. Wait for them — do not read it back again/);
    expect(a.orders.editOrder).not.toHaveBeenCalled();
  });

  it("a change after the read-back needs a fresh read-back — and says so, not 'not read back yet'", async () => {
    const a = ai(); const { st } = await readBack(a);
    a.addItemConversational({ said: "kebab pizza 12 inch", modifierNames: ["thin base"] }, c(), st);
    expect(st.cart.items).toHaveLength(3);
    const out = await a.runToolForConversation("amend_order", yes("Yes"), c(), st, null);
    expect(out.result).toMatch(/^The order has CHANGED since it was read back/);
    expect(a.orders.editOrder).not.toHaveBeenCalled();
  });

  it("order_confirmed while changing an order saves it there and then — no payment question, no second tool", async () => {
    const a = ai(); const { st } = await readBack(a);
    const out = await a.runToolForConversation("order_confirmed", { __spokeAfterQuestion: true }, c(), st, null);
    expect(out.result).toMatch(/^Order 58EAU saved with the change — new total £27\.90/);
    expect(out.result).not.toMatch(/cash|kitchen has the new ticket/);
    expect(out.sayNow).toBe("Done — order 5, 8, E, A, U is updated, and it now comes to £27.90. Anything else?");
    expect(a.orders.editOrder).toHaveBeenCalledTimes(1);
    // The model calling amend_order afterwards anyway saves nothing twice.
    expect((await a.runToolForConversation("amend_order", yes("yes"), c(), st, null)).result).toMatch(/no existing order being changed/);
    expect(a.orders.editOrder).toHaveBeenCalledTimes(1);
  });

  it("'that's it' with nothing being chosen is pointed at the read-back or the save", async () => {
    const a = ai(); const { st } = await readBack(a);
    const out = a.addItemConversational({ done: true }, c(), st);
    expect(out.result).toMatch(/Nothing is being chosen right now\. If they are agreeing to the read-back, call amend_order/);
    expect(st.cart.items).toHaveLength(2);
  });

  it("the gateway hands amend_order the caller's answer to the read-back, and its words", async () => {
    const sim = conversationSim();
    (sim.gateway.voice.conversationTool as jest.Mock).mockImplementation(async (_c: string, name: string) =>
      name === 'read_back_order' ? { result: 'read back', sayNow: 'So that is chips. Is that all correct?' } : { result: 'ok' },
    );
    await sim.answer();
    sim.brain.deliver({ type: 'response.created', response: { id: 'r1' } });
    sim.brain.deliver({ type: 'response.function_call_arguments.done', response_id: 'r1', name: 'read_back_order', call_id: 'c1', arguments: '{}' });
    await settle(30);
    sim.brain.deliver({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    await settle(10);
    sim.brain.deliver({ type: 'response.created', response: { id: 's1', metadata: { origin: 'script' } } });
    sim.brain.deliver({ type: 'response.output_audio_transcript.done', response_id: 's1', transcript: 'So that is chips. Is that all correct?' });
    sim.brain.deliver({ type: 'response.done', response: { id: 's1', status: 'completed' } });
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u-fine' });
    sim.brain.deliver({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u-fine', transcript: "That's fine." });
    await settle(10);
    sim.brain.deliver({ type: 'response.created', response: { id: 'r2' } });
    sim.brain.deliver({ type: 'response.function_call_arguments.done', response_id: 'r2', name: 'amend_order', call_id: 'c2', arguments: '{}' });
    await settle(30);
    const call = (sim.gateway.voice.conversationTool as jest.Mock).mock.calls.find((k) => k[1] === 'amend_order')!;
    expect(call[2].__spokeAfterQuestion).toBe(true);
    expect(call[2].__heard).toBe("That's fine.");
    expect(sim.log.join('\n')).toMatch(/said "So that is chips\. Is that all correct\?" \(38 chars\)/);
  });
});

// ── call HPHR9SFQ: "donner kebab" turned the pepperoni into a kebab pizza, and the kebab stayed missing ──
describe("an answer lands in the group it belongs to, and a deal's fixed parts are not questions", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const G = (id: string, name: string, opts: string[], over: any = {}) => ({ id, name, required: true, min: 1, max: 1, selectionType: "VARIANT", options: opts.map((o, i) => ({ id: `${id}${i + 1}`, name: o, price: 0 })), ...over });
  const deal = (kebabs: string[]) => ({ id: "deal2", name: "MEAL DEAL 2", price: 25, categoryName: "Deals", modifierGroups: [
    G("dp", '10" pizza', ['10" PEPPERONI', '10"KEBAB PIZZA ', "10 inch AMELIO"]),
    G("dd", "Drink", ["CAN Coke", "CAN Sprite"], { min: 2, max: 2, selectionType: "ADDON" }),
    G("ds", "Sauce", ["+GARLIC", "+CHILLI"], { required: false, min: 1 }),
    G("dc", "CHIPS OR SALAD", ["Chips", "Salad"], { required: false, min: 1 }),
    G("dk", "Kebab", kebabs),
  ] });
  const c = (kebabs: string[] = ["DONNER KEBAB"]) => { const MENU = [deal(kebabs)]; const x: any = { currency: "GBP", items: MENU, deliveryZones: [] }; x.itemIndex = new Map(MENU.map((i) => [i.id, i])); x.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])))); return x; };
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log: jest.fn(), warn() {}, error() {} }; return a; };
  const fresh = () => ({ cart: { items: [], fulfillmentType: "PICKUP", fulfillmentChosen: true }, turns: [] }) as any;
  const names = (st: any) => st.cart.items[0].modifiers.map((m: any) => m.name);

  it("the caller's exact order from the call: pepperoni, chips, garlic, two cokes — the kebab fills itself and the deal is added once", async () => {
    const a = ai(); const st = fresh(); const ctx = c();
    const out = a.addItemConversational({ said: "meal deal 2", modifierNames: ["10 inch pepperoni", "chips", "garlic", "two cokes"] }, ctx, st);
    // In the order they were said; the kebab, which nobody chose, last.
    expect(out.result).toMatch(/^Added 1 × MEAL DEAL 2 with 10" PEPPERONI, Chips, \+GARLIC, CAN Coke, CAN Coke, DONNER KEBAB — £25\.00\./);
    expect(st.cart.items).toHaveLength(1);
    expect(names(st)).toEqual(['10" PEPPERONI', "Chips", "+GARLIC", "CAN Coke", "CAN Coke", "DONNER KEBAB"]);
    const rb = await a.runTool("read_back_order", {}, ctx, st, null);
    expect(rb.sayNow).toMatch(/MEAL DEAL 2 with 10 inch PEPPERONI, Chips, GARLIC, 2 CAN Coke and DONNER KEBAB, for collection\. That comes to £25\.00/);
  });

  it("with a real kebab choice, 'donner kebab' goes to the kebab group and the pepperoni stays", () => {
    const a = ai(); const st = fresh(); const ctx = c(["DONNER KEBAB", "CHICKEN KEBAB"]);
    const first = a.addItemConversational({ said: "meal deal 2", modifierNames: ["10 inch pepperoni", "chips", "garlic", "two cokes"] }, ctx, st);
    expect(first.result).toMatch(/still needs a choice of: kebab \(DONNER KEBAB, CHICKEN KEBAB\)/);
    expect(st.draft.picks.find((p: any) => p.g === "dp").o).toBe("dp1");
    const out = a.addItemConversational({ said: "donner kebab" }, ctx, st);
    expect(out.result).toMatch(/^Added 1 × MEAL DEAL 2 with 10" PEPPERONI, .*DONNER KEBAB/);
    expect(names(st)).toContain('10" PEPPERONI');
    expect(names(st)).not.toContain('10"KEBAB PIZZA ');
    // "yes" to "do you want the donner kebab?" arrives as the option's name too
    const b = ai(); const st2 = fresh();
    b.addItemConversational({ said: "meal deal 2", modifierNames: ["10 inch pepperoni", "chips", "garlic", "two cokes"] }, ctx, st2);
    b.addItemConversational({ modifierNames: ["donner kebab"] }, ctx, st2);
    expect(st2.cart.items).toHaveLength(1);
    expect(names(st2)).toContain('10" PEPPERONI');
  });

  it("an intentional 'kebab pizza' changes the pizza group only", () => {
    const a = ai(); const st = fresh(); const ctx = c(["DONNER KEBAB", "CHICKEN KEBAB"]);
    a.addItemConversational({ said: "meal deal 2", modifierNames: ["10 inch pepperoni", "chips", "garlic", "two cokes"] }, ctx, st);
    const out = a.addItemConversational({ said: "change the pizza to kebab pizza", modifierNames: ["kebab pizza"] }, ctx, st);
    expect(out.result).toMatch(/Replaced: 10" PEPPERONI/);
    expect(out.result).toMatch(/still needs a choice of: kebab/);
    expect(st.draft.picks.find((p: any) => p.g === "dp").o).toBe("dp2");
    expect(st.draft.picks.filter((p: any) => p.g === "dk")).toHaveLength(0);
  });

  it("the same unmatched answer twice is not asked for a third time the same way", () => {
    const a = ai(); const st = fresh(); const ctx = c(["DONNER KEBAB", "CHICKEN KEBAB"]);
    a.addItemConversational({ said: "meal deal 2", modifierNames: ["10 inch pepperoni", "chips", "garlic", "two cokes"] }, ctx, st);
    const one = a.addItemConversational({ said: "donate kavabit", modifierNames: ["donate kavabit"] }, ctx, st);
    expect(one.result).toMatch(/Could not place: "donate kavabit"/);
    expect(one.result).not.toMatch(/NOTHING they said matched/);
    const two = a.addItemConversational({ said: "donate kavabit qivis", modifierNames: ["donate kavabit qivis"] }, ctx, st);
    expect(two.result).toMatch(/NOTHING they said matched — 2 times running\. Do not ask the same way again: offer the kebab options as a short list.*or offer transfer_to_staff/);
    expect(st.draft.picks).toHaveLength(5);
    expect(st.draft.stalls).toBe(2);
  });

  it("logs what add_item was given and what it did with it", () => {
    const a = ai(); const st = fresh(); const ctx = c(["DONNER KEBAB", "CHICKEN KEBAB"]);
    a.addItemConversational({ said: "meal deal 2", modifierNames: ["10 inch pepperoni", "thingamajig"] }, ctx, st);
    const line = (a.logger.log as jest.Mock).mock.calls.map((k) => String(k[0])).find((l) => l.startsWith("add_item MEAL DEAL 2"));
    expect(line).toMatch(/said="meal deal 2" names=\["10 inch pepperoni","thingamajig"\] → kept \[10" PEPPERONI\] replaced \[\] unplaced \[thingamajig\] missing \[drink, sauce, chips or salad, kebab\]/);
  });
});

// ── call G9JVU_7A: the address resolved in 170ms and waited twelve seconds to be repeated ──
describe("questions with a known wording are spoken as scripts, not composed", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const G = (id: string, name: string, opts: string[]) => ({ id, name, required: true, min: 1, max: 1, selectionType: "VARIANT", options: opts.map((o, i) => ({ id: `${id}${i + 1}`, name: o, price: 0 })) });
  const MENU: any[] = [
    { id: "pep12", name: 'Pepperoni (12")', price: 8.9, categoryName: "Pizzas", modifierGroups: [G("cr", "Select Your Pizza Crust", ["Thin", "Deep Pan", "Stuffed"])] },
    { id: "chips", name: "Chips", price: 2.9, categoryName: "Sides", modifierGroups: [] },
    { id: "deal2", name: "MEAL DEAL 2", price: 25, categoryName: "Deals", modifierGroups: [G("dp", "Pizza", ["Margherita", "Pepperoni"]), G("dk", "Kebab", ["Donner", "Chicken"]), G("dd", "Drink", ["Coke", "Fanta"])] },
  ];
  const c = (over: any = {}) => { const x: any = { currency: "GBP", country: "GB", items: MENU, deliveryZones: [{ id: "z", postcodePrefix: "NE10", fee: 1 }], acceptsCash: true, acceptsCard: true, ...over }; x.itemIndex = new Map(MENU.map((i) => [i.id, i])); x.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])))); return x; };
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };
  const ADDR = { line1: "11 Follingsby Drive", city: "Gateshead", postcode: "NE10 8YH", country: "GB" };
  const withChips = (over: any = {}) => ({ cart: { items: [{ lineId: "a", itemId: "chips", name: "Chips", quantity: 1, unitBasePrice: 2.9, modifiers: [] }], ...over }, turns: [] }) as any;

  it("a resolved address is read back as a script, with the confirmation gate still in front of it", async () => {
    const a = ai(); const st: any = { cart: { items: [], fulfillmentType: "DELIVERY", fulfillmentChosen: true, deliveryAddress: ADDR }, turns: [], addressConfirmed: true };
    const out = await a.scripted("resolve_address", { result: "That resolves to 11 Follingsby Drive, Gateshead, N E 1 0, 8 Y H. Say exactly that followed by \"— is that right?\" and wait." }, c(), st);
    expect(out.sayNow).toBe("11 Follingsby Drive, Gateshead, N E 1 0, 8 Y H — is that right?");
    expect(out.askedBy).toBe("propose_delivery_address");
    expect(out.result).toMatch(/Wait for their answer\. Call confirm_delivery_address only if they say yes/);
    expect(st.addressConfirmed).toBe(false);
    expect(a.addressStillConfirmed(st)).toBe(false);
  });

  it("confirming the address with the order already taken reads it straight back, charge included", async () => {
    const a = ai(); const st = withChips({ fulfillmentType: "DELIVERY", fulfillmentChosen: true, deliveryAddress: ADDR });
    const out = await a.runToolForConversation("confirm_delivery_address", { __conversation: true, __spokeAfterQuestion: true }, c(), st, null);
    expect(out.sayNow).toBe("Lovely — delivery to that address is £1.00. So that's Chips, for delivery to 11 Follingsby Drive, Gateshead, N E 1 0, 8 Y H. plus £1.00 delivery That comes to £3.90. Is that all correct?");
    expect(out.askedBy).toBe("read_back_order");
    expect(out.result).toMatch(/^Address confirmed\. Delivers to NE10\. Fee £1\.00\. The whole order was then read back to the caller, charge included\. Order read back/);
    expect(st.readBackOf).toBe(a.orderFingerprint(st));
    expect(a.addressStillConfirmed(st)).toBe(true);
  });

  it("confirming the address with nothing ordered yet asks for the order; with a dish half-chosen it leaves the model to it", async () => {
    const a = ai();
    const empty: any = { cart: { items: [], fulfillmentType: "DELIVERY", fulfillmentChosen: true, deliveryAddress: ADDR }, turns: [] };
    const one = await a.runToolForConversation("confirm_delivery_address", { __conversation: true, __spokeAfterQuestion: true }, c(), empty, null);
    expect(one.sayNow).toBe("Lovely — delivery to that address is £1.00. What would you like to order?");
    const mid = withChips({ fulfillmentType: "DELIVERY", fulfillmentChosen: true, deliveryAddress: ADDR });
    mid.draft = { itemId: "pep12", quantity: 1, picks: [], startedAt: Date.now() };
    const two = await a.runToolForConversation("confirm_delivery_address", { __conversation: true, __spokeAfterQuestion: true }, c(), mid, null);
    expect(two.sayNow).toBeUndefined();
    expect(two.result).toMatch(/^Address confirmed/);
  });

  it("collection or delivery is noted in a script — and read back at once when the order is all there", async () => {
    const a = ai();
    const st = withChips();
    const pickup = await a.runToolForConversation("set_fulfillment", { type: "PICKUP" }, c(), st, null);
    expect(pickup.sayNow).toBe("Collection it is. So that's Chips, for collection. That comes to £2.90. Is that all correct?");
    expect(pickup.askedBy).toBe("read_back_order");
    const known: any = { cart: { items: [] }, turns: [], savedAddress: { line1: "11 Sunningdale Drive", city: "Washington", postcode: "NE37 2LL" } };
    const still = await a.runToolForConversation("set_fulfillment", { type: "DELIVERY" }, c(), known, null);
    expect(still.sayNow).toBe("Are you still at 11 Sunningdale Drive?");
    expect(still.askedBy).toBe("set_fulfillment");
    const fresh: any = { cart: { items: [] }, turns: [] };
    const ask = await a.runToolForConversation("set_fulfillment", { type: "DELIVERY" }, c(), fresh, null);
    expect(ask.sayNow).toBe("Delivery — what's the address, with the postcode?");
  });

  it("the payment question is a script when the shop takes both, and the model's when it does not", async () => {
    const a = ai();
    const st = withChips({ fulfillmentType: "PICKUP", fulfillmentChosen: true });
    await a.runTool("read_back_order", {}, c(), st, null);
    const out = await a.runToolForConversation("order_confirmed", { __spokeAfterQuestion: true }, c(), st, null);
    expect(out.sayNow).toBe("Lovely. How would you like to pay — cash, or card?");
    const b = ai(); const st2 = withChips({ fulfillmentType: "PICKUP", fulfillmentChosen: true });
    await b.runTool("read_back_order", {}, c({ acceptsCard: false }), st2, null);
    const cashOnly = await b.runToolForConversation("order_confirmed", { __spokeAfterQuestion: true }, c({ acceptsCard: false }), st2, null);
    expect(cashOnly.sayNow).toBeUndefined();
  });

  it("one missing choice is asked as a script; several, or a caller not getting through, go to the model", () => {
    const a = ai(); const ctx = c();
    const st: any = { cart: { items: [] }, turns: [] };
    const one = a.addItemConversational({ said: "12 inch pepperoni" }, ctx, st);
    expect(one.sayNow).toBe("Which pizza crust for the Pepperoni: Thin, Deep Pan or Stuffed?");
    expect(one.result).toMatch(/That question is being asked for you/);
    const st2: any = { cart: { items: [] }, turns: [] };
    const many = a.addItemConversational({ said: "meal deal 2" }, ctx, st2);
    expect(many.sayNow).toBeUndefined();
    const st3: any = { cart: { items: [] }, turns: [] };
    a.addItemConversational({ said: "12 inch pepperoni" }, ctx, st3);
    a.addItemConversational({ modifierNames: ["blorp"] }, ctx, st3);
    const stuck = a.addItemConversational({ modifierNames: ["blorp"] }, ctx, st3);
    expect(stuck.sayNow).toBeUndefined();
    expect(stuck.result).toMatch(/NOTHING they said matched/);
  });

  it("the gateway judges the yes against the question the script asked, whichever tool spoke it", async () => {
    const sim = conversationSim();
    (sim.gateway.voice.conversationTool as jest.Mock).mockImplementation(async (_c: string, name: string) =>
      name === 'confirm_delivery_address'
        ? { result: 'Address confirmed. The whole order was then read back.', sayNow: 'Lovely. So that is chips. Is that all correct?', askedBy: 'read_back_order' }
        : name === 'resolve_address'
          ? { result: 'Address resolved and read back.', sayNow: '11 Follingsby Drive — is that right?', askedBy: 'propose_delivery_address' }
          : { result: 'ok' },
    );
    await sim.answer();
    const toolIn = (rid: string, name: string) => {
      sim.brain.deliver({ type: 'response.created', response: { id: rid } });
      sim.brain.deliver({ type: 'response.function_call_arguments.done', response_id: rid, name, call_id: `c-${rid}`, arguments: '{}' });
    };
    const scriptSpoken = async (rid: string, sid: string, text: string) => {
      await settle(30);
      sim.brain.deliver({ type: 'response.done', response: { id: rid, status: 'completed' } });
      await settle(10);
      sim.brain.deliver({ type: 'response.created', response: { id: sid, metadata: { origin: 'script' } } });
      sim.brain.deliver({ type: 'response.output_audio_transcript.done', response_id: sid, transcript: text });
      sim.brain.deliver({ type: 'response.done', response: { id: sid, status: 'completed' } });
    };
    // resolve_address's script asks the address question; the yes is confirm_delivery_address's evidence
    toolIn('r1', 'resolve_address');
    await scriptSpoken('r1', 's1', '11 Follingsby Drive — is that right?');
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u-yes1' });
    toolIn('r2', 'confirm_delivery_address');
    await scriptSpoken('r2', 's2', 'Lovely. So that is chips. Is that all correct?');
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u-yes2' });
    toolIn('r3', 'order_confirmed');
    await settle(30);
    const calls = (sim.gateway.voice.conversationTool as jest.Mock).mock.calls.map((k) => [k[1], k[2].__spokeAfterQuestion]);
    expect(calls).toEqual([['resolve_address', false], ['confirm_delivery_address', true], ['order_confirmed', true]]);
  });
});

// ── order S6TJG: "extra pepperoni" went to the kitchen as a note, and nobody paid for it ──
describe("an extra topping in a note is charged as a topping", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const MENU: any[] = [
    { id: "marg12", name: 'MARGHERITA (12")', price: 8.6, categoryName: "Pizzas", modifierGroups: [
      { id: "cr", name: "Select Your Pizza Crust", required: true, min: 1, max: 1, selectionType: "VARIANT", options: [{ id: "cr1", name: "thin base", price: 0 }, { id: "cr2", name: "deep pan", price: 0 }] },
      { id: "tp", name: "Extra Toppings", required: false, min: 0, max: 5, selectionType: "ADDON", options: [{ id: "tp1", name: "Pepperoni", price: 1.5 }, { id: "tp2", name: "Mushrooms", price: 1 }, { id: "tp3", name: "Onions", price: 0.8 }] },
    ] },
  ];
  const c = () => { const x: any = { currency: "GBP", items: MENU, deliveryZones: [] }; x.itemIndex = new Map(MENU.map((i) => [i.id, i])); x.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])))); return x; };
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };
  const fresh = () => ({ cart: { items: [] }, turns: [] }) as any;

  it("'extra pepperoni' becomes the Pepperoni topping, priced, and leaves no note", () => {
    const a = ai(); const st = fresh();
    const out = a.addItemConversational({ said: "12 inch margherita", modifierNames: ["thin base"], notes: "extra pepperoni" }, c(), st);
    expect(out.result).toMatch(/^Added 1 × MARGHERITA \(12"\) with thin base, Pepperoni — £10\.10\./);
    expect(out.result).toMatch(/Charged as toppings, not notes: Pepperoni \(\+1\.50\) — say the price/);
    expect(st.cart.items[0].modifiers.map((m: any) => [m.name, m.price])).toEqual([["thin base", 0], ["Pepperoni", 1.5]]);
    expect(st.cart.items[0].notes).toBeUndefined();
  });

  it("cooking notes stay notes; 'no onion' never adds onions; 'double pepperoni' is two", () => {
    const a = ai(); const st = fresh();
    const out = a.addItemConversational({ said: "12 inch margherita", modifierNames: ["deep pan"], notes: "well done, no onion, extra mushrooms and double pepperoni" }, c(), st);
    expect(st.cart.items[0].modifiers.map((m: any) => m.name)).toEqual(["deep pan", "Mushrooms", "Pepperoni", "Pepperoni"]);
    expect(st.cart.items[0].notes).toBe("well done, no onion");
    expect(out.result).toMatch(/Charged as toppings, not notes: Mushrooms \(\+1\.00\), 2× Pepperoni \(\+1\.50\)/);
    expect(out.result).toMatch(/— £12\.60\./); // 8.60 + 1.00 + 1.50 + 1.50
  });

  it("an extra that is not on the menu stays a note, and a required choice is never read out of a note", () => {
    const a = ai(); const st = fresh();
    const out = a.addItemConversational({ said: "12 inch margherita", notes: "extra anchovies, thin base" }, c(), st);
    expect(out.result).toMatch(/^NOT added yet\..*still needs a choice of: pizza crust/);
    expect(st.draft.picks).toEqual([]);
    const done = a.addItemConversational({ modifierNames: ["thin base"] }, c(), st);
    expect(done.result).toMatch(/^Added 1 × MARGHERITA \(12"\) with thin base \(note: extra anchovies, thin base\)/);
  });

  it("the prompt and the tool say extras are toppings, not notes", () => {
    const a = ai();
    expect(a.promptForConversation(c(), fresh(), null)).toMatch(/An EXTRA — "extra pepperoni", "add mushrooms", "double cheese" — is a paid topping: put it in modifierNames, never in notes/);
    const add = a.toolsForConversation(c()).find((t: any) => t.name === "add_item");
    expect(add.description).toMatch(/Extras like 'extra pepperoni' are paid toppings — modifierNames, not notes/);
  });
});

// ── call vMxlYKAQ: "add extra toppings on that pizza" lost the extra pepperoni ──
describe("toppings added to a pizza already on the order", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  // The live topping group: pick-many, no maximum written down.
  const MENU: any[] = [
    { id: "marg12", name: 'MARGHERITHA (12")', price: 8.6, categoryName: "Pizzas", modifierGroups: [
      { id: "cr", name: "select your pizza crust", required: true, min: 1, max: 1, selectionType: "VARIANT", options: [{ id: "cr1", name: "THIN BASE", price: 0 }, { id: "cr2", name: "DEEP PAN", price: 0 }] },
      { id: "tp", name: "select your extra toppings", required: false, min: 0, max: null, selectionType: "ADDON", options: [{ id: "tp1", name: "PEPPERONI", price: 1.5 }, { id: "tp2", name: "MUSHROOMS", price: 1 }, { id: "tp3", name: "ONIONS", price: 0.8 }, { id: "tp4", name: "EXTRA CHEESE", price: 1.2 }] },
    ] },
    { id: "chips", name: "CHIPS", price: 2.5, categoryName: "Sides", modifierGroups: [] },
  ];
  const c = () => { const x: any = { currency: "GBP", items: MENU, deliveryZones: [] }; x.itemIndex = new Map(MENU.map((i) => [i.id, i])); x.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])))); return x; };
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };
  const placed = () => {
    const a = ai(); const st: any = { cart: { items: [] }, turns: [] };
    a.addItemConversational({ said: "12 inch margheritha", modifierNames: ["thin base"] }, c(), st);
    return { a, st };
  };
  const names = (st: any) => st.cart.items[0].modifiers.map((m: any) => m.name);

  it("a pick-many group with no maximum keeps every topping named, in one call or several", async () => {
    const { a, st } = placed();
    let out = await a.runToolForConversation("change_item", { said: "the margheritha", modifierNames: ["extra pepperoni", "mushrooms"] }, c(), st, null);
    expect(names(st)).toEqual(["THIN BASE", "PEPPERONI", "MUSHROOMS"]);
    expect(out.result).toMatch(/^Changed MARGHERITHA \(12"\): choices THIN BASE, PEPPERONI, MUSHROOMS\./);
    out = await a.runToolForConversation("change_item", { said: "the pizza", modifierNames: ["onions"] }, c(), st, null);
    expect(names(st)).toEqual(["THIN BASE", "PEPPERONI", "MUSHROOMS", "ONIONS"]);
    expect(out.result).not.toMatch(/taken off/);
  });

  it("the crust still switches, and the toppings stay", async () => {
    const { a, st } = placed();
    await a.runToolForConversation("change_item", { said: "the margheritha", modifierNames: ["pepperoni"] }, c(), st, null);
    const out = await a.runToolForConversation("change_item", { said: "the margheritha", modifierNames: ["deep pan"] }, c(), st, null);
    expect(names(st)).toEqual(["PEPPERONI", "DEEP PAN"]);
    expect(out.result).toMatch(/THIN BASE taken off/);
  });

  it("a topping written into the note of an existing line is charged, and the cooking note stays", async () => {
    const { a, st } = placed();
    const out = await a.runToolForConversation("change_item", { said: "the pizza", notes: "extra pepperoni, well done" }, c(), st, null);
    expect(names(st)).toEqual(["THIN BASE", "PEPPERONI"]);
    expect(st.cart.items[0].notes).toBe("well done");
    expect(out.result).toMatch(/charged as toppings, not notes: PEPPERONI \(\+1\.50\) — say the price/);
    expect(out.result).toMatch(/note "well done"/);
  });

  it("'double pepperoni' is two, 'extra cheese' is the option of that name, and an unknown extra is said so", async () => {
    const { a, st } = placed();
    const out = await a.runToolForConversation("change_item", { said: "the pizza", modifierNames: ["double pepperoni", "extra cheese", "anchovies"] }, c(), st, null);
    expect(names(st)).toEqual(["THIN BASE", "PEPPERONI", "PEPPERONI", "EXTRA CHEESE"]);
    expect(out.result).toMatch(/^Could NOT put "anchovies" on the MARGHERITHA \(12"\) — nothing on this item's menu matches it \(choices THIN BASE, PEPPERONI, PEPPERONI, EXTRA CHEESE did go on\)/);
  });

  it("'the pizza' finds the one pizza on the order, and two pizzas are a question", async () => {
    const { a, st } = placed();
    a.addItemConversational({ said: "chips" }, c(), st);
    let out = await a.runToolForConversation("change_item", { said: "the pizza", modifierNames: ["onions"] }, c(), st, null);
    expect(names(st)).toEqual(["THIN BASE", "ONIONS"]);
    a.addItemConversational({ said: "12 inch margheritha", modifierNames: ["deep pan"] }, c(), st);
    out = await a.runToolForConversation("change_item", { said: "the pizza", modifierNames: ["mushrooms"] }, c(), st, null);
    expect(out.result).toMatch(/^Could be more than one line/);
  });

  it("add_item keeps every topping too when the group has no maximum", () => {
    const a = ai(); const st: any = { cart: { items: [] }, turns: [] };
    a.addItemConversational({ said: "12 inch margheritha", modifierNames: ["thin base", "extra pepperoni", "mushrooms", "onions"] }, c(), st);
    expect(names(st)).toEqual(["THIN BASE", "PEPPERONI", "MUSHROOMS", "ONIONS"]);
  });

  it("the tool and the amend prompt say toppings are added on the line, not replaced", () => {
    const a = ai();
    const t = a.toolsForConversation(c()).find((x: any) => x.name === "change_item");
    expect(t.description).toMatch(/A topping named here is ADDED to the ones already on it/);
    expect(a.promptForConversation(c(), { cart: { items: [] }, turns: [] }, null)).toMatch(/"extra pepperoni on the pizza" is change_item on that line with modifierNames, and it keeps the toppings already there/);
  });
});

// ── call DPD-n9tw: "we don't have pepperoni for a margheritha" — we do ──
//
// The caller had a MARGHERITHA on order and rang back for mushroom and
// pepperoni. He was told the pizza does not take pepperoni, argued ("I can see
// on your menu there is an extra pepperoni we can add… it's called a plus
// pepperoni"), and was told again to order a different pizza. The POS and the
// website both offer +pepperoni on it at £1.50.
//
// scoreItem caps at 1, so "+pepperoni" — the option he named exactly — scored
// no better than "+peppers", which the phonetic fold merely reached. Level, so
// the tie-break refused both, and a refusal reads as "we don't sell it".
describe("an option the caller names outright", () => {
  const { VoiceAiService } = require("../voice-ai.service");
  const { matchOption, matchOptionResult } = require("../voice-menu-match");
  // This shop's real topping list, from the screenshot.
  const TOPPINGS = ["+pepperoni", "+salami", "+onion", "+peppers", "+chilli", "+jalapeno", "+donner", "+bacon", "+ham", "+meatballs", "+mushroom"]
    .map((name, i) => ({ id: `t${i}`, name, price: 1.5 }));
  const GROUP = "select your extra toppings";
  const MENU: any[] = [
    { id: "marg", name: "MARGHERITHA", price: 7.5, categoryName: "PIZZA", modifierGroups: [
      { id: "crust", name: "select your pizza crust", required: true, min: 1, max: 1, selectionType: "VARIANT", options: [{ id: "c1", name: "THIN BASE", price: 0 }, { id: "c2", name: "DEEP PAN", price: 0 }] },
      { id: "tp", name: GROUP, required: false, min: 0, max: null, selectionType: "ADDON", options: TOPPINGS },
    ] },
  ];
  const c = () => { const x: any = { currency: "GBP", items: MENU, deliveryZones: [] }; x.itemIndex = new Map(MENU.map((i) => [i.id, i])); x.optionIndex = new Map(MENU.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }])))); return x; };
  const ai = () => { const a: any = Object.create(VoiceAiService.prototype); a.logger = { log() {}, warn() {}, error() {} }; return a; };
  const placed = () => { const a = ai(); const st: any = { cart: { items: [] }, turns: [] }; a.addItemConversational({ said: "margheritha", modifierNames: ["thin base"] }, c(), st); return { a, st }; };
  const names = (st: any) => st.cart.items[0].modifiers.map((m: any) => m.name);

  it("finds the pepperoni that was refused, however he asked for it", () => {
    for (const said of ["pepperoni", "extra pepperoni", "plus pepperoni", "pepperonis"]) {
      const hit = matchOption(said, TOPPINGS, GROUP);
      expect(hit).not.toBeNull();
      expect(hit.item.name).toBe("+pepperoni");
    }
  });

  it("and does not swallow the peppers next to it", () => {
    expect(matchOption("peppers", TOPPINGS, GROUP).item.name).toBe("+peppers");
    expect(matchOption("extra peppers", TOPPINGS, GROUP).item.name).toBe("+peppers");
    expect(matchOption("onions", TOPPINGS, GROUP).item.name).toBe("+onion");
    expect(matchOption("jalapeno", TOPPINGS, GROUP).item.name).toBe("+jalapeno");
  });

  it("still refuses to guess between two options that really are level", () => {
    const twins = [{ id: "a", name: "CHICKEN STRIPS", price: 1 }, { id: "b", name: "CHICKEN WINGS", price: 1 }];
    expect(matchOption("chicken", twins, "sides")).toBeNull();
    const r = matchOptionResult("chicken", twins, "sides");
    expect(r.kind).toBe("ambiguous");
    expect(r.items.map((o: any) => o.name).sort()).toEqual(["CHICKEN STRIPS", "CHICKEN WINGS"]);
  });

  it("something the item genuinely does not have is still nothing", () => {
    expect(matchOptionResult("anchovies", TOPPINGS, GROUP).kind).toBe("none");
  });

  it("the whole call, end to end: mushroom AND pepperoni, both charged", async () => {
    const { a, st } = placed();
    const out = await a.runToolForConversation("change_item", { said: "the margheritha", modifierNames: ["mushroom", "extra pepperoni"] }, c(), st, null);
    expect(names(st)).toEqual(["THIN BASE", "+mushroom", "+pepperoni"]);
    expect(out.result).toMatch(/^Changed MARGHERITHA: choices THIN BASE, \+mushroom, \+pepperoni\./);
    // 7.50 + 1.50 + 1.50
    expect(out.result).toMatch(/£10\.50/);
  });

  it("asking again does not add it twice or charge twice", async () => {
    const { a, st } = placed();
    await a.runToolForConversation("change_item", { said: "the margheritha", modifierNames: ["extra pepperoni"] }, c(), st, null);
    const again = await a.runToolForConversation("change_item", { said: "the margheritha", modifierNames: ["pepperoni"] }, c(), st, null);
    expect(names(st)).toEqual(["THIN BASE", "+pepperoni"]);
    expect(again.result).toMatch(/\+pepperoni already on it — not added twice/);
    expect(again.result).toMatch(/£9\.00/);
    // A count, though, is a count: "double pepperoni" on one is two, not three.
    await a.runToolForConversation("change_item", { said: "the margheritha", modifierNames: ["double pepperoni"] }, c(), st, null);
    expect(names(st)).toEqual(["THIN BASE", "+pepperoni", "+pepperoni"]);
  });

  it("a note naming the same topping twice is charged once", () => {
    const a = ai(); const st: any = { cart: { items: [] }, turns: [] };
    const out = a.addItemConversational({ said: "margheritha", modifierNames: ["thin base", "extra pepperoni"], notes: "extra pepperoni, well done" }, c(), st);
    expect(names(st)).toEqual(["THIN BASE", "+pepperoni"]);
    expect(st.cart.items[0].notes).toBe("well done");
    expect(out.result).toMatch(/£9\.00/);
  });

  it("a real tie asks which, and never says unavailable", async () => {
    const twinMenu: any[] = [{ id: "sides", name: "SIDES BOX", price: 5, categoryName: "SIDES", modifierGroups: [
      { id: "g", name: "pick your bits", required: false, min: 0, max: 3, selectionType: "ADDON", options: [{ id: "a", name: "CHICKEN STRIPS", price: 1 }, { id: "b", name: "CHICKEN WINGS", price: 1 }] },
    ] }];
    const cx: any = { currency: "GBP", items: twinMenu, deliveryZones: [] };
    cx.itemIndex = new Map(twinMenu.map((i) => [i.id, i]));
    cx.optionIndex = new Map(twinMenu.flatMap((i: any) => i.modifierGroups.flatMap((g: any) => g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }]))));
    const a = ai(); const st: any = { cart: { items: [] }, turns: [] };
    a.addItemConversational({ said: "sides box" }, cx, st);
    const out = await a.runToolForConversation("change_item", { said: "the sides box", modifierNames: ["chicken"] }, cx, st, null);
    expect(out.result).toMatch(/"chicken" could be CHICKEN STRIPS or CHICKEN WINGS/);
    expect(out.result).toMatch(/Do NOT tell them it is unavailable/);
    expect(st.cart.items[0].modifiers).toEqual([]);
  });

  it("when a choice will not place, the model is handed the real list instead of guessing", async () => {
    const { a, st } = placed();
    const out = await a.runToolForConversation("change_item", { said: "the margheritha", modifierNames: ["anchovies"] }, c(), st, null);
    expect(out.result).toMatch(/Could NOT put "anchovies" on the MARGHERITHA/);
    expect(out.result).toMatch(/select your extra toppings \(optional\): \+pepperoni \+1\.50/);
  });

  it("find_item hands back everything that can go on the dish", () => {
    const a = ai();
    const said = a.findItem("margheritha", c());
    expect(said).toMatch(/That's MARGHERITHA \[marg\]/);
    expect(said).toMatch(/select your pizza crust \(pick 1, REQUIRED\): THIN BASE, DEEP PAN/);
    expect(said).toMatch(/\+pepperoni \+1\.50/);
  });

  it("the prompt forbids refusing a topping from memory", () => {
    const a = ai();
    expect(a.promptForConversation(c(), { cart: { items: [] }, turns: [] }, null)).toMatch(
      /NEVER tell a caller a topping or option is unavailable from memory/,
    );
  });
});
