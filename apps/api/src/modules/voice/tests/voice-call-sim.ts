import { VoiceAiService, emptyState } from "../voice-ai.service";
import { VoiceService } from "../voice.service";

// A whole call, driven offline, through the real code.
//
// Every bug in this module so far was found by someone dialling the number and
// reading a log afterwards. That is a slow way to learn that a question was
// asked in the wrong order, and it means the person testing is the person who
// least wants to be doing it.
//
// This runs the actual VoiceService and VoiceAiService against a scripted
// caller, with the database, the address lookup and the model replaced. What
// it CANNOT prove is anything the model decides — so the flows worth pinning
// here are exactly the ones that were made deterministic: the menu, the
// address, the confirmations. If a step in one of these tests reaches the
// model, that is itself the finding.

export interface SimTurn {
  /** What the caller said (or the digit they pressed). */
  said?: string;
  digit?: string;
  /** What the line said back. */
  heard: string;
}

export interface SimOptions {
  /** Postcode → addresses, standing in for the address service. */
  postcodes?: Record<string, Array<{ line1: string; city?: string }>>;
  /** What the geocoder returns for a whole spoken address. Keyed loosely —
   *  the first key the query contains wins. */
  geocoded?: Record<string, Array<{ line1: string; city?: string; postcode: string }>>;
  /** Addresses this shop has already delivered to, as its own order history
   *  holds them. Consulted before any network lookup. */
  pastDeliveries?: Array<{ addressLine1: string; city?: string }>;
  /** Rows the order lookups should find. */
  orders?: any[];
  /** Delivery zones for the shop. */
  zones?: Array<Record<string, unknown>>;
  /** A saved address for this caller, as caller ID would supply. */
  savedAddress?: { line1: string; city: string; postcode: string };
  /** Replies from the model, in order, for turns that reach it. */
  modelReplies?: string[];
}

/** A call in progress, driven one turn at a time. */
export class VoiceCallSim {
  readonly transcript: Array<{ who: "caller" | "line"; text: string }> = [];
  /** Turns that had to ask the model. Every one is latency the caller feels. */
  modelTurns = 0;

  private readonly svc: any;
  private readonly store: { row: any };

  constructor(private readonly opts: SimOptions = {}) {
    const ai: any = Object.create(VoiceAiService.prototype);
    ai.logger = { log() {}, warn() {}, error() {} };
    ai.config = { get: () => undefined };
    ai.orders = { create: async () => ({ id: "o1", orderNumber: 1, total: 0 }), editOrder: async () => ({}) };
    ai.sms = { send: async () => ({ ok: true }) };
    ai.payments = { createCheckoutSession: async () => ({ url: "https://pay" }) };
    // Anything reaching the model is recorded and answered blandly — the point
    // is to notice that it happened, not to simulate Claude.
    ai.anthropic = null;
    ai.respond = async ({ state, userText }: any) => {
      this.modelTurns++;
      const reply =
        this.opts.modelReplies?.[this.modelTurns - 1] ?? "[model would answer here]";
      state.turns.push({ role: "user", text: userText });
      state.turns.push({ role: "assistant", text: reply });
      return { turn: { say: reply }, state };
    };

    const state = emptyState();
    state.callId = "call-1";
    state.savedAddress = opts.savedAddress;
    this.store = {
      row: {
        id: "call-1",
        status: "ANSWERED",
        toNumber: "+441912345678",
        fromNumber: "+447700900123",
        transcript: state,
      },
    };

    const ctx = {
      tenantId: "t1",
      locationId: "l1",
      locationName: "Pizza Uno",
      country: "GB",
      currency: "GBP",
      transferNumber: "+441912312345",
      deliveryPrepMinutes: 45,
      collectionPrepMinutes: 20,
      address: { city: "Gateshead" },
      deliveryZones: (opts.zones ?? [
        { id: "z1", postcodePrefix: "NE37", areaName: null, maxDistanceMiles: null, fee: 2.5, minOrderValue: null },
      ]) as any,
      items: [],
      itemIndex: new Map(),
      optionIndex: new Map(),
    };

    const svc: any = Object.create(VoiceService.prototype);
    svc.logger = { log() {}, warn() {}, error() {} };
    svc.ai = ai;
    svc.contexts = { resolve: async () => ctx };
    svc.addresses = {
      resolveAddress: async (query: string) => {
        const key = Object.keys(opts.geocoded ?? {}).find((k) =>
          query.toLowerCase().includes(k.toLowerCase()),
        );
        return key ? opts.geocoded![key]! : [];
      },
      searchByPostcode: async (postcode: string) => ({
        provider: "sim",
        suggestions: (opts.postcodes?.[postcode.replace(/\s+/g, "")] ?? []).map((a) => ({
          id: "x",
          label: a.line1,
          line1: a.line1,
          city: a.city,
        })),
      }),
    };
    // The address chain, and the shop's own delivery history in front of it.
    // Both hang off the AI service because that is where streetsForPostcode
    // lives — the scripted flow and the model path share one lookup.
    ai.addresses = svc.addresses;
    ai.prisma = {
      order: { findMany: async () => opts.pastDeliveries ?? [] },
    };

    svc.db = () => ({
      voiceCall: {
        findUnique: async () => this.store.row,
        update: async ({ data }: any) => {
          if (data.transcript) this.store.row.transcript = data.transcript;
          return this.store.row;
        },
      },
      order: {
        findMany: async () => opts.orders ?? [],
        findFirst: async () => (opts.orders ?? [])[0] ?? null,
      },
    });
    this.svc = svc;
  }

  /** What the caller hears when the line picks up. */
  greeting(): string {
    const say = this.svc.ai.greeting({ locationName: "Pizza Uno" } as any, null);
    this.transcript.push({ who: "line", text: say });
    return say;
  }

  async say(text: string): Promise<string> {
    this.transcript.push({ who: "caller", text });
    const turn = await this.svc.onCallerSaid({ callId: "call-1", text });
    this.transcript.push({ who: "line", text: turn.say });
    return turn.say;
  }

  async press(digit: string): Promise<string> {
    this.transcript.push({ who: "caller", text: `[presses ${digit}]` });
    const turn = await this.svc.onDigit({ callId: "call-1", digit });
    const say = turn?.say ?? "";
    this.transcript.push({ who: "line", text: say });
    return say;
  }

  get state(): any {
    return this.store.row.transcript;
  }

  /** The call as a script, for reading in a failure message. */
  print(): string {
    return this.transcript
      .map((t) => `${t.who === "caller" ? "CALLER" : "  LINE"}: ${t.text}`)
      .join("\n");
  }
}
