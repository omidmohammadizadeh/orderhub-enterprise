// Phase BI — public Uber Direct webhook receiver.
//
// URL (one per location): POST /api/v1/webhooks/uber-direct/:locationId
// Auth: Uber signs the body — x-uber-signature = HMAC-SHA256(rawBody, signingKey)
// in hex. We verify against the location's stored signing key.

import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  RawBodyRequest,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { Public } from "../../../common/decorators/public.decorator";
import { BillingExempt } from "../../../common/guards/billing.guard";
import { UberDirectConfigService } from "./uber-direct-config.service";
import { UberDirectWebhookService } from "./uber-direct-webhook.service";

@ApiTags("webhooks")
@BillingExempt()
@Controller({ path: "webhooks/uber-direct", version: "1" })
export class UberDirectWebhookController {
  private readonly logger = new Logger(UberDirectWebhookController.name);

  constructor(
    private readonly config: UberDirectConfigService,
    private readonly webhook: UberDirectWebhookService,
  ) {}

  @Post(":locationId")
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 300 }, medium: { ttl: 60_000, limit: 300 } })
  @ApiOperation({ summary: "Receive an Uber Direct courier webhook" })
  async receive(
    @Param("locationId") locationId: string,
    @Headers("x-uber-signature") sigUber: string | undefined,
    @Headers("x-postmates-signature") sigPostmates: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const cfg = await this.config.getDecrypted(locationId);
    if (!cfg) {
      this.logger.warn(`Uber Direct webhook for unconfigured location ${locationId}`);
      return { received: true, reason: "not_configured" };
    }

    const raw = req.rawBody;
    const signature = sigUber || sigPostmates;
    if (cfg.signingKey) {
      if (!raw || !signature) {
        throw new UnauthorizedException("Missing Uber Direct webhook signature");
      }
      const expected = createHmac("sha256", cfg.signingKey)
        .update(raw)
        .digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new UnauthorizedException("Invalid Uber Direct webhook signature");
      }
    } else {
      this.logger.warn(
        `Uber Direct webhook for ${locationId} accepted without signature (no signing key saved)`,
      );
    }

    let body: any;
    try {
      body = raw ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      return { received: true, ignored: true, reason: "bad_json" };
    }

    try {
      const result = await this.webhook.handle(body);
      return { received: true, ...result };
    } catch (err: any) {
      this.logger.error(`Uber Direct webhook processing failed: ${err?.message ?? err}`);
      return { received: true, ignored: true, reason: err?.message };
    }
  }
}
