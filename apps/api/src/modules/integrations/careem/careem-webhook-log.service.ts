import { Injectable } from "@nestjs/common";

// A tiny ring buffer of the last few Careem notifications.
//
// It exists because the webhook endpoint deliberately answers 200 whether or
// not the key was accepted — telling a caller "wrong key" tells anyone probing
// that they found a live endpoint — which also means the operator who just
// configured the key has no way to tell it worked. This gives them one.
//
// Diagnostic only, and honest about it: in memory, capped, lost on restart,
// and per-instance. It is not an audit trail and must never become one; the
// moment order intake lands, that record is the Order row.
const CAPACITY = 25;

export interface CareemWebhookRecord {
  at: string;
  eventType: string | null;
  orderId: string | number | null;
  status: string | null;
  /** Whether x-careem-api-key matched. The whole point of the buffer. */
  authenticated: boolean;
  /** Trimmed. Enough to write a transformer from, not enough to fill a log. */
  payloadPreview: string;
}

@Injectable()
export class CareemWebhookLogService {
  private readonly buffer: CareemWebhookRecord[] = [];

  record(entry: CareemWebhookRecord): void {
    this.buffer.unshift(entry);
    if (this.buffer.length > CAPACITY) this.buffer.length = CAPACITY;
  }

  recent(limit = CAPACITY): CareemWebhookRecord[] {
    return this.buffer.slice(0, limit);
  }

  /** Has a correctly-keyed webhook ever arrived on this instance? The single
   *  fact an operator wants after saving the credential. */
  get everAuthenticated(): boolean {
    return this.buffer.some((e) => e.authenticated);
  }
}
