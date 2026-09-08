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
  s.relayModel = env.VOICE_RELAY_TRANSCRIPTION_MODEL ?? "deepgram/nova-3";
  s.relayLanguage = env.VOICE_RELAY_LANGUAGE ?? s.language ?? "en-GB";
  s.keytermsEnabled = env.VOICE_RELAY_KEYTERMS === "true";
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
  it("asks for a named transcription model instead of taking the default", async () => {
    // Every accuracy problem on this line has been the transcriber, not the
    // brain — and we had never actually asked for a good one.
    const s = svc();
    s.relayEngine = undefined;
    await s.startConversationRelay("cc1", { url: "wss://x", greeting: "Hi" });
    expect(s.command.mock.calls[0][2].transcription_engine_config.transcription_model).toBe(
      "deepgram/nova-3",
    );
  });

  it("pins the language with the field Conversation Relay actually has", async () => {
    // `transcription_language` was invented here, and this test used to lock
    // it in. Conversation Relay has no such field — the language for the whole
    // relay is the top-level one — so every call ever taken on this line sent
    // a key that was silently dropped, while the transcriber detected the
    // language per utterance. That is how a caller ordering in English in
    // Gateshead was transcribed as "ग्वालिक नहीं हूं." in August and "Tu hai
    // vinto i peperoni?" in September.
    const s = svc();
    s.command = jest.fn().mockResolvedValue(true);
    await s.startConversationRelay("cc1", { url: "wss://x", greeting: "Hi" });

    const body = s.command.mock.calls[0][2];
    expect(body.language).toBe("en-GB");
    expect(body.transcription_engine_config).toEqual({
      transcription_model: expect.any(String),
    });
    expect(body.transcription_engine_config.transcription_language).toBeUndefined();
  });

  it("drops the language before it drops the model, and the model before the call", async () => {
    // A call on a worse transcriber beats no call at all — but the language is
    // the cheaper thing to give up, so it goes first.
    const s = svc();
    s.relayEngine = undefined;
    s.command = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    expect(await s.startConversationRelay("cc1", { url: "wss://x", greeting: "Hi" })).toBe(
      true,
    );
    expect(s.command.mock.calls[1][2].transcription_engine_config).toEqual({
      transcription_model: expect.any(String),
    });
    expect(s.command.mock.calls[2][2].transcription_engine_config).toBeUndefined();
    expect(s.logger.error).toHaveBeenCalled();
  });

  it("names the engine the way Conversation Relay names it", async () => {
    // "B" is transcription_start's alias and means nothing here — sending it
    // started a relay that spoke perfectly and never transcribed a word.
    // Sending NOTHING was not the fix it looked like either: their own example
    // passes the engine and the model together, and a deepgram model with no
    // engine named left something else free to pick the language per
    // utterance.
    const s = svc({ TELNYX_TRANSCRIPTION_ENGINE: "B" });
    s.relayEngine = undefined;
    await s.startConversationRelay("cc1", { url: "wss://x", greeting: "Hello" });

    const body = s.command.mock.calls[0][2];
    expect(body.transcription_engine).toBe("Deepgram");
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

describe("telling the transcriber what the shop sells", () => {
  // The words nova-3 gets wrong are not random: they are the ones its training
  // data has barely seen, which on a takeaway line is most of the menu.
  // "gyros" came back as "heroes", "souvlaki" as "civlaki", "kofte" as
  // "coffee". Claude never saw the real word.

  it("sends no keyterms unless somebody has deliberately switched them on", async () => {
    // The idea is sound and the evidence against it is one call, but it is a
    // bad call: within an hour of turning keyterms on, a caller saying "12
    // inch pepperoni" to a pizzeria was transcribed "Tu hai vinto i
    // peperoni?". This menu's hundred commonest words are capricciosa,
    // milanese, sorrento, bolognese, diavola, calzone — handing that list to a
    // multilingual model as the things to listen for is a vote for which
    // language it is hearing. Off until it can be tested somewhere that is not
    // a live shop.
    const s = svc();
    s.keytermsEnabled = false;
    await s.startConversationRelay("cc1", {
      url: "wss://x",
      greeting: "Hi",
      keyterms: ["gyros", "souvlaki"],
    });
    expect("keyterm" in s.command.mock.calls[0][2].transcription_engine_config).toBe(false);
  });

  it("sends them, capped, for whoever switches them on", async () => {
    const s = svc();
    s.keytermsEnabled = true;
    await s.startConversationRelay("cc1", {
      url: "wss://x",
      greeting: "Hi",
      keyterms: Array.from({ length: 250 }, (_, i) => `term${i}`),
    });
    expect(s.command.mock.calls[0][2].transcription_engine_config.keyterm).toHaveLength(100);
  });

  it("drops the keyterms first when something is refused", async () => {
    const s = svc();
    s.keytermsEnabled = true;
    s.command = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(
      await s.startConversationRelay("cc1", {
        url: "wss://x",
        greeting: "Hi",
        keyterms: ["gyros"],
      }),
    ).toBe(true);

    const second = s.command.mock.calls[1][2].transcription_engine_config;
    expect(second.keyterm).toBeUndefined();
    expect(second.transcription_model).toEqual(expect.any(String));
  });
});

describe("startMediaStream", () => {
  it("asks Telnyx for μ-law on the inbound stream, whatever the call negotiated", async () => {
    // Left at "default" the stream carries the call's own codec — A-law on
    // plenty of UK routes — and the model, told to expect μ-law, hears noise.
    const s = svc();
    s.config = { get: () => undefined };
    await s.startMediaStream("cc1", "wss://x");
    const body = s.command.mock.calls[0][2];
    expect(body.stream_codec).toBe("PCMU");
    expect(body.stream_track).toBe("inbound_track");
    expect(body.stream_bidirectional_codec).toBe("PCMU");
    expect(body.stream_bidirectional_mode).toBe("rtp");
  });

  it("lets the inbound codec be overridden for a deliberate experiment", async () => {
    const s = svc();
    s.config = { get: (k: string) => (k === "VOICE_STREAM_INBOUND_CODEC" ? "L16" : undefined) };
    await s.startMediaStream("cc1", "wss://x");
    expect(s.command.mock.calls[0][2].stream_codec).toBe("L16");
  });
});
