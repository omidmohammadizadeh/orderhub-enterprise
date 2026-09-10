import { VoiceRealtimeSim } from "./voice-realtime-sim";

// "First time I called the AI did not speak, it was silence; second time it
// worked." Two ways a line that has already been answered can go quiet, and
// both used to end in a bare socket close with nobody hanging up:
//
//  - the session lookup fails during attach, so there is no model to greet
//    with — the caller was left on an open leg with nothing on it;
//  - a deploy sends SIGTERM while calls are up, every socket closes, and
//    Telnyx keeps each caller's leg up with nothing on it.
//
// Neither is allowed to be silent any more. The call is handed to the
// standard engine, and if even that fails it is ended so the caller gets a
// tone to redial on.

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("a session that cannot be answered with is not left silent", () => {
  it("hands the call to the standard engine when the session lookup comes back empty", async () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeSession = jest.fn(async () => null);
    sim.gateway.fallbackToRelay = jest.fn(async () => true);
    sim.gateway.telnyx.hangup = jest.fn(async () => true);
    await sim.gateway.attach(sim.caller, "cc-empty");
    expect(sim.gateway.fallbackToRelay).toHaveBeenCalledWith("cc-empty", { alreadySpoke: false });
    expect(sim.gateway.telnyx.hangup).not.toHaveBeenCalled();
    expect(sim.gateway.calls.has("cc-empty")).toBe(false);
    expect(sim.log.join("\n")).toMatch(/has no session to answer with — handing the call to the standard engine/);
  });

  it("ends the call when the handover fails too, rather than leaving dead air", async () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeSession = jest.fn(async () => null);
    sim.gateway.fallbackToRelay = jest.fn(async () => false);
    sim.gateway.telnyx.hangup = jest.fn(async () => true);
    await sim.gateway.attach(sim.caller, "cc-empty");
    expect(sim.gateway.telnyx.hangup).toHaveBeenCalledWith("cc-empty");
    expect(sim.log.join("\n")).toMatch(/could not be handed over either — hanging up/);
  });

  it("treats a lookup that throws the same way", async () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.voice.realtimeSession = jest.fn(async () => {
      throw new Error("db pool not ready");
    });
    sim.gateway.fallbackToRelay = jest.fn(async () => true);
    await sim.gateway.attach(sim.caller, "cc-throw");
    expect(sim.gateway.fallbackToRelay).toHaveBeenCalledWith("cc-throw", { alreadySpoke: false });
  });
});

describe("a deploy hands live calls over instead of cutting them off", () => {
  it("does nothing, quickly, when no call is up", async () => {
    const sim = new VoiceRealtimeSim();
    sim.gateway.fallbackToRelay = jest.fn(async () => true);
    await sim.gateway.beforeApplicationShutdown("SIGTERM");
    expect(sim.gateway.fallbackToRelay).not.toHaveBeenCalled();
    expect(sim.log.join("\n")).toMatch(/shutting down \(SIGTERM\) — no live calls/);
  });

  it("hands every live call to the standard engine, admitting the restart", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer("cc-live");
    sim.gateway.fallbackToRelay = jest.fn(async () => true);
    sim.gateway.telnyx.hangup = jest.fn(async () => true);
    await sim.gateway.beforeApplicationShutdown("SIGTERM");
    await settle();
    expect(sim.gateway.fallbackToRelay).toHaveBeenCalledWith("cc-live", { alreadySpoke: true });
    expect(sim.gateway.telnyx.hangup).not.toHaveBeenCalled();
    expect(sim.gateway.calls.size).toBe(0);
    expect(sim.log.join("\n")).toMatch(/shutdown: 1\/1 live call\(s\) handed to the standard engine/);
  });

  it("ends a call it cannot hand over, so the caller gets a tone rather than silence", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer("cc-stuck");
    sim.gateway.fallbackToRelay = jest.fn(async () => false);
    sim.gateway.telnyx.hangup = jest.fn(async () => true);
    await sim.gateway.beforeApplicationShutdown("SIGTERM");
    await settle();
    expect(sim.gateway.telnyx.hangup).toHaveBeenCalledWith("cc-stuck");
    expect(sim.log.join("\n")).toMatch(/could not be handed over on shutdown — hanging up/);
  });

  it("gives up after its budget rather than holding the process open", async () => {
    const sim = new VoiceRealtimeSim();
    await sim.answer("cc-slow");
    sim.gateway.config = { get: (k: string) => (k === "VOICE_SHUTDOWN_HANDOVER_MS" ? "30" : undefined) };
    sim.gateway.fallbackToRelay = jest.fn(() => new Promise<boolean>(() => {}));
    const started = Date.now();
    await sim.gateway.beforeApplicationShutdown("SIGTERM");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sim.log.join("\n")).toMatch(/shutdown handover ran past 30ms/);
  });
});
