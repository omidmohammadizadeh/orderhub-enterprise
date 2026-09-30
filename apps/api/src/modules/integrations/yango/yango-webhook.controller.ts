// Phase BK — public Yango callback receiver.
//
// URL: POST /api/v1/webhooks/yango/:webhookToken?updated_ts=…&claim_id=…
//
// Yango's callback is thin and untrusted by design:
//   • it is UNSIGNED (no HMAC, no auth header);
//   • it carries only claim_id + updated_ts, glued onto the URL we gave it
//     (which is why our URL ends in "?");
//   • Yango marks it deprecated in favour of polling.
//
// So nothing in the request is believed. It only tells us WHICH claim to re-read
// — from Yango, with the location's own token — and the poller would have found
// the same change within 15 seconds anyway. A forged callback can cause one
// extra claims/info call and nothing else; the token in the path just keeps
// strangers from making us do even that. Always 200: Yango retries non-200s,
// and a retry can't fix anything here.

import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { Public } from "../../../common/decorators/public.decorator";
import { BillingExempt } from "../../../common/guards/billing.guard";
import { YangoClientService } from "./yango-client.service";
import { YangoConfigService } from "./yango-config.service";
import { YangoTrackingService } from "./yango-tracking.service";

@ApiTags("webhooks")
@BillingExempt()
@Controller({ path: "webhooks/yango", version: "1" })
export class YangoWebhookController {
  private readonly logger = new Logger(YangoWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: YangoConfigService,
    private readonly client: YangoClientService,
    private readonly tracking: YangoTrackingService,
  ) {}

  @Post(":webhookToken")
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 600 }, medium: { ttl: 60_000, limit: 600 } })
  @ApiOperation({ summary: "Yango claim-changed nudge (re-reads the claim from Yango)" })
  async receive(
    @Param("webhookToken") webhookToken: string,
    @Query("claim_id") claimId: string | undefined,
  ) {
    const cfg = await this.config.findByWebhookToken(webhookToken);
    if (!cfg?.token) return { received: true, reason: "not_configured" };
    const id = String(claimId ?? "").trim();
    // Yango claim ids are 32–64 chars of hex-ish text; anything else is noise.
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return { received: true, reason: "no_claim_id" };

    // Only a claim this location dispatched, and only while we still hold it.
    const order = await (this.prisma as any).order.findFirst({
      where: { courierProvider: "YANGO", courierJobId: id, locationId: cfg.locationId },
    });
    if (!order) return { received: true, reason: "order_not_found" };

    try {
      const claim = await this.client.claimInfo(cfg, id);
      const res = await this.tracking.apply(order, claim, cfg);
      return { received: true, ...(res ?? {}) };
    } catch (err: any) {
      this.logger.warn(`Yango callback for claim ${id} failed: ${err?.message ?? err}`);
      return { received: true, ignored: true };
    }
  }
}
