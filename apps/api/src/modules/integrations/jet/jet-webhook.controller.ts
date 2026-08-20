import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { ApiTags } from "@nestjs/swagger";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { Public } from "../../../common/decorators/public.decorator";
import { JetClientService } from "./jet-client.service";
import { JetOrderService } from "./jet-order.service";
import { JetOrderAckService } from "./jet-order-ack.service";
import { jetOrderIdFrom } from "./jet-order.mappers";

// Phase JE-1 — JET Connect inbound order webhooks.
//
// Two endpoints, one shape:
//   POST /v1/integrations/jet/orders  → Receive Order (the order arrives)
//   POST /v1/integrations/jet/final   → Final Picked Order (post-amendment copy)
//
// Both answer **202**, not 200. Answering 200 requires the order to be fully
// written before we reply, which couples JET's timeout to our database
// latency; 202 puts the order in a pending state and hands us a 3-minute
// window to acknowledge properly. That is the flow their async contract is
// built around and the one the injection SLA is measured on. See
// JetOrderAckService for how the window is guaranteed.
//
// Ingest therefore runs AFTER the response, deliberately not awaited.
//
// ── Shape verification ──────────────────────────────────────────────────
// The full raw envelope is logged and persisted to WebhookEvent.rawPayload on
// every delivery, before anything tries to interpret it. The transformer was
// written from the spec's examples, and the spec has been wrong for every
// other integration we have built; the first real order is the verification
// step, and this is what makes it a five-minute check rather than a redeploy.
@ApiTags("jet")
@Controller({ path: "integrations/jet", version: "1" })
export class JetWebhookController {
  private readonly logger = new Logger(JetWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: JetClientService,
    private readonly orders: JetOrderService,
    private readonly ack: JetOrderAckService,
  ) {}

  @Public()
  @Post("orders")
  @HttpCode(HttpStatus.ACCEPTED)
  async receiveOrder(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-jet-connect-hash") hash: string,
    @Headers("authorization") authorization: string,
  ) {
    return this.handle(req, hash, authorization, "initial");
  }

  @Public()
  @Post("final")
  @HttpCode(HttpStatus.ACCEPTED)
  async receiveFinalPickedOrder(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-jet-connect-hash") hash: string,
    @Headers("authorization") authorization: string,
  ) {
    return this.handle(req, hash, authorization, "final");
  }

  private async handle(
    req: RawBodyRequest<Request>,
    hash: string | undefined,
    authorization: string | undefined,
    kind: "initial" | "final",
  ) {
    const raw: Buffer =
      req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

    let payload: any = {};
    let parseError: string | null = null;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch (e: any) {
      parseError = String(e?.message ?? e);
    }

    const jetOrderId = jetOrderIdFrom(payload);

    // ── Authenticate ──────────────────────────────────────────────────
    // Order webhooks carry both: the API key we issued JET (Authorization)
    // and an HMAC over the raw body (X-JET-Connect-Hash). Either being
    // configured-and-wrong is a rejection.
    const keyOk = this.client.verifyInboundApiKey(authorization);
    const hmacOk = this.client.webhookSecretConfigured
      ? this.client.verifyWebhookSignature(raw, hash)
      : true;

    if (!this.client.webhookSecretConfigured) {
      this.logger.warn(
        "JET webhook accepted WITHOUT signature verification — JET_WEBHOOK_SECRET is not set. " +
          "Set it before going live; any caller can post orders until you do.",
      );
    }

    // ── Persist the raw envelope, always ──────────────────────────────
    // Recorded before any judgement about validity, so a rejected or
    // unparseable delivery is still inspectable. create-catch-P2002 gives a
    // clean first-seen signal: JET retries reuse the order id.
    let firstSeen = false;
    if (jetOrderId) {
      try {
        await this.prisma.webhookEvent.create({
          data: {
            platform: "JUST_EAT",
            externalEventId: jetOrderId,
            signature: hash ?? null,
            rawPayload: payload,
            metadata: { kind, keyOk, hmacOk, ...(parseError ? { parseError } : {}) },
          },
        });
        firstSeen = true;
      } catch (e: any) {
        if (e?.code !== "P2002") {
          this.logger.warn(`JET webhook persist failed: ${e?.message}`);
        }
      }
    }

    // The whole envelope, once per order. This is the line that turns "the
    // docs said X" into "the wire says Y" — the single most expensive lesson
    // from HubRise and Deliveroo.
    this.logger.log(
      `JET ${kind} webhook envelope (order=${jetOrderId ?? "MISSING"} ` +
        `first=${firstSeen} keyOk=${keyOk} hmacOk=${hmacOk}): ${raw.toString("utf8").slice(0, 4000)}`,
    );

    if (parseError) {
      this.logger.error(`JET ${kind} webhook body was not valid JSON: ${parseError}`);
      return { OrderId: jetOrderId ?? "" };
    }

    if (!keyOk || !hmacOk) {
      // Diagnose rather than guess: a NAMED variant match proves the secret is
      // right and only the signing format is off; "no_match" proves the
      // deployed secret value is wrong. Logs HMAC prefixes only.
      if (!hmacOk) {
        const variant = this.client.diagnoseSignatureVariant(raw, hash);
        this.logger.error(
          `JET ${kind} webhook REJECTED: signature did not verify. variantMatch=${variant} ` +
            `(a named scheme ⇒ secret is correct, format needs fixing; "no_match" ⇒ wrong JET_WEBHOOK_SECRET). ` +
            `rawLen=${raw.length}`,
        );
      }
      if (!keyOk) {
        this.logger.error(
          `JET ${kind} webhook REJECTED: the Authorization header did not match JET_INBOUND_API_KEY.`,
        );
      }
      await this.markRejected(jetOrderId, keyOk, hmacOk);
      return { OrderId: jetOrderId ?? "" };
    }

    if (!jetOrderId) {
      this.logger.error(
        `JET ${kind} webhook has no order id (keys=${Object.keys(payload ?? {}).join(",")}) — cannot process or acknowledge`,
      );
      return { OrderId: "" };
    }

    // A redelivery. ingestCanonical is idempotent on [externalId, platform] so
    // reprocessing is harmless, but re-acking an order JET no longer considers
    // pending gets a 400 back, so a duplicate stops here.
    if (!firstSeen) {
      this.logger.log(
        `JET ${kind} webhook for ${jetOrderId} is a redelivery — already recorded, not reprocessing`,
      );
      return { OrderId: jetOrderId };
    }

    // We owe JET an acknowledgement from this moment. Recorded BEFORE the
    // response so that a crash immediately after leaves the watchdog something
    // to find.
    await this.ack.markPending({ jetOrderId });

    // Deliberately not awaited: the 202 goes back now and the order is
    // ingested behind it. ingestOrder acknowledges on every path, including
    // its own failures, so nothing is lost by returning first.
    void this.orders
      .ingestOrder(payload, { kind })
      .catch((err) =>
        this.logger.error(
          `JET ${kind} intake threw outside its own handling for ${jetOrderId}: ${err?.message}`,
        ),
      );

    return { OrderId: jetOrderId };
  }

  /** Note a rejected delivery on its recorded event, for the health probe. */
  private async markRejected(
    jetOrderId: string | null,
    keyOk: boolean,
    hmacOk: boolean,
  ): Promise<void> {
    if (!jetOrderId) return;
    await this.prisma.webhookEvent
      .update({
        where: {
          platform_externalEventId: {
            platform: "JUST_EAT",
            externalEventId: jetOrderId,
          },
        },
        data: {
          processingError: `rejected: keyOk=${keyOk} hmacOk=${hmacOk}`,
        },
      })
      .catch(() => {
        /* best-effort bookkeeping */
      });
  }
}
