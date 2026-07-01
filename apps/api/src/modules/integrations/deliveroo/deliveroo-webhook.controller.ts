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
import { DeliverooClientService } from "./deliveroo-client.service";
import { DeliverooOrderService } from "./deliveroo-order.service";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { Public } from "../../../common/decorators/public.decorator";

// Phase BA-3 — Deliveroo inbound webhook receiver.
//
// Deliveroo posts here for order + menu events. We ALWAYS return 200 (never
// error back to Deliveroo), verify the HMAC (X-Deliveroo-Hmac-Sha256 over
// `${sequenceGuid} ${rawBody}`, legacy new_order/cancel_order use ` \n `), and
// record the event idempotently. On the FIRST valid delivery of an event we
// route it (BA-3b): order.new → ingestCanonical, order.status_update →
// updateStatus, rider.status_update → courier columns. Routing is best-effort
// and fully swallowed — a handler failure never turns into a non-200.
@ApiTags("deliveroo")
@Controller({ path: "integrations/deliveroo", version: "1" })
export class DeliverooWebhookController {
  private readonly logger = new Logger(DeliverooWebhookController.name);

  constructor(
    private readonly client: DeliverooClientService,
    private readonly prisma: PrismaService,
    private readonly orderRouter: DeliverooOrderService,
  ) {}

  @Public()
  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-deliveroo-sequence-guid") sequenceGuid: string,
    @Headers("x-deliveroo-hmac-sha256") signature: string,
  ) {
    const raw: Buffer =
      req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

    let body: any = {};
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      /* keep {} */
    }
    const event: string = body?.event ?? body?.event_name ?? "unknown";
    const legacy = event === "new_order" || event === "cancel_order";

    // Try the expected separator first, then the other, so a mislabelled
    // legacy/standard event still verifies.
    const valid =
      this.client.verifyWebhookSignature(sequenceGuid, raw, signature, legacy) ||
      this.client.verifyWebhookSignature(sequenceGuid, raw, signature, !legacy);

    // Record the event. create-catch-P2002 gives us a clean "first time we've
    // seen this sequence guid" signal — Deliveroo retries reuse the same guid,
    // so a duplicate must NOT re-run the handler (ingest is idempotent anyway,
    // but rider timestamps + status echoes shouldn't be reprocessed).
    let firstSeen = false;
    if (sequenceGuid) {
      try {
        await this.prisma.webhookEvent.create({
          data: {
            platform: "DELIVEROO",
            externalEventId: sequenceGuid,
            signature: signature ?? null,
            rawPayload: body,
            metadata: { event, valid },
          },
        });
        firstSeen = true;
      } catch (e: any) {
        if (e?.code !== "P2002") {
          this.logger.warn(`Deliveroo webhook persist failed: ${e?.message}`);
        }
        // P2002 → duplicate delivery, already recorded. firstSeen stays false.
      }
    }

    this.logger.log(
      `Deliveroo webhook event=${event} valid=${valid} first=${firstSeen} seq=${sequenceGuid ?? "—"}`,
    );

    // Route the first valid delivery. Best-effort: any handler error is
    // swallowed + logged so Deliveroo still gets its 200 (and retries the
    // same guid, which we'll then treat as a duplicate — the underlying
    // ingest/updateStatus paths are themselves idempotent).
    if (valid && firstSeen) {
      try {
        const result = await this.orderRouter.route(event, body);
        await this.prisma.webhookEvent
          .update({
            where: {
              platform_externalEventId: {
                platform: "DELIVEROO",
                externalEventId: sequenceGuid,
              },
            },
            data: {
              orderId: result.orderId ?? null,
              processedAt: new Date(),
              metadata: { event, valid, ...result },
            },
          })
          .catch(() => {
            /* best-effort bookkeeping */
          });
      } catch (err: any) {
        this.logger.error(
          `Deliveroo webhook routing failed for ${event}/${sequenceGuid}: ${err?.message}`,
        );
        if (sequenceGuid) {
          await this.prisma.webhookEvent
            .update({
              where: {
                platform_externalEventId: {
                  platform: "DELIVEROO",
                  externalEventId: sequenceGuid,
                },
              },
              data: { processingError: String(err) },
            })
            .catch(() => {
              /* best-effort */
            });
        }
      }
    }

    return { ok: true };
  }
}
