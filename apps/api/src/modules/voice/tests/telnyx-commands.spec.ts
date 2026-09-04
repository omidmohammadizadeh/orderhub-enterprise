import { TelnyxCallControlService } from "../telnyx-call-control.service";

// The exact shape of the two commands that have now each broken a live call.
//
// Both failures were 422s that we logged and carried on from, so the caller
// heard an apology and nothing else. Neither was a logic bug — both were a
// parameter in the wrong place. That is precisely what a test can hold.

const svc = (env: Record<string, string> = {}) => {
  const s = Object.create(TelnyxCallControlService.prototype) as any;
  s.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  s.apiKey = "test";
  s.language = env.TELNYX_VOICE_LANGUAGE ?? "en-GB";
  s.engine = env.TELNYX_TRANSCRIPTION_ENGINE ?? "B";
  s.sttLanguage =
    env.TELNYX_TRANSCRIPTION_LANGUAGE ?? (s.language.split(/[-_]/)[0] || "en");
  s.sttModel = env.TELNYX_TRANSCRIPTION_MODEL ?? "openai/whisper-large-v3-turbo";
  s.ended = new Set();
  s.command = jest.fn().mockResolvedValue(true);
  return s;
};

describe("startTranscription", () => {
  it("puts the language inside the engine config, never at the top level", async () => {
    // Top-level `language` is the legacy Google parameter. Sent alongside
    // engine B it is a 422 (code 90013) and the line goes deaf for the whole
    // call — which is exactly what happened on 2026-09-04.
    const s = svc();
    await s.startTranscription("cc1");

    const body = s.command.mock.calls[0][2];
    expect(body.language).toBeUndefined();
    expect(body.transcription_engine_config).toEqual({
      language: "en",
      transcription_model: "openai/whisper-large-v3-turbo",
    });
    expect(body.transcription_engine).toBe("B");
    expect(body.transcription_tracks).toBe("inbound");
  });

  it("does not send the speech engine's regional code to the listener", async () => {
    // Polly wants "en-GB" and gives us a British voice for it. The
    // transcription engines take a bare language and reject the regional form.
    const s = svc({ TELNYX_VOICE_LANGUAGE: "en-GB" });
    await s.startTranscription("cc1");
    expect(s.command.mock.calls[0][2].transcription_engine_config.language).toBe("en");
  });

  it("never runs on whisper-tiny, which is the engine B default", async () => {
    // Tiny hallucinated whole phrases in other languages from plain English
    // speech: a caller ordering food came back as "Allah of Egypt". The engine
    // default is the trap — the model has to be asked for explicitly.
    const s = svc();
    await s.startTranscription("cc1");
    const model = s.command.mock.calls[0][2].transcription_engine_config
      .transcription_model;
    expect(model).toBe("openai/whisper-large-v3-turbo");
    expect(model).not.toContain("tiny");
  });

  it("honours an explicit transcription language override", async () => {
    const s = svc({ TELNYX_TRANSCRIPTION_LANGUAGE: "fr" });
    await s.startTranscription("cc1");
    expect(s.command.mock.calls[0][2].transcription_engine_config.language).toBe("fr");
  });

  it("retries without a language rather than leaving the line deaf", async () => {
    const s = svc();
    s.command = jest
      .fn()
      .mockResolvedValueOnce(false) // language rejected
      .mockResolvedValueOnce(true); // engine default accepted

    expect(await s.startTranscription("cc1")).toBe(true);
    expect(s.command).toHaveBeenCalledTimes(2);
    expect(s.command.mock.calls[1][2].transcription_engine_config).toBeUndefined();
    // Loud, because living on the fallback means the configured language is
    // wrong and somebody should fix it.
    expect(s.logger.error).toHaveBeenCalled();
  });

  it("reports failure when even the default is refused", async () => {
    const s = svc();
    s.command = jest.fn().mockResolvedValue(false);
    expect(await s.startTranscription("cc1")).toBe(false);
  });
});

describe("transfer", () => {
  it("dials +E164, whatever the shop typed into the settings box", async () => {
    // Telnyx rejects anything else with code 10016 — and a transfer only ever
    // runs when something has already gone wrong, so this failing strands the
    // caller in silence.
    const s = svc();
    await s.transfer("cc1", "0191 231 2345");
    expect(s.command.mock.calls[0][2].to).toBe("+441912312345");
  });

  it("leaves an already-international number alone", async () => {
    const s = svc();
    await s.transfer("cc1", "+447700900123");
    expect(s.command.mock.calls[0][2].to).toBe("+447700900123");
  });

  it("refuses rather than dialling something that is not a number", async () => {
    const s = svc();
    expect(await s.transfer("cc1", "ask for Dave")).toBe(false);
    expect(s.command).not.toHaveBeenCalled();
    expect(s.logger.error).toHaveBeenCalled();
  });
});

describe("startConversationRelay", () => {
  it("does NOT send transcription_start's engine alias", async () => {
    // "B" is the legacy alias for transcription_start. Conversation Relay
    // names its engines deepgram / google / telnyx, so "B" means nothing —
    // and sending it started a relay that spoke perfectly and never
    // transcribed a word. The caller pressed 1, heard the next question,
    // answered it, and no prompt frame ever arrived.
    const s = svc({ TELNYX_TRANSCRIPTION_ENGINE: "B" });
    s.relayEngine = undefined;
    await s.startConversationRelay("cc1", { url: "wss://x", greeting: "Hello" });

    const body = s.command.mock.calls[0][2];
    expect(body.transcription_engine).toBeUndefined();
    expect(body.url).toBe("wss://x");
    expect(body.greeting).toBe("Hello");
  });

  it("lets the greeting be talked over", async () => {
    // The whole point of the press-or-say menu: a regular who knows what they
    // want should never sit through "to place an order, press one".
    const s = svc();
    s.relayEngine = undefined;
    await s.startConversationRelay("cc1", { url: "wss://x", greeting: "Hi" });
    const body = s.command.mock.calls[0][2];
    expect(body.interruptible).toBe(true);
    expect(body.interruptible_greeting).toBe(true);
    expect(body.dtmf_detection).toBe(true);
  });

  it("sends an engine only when one was deliberately chosen", async () => {
    const s = svc();
    s.relayEngine = "deepgram";
    await s.startConversationRelay("cc1", { url: "wss://x", greeting: "Hi" });
    expect(s.command.mock.calls[0][2].transcription_engine).toBe("deepgram");
  });
});
