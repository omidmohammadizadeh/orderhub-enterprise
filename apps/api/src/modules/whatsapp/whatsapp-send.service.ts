import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

// Phase AY (P2) — outbound WhatsApp Cloud API (Graph). Sends plain text and
// interactive messages (reply buttons + list pickers). Access token comes from
// WHATSAPP_ACCESS_TOKEN env for now; P6 moves it into per-location
// Integration.credentials. We send to the same phoneNumberId the inbound
// message arrived on, so multi-location works without extra config.

const GRAPH_VERSION = "v21.0";

export interface WaReplyButton {
  id: string;
  title: string; // max 20 chars
}

export interface WaListRow {
  id: string;
  title: string; // max 24 chars
  description?: string; // max 72 chars
}

export interface WaListSection {
  title?: string;
  rows: WaListRow[];
}

@Injectable()
export class WhatsAppSendService {
  private readonly logger = new Logger(WhatsAppSendService.name);

  constructor(private readonly config: ConfigService) {}

  private get token(): string | undefined {
    return this.config.get<string>("WHATSAPP_ACCESS_TOKEN");
  }

  /** Send a plain text reply. */
  async sendText(phoneNumberId: string, to: string, body: string): Promise<void> {
    await this.post(phoneNumberId, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: truncate(body, 4096) },
    });
  }

  /** Up to 3 reply buttons under a body of text. */
  async sendButtons(
    phoneNumberId: string,
    to: string,
    body: string,
    buttons: WaReplyButton[],
  ): Promise<void> {
    const trimmed = buttons.slice(0, 3).map((b) => ({
      type: "reply",
      reply: { id: truncate(b.id, 256), title: truncate(b.title, 20) },
    }));
    await this.post(phoneNumberId, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: truncate(body, 1024) },
        action: { buttons: trimmed },
      },
    });
  }

  /** A tappable list picker (e.g. menu categories / items). */
  async sendList(
    phoneNumberId: string,
    to: string,
    body: string,
    buttonLabel: string,
    sections: WaListSection[],
    header?: string,
  ): Promise<void> {
    // WhatsApp caps lists at 10 rows total across all sections.
    let budget = 10;
    const cappedSections = sections
      .map((s) => {
        const rows = s.rows.slice(0, Math.max(0, budget)).map((r) => ({
          id: truncate(r.id, 200),
          title: truncate(r.title, 24),
          ...(r.description ? { description: truncate(r.description, 72) } : {}),
        }));
        budget -= rows.length;
        return { ...(s.title ? { title: truncate(s.title, 24) } : {}), rows };
      })
      .filter((s) => s.rows.length > 0);

    await this.post(phoneNumberId, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        ...(header ? { header: { type: "text", text: truncate(header, 60) } } : {}),
        body: { text: truncate(body, 1024) },
        action: { button: truncate(buttonLabel, 20), sections: cappedSections },
      },
    });
  }

  private async post(phoneNumberId: string, payload: unknown): Promise<void> {
    const token = this.token;
    if (!token) {
      this.logger.warn("WHATSAPP_ACCESS_TOKEN not set — cannot send reply");
      return;
    }
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
    try {
      await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      });
    } catch (err: any) {
      // Never throw — the webhook must still return 200. Log Meta's error body.
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(
        `WhatsApp send failed (phoneNumberId=${phoneNumberId}): ${JSON.stringify(detail)}`,
      );
    }
  }
}

function truncate(s: string, max: number): string {
  if (!s) return s;
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
