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
    await settle(400);

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

  it('a failed reply the server made for a caller turn is not ours to replay', async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.sent.length = 0;
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    sim.brain.deliver({ type: 'response.created', response: { id: 'c1' } }); // no metadata: the server's own
    sim.brain.deliver(RL('c1'));
    await settle(600);
    expect(creates(sim)).toHaveLength(0);
    expect(sim.log.join(' ')).not.toMatch(/retry 1\/2/);
  });

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
