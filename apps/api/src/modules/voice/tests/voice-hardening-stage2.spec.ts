// Stage 2 — one owner per turn, and timing that measures what a caller feels.

import { VoiceRealtimeSim } from './voice-realtime-sim';

// A second of μ-law: long enough that playback is always still in progress
// when an interruption arrives. Three bytes played out in under a millisecond,
// so on a slow run there was nothing left to truncate and the test flaked.
const ONE_SECOND = Buffer.alloc(8000).toString('base64');
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const lastTurnDetection = (sim: VoiceRealtimeSim) =>
  [...sim.toModel]
    .reverse()
    .find((m) => m.type === 'session.update' && m.session?.audio?.input?.turn_detection)?.session
    .audio.input.turn_detection;

describe('7. one owner per turn', () => {
  it('stops the server replying while a code-owned question is open, and resumes when it closes', async () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeDigit = async (_c: string, d: string) =>
      d === '1'
        ? { say: 'For your size, press 1 for 10, 2 for 12.', owned: true }
        : { say: 'Twelve inch. Anything else?', owned: false };
    await sim.answer();
    sim.brain.sent.length = 0;

    await sim.press('1');
    expect(lastTurnDetection(sim)?.create_response).toBe(false);

    await sim.press('2');
    expect(lastTurnDetection(sim)?.create_response).toBe(true);
  });

  it('hands the turn to the model explicitly when the caller changes the subject', async () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeDigit = async () => ({ say: 'Press 1 or 2.', owned: true });
    sim.gateway.voice.realtimeSaid = async () => null; // not an answer to the question
    await sim.answer();
    await sim.press('1');
    sim.brain.sent.length = 0;

    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    sim.brain.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u1',
      transcript: 'actually can I get a coke',
    });
    await settle(30);

    // Code released the turn AND asked the model to reply — the server would
    // not have, because create_response was off.
    expect(lastTurnDetection(sim)?.create_response).toBe(true);
    expect(sim.toModel.some((m) => m.type === 'response.create')).toBe(true);
  });

  it('does not send a session.update when ownership has not changed', async () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeDigit = async () => ({ say: 'Next?', owned: false });
    await sim.answer();
    sim.brain.sent.length = 0;
    await sim.press('5');
    expect(sim.toModel.filter((m) => m.type === 'session.update')).toHaveLength(0);
  });
});

describe('9. latency instrumentation', () => {
  it('times each exchange from when the caller stopped talking', async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.deliver({ type: 'input_audio_buffer.speech_stopped' });
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    await settle(20);
    sim.brain.deliver({ type: 'response.created', response: { id: 'r1' } });
    sim.brain.deliver({
      type: 'response.output_audio.delta',
      response_id: 'r1',
      item_id: 'a1',
      delta: Buffer.alloc(8000).toString('base64'),
    });
    sim.brain.deliver({ type: 'response.done', response: { id: 'r1' } });
    await settle();

    const line = sim.log.find((l) => l.includes('turn timing'));
    expect(line).toBeDefined();
    expect(line).toMatch(/stop→first-audio \d+ms/);
    expect(line).toMatch(/stop→forwarded \d+ms/);
    expect(line).toMatch(/stop→generated \d+ms/);
    // A second of audio queued: the line is quiet ~1000ms after generation.
    expect(line).toMatch(/stop→line-quiet\(est\) \d+ms/);
  });

  it('rolls up p50 and p95 at hangup', async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    for (let i = 0; i < 3; i++) {
      sim.brain.deliver({ type: 'input_audio_buffer.speech_stopped' });
      sim.brain.deliver({ type: 'response.created', response: { id: `r${i}` } });
      sim.brain.deliver({
        type: 'response.output_audio.delta',
        response_id: `r${i}`,
        item_id: `a${i}`,
        delta: 'AAAA',
      });
      sim.brain.deliver({ type: 'response.done', response: { id: `r${i}` } });
      await settle();
    }
    sim.caller.close();
    await settle();

    const summary = sim.log.find((l) => l.includes('latency summary'));
    expect(summary).toMatch(/stop→first-audio p50 \d+ms p95 \d+ms \(n=3\)/);
  });
});

describe('leftovers from the first live calls on this branch', () => {
  it('does not send response.cancel on speech_started — the server already did', async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.deliver({ type: 'response.created', response: { id: 'r1' } });
    sim.brain.deliver({
      type: 'response.output_audio.delta',
      response_id: 'r1',
      item_id: 'a1',
      delta: ONE_SECOND,
    });
    sim.brain.sent.length = 0;
    sim.brain.deliver({ type: 'input_audio_buffer.speech_started' });
    await settle();
    expect(sim.toModel.some((m) => m.type === 'response.cancel')).toBe(false);
    expect(sim.toModel.some((m) => m.type === 'conversation.item.truncate')).toBe(true);
    // but a keypress still cancels
    await sim.press('1');
    sim.brain.deliver({ type: 'response.created', response: { id: 'r2' } });
    sim.brain.deliver({
      type: 'response.output_audio.delta',
      response_id: 'r2',
      item_id: 'a2',
      delta: ONE_SECOND,
    });
    sim.brain.sent.length = 0;
    await sim.press('2');
    expect(sim.toModel.some((m) => m.type === 'response.cancel')).toBe(true);
  });

  it('treats a reply with nothing in it as a stall, on the short clock', async () => {
    const sim = new VoiceRealtimeSim({ quietMs: 40, idleMs: 5000 });
    await sim.answer();
    sim.brain.sent.length = 0;
    sim.brain.deliver({ type: 'response.created', response: { id: 'r1' } });
    sim.brain.deliver({ type: 'response.done', response: { id: 'r1' } }); // no audio, no tool
    await settle(200);
    expect(sim.log.join(' ')).toMatch(/empty reply .* treating as a stall/);
    expect(sim.log.join(' ')).toMatch(/nothing came back/); // the MODEL is who the line waits on here
  });
});

describe('what goes on the ticket', () => {
  const { VoiceAiService } = require('../voice-ai.service');
  const ai = () => {
    const a: any = Object.create(VoiceAiService.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    return a;
  };
  it("never writes the payment answer down as the customer's name", () => {
    const a = ai();
    for (const bad of ['cash', 'Card', 'yes', 'No.', '', '   ']) {
      expect(a.customerNameFrom(bad, { knownName: undefined })).toBe('Phone order');
    }
    expect(a.customerNameFrom('cash', { knownName: 'Omid' })).toBe('Omid');
    expect(a.customerNameFrom('Sarah', {})).toBe('Sarah');
  });
  it('tells the line to speak English whatever it hears', () => {
    const a = ai();
    const ctx: any = {
      currency: 'GBP',
      items: [],
      itemIndex: new Map(),
      optionIndex: new Map(),
      locationName: 'T',
      spokenLanguage: 'English',
      deliveryZones: [],
    };
    const p = a.promptForRealtime(ctx, { cart: { items: [] }, turns: [] });
    expect(p).toMatch(/LANGUAGE/);
    expect(p).toMatch(/Speak English, and only English/);
    expect(p).toMatch(/Never switch/);
  });
});

describe('asking the way a person asks', () => {
  const { VoiceAiService } = require('../voice-ai.service');
  const ai = () => {
    const a: any = Object.create(VoiceAiService.prototype);
    a.logger = { log() {}, warn() {}, error() {} };
    return a;
  };
  const G = (id: string, name: string, opts: string[]) => ({
    id,
    name,
    required: true,
    min: 1,
    options: opts.map((o, i) => ({ id: `${id}${i + 1}`, name: o, price: 0 })),
  });
  const DEAL = {
    id: 'deal2',
    name: 'Meal Deal 2',
    price: 25,
    modifierGroups: [
      G('pz', 'Select Your Pizza', ['Margherita', 'Pepperoni']),
      G('kb', 'Kebab', ['Doner', 'Chicken']),
      G('sd', 'Side', ['Chips', 'Salad']),
      G('dr', 'Drink', ['Coke', 'Fanta', 'Water']),
    ],
  };
  const PIZZA = {
    id: 'pep',
    name: 'Pepperoni Pizza',
    price: 9,
    modifierGroups: [
      G('sz', 'Select Pizza Size', ['10"', '12"']),
      G('cr', 'Select Your Pizza Crust', ['Thin', 'Deep Pan', 'Stuffed']),
    ],
  };
  const MENU: any[] = [DEAL, PIZZA];
  const ctx = () => {
    const c: any = { currency: 'GBP', items: MENU };
    c.itemIndex = new Map(MENU.map((i: any) => [i.id, i]));
    c.optionIndex = new Map(
      MENU.flatMap((i: any) =>
        i.modifierGroups.flatMap((g: any) =>
          g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }]),
        ),
      ),
    );
    return c;
  };
  const fresh = () => ({ cart: { items: [] }, turns: [] }) as any;

  it('a deal is described first, then all the choices are taken in one breath', () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    const open = a.addItem({ itemId: 'deal2' }, c, st);
    expect(open.sayNow).toBe(
      "Meal Deal 2 comes with pizza, kebab, side and drink. Tell me your choices and I'll add them for you.",
    );
    expect(st.choices).toBeUndefined();

    const said = a.answerItemOption(c, st, 'margherita, doner kebab, chips and a fanta');
    expect(st.pendingItem.chosen).toEqual(expect.arrayContaining(['pz1', 'kb1', 'sd1', 'dr2']));
    // Everything answered: straight to the note question, not a fifth question.
    expect(said).toMatch(/Any notes/);
  });

  it('asks only for what a partial answer left out', () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    a.addItem({ itemId: 'deal2' }, c, st);
    const said = a.answerItemOption(c, st, 'pepperoni and a coke please');
    expect(st.pendingItem.chosen).toEqual(expect.arrayContaining(['pz2', 'dr1']));
    expect(said).toMatch(/And for the kebab — Doner or Chicken\?/);
    // and the keypad still maps to the question just asked
    expect(st.choices).toEqual(['kb1', 'kb2']);
  });

  it('a pizza with a size and a crust is two plain questions, not a form', () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    const open = a.addItem({ itemId: 'pep' }, c, st);
    expect(open.sayNow).toBe(
      'Pepperoni Pizza comes with a choice of pizza size — 10 inch or 12 inch. Which would you like?',
    );
    expect(st.pendingItem.overview).toBeFalsy();
    expect(a.chooseByNumber(c, st, '2')).toBe(
      '12 inch. And for the pizza crust — Thin, Deep Pan or Stuffed?',
    );
  });

  it('"12 pepperoni" only gets asked about the crust', () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    const open = a.addItem({ itemId: 'pep', modifierOptionIds: ['sz2'] }, c, st);
    expect(open.sayNow).toBe(
      'Pepperoni Pizza comes with a choice of pizza crust — Thin, Deep Pan or Stuffed. Which would you like?',
    );
  });

  it('offers the numbers only once speech has failed twice', () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    a.addItem({ itemId: 'pep' }, c, st);
    expect(a.answerItemOption(c, st, 'Svensk')).toBeNull();
    expect(a.askNextOption(c, st).say).not.toMatch(/press 1/);
    expect(a.answerItemOption(c, st, 'Телигов')).toBeNull();
    expect(a.askNextOption(c, st).say).toMatch(/Or press 1 for 10 inch, 2 for 12 inch\./);
  });
});

describe('the voice', () => {
  it('defaults to marin', async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    expect(sim.session.audio.output.voice).toBe('marin');
  });
});
