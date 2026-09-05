import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPublicKey, verify as cryptoVerify } from "crypto";
import { toE164 } from "../sms/phone";

// Thin client for Telnyx Call Control v2 — the six commands the AI phone line
// actually issues, and the webhook signature check.
//
// Nothing here knows about menus, orders or wallets. It speaks telephony, so
// that when we outgrow turn-taking and move to streamed audio, this is the only
// file that has to change.

const API = "https://api.telnyx.com/v2";

/** Ed25519 SPKI DER prefix — Telnyx publishes a bare 32-byte key, and Node's
 *  crypto wants it wrapped before it will import it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

@Injectable()
export class TelnyxCallControlService {
  private readonly logger = new Logger(TelnyxCallControlService.name);
  private readonly apiKey?: string;
  private readonly publicKey?: string;
  private readonly voice: string;
  private readonly language: string;
  private readonly engine: string;
  private readonly sttLanguage: string;
  private readonly sttModel: string;
  /** Conversation Relay's transcription engine. Unset = Telnyx's default,
   *  which is Deepgram — the one engine here that does keyterm boosting. */
  private readonly relayEngine?: string;
  /** The transcription model the relay should use. The default is not good
   *  enough for a phone line, and we had never asked for anything else. */
  private readonly relayModel: string;
  /** What to listen FOR, as opposed to the voice we speak in. */
  private readonly transcriptionLanguage: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>("TELNYX_API_KEY") || undefined;
    this.publicKey = this.config.get<string>("TELNYX_PUBLIC_KEY") || undefined;
    // A UK neural voice by default — the accent is the first thing a caller
    // judges, and an American voice on a Durham takeaway line lands badly.
    this.voice = this.config.get<string>("TELNYX_VOICE") || "Polly.Amy-Neural";
    this.language = this.config.get<string>("TELNYX_VOICE_LANGUAGE") || "en-GB";
    this.engine = this.config.get<string>("TELNYX_TRANSCRIPTION_ENGINE") || "B";
    // Speaking and listening do NOT take the same language code. Polly wants
    // the regional form ("en-GB") and gives us a British voice for it; the
    // transcription engines take a bare language ("en") and reject "en-GB"
    // outright with a 422. Sharing one value between them is what silently
    // killed every call — the STT command failed, nobody was listening, and
    // the caller heard the "trouble hearing you" apology every time.
    this.sttLanguage =
      this.config.get<string>("TELNYX_TRANSCRIPTION_LANGUAGE") ||
      this.language.split(/[-_]/)[0] ||
      "en";
    // Engine B defaults to `openai/whisper-tiny`, and tiny is why a caller
    // ordering food was transcribed as "I like the Salok el-Rab", "enough for
    // a nap" and "Allah of Egypt" — a model that small hallucinates whole
    // phrases, in other languages, from ordinary English speech. The turbo
    // model is the same engine, no extra account setup, and is the single
    // biggest lever on whether this line works at all.
    this.sttModel =
      this.config.get<string>("TELNYX_TRANSCRIPTION_MODEL") ||
      "openai/whisper-large-v3-turbo";
    // Deliberately has no default. See startConversationRelay.
    this.relayEngine =
      this.config.get<string>("VOICE_RELAY_TRANSCRIPTION_ENGINE") || undefined;
    this.transcriptionLanguage =
      this.config.get<string>("VOICE_RELAY_TRANSCRIPTION_LANGUAGE") || "en";
    this.relayModel =
      this.config.get<string>("VOICE_RELAY_TRANSCRIPTION_MODEL") || "deepgram/nova-3";
  }

  configured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Is this webhook really from Telnyx?
   *
   * The endpoint is public and answers calls that cost money, so an unsigned
   * request is refused. Returns true when no public key is configured — that
   * keeps a local/dev setup working, and is why TELNYX_PUBLIC_KEY belongs in
   * production env alongside the API key.
   */
  verifySignature(rawBody: string, signature?: string, timestamp?: string): boolean {
    if (!this.publicKey) return true;
    if (!signature || !timestamp) return false;
    // Reject anything older than five minutes so a captured webhook can't be
    // replayed to run up call charges.
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) return false;
    try {
      const key = createPublicKey({
        key: Buffer.concat([
          ED25519_SPKI_PREFIX,
          Buffer.from(this.publicKey, "base64"),
        ]),
        format: "der",
        type: "spki",
      });
      return cryptoVerify(
        null,
        Buffer.from(`${timestamp}|${rawBody}`),
        key,
        Buffer.from(signature, "base64"),
      );
    } catch (e: any) {
      this.logger.warn(`Telnyx signature check failed: ${e?.message ?? e}`);
      return false;
    }
  }

  private async command(
    callControlId: string,
    action: string,
    body: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!this.apiKey) {
      this.logger.warn(`TELNYX_API_KEY not set — dropping ${action}`);
      return false;
    }
    try {
      const res = await fetch(
        `${API}/calls/${encodeURIComponent(callControlId)}/actions/${action}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.logger.error(`Telnyx ${action} failed ${res.status}: ${text.slice(0, 300)}`);
        return false;
      }
      return true;
    } catch (e: any) {
      this.logger.error(`Telnyx ${action} threw: ${e?.message ?? e}`);
      return false;
    }
  }

  answer(callControlId: string) {
    return this.command(callControlId, "answer");
  }

  /** Say something to the caller. */
  speak(callControlId: string, text: string) {
    return this.command(callControlId, "speak", {
      payload: text,
      voice: this.voice,
      language: this.language,
    });
  }

  /**
   * Start live transcription of the CALLER only.
   *
   * Only documented parameters go in here. The first attempt carried a `hints`
   * array and `interim_results` alongside engine B — `hints` isn't a top-level
   * parameter at all (engine settings live under transcription_engine_config)
   * and interim results are engine-A only. Telnyx 400'd the command, we logged
   * it and carried on, and the caller spent 48 seconds talking to a line that
   * was not listening. Hence the boolean return, and the caller who checks it.
   *
   * `inbound` matters too: transcribing both tracks feeds the AI its own
   * speech back as if the caller had said it, and the conversation talks
   * itself into a corner within two turns.
   */
  async startTranscription(callControlId: string): Promise<boolean> {
    const base = {
      // B is Telnyx's own engine — more accurate and cheaper than the Google
      // default, which is what the first live call was using at 0.33–0.62
      // confidence.
      transcription_engine: this.engine,
      transcription_tracks: "inbound",
    };

    // The language belongs INSIDE the engine config, not at the top level.
    // Top-level `language` is the legacy Google-engine parameter; sending it
    // alongside engine B is a 422 ("Invalid value for language", code 90013)
    // and the call goes deaf. This is the second time this command has been
    // rejected for putting an engine setting at the top level — the first was
    // `hints`, and it cost a caller 48 seconds of talking to nobody.
    if (
      await this.command(callControlId, "transcription_start", {
        ...base,
        transcription_engine_config: {
          language: this.sttLanguage,
          transcription_model: this.sttModel,
        },
      })
    ) {
      return true;
    }

    // Last resort: let the engine pick its own default rather than leave the
    // line deaf. A transcript in the wrong dialect is recoverable; silence is
    // not. Logged loudly, because it means the configured language is wrong
    // and somebody should fix it rather than live on this fallback.
    this.logger.error(
      `Transcription rejected language "${this.sttLanguage}" on ${this.engine} — retrying with the engine default. Set TELNYX_TRANSCRIPTION_LANGUAGE to a value this engine accepts.`,
    );
    return this.command(callControlId, "transcription_start", base);
  }

  /**
   * Cut our own speech off mid-sentence.
   *
   * This is barge-in, and it is the single biggest difference between a line
   * that feels like a person and one that feels like a phone menu: the caller
   * who already knows what they want should not have to sit through "to place
   * an order, press one". The moment they press a key or start talking, we
   * stop.
   *
   * Failure is deliberately not propagated. If the speech has already finished
   * Telnyx has nothing to stop and answers 4xx, which is not a problem worth
   * telling anyone about — the caller got what they wanted either way.
   */
  async stopSpeaking(callControlId: string): Promise<void> {
    await this.command(callControlId, "playback_stop", { stop: "current" }).catch(
      () => false,
    );
  }

  /**
   * Hand the call to Conversation Relay.
   *
   * Replaces answer + speak + transcription_start in one command: Telnyx does
   * the listening, the endpointing and the speaking, and talks to us over a
   * WebSocket in TEXT. The greeting goes here rather than being a speak
   * command afterwards, so the caller hears it the instant the leg is up.
   *
   * `interruptible` is what lets a caller talk over us without us having to
   * notice and issue a stop — barge-in stops being something we implement.
   */
  async startConversationRelay(
    callControlId: string,
    args: { url: string; greeting: string },
  ): Promise<boolean> {
    const base = {
      url: args.url,
      greeting: args.greeting,
      voice: this.voice,
      language: this.language,
      dtmf_detection: true,
      interruptible: true,
      // Let the caller talk over the menu. A regular who knows what they want
      // should never have to sit through "to place an order, press one".
      interruptible_greeting: true,
      // NOTE the absence of `transcription_engine: "B"`.
      //
      // "B" is the legacy alias used by transcription_start. Conversation
      // Relay names its engines differently — deepgram (default), google,
      // telnyx — so "B" means nothing here. Sending it started a relay that
      // spoke perfectly and never transcribed a word: the caller pressed 1,
      // heard the next question, answered it, and no prompt frame ever
      // arrived. Silence, from their side of it.
      //
      // This is the THIRD time a value valid for one Telnyx command has been
      // sent to another that names the same thing differently. So the default
      // is now to send nothing and let Telnyx pick, and an override has to be
      // set deliberately, by someone who has checked.
      ...(this.relayEngine ? { transcription_engine: this.relayEngine } : {}),
    };

    // Ask for a named transcription model rather than taking the default.
    //
    // Every accuracy problem on this line has been the transcriber, not the
    // brain: "delivery" came back as "Very very", "N E" as "M e", "three cola"
    // as "Drie coli". Claude never saw those words. The default engine is
    // whatever Telnyx picks, and we have never actually asked for a good one —
    // nova-3 is their current best for telephone audio.
    //
    // And PIN THE LANGUAGE while we are at it.
    //
    // nova-3 can detect language per utterance, and left to itself on 8kHz
    // phone audio it does. A real call came back "ग्वालिक नहीं हूं." and then
    // "Goli que meio." from a caller ordering in English in Gateshead — Hindi
    // and something Portuguese-shaped, from a man asking for chips. Nothing
    // downstream can recover from that, and the model was being handed it as
    // though it were what the caller said.
    //
    // The top-level `language` is the voice we speak IN. This is the one that
    // says what to listen FOR, and they are different fields.
    const engineConfig = {
      transcription_model: this.relayModel,
      transcription_language: this.transcriptionLanguage,
    };

    // Tried first, then without. An unknown model must not stop a relay
    // starting, because a call on a worse transcriber still beats no call.
    if (
      await this.command(callControlId, "conversation_relay_start", {
        ...base,
        transcription_engine_config: engineConfig,
      })
    ) {
      return true;
    }
    this.logger.warn(
      `Conversation Relay rejected ${JSON.stringify(engineConfig)} — retrying with the model alone.`,
    );
    if (
      await this.command(callControlId, "conversation_relay_start", {
        ...base,
        transcription_engine_config: { transcription_model: this.relayModel },
      })
    ) {
      return true;
    }
    this.logger.error(
      `Conversation Relay rejected transcription model "${this.relayModel}" — starting on the default. Set VOICE_RELAY_TRANSCRIPTION_MODEL to one this account accepts.`,
    );
    return this.command(callControlId, "conversation_relay_start", base);
  }

  /**
   * Hand the caller to a human.
   *
   * Normalised here rather than at the call sites, because the number comes
   * from a settings box a person typed into — "0191 231 2345" is what a shop
   * owner writes, and Telnyx rejects anything that is not +E164 (code 10016).
   * The transfer failing is the worst possible moment for a formatting bug:
   * it only ever runs when something has already gone wrong.
   */
  transfer(callControlId: string, to: string, from?: string): Promise<boolean> {
    const dest = toE164(to);
    if (!dest) {
      this.logger.error(`Cannot transfer ${callControlId}: "${to}" is not a dialable number`);
      return Promise.resolve(false);
    }
    const fromE164 = from ? toE164(from) : null;
    return this.command(callControlId, "transfer", {
      to: dest,
      ...(fromE164 ? { from: fromE164 } : {}),
    });
  }

  async hangup(callControlId: string): Promise<boolean> {
    // The goodbye timer regularly fires after the caller has already put the
    // phone down, and "Call has already ended" is the outcome we wanted. It is
    // logged as an error by `command`, so it is checked here first rather than
    // filling the log with failures that are actually successes.
    if (this.ended.has(callControlId)) return true;
    return this.command(callControlId, "hangup");
  }

  /** Calls we know are over, so we stop issuing commands against them. */
  private readonly ended = new Set<string>();

  /** Told by the controller on call.hangup. */
  markEnded(callControlId: string): void {
    this.ended.add(callControlId);
    // The set would otherwise grow for the life of the process.
    if (this.ended.size > 500) {
      for (const id of this.ended) {
        this.ended.delete(id);
        if (this.ended.size <= 250) break;
      }
    }
  }
}
