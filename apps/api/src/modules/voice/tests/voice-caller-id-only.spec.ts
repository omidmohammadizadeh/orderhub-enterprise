// Caller ID without the AI.
//
// A shop that doesn't want a machine answering its phone can still use the
// number it was given: their provider rings ours at the same time as their own
// line, we never pick up, and the ringing alone carries the caller to the
// tills. Nothing is answered, so nothing is billed.
//
// The rules this file holds:
//   - the popup fires BEFORE anything that can refuse a call, because a shop
//     using the number this way may have no menu, no credit, and the AI off;
//   - it is the same event and the same lookup the Comet reader sends, so a
//     till cannot tell which of the three rang it;
//   - it never breaks a call: a popup that throws must still let the AI answer.

import { VoiceService } from "../voice.service";

const CALL = { id: "call_1", locationId: "loc_1", tenantId: "t_1" };

function build(opts: {
  callerIdOnly?: boolean;
  enabled?: boolean;
  /** null = the number is not ours at all */
  target?: null;
  /** null = no published menu, so the full context refuses */
  context?: null;
  lookupThrows?: boolean;
  match?: unknown;
}) {
  const emitted: Array<{ locationId: string; event: string; payload: any }> = [];
  const updates: any[] = [];
  const s: any = Object.create(VoiceService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  s.contexts = {
    callerIdTarget: async () =>
      opts.target === null
        ? null
        : { tenantId: CALL.tenantId, locationId: CALL.locationId, callerIdOnly: opts.callerIdOnly === true },
    resolve: async () =>
      opts.context === null
        ? null
        : {
            tenantId: CALL.tenantId,
            locationId: CALL.locationId,
            brandId: null,
            enabled: opts.enabled === true,
            callerIdOnly: opts.callerIdOnly === true,
            testMode: true,
          },
  };
  s.customers = {
    lookupByPhone: async () => {
      if (opts.lookupThrows) throw new Error("customer lookup exploded");
      return opts.match ?? null;
    },
  };
  s.socket = {
    emitToLocation: (locationId: string, event: string, payload: any) =>
      emitted.push({ locationId, event, payload }),
  };
  s.prisma = {
    voiceCall: {
      upsert: async () => ({ id: CALL.id }),
      update: async (args: any) => {
        updates.push(args.data);
        return {};
      },
    },
  };
  s.wallet = { reserveForVoiceCall: async () => ({ ok: true, balanceMinor: 500, priceMinor: 100 }) };
  s.ai = { greeting: () => "Hello" };
  s.knownCaller = async () => ({ name: null, address: null });
  return { s, emitted, updates };
}

const ring = (s: any, from: string | null = "+447700900123") =>
  s.onIncomingCall({ providerCallId: "ccid_1", from, to: "+441910000000", provider: "TELNYX" });

describe("caller ID only", () => {
  it("puts the caller on the tills and never answers", async () => {
    const { s, emitted, updates } = build({ callerIdOnly: true, enabled: false });
    const decision = await ring(s);

    expect(decision.answer).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toBe("callerid:ring");
    expect(emitted[0]!.locationId).toBe(CALL.locationId);
    expect(emitted[0]!.payload.phone).toBe("+447700900123");
    expect(typeof emitted[0]!.payload.at).toBe("string");
  });

  it("is not counted as a call we turned away", async () => {
    // The dashboard's "turned away" figure is meant to be alarming. A shop
    // whose line never answers on purpose would otherwise fill it.
    const { s, updates } = build({ callerIdOnly: true, enabled: false });
    const decision = await ring(s);

    expect(decision.reason).toBe("CALLER_ID_ONLY");
    expect(updates.at(-1)).toMatchObject({
      status: "NOT_ANSWERED",
      notAnsweredReason: "CALLER_ID_ONLY",
    });
  });

  it("still says DISABLED when the shop simply switched the AI off", async () => {
    const { s, emitted, updates } = build({ callerIdOnly: false, enabled: false });
    const decision = await ring(s);

    expect(decision.reason).toBe("DISABLED");
    expect(updates.at(-1)).toMatchObject({ notAnsweredReason: "DISABLED" });
    expect(emitted).toHaveLength(0);
  });

  it("shows the caller even when the shop has no menu published", async () => {
    // The whole point: this shop bought the popup, not the ordering. Resolving
    // a POS menu is not a condition of being told who is ringing.
    const { s, emitted } = build({ callerIdOnly: true, context: null });
    const decision = await ring(s);

    expect(decision.answer).toBe(false);
    expect(decision.reason).toBe("UNKNOWN_NUMBER");
    expect(emitted).toHaveLength(1);
  });

  it("names a regular the same way the Comet popup does", async () => {
    const match = { name: "Jane", orders: 12, email: null, addresses: [] };
    const { s, emitted } = build({ callerIdOnly: true, enabled: false, match });

    await ring(s);

    expect(emitted[0]!.payload.match).toEqual(match);
  });

  it("shows the caller on a shop where the AI DOES answer", async () => {
    const { s, emitted } = build({ callerIdOnly: true, enabled: true });
    const decision = await ring(s);

    expect(decision.answer).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it("says nothing for a withheld number", async () => {
    const { s, emitted } = build({ callerIdOnly: true, enabled: false });
    await ring(s, null);
    expect(emitted).toHaveLength(0);
  });

  it("sends nothing for a number that is not ours", async () => {
    const { s, emitted } = build({ callerIdOnly: true, target: null });
    await ring(s);
    expect(emitted).toHaveLength(0);
  });

  it("lets the AI answer even when the popup throws", async () => {
    // A broken lookup must cost a shop its popup, never its call.
    const { s, emitted } = build({ callerIdOnly: true, enabled: true, lookupThrows: true });
    const decision = await ring(s);

    expect(decision.answer).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});
