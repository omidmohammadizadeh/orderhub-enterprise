import type { CanonicalOrder } from "@orderhub/shared";

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: string;
}

// All platform adapters implement this interface.
// The adapter layer is the ONLY place that knows about platform-specific
// payload shapes, signature schemes, and idempotency key extraction.
export abstract class BaseWebhookAdapter {
  abstract readonly platform: string;

  // Verify the platform's request signature (HMAC, JWT, etc.)
  abstract verifySignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): WebhookVerificationResult;

  // Normalize raw platform payload → CanonicalOrder.
  // Returns null if the event type is not an order event (e.g. menu sync ping).
  abstract normalize(
    rawPayload: unknown,
    locationId: string,
  ): CanonicalOrder | null;

  // Extract a stable deduplication key for WebhookEvent idempotency.
  abstract extractEventId(
    rawPayload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): string;
}
