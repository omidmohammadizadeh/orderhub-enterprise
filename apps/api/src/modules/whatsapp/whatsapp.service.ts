import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { WhatsAppAiService } from "./whatsapp-ai.service";
import { WhatsAppSendService } from "./whatsapp-send.service";
import { ReferralService } from "../loyalty/referral.service";

// Phase AY — WhatsApp Cloud API webhook plumbing. Handles Meta's GET
// verification handshake, verifies + parses inbound POST events, and routes
// customer messages into the AI conversation engine (P2).
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly ai: WhatsAppAiService,
    private readonly referrals: ReferralService,
    private readonly send: WhatsAppSendService,
  ) {}

  /** Meta webhook verification (GET): echo the challenge when the token matches. */
  verifyWebhook(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    const expected = this.config.get<string>("WHATSAPP_VERIFY_TOKEN");
    if (mode === "subscribe" && expected && token === expected && challenge) {
      this.logger.log("WhatsApp webhook verified");
      return challenge;
    }
    throw new ForbiddenException("WhatsApp webhook verification failed");
  }

  /** Inbound events (POST): verify signature, then parse messages. */
  async handleInbound(
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    if (!this.verifySignature(rawBody, headers)) {
      this.logger.warn("WhatsApp webhook signature invalid — ignoring");
      return;
    }
    let payload: WaWebhookPayload;
    try {
      payload = JSON.parse((rawBody ?? Buffer.from("{}")).toString("utf8")) as WaWebhookPayload;
    } catch {
      this.logger.warn("WhatsApp webhook body was not valid JSON");
      return;
    }

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;
        const phoneNumberId = value.metadata?.phone_number_id;
        // Profile name (if shared) — used to greet + prefill the customer name.
        const profileName = value.contacts?.[0]?.profile?.name;
        // Delivery/read receipts come through `statuses` — ignore for now.
        for (const msg of value.messages ?? []) {
          const from = msg.from;
          if (!phoneNumberId || !from) continue;

          // Flow completion (the native "customise item" form) — arrives as an
          // interactive nfm_reply carrying the submitted form values.
          const flowReply =
            msg.interactive?.type === "nfm_reply" ? msg.interactive.nfm_reply : undefined;
          if (flowReply?.response_json) {
            this.logger.log(`WhatsApp flow reply: from=${from} phoneNumberId=${phoneNumberId}`);
            try {
              await this.ai.handleFlowReply({
                phoneNumberId,
                from,
                responseJson: flowReply.response_json,
                profileName,
              });
            } catch (err: any) {
              this.logger.error(`WhatsApp flow-reply error for ${from}: ${err?.message ?? err}`);
            }
            continue;
          }

          const body = this.extractText(msg);
          this.logger.log(
            `WhatsApp inbound: from=${from} phoneNumberId=${phoneNumberId} type=${msg.type} text=${body ?? "—"}`,
          );
          if (!body) continue;

          // A referral verification, BEFORE the AI sees it. "VERIFY 7QK2" is
          // not an attempt to order anything, and letting the engine answer it
          // would have the shop try to sell a confused new customer a kebab.
          //
          // Free on both legs: inbound is never billed, and their message
          // opens the 24-hour window this reply goes out in.
          try {
            const reply = await this.referrals.verifyFromWhatsApp(body, from);
            if (reply) {
              await this.send.sendText(phoneNumberId, from, reply);
              continue;
            }
          } catch (err: any) {
            this.logger.error(
              `Referral verify failed for ${from}: ${err?.message ?? err}`,
            );
            // Falls through to the AI rather than leaving them on silence.
          }

          // Route into the AI conversation engine. Errors are swallowed so the
          // webhook still returns 200 (the engine sends its own error reply).
          try {
            await this.ai.handleMessage({ phoneNumberId, from, text: body, profileName });
          } catch (err: any) {
            this.logger.error(
              `WhatsApp engine error for ${from}: ${err?.message ?? err}`,
            );
          }
        }
      }
    }
  }

  /** Pull a usable string out of text / interactive / button message shapes. */
  private extractText(msg: WaMessage): string | null {
    if (msg.text?.body) return msg.text.body;
    if (msg.interactive?.list_reply) return msg.interactive.list_reply.id ?? msg.interactive.list_reply.title ?? null;
    if (msg.interactive?.button_reply)
      return msg.interactive.button_reply.id ?? msg.interactive.button_reply.title ?? null;
    if (msg.button?.text) return msg.button.text;
    return null;
  }

  /** Meta signs the payload with HMAC-SHA256(appSecret) in X-Hub-Signature-256. */
  private verifySignature(
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const appSecret = this.config.get<string>("WHATSAPP_APP_SECRET");
    if (!appSecret) {
      // Not configured yet (P1) — accept so the integration handshake works, but
      // warn. P6 makes this per-integration and required.
      this.logger.warn("WHATSAPP_APP_SECRET not set — skipping signature verification");
      return true;
    }
    if (!rawBody) return false;
    const header = headers["x-hub-signature-256"];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
      return false;
    }
  }
}

// ── Minimal Meta Cloud API webhook shapes (only what we read) ─────────────────
interface WaInteractiveReply {
  id?: string;
  title?: string;
}
interface WaMessage {
  from: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    list_reply?: WaInteractiveReply;
    button_reply?: WaInteractiveReply;
    nfm_reply?: { response_json?: string; name?: string };
  };
}
interface WaChangeValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: WaMessage[];
  statuses?: unknown[];
}
interface WaWebhookPayload {
  object?: string;
  entry?: Array<{ id?: string; changes?: Array<{ value?: WaChangeValue; field?: string }> }>;
}
