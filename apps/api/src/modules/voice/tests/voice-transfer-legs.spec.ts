// Call sQLUYKlg. The caller asked for a person, the transfer worked, and two
// things happened that should not have.
//
//   09:46:39  call sQLUYKlg call.bridged      the caller is with the shop
//   09:46:44  said "Got it. Passing you over to someone now."
//   09:46:51  said "Just a moment, they'll be with you shortly."
//   09:46:57  said "I'm not quite catching that. What can I do for you?"
//
// The media fork was never stopped, so the model sat on a conversation
// between two humans and talked over it. And:
//
//   09:46:52  call m3hEZkow answering on the speech-to-speech engine
//
// m3hEZkow is the leg WE dialled. The shop picked up its own phone and got
// the AI, because call.answered had no guard against our own outbound legs —
// call.initiated has always had one.

import { VoiceTelnyxController } from "../voice-telnyx.controller";

describe("the leg we dialled is not a caller", () => {
  // `row` is the VoiceCall record. onIncomingCall writes it BEFORE we answer,
  // so a genuine caller always has one by the time call.answered arrives and a
  // leg we dialled never does — which is the check that holds when the
  // provider tells us nothing about direction (see call tdyKDXHw below).
  const ctl = (opts: { row?: any } = {}) => {
    const started: string[] = [];
    const stopped: string[] = [];
    const c: any = Object.create(VoiceTelnyxController.prototype);
    c.logger = { log() {}, warn() {}, error() {} };
    c.realtime = {
      available: () => ({ ok: true }),
      streamUrl: (id: string) => `wss://x/${id}`,
      isConnected: () => false,
      stop: (id: string) => stopped.push(id),
    };
    c.relay = { isConnected: () => false };
    c.telnyx = {
      verifySignature: () => true,
      startMediaStream: async (id: string) => {
        started.push(id);
        return true;
      },
      stopMediaStream: jest.fn(async () => true),
    };
    c.voice = { engineFor: async () => "REALTIME" };
    c.db = () => ({
      voiceCall: {
        findUnique: async () => ("row" in opts ? opts.row : { transcript: null }),
      },
    });
    return { c, started, stopped };
  };

  it("does not answer our own outbound transfer leg with the AI", async () => {
    const { c, started } = ctl();
    await c.onAnswered("m3hEZkow", { direction: "outgoing" });
    expect(started).toEqual([]);
  });

  it("still answers a real inbound call", async () => {
    const { c, started } = ctl();
    await c.onAnswered("sQLUYKlg", { direction: "incoming" });
    expect(started).toEqual(["sQLUYKlg"]);
  });

  it("answers when the provider tells us nothing about direction", async () => {
    // Older payloads, and anything unexpected: a missing field must never
    // stop a genuine caller being answered.
    const { c, started } = ctl();
    await c.onAnswered("sQLUYKlg", {});
    expect(started).toEqual(["sQLUYKlg"]);
  });

  it("leaves our own leg alone when the provider says nothing about direction EITHER", async () => {
    // Call tdyKDXHw, 15 Sep. The caller asked for a person, the transfer was
    // made and bridged — and then call.answered for the leg we dialled arrived
    // with no direction on it. The guard above could not fire, so we started a
    // media stream on the SHOP's leg, found no model session, tried to hand it
    // to the relay engine, and the caller lost the call a second after being
    // put through. The leg had no VoiceCall row, because we never decided to
    // answer it; that is what settles it.
    const { c, started } = ctl({ row: null });
    await c.onAnswered("tdyKDXHw", {});
    expect(started).toEqual([]);
  });

  it("takes the model off the call the moment the two legs are joined", async () => {
    const { c, stopped } = ctl();
    await c.webhook({ headers: {} } as any, {
      data: { event_type: "call.bridged", payload: { call_control_id: "sQLUYKlg" } },
    });
    expect(stopped).toEqual(["sQLUYKlg"]);
    expect(c.telnyx.stopMediaStream).toHaveBeenCalledWith("sQLUYKlg");
  });

  it("and the outbound leg never reaches the AI through the webhook either", async () => {
    const { c, started } = ctl();
    await c.webhook({ headers: {} } as any, {
      data: {
        event_type: "call.answered",
        payload: { call_control_id: "m3hEZkow", direction: "outgoing" },
      },
    });
    expect(started).toEqual([]);
  });
});
