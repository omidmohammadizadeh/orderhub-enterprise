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
  const ctl = () => {
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
    c.db = () => ({ voiceCall: { findUnique: async () => null } });
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
