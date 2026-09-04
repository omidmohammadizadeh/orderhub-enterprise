import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPublicKey, verify as cryptoVerify } from "crypto";

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

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>("TELNYX_API_KEY") || undefined;
    this.publicKey = this.config.get<string>("TELNYX_PUBLIC_KEY") || undefined;
    // A UK neural voice by default — the accent is the first thing a caller
    // judges, and an American voice on a Durham takeaway line lands badly.
    this.voice = this.config.get<string>("TELNYX_VOICE") || "Polly.Amy-Neural";
    this.language = this.config.get<string>("TELNYX_VOICE_LANGUAGE") || "en-GB";
    this.engine = this.config.get<string>("TELNYX_TRANSCRIPTION_ENGINE") || "B";
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
  startTranscription(callControlId: string): Promise<boolean> {
    return this.command(callControlId, "transcription_start", {
      language: this.language,
      // B is Telnyx's own engine — more accurate and cheaper than the Google
      // default, which is what the first live call was using at 0.33–0.62
      // confidence.
      transcription_engine: this.engine,
      transcription_tracks: "inbound",
    });
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

  /** Hand the caller to a human. */
  transfer(callControlId: string, to: string, from?: string) {
    return this.command(callControlId, "transfer", {
      to,
      ...(from ? { from } : {}),
    });
  }

  hangup(callControlId: string) {
    return this.command(callControlId, "hangup");
  }
}
