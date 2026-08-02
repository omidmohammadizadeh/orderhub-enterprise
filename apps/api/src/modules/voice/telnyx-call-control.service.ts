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

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>("TELNYX_API_KEY") || undefined;
    this.publicKey = this.config.get<string>("TELNYX_PUBLIC_KEY") || undefined;
    // A UK neural voice by default — the accent is the first thing a caller
    // judges, and an American voice on a Durham takeaway line lands badly.
    this.voice = this.config.get<string>("TELNYX_VOICE") || "Polly.Amy-Neural";
    this.language = this.config.get<string>("TELNYX_VOICE_LANGUAGE") || "en-GB";
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
  ): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn(`TELNYX_API_KEY not set — dropping ${action}`);
      return;
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
        // Losing a command mid-call is not fatal on its own — the caller may
        // just hear silence — so log loudly and let the call continue rather
        // than throwing into a webhook Telnyx will retry.
        this.logger.error(`Telnyx ${action} failed ${res.status}: ${text.slice(0, 300)}`);
      }
    } catch (e: any) {
      this.logger.error(`Telnyx ${action} threw: ${e?.message ?? e}`);
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
   * `inbound` matters: transcribing both tracks feeds the AI its own speech
   * back as if the caller had said it, and the conversation talks itself into
   * a corner within two turns.
   */
  startTranscription(callControlId: string) {
    return this.command(callControlId, "transcription_start", {
      language: this.language,
      transcription_tracks: "inbound",
      interim_results: false,
    });
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
