// Which engine answers a shop that has never been asked.
//
// The chained engine turns the caller into text before anything can think
// about it, and that text is where orders were being lost: "twelve inch
// pepperoni, chips and garlic" arrived as "twelve inch pepperoni", the rest of
// the sentence simply gone. Nothing downstream recovers words that were never
// written down.

import { VoiceService } from "../voice.service";

const svc = (settings: any) => {
  const s: any = Object.create(VoiceService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  s.prisma = {
    voiceCall: { findFirst: async () => ({ locationId: "loc1" }) },
    location: { findUnique: async () => ({ settings }) },
  };
  return s;
};

describe("the engine a call is answered on", () => {
  it("is the engine that works when the shop has never chosen", async () => {
    // Speech-to-speech was the default for a few hours and should not have
    // been: it has not yet completed a call, and every attempt costs the
    // caller five seconds of silence before it hands back. A default is the
    // thing that works.
    expect(await svc({}).engineFor("cc1")).toBe("RELAY");
    expect(await svc({ voiceAiEnabled: true }).engineFor("cc1")).toBe("RELAY");
  });

  it("still honours a shop that chose the older one", async () => {
    expect(await svc({ voiceEngine: "RELAY" }).engineFor("cc1")).toBe("RELAY");
  });

  it("honours a shop that chose speech-to-speech", async () => {
    expect(await svc({ voiceEngine: "REALTIME" }).engineFor("cc1")).toBe("REALTIME");
  });

  it("falls back for a call it cannot place", async () => {
    const s: any = Object.create(VoiceService.prototype);
    s.prisma = { voiceCall: { findFirst: async () => null } };
    expect(await s.engineFor("cc1")).toBe("RELAY");
  });

  it("knows the difference between choosing and defaulting", async () => {
    // A shop with no OpenAI key that never asked for speech-to-speech is not
    // misconfigured — it is on the older engine, and saying "ERROR" every time
    // its phone rings trains everybody to ignore the log.
    expect(await svc({}).engineWasChosen("cc1")).toBe(false);
    expect(await svc({ voiceEngine: "REALTIME" }).engineWasChosen("cc1")).toBe(true);
    expect(await svc({ voiceEngine: "RELAY" }).engineWasChosen("cc1")).toBe(true);
  });
});
