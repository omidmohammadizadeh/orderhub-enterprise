// Which engine answers a call — and the fact that nobody chooses any more.
//
// The two were built to be compared, and they have been. Speech-to-speech
// understands a caller on a bad line in a way the chained pipeline never
// managed, so it is simply what answers the phone: a shop should not be able
// to end up on the worse one because of a dropdown somebody set weeks ago.
//
// The chained engine still runs. It catches a call that cannot start, or one
// whose model goes quiet mid-sentence — which is how an order reached a
// kitchen on 6 September after the model stopped speaking halfway through
// taking payment. That is a floor, not a choice.

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
  it("is speech-to-speech, for everybody", async () => {
    expect(await svc({}).engineFor("cc1")).toBe("REALTIME");
    expect(await svc({ voiceAiEnabled: true }).engineFor("cc1")).toBe("REALTIME");
  });

  it("ignores a setting left behind by the old switcher", async () => {
    // Shops that picked one while the two were being compared must not be
    // pinned to it for ever by a value nobody remembers setting.
    expect(await svc({ voiceEngine: "RELAY" }).engineFor("cc1")).toBe("REALTIME");
    expect(await svc({ voiceEngine: "REALTIME" }).engineFor("cc1")).toBe("REALTIME");
  });

  it("does not go looking for a call it cannot place", async () => {
    // No query, no setting, no failure mode. It is the same answer either way.
    const s: any = Object.create(VoiceService.prototype);
    expect(await s.engineFor("anything")).toBe("REALTIME");
  });
});
