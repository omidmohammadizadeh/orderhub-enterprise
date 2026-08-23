import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { timingSafeEqual } from "crypto";
import { Public } from "../../../common/decorators/public.decorator";
import { BillingExempt } from "../../../common/guards/billing.guard";

// Phase CA-1 — Careem's inbound notifications.
//
// Four event types arrive on ONE endpoint, distinguished by `event_type`:
//
//   ORDER_CREATED                    a customer placed an order
//   ORDER_STATUS_UPDATED             it advanced (accepted → driver_coming →
//                                    driver_here → trip_started → trip_ended,
//                                    or cancelled)
//   ORDER_ITEM_REPLACEMENT_ACCEPTED  the customer accepted a substitution
//   CATALOG_REQUEST_STATUS_UPDATED   an async catalog upload finished
//
// ── Authentication ──────────────────────────────────────────────────────────
//
// There is no signature. Careem's spec carries no HMAC of any kind; every
// webhook operation declares `security: []`, and authentication is a STATIC
// shared secret in `x-careem-api-key`. That proves the sender knows the key
// and says nothing about the body, so:
//
//   • the compare is constant-time, because a static secret checked with ===
//     leaks its prefix to anyone willing to time the responses;
//   • order handling must be idempotent on Careem's order id, because a
//     replayed body is indistinguishable from a fresh one — an HMAC over the
//     body wouldn't fix replay either, but here there is nothing else at all.
//
// ── Always 200 ──────────────────────────────────────────────────────────────
//
// Except for a failed key check. A body we can't parse or an order we can't
// match will not parse or match on the retry either, so it is logged and
// dropped rather than retried for ever. A REJECTED KEY still returns 200 as
// well: a 401 tells someone probing that they found a live endpoint with the
// wrong key, and Careem's own retries would hammer us while a
// misconfiguration is being fixed.
@ApiExcludeController()
@BillingExempt() // order intake is never gated by our own billing status
@Controller({ path: "webhooks/careem", version: "1" })
export class CareemWebhookController {
  private readonly logger = new Logger(CareemWebhookController.name);

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Body() body: CareemNotification,
    @Headers("x-careem-api-key") apiKey?: string,
  ): Promise<{ received: true }> {
    if (!verifyCareemApiKey(apiKey, process.env.CAREEM_WEBHOOK_API_KEY)) {
      this.logger.warn(
        `Careem webhook rejected: bad or missing x-careem-api-key ` +
          `(event=${body?.event_type ?? "?"})`,
      );
      return { received: true };
    }

    const eventType = body?.event_type;
    const orderId = body?.details?.id;
    this.logger.log(
      `Careem webhook ${eventType ?? "?"} order=${orderId ?? "-"} ` +
        `status=${body?.details?.status ?? "-"}`,
    );

    switch (eventType) {
      case "ORDER_CREATED":
      case "ORDER_STATUS_UPDATED":
      case "ORDER_ITEM_REPLACEMENT_ACCEPTED":
      case "CATALOG_REQUEST_STATUS_UPDATED":
        // CA-2 onward. Landing them as logged no-ops rather than 404ing means
        // Careem can point staging at us today and we can read real payloads
        // out of the logs — which is the only way the transformer gets built
        // from real shapes instead of from the spec's examples.
        this.logger.debug(
          `Careem ${eventType} payload: ${JSON.stringify(body).slice(0, 2000)}`,
        );
        break;
      default:
        this.logger.warn(`Careem webhook with unknown event_type: ${eventType}`);
    }

    return { received: true };
  }
}

/** The envelope every Careem notification shares. `details` is the order for
 *  the three order events and the catalog request for the fourth. */
export interface CareemNotification {
  event_type?:
    | "ORDER_CREATED"
    | "ORDER_STATUS_UPDATED"
    | "ORDER_ITEM_REPLACEMENT_ACCEPTED"
    | "CATALOG_REQUEST_STATUS_UPDATED"
    | string;
  details?: {
    /** Careem's order id is a NUMBER in their payloads, not a string. */
    id?: number | string;
    status?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Constant-time compare of the static webhook key.
 *
 * Exported and pure so the rejection cases are testable without HTTP. Returns
 * false — never throws — for a missing header, a missing configured key, or a
 * length mismatch: timingSafeEqual throws on unequal lengths, and an exception
 * on a public endpoint anyone can post to is a denial-of-service waiting to
 * happen.
 */
export function verifyCareemApiKey(
  received: string | undefined,
  expected: string | undefined,
): boolean {
  const a = Buffer.from((received ?? "").trim(), "utf8");
  const b = Buffer.from((expected ?? "").trim(), "utf8");
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
