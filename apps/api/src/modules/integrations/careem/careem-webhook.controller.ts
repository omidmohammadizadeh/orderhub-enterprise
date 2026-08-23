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
import { CareemWebhookLogService } from "./careem-webhook-log.service";
import { CareemOrderService } from "./careem-order.service";

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
// The public path is /api/v1/webhooks/careem — main.ts sets a global "api"
// prefix, so the version alone is not the whole path. Careem's portal takes the
// full URL and the key together when the credential is generated.
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

  constructor(
    private readonly seen: CareemWebhookLogService,
    private readonly orders: CareemOrderService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Body() body: CareemNotification,
    @Headers("x-careem-api-key") apiKey?: string,
  ): Promise<{ received: true }> {
    const authenticated = verifyCareemApiKey(
      apiKey,
      process.env.CAREEM_WEBHOOK_API_KEY,
    );
    const eventType = body?.event_type;
    const orderId = body?.details?.id;

    // Recorded either way. The endpoint answers 200 on a bad key so a prober
    // learns nothing, which also robs the operator who just configured that key
    // of any way to tell it worked — this is how they find out.
    this.seen.record({
      at: new Date().toISOString(),
      eventType: eventType ?? null,
      orderId: orderId ?? null,
      status: body?.details?.status ?? null,
      authenticated,
      payloadPreview: JSON.stringify(body ?? {}).slice(0, 4000),
    });

    if (!authenticated) {
      this.logger.warn(
        `Careem webhook rejected: bad or missing x-careem-api-key ` +
          `(event=${eventType ?? "?"})`,
      );
      return { received: true };
    }

    this.logger.log(
      `Careem webhook ${eventType ?? "?"} order=${orderId ?? "-"} ` +
        `status=${body?.details?.status ?? "-"}`,
    );

    // Everything below is best-effort. Careem retries a failed webhook four
    // times, and a payload we cannot process will not process on the fifth
    // attempt either — so errors are logged and swallowed rather than turned
    // into a non-2xx that provokes retries we know are pointless.
    try {
      switch (eventType) {
        case "ORDER_CREATED":
          await this.orders.ingest(body.details as never);
          break;

        case "ORDER_STATUS_UPDATED":
          await this.orders.applyStatus(body.details as never);
          break;

        case "ORDER_ITEM_REPLACEMENT_ACCEPTED":
          // Shops only, per their docs, and it needs the merchant to propose a
          // replacement through Careem's own portal. Nothing to do for a
          // restaurant; logged so we notice if one ever arrives.
          this.logger.warn(
            `Careem item replacement on order ${orderId} — not handled for restaurants`,
          );
          break;

        // Their docs name this event twice and differently: the events table
        // says CATALOG_STATUS_UPDATED, the sequence diagram says
        // CATALOG_REQUEST_STATUS_UPDATED. Accept both rather than bet on one.
        case "CATALOG_STATUS_UPDATED":
        case "CATALOG_REQUEST_STATUS_UPDATED":
          // CA-3. The catalog push is not built yet, so this is recorded for
          // the diagnostics page rather than acted on.
          this.logger.log(
            `Careem catalog request ${(body.details as Record<string, unknown>)?.request_id} ` +
              `→ ${(body.details as Record<string, unknown>)?.status}`,
          );
          break;

        default:
          this.logger.warn(`Careem webhook with unknown event_type: ${eventType}`);
      }
    } catch (err) {
      this.logger.error(
        `Careem ${eventType} handling failed for order ${orderId}: ${(err as Error).message}`,
      );
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
    | "CATALOG_STATUS_UPDATED"
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
