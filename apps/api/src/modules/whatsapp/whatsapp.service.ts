import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { WhatsAppAiService } from "./whatsapp-ai.service";

// Phase AY — WhatsApp Cloud API webhook plumbing. Handles Meta's GET
// verification handshake, verifies + parses inbound POST events, and routes
// customer messages into the AI conversation engine (P2).
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly ai: WhatsAppAiService,
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
          const body = this.extractText(msg);
          this.logger.log(
            `WhatsApp inbound: from=${from} phoneNumberId=${phoneNumberId} type=${msg.type} text=${body ?? "—"}`,
          );
          if (!phoneNumberId || !from || !body) continue;
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
    list_reply?: WaInteractiveReply;
    button_reply?: WaInteractiveReply;
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
