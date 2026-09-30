import { Injectable } from "@nestjs/common";

// The last few Keeta webhooks, in memory, for the diagnostics card.
//
// Two questions only a live delivery can answer are recorded here: whether
// Keeta's webhook `sig` matched any of our candidate recipes (and which), and
// whether the sender was on Keeta's published IP list. Both are needed before
// KEETA_WEBHOOK_SIG_MODE can be switched to "enforce".

export interface KeetaWebhookSeen {
  at: string;
  eventId: number | null;
  messageId: string | null;
  shopId: string | null;
  orderViewId: string | null;
  sigOk: boolean;
  sigVariant: string | null;
  sourceIp: string | null;
  ipListed: boolean;
  handled: string;
  preview: string;
}

const MAX = 50;

@Injectable()
export class KeetaWebhookLogService {
  private readonly rows: KeetaWebhookSeen[] = [];
  private lastMatchedVariant: string | null = null;

  record(row: KeetaWebhookSeen): void {
    this.rows.unshift(row);
    if (this.rows.length > MAX) this.rows.length = MAX;
    if (row.sigOk && row.sigVariant) this.lastMatchedVariant = row.sigVariant;
  }

  recent(): KeetaWebhookSeen[] {
    return [...this.rows];
  }

  matchedVariant(): string | null {
    return this.lastMatchedVariant;
  }
}

/** Keeta's published webhook source IPs (Webhook guide, "IP whitelist"). */
export const KEETA_WEBHOOK_IPS = new Set([
  "43.135.86.188",
  "43.135.94.192",
  "101.32.221.146",
  "43.128.27.185",
  "101.32.216.180",
  "119.28.140.253",
  "162.62.123.227",
  "162.62.219.133",
  "162.62.55.69",
  "162.62.61.26",
  "43.131.16.79",
  "43.131.30.39",
  "43.131.52.67",
  "43.131.55.51",
  "43.157.1.126",
  "43.157.104.104",
  "43.157.33.44",
  "43.157.64.52",
  "43.158.90.31",
  "43.158.90.65",
  "49.51.164.88",
  "49.51.172.32",
]);
