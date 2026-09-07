// The conversation engine: the same brain, without the phone tree.
//
// No keypad menu, no slot machine, no numbered walkthrough, no decision made
// by reading the sidecar transcript. The model gets the menu and the tools
// and holds the conversation; the rules that survive are the ones that never
// depended on hearing — a price is read from the basket, an order is placed
// only for the basket that was read back.

import { VoiceAiService } from '../voice-ai.service';
import { VoiceService } from '../voice.service';
import { VoiceRealtimeSim } from './voice-realtime-sim';

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const G = (id: string, name: string, opts: string[], extra: any = {}) => ({
  id,
  name,
  required: true,
  min: 1,
  options: opts.map((o, i) => ({ id: `${id}${i + 1}`, name: o, price: 0 })),
  ...extra,
});
const MENU: any[] = [
  {
    id: 'pep10',
    name: 'Pepperoni (10")',
    price: 8,
    categoryName: 'Pizzas',
    modifierGroups: [
      G('cr', 'Select Your Pizza Crust', ['Thin', 'Deep Pan', 'Stuffed']),
      { ...G('tp', 'Extra Toppings', ['Pepperoni', 'Mushroom']), required: false, min: 0 },
    ],
  },
  {
    id: 'pep12',
    name: 'Pepperoni (12")',
    price: 10,
    categoryName: 'Pizzas',
    modifierGroups: [
      G('cr', 'Select Your Pizza Crust', ['Thin', 'Deep Pan', 'Stuffed']),
      { ...G('tp', 'Extra Toppings', ['Pepperoni', 'Mushroom']), required: false, min: 0 },
    ],
  },
  { id: 'chips', name: 'Chips', price: 2.9, categoryName: 'Sides', modifierGroups: [] },
  { id: 'gs', name: 'Garlic Sauce', price: 1.3, categoryName: 'Sides', modifierGroups: [] },
  {
    id: 'deal2',
    name: 'Meal Deal 2',
    price: 25,
    categoryName: 'Deals',
    modifierGroups: [
      G('dp', 'Pizza', ['Margherita', 'Pepperoni']),
      G('dk', 'Kebab', ['Doner', 'Chicken']),
      G('dd', 'Drink', ['Coke', 'Fanta']),
    ],
  },
];
const ai = (anthropic: any = null) => {
  const a: any = Object.create(VoiceAiService.prototype);
  a.logger = { log() {}, warn() {}, error() {} };
  a.anthropic = anthropic;
  a.model = 'claude-test';
  return a;
};
const ctx = () => {
  const c: any = {
    currency: 'GBP',
    items: MENU,
    locationName: 'Chicago Pizzeria',
    spokenLanguage: 'English',
    deliveryZones: [{ id: 'z', postcodePrefix: 'NE10', fee: 1 }],
  };
  c.itemIndex = new Map(MENU.map((i: any) => [i.id, i]));
  c.optionIndex = new Map(
    MENU.flatMap((i: any) =>
      (i.modifierGroups ?? []).flatMap((g: any) =>
        g.options.map((o: any) => [o.id, { groupId: g.id, itemId: i.id, option: o }]),
      ),
    ),
  );
  return c;
};
const fresh = () => ({ cart: { items: [] }, turns: [] }) as any;

describe('what the caller hears first', () => {
  it('is a person, not a menu', () => {
    const g = ai().conversationGreeting(ctx(), null);
    expect(g).toBe('Hi, thanks for calling Chicago Pizzeria. What can I get for you?');
    expect(g).not.toMatch(/press/i);
    expect(ai().conversationGreeting(ctx(), 'Omid')).toMatch(/^Hi Omid, welcome back/);
  });
});

describe('the prompt', () => {
  it('carries the menu, compactly, with sizes folded and choices starred', () => {
    const menu = ai().compactMenu(ctx());
    expect(menu).toContain('## Pizzas');
    expect(menu).toContain('- Pepperoni — 10 inch £8.00, 12 inch £10.00 *');
    expect(menu).toContain('- Chips — £2.90');
    expect(menu).not.toContain('Chips — £2.90 *');
    expect(menu).toContain('- Meal Deal 2 — £25.00 *');
  });

  it('never mentions numbers to press, and pins the language', () => {
    const p = ai().promptForConversation(ctx(), fresh(), null);
    expect(p).not.toMatch(/press 1/i);
    expect(p).toMatch(/Never tell anyone to press a number/);
    expect(p).toMatch(/Speak English, and only English/);
    expect(p).toMatch(/MENU\n## Pizzas/);
    expect(p.length).toBeLessThan(14_000 * 4);
  });

  it('offers the usual once, when there is one', () => {
    const p = ai().promptForConversation(ctx(), fresh(), 'chips and garlic sauce, delivered');
    expect(p).toMatch(/Their usual: "chips and garlic sauce, delivered"/);
    expect(ai().promptForConversation(ctx(), fresh(), null)).not.toMatch(/ORDERED HERE BEFORE/);
  });
});

describe('the tools', () => {
  it('adds parse_order and lets add_item take choices by name', () => {
    const tools = ai().toolsForConversation(ctx());
    const names = tools.map((t: any) => t.name);
    expect(names).toContain('parse_order');
    expect(names).toContain('read_back_order');
    const add = tools.find((t: any) => t.name === 'add_item') as any;
    expect(add.parameters.properties.modifierNames).toBeDefined();
    expect(add.description).toMatch(/does NOT add it/);
  });
});

describe('add_item without a walkthrough', () => {
  it('says what is missing instead of adding, then adds when told', () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    const first = a.addItemConversational({ said: '12 inch pepperoni' }, c, st);
    expect(first.result).toMatch(
      /^NOT added yet\. The Pepperoni still needs a choice of: pizza crust \(Thin, Deep Pan, Stuffed\)/,
    );
    expect(st.cart.items).toHaveLength(0);

    const second = a.addItemConversational(
      { said: '12 inch pepperoni', modifierNames: ['deep pan'] },
      c,
      st,
    );
    expect(second.result).toMatch(/^Added 1 × Pepperoni \(12"\) with Deep Pan/);
    expect(st.cart.items[0]).toMatchObject({ itemId: 'pep12', quantity: 1 });
    expect(st.cart.items[0].modifiers.map((m: any) => m.name)).toEqual(['Deep Pan']);
  });

  it("takes a required choice out of the caller's own words", () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    const out = a.addItemConversational(
      { said: 'two 12 inch pepperoni deep pan, no onions', notes: 'no onions' },
      c,
      st,
    );
    expect(out.result).toMatch(/^Added 2 × Pepperoni \(12"\) with Deep Pan \(note: no onions\)/);
  });

  it("never reads an optional paid topping out of the dish's own name", () => {
    // "pepperoni" is the pizza, not the £-extra pepperoni topping.
    const a = ai();
    const c = ctx();
    const st = fresh();
    a.addItemConversational({ said: '10 inch pepperoni', modifierNames: ['thin'] }, c, st);
    expect(st.cart.items[0].modifiers.map((m: any) => m.name)).toEqual(['Thin']);
  });

  it('asks for everything a deal still needs, in one message', () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    const out = a.addItemConversational(
      { said: 'meal deal 2', modifierNames: ['pepperoni'] },
      c,
      st,
    );
    expect(out.result).toMatch(/kebab \(Doner, Chicken\); drink \(Coke, Fanta\)/);
    expect(out.result).not.toMatch(/pizza \(/);
    expect(st.cart.items).toHaveLength(0);
  });

  it('invalidates an earlier confirmation', async () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    a.addItemConversational({ said: 'chips' }, c, st);
    await a.runTool('read_back_order', {}, c, st, null);
    await a.runToolForConversation('order_confirmed', { __spokeAfterQuestion: true }, c, st, null);
    expect(a.orderStillConfirmed(st)).toBe(true);
    a.addItemConversational({ said: 'garlic sauce' }, c, st);
    expect(a.orderStillConfirmed(st)).toBe(false);
  });
});

describe('consent on this engine', () => {
  it("takes the model's word for the yes — and still refuses an unread order", async () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    a.addItemConversational({ said: 'chips' }, c, st);
    // No transcript anywhere in this input. The model says they agreed.
    const early = await a.runToolForConversation('order_confirmed', { __spokeAfterQuestion: true }, c, st, null);
    expect(early.result).toMatch(/has not been read back/);
    await a.runTool('read_back_order', {}, c, st, null);
    const ok = await a.runToolForConversation('order_confirmed', { __spokeAfterQuestion: true }, c, st, null);
    expect(ok.result).toMatch(/Confirmed/);
  });

  it("confirms an address on the model's word", async () => {
    const a = ai();
    const c = ctx();
    const st = fresh();
    st.cart.deliveryAddress = { line1: '1 Test Street', city: 'Gateshead', postcode: 'NE10 8YH' };
    const out = await a.runToolForConversation('confirm_delivery_address', { __spokeAfterQuestion: true }, c, st, null);
    expect(out.result).toMatch(/Address confirmed/);
    expect(a.addressStillConfirmed(st)).toBe(true);
  });
});

describe('parse_order — Claude behind the counter', () => {
  const claude = (reply: string) => ({
    messages: { create: async () => ({ content: [{ type: 'text', text: reply }] }) },
  });

  it('adds what Claude resolved and returns what still needs asking', async () => {
    const a = ai(
      claude(
        JSON.stringify([
          { itemId: 'pep12', quantity: 1, modifierNames: ['deep pan'] },
          { itemId: 'chips', quantity: 2 },
          { itemId: 'pep10', quantity: 1 }, // crust not said
        ]),
      ),
    );
    const c = ctx();
    const st = fresh();
    const out = await a.runToolForConversation(
      'parse_order',
      { said: 'a 12 inch pepperoni deep pan, two chips and a ten inch pepperoni' },
      c,
      st,
    );
    expect(st.cart.items.map((i: any) => `${i.quantity}x${i.itemId}`)).toEqual([
      '1xpep12',
      '2xchips',
    ]);
    expect(out.result).toMatch(
      /Still to ask: NOT added yet\. The Pepperoni still needs a choice of: pizza crust/,
    );
    expect(out.result).toMatch(/Order so far:/);
  });

  it('falls back to the matcher without a Claude key', async () => {
    const a = ai(null);
    const c = ctx();
    const st = fresh();
    const out = await a.runToolForConversation(
      'parse_order',
      { said: 'chips and garlic sauce' },
      c,
      st,
    );
    expect(st.cart.items.map((i: any) => i.itemId).sort()).toEqual(['chips', 'gs']);
    expect(out.result).toMatch(/Added 1 × Chips/);
  });

  it('survives Claude answering with prose around the JSON, or nonsense', async () => {
    const a = ai(claude('Sure! Here you go: [{"itemId":"chips","quantity":1}] hope that helps'));
    const c = ctx();
    const st = fresh();
    await a.runToolForConversation('parse_order', { said: 'chips' }, c, st);
    expect(st.cart.items).toHaveLength(1);
    const b = ai(claude('I cannot help with that.'));
    const st2 = fresh();
    const out = await b.runToolForConversation('parse_order', { said: 'chips' }, c, st2);
    expect(st2.cart.items).toHaveLength(1); // matcher fallback
    expect(out.result).toMatch(/Added 1 × Chips/);
  });
});

describe('the session and the gateway in conversation mode', () => {
  it('opens the conversation engine when the shop is set to it', async () => {
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    s.ai = ai();
    const c = ctx();
    c.voiceEngine = 'CONVERSATION';
    s.loadByControlId = async () => ({
      call: { id: 'c1', fromNumber: '+44' },
      ctx: c,
      state: fresh(),
    });
    s.lastOrderFor = async () => null;
    const session = await s.realtimeSession('cc1');
    expect(session.mode).toBe('CONVERSATION');
    expect(session.greeting).toMatch(/^Hi, thanks for calling/);
    expect(session.instructions).toMatch(/MENU/);
    expect(session.tools.map((t: any) => t.name)).toContain('parse_order');
  });

  const conversationSim = () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeSession = async () => ({
      instructions: 'x',
      greeting: 'Hi',
      tools: [],
      mode: 'CONVERSATION',
    });
    sim.gateway.voice.realtimeDigit = jest.fn(async () => ({ say: 'never' }));
    sim.gateway.voice.realtimeSaid = jest.fn(async () => ({ say: 'never' }));
    sim.gateway.voice.realtimeTool = jest.fn(async () => ({ result: 'wrong engine' }));
    sim.gateway.voice.conversationTool = jest.fn(async () => ({ result: 'ok' }));
    return sim;
  };

  it('a keypress is told to the model, not routed as a menu choice', async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.sent.length = 0;
    await sim.press('2');
    const told = sim.toModel.find((m) => m.type === 'conversation.item.create');
    expect(told.item.content[0].text).toMatch(/pressed 2/);
    expect(told.item.content[0].text).not.toMatch(/update on an order/);
    expect(sim.toModel.some((m) => m.type === 'response.create')).toBe(true);
    expect(sim.gateway.voice.realtimeDigit).not.toHaveBeenCalled();
  });

  it('speech goes to the model, never to a walkthrough', async () => {
    const sim = conversationSim();
    await sim.answer();
    sim.brain.deliver({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    sim.brain.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u1',
      transcript: 'twelve inch',
    });
    await settle(30);
    expect(sim.gateway.voice.realtimeSaid).not.toHaveBeenCalled();
  });

  it('tools run through the conversation executor', async () => {
    const sim = conversationSim();
    await sim.answer();
    await sim.callTool('add_item', { said: 'chips' });
    expect(sim.gateway.voice.conversationTool).toHaveBeenCalledWith(
      'cc-test',
      'add_item',
      expect.objectContaining({ said: 'chips', __conversation: true }),
    );
    expect(sim.gateway.voice.realtimeTool).not.toHaveBeenCalled();
  });
});

describe('the facts of the shop, in the prompt', () => {
  it("knows a returning caller's address and asks 'still at…?'", () => {
    const st: any = {
      cart: { items: [] },
      turns: [],
      knownName: 'Omid',
      savedAddress: { line1: '11 Test Drive', city: 'Gateshead', postcode: 'NE10 8YH' },
    };
    const p = ai().promptForConversation(ctx(), st, null);
    expect(p).toMatch(/You know this caller — Omid/);
    expect(p).toMatch(/ask "still at 11 Test Drive\?"/);
  });

  it('describes area delivery when the shop uses areas, postcodes otherwise', () => {
    const areas = ctx();
    areas.deliveryZones = [{ id: 'a', areaName: 'Washington', fee: 2 }];
    expect(ai().promptForConversation(areas, fresh(), null)).toMatch(
      /Delivery is by AREA here: Washington/,
    );
    const pc = ctx();
    pc.country = 'GB';
    expect(ai().promptForConversation(pc, fresh(), null)).toMatch(/get the postcode first/);
  });

  it('says the shop is closed when it is', () => {
    const c = ctx();
    c.timezone = 'Europe/London';
    c.openingHours = {
      monday: [],
      tuesday: [],
      wednesday: [],
      thursday: [],
      friday: [],
      saturday: [],
      sunday: [],
    };
    expect(ai().promptForConversation(c, fresh(), null)).toMatch(/THE SHOP IS CLOSED RIGHT NOW/);
    expect(ai().promptForConversation(ctx(), fresh(), null)).not.toMatch(/CLOSED RIGHT NOW/);
  });
});

describe('after the first live call on this engine', () => {
  it('tells the model to name two or three, never the list', () => {
    const p = ai().promptForConversation(ctx(), fresh(), null);
    expect(p).toMatch(/name two or three — short names/);
    expect(p).toMatch(/Never read the whole list/);
  });

  it('logs when the caller starts and stops speaking', async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer();
    sim.brain.deliver({ type: 'input_audio_buffer.speech_started' });
    sim.brain.deliver({ type: 'input_audio_buffer.speech_stopped' });
    await settle();
    expect(sim.log.join(' ')).toMatch(/caller started speaking/);
    expect(sim.log.join(' ')).toMatch(/caller stopped speaking/);
  });

  it('checks in sooner than the phone-system engine after a question goes unanswered', async () => {
    // idleMs is what the other engine waits; conversation mode caps it.
    const sim = new VoiceRealtimeSim({ idleMs: 5000 });
    sim.gateway.voice.realtimeSession = async () => ({
      instructions: 'x',
      greeting: 'Hi',
      tools: [],
      mode: 'CONVERSATION',
    });
    sim.gateway.config = {
      get: (k: string) =>
        k === 'VOICE_CONVERSATION_IDLE_MS'
          ? '60'
          : k === 'VOICE_REALTIME_IDLE_MS'
            ? '5000'
            : undefined,
    };
    await sim.answer();
    sim.brain.sent.length = 0;
    sim.brain.deliver({ type: 'response.created', response: { id: 'r1' } });
    sim.brain.deliver({
      type: 'response.output_audio.delta',
      response_id: 'r1',
      item_id: 'a1',
      delta: 'AAAA',
    });
    sim.brain.deliver({ type: 'response.done', response: { id: 'r1' } });
    await settle(250);
    expect(sim.log.join(' ')).toMatch(/caller quiet — checking in/); // the caller is who the line waits on
  });
});
