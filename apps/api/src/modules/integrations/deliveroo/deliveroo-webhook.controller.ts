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
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { Public } from "../../../common/decorators/public.decorator";

// Phase BA-3a — Deliveroo inbound webhook receiver (connectivity + signature).
//
// Deliveroo posts here for order + menu events. We ALWAYS return 200 (never
// error back to Deliveroo), verify the HMAC (X-Deliveroo-Hmac-Sha256 over
// `${sequenceGuid} ${rawBody}`, legacy new_order/cancel_order use ` \n `), and
// record the event idempotently. Order creation + status/rider mapping land in
// Phase 3b (routing order.new → OrdersService.ingestCanonical, etc.).
@ApiTags("deliveroo")
@Controller({ path: "integrations/deliveroo", version: "1" })
export class DeliverooWebhookController {
  private readonly logger = new Logger(DeliverooWebhookController.name);

  constructor(
    private readonly client: DeliverooClientService,
    private readonly prisma: PrismaService,
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

    if (sequenceGuid) {
      await this.prisma.webhookEvent
        .upsert({
          where: {
            platform_externalEventId: {
              platform: "DELIVEROO",
              externalEventId: sequenceGuid,
            },
          },
          create: {
            platform: "DELIVEROO",
            externalEventId: sequenceGuid,
            signature: signature ?? null,
            rawPayload: body,
            metadata: { event, valid },
          },
          update: {},
        })
        .catch((e) =>
          this.logger.warn(`Deliveroo webhook persist failed: ${e?.message}`),
        );
    }

    this.logger.log(
      `Deliveroo webhook event=${event} valid=${valid} seq=${sequenceGuid ?? "—"}`,
    );

    // Phase 3b: if (valid) route order.new → ingestCanonical, status_update →
    // updateStatus, riders.update_status → courier columns, menu.upload_result
    // → surface to the UI.
    return { ok: true };
  }
}
