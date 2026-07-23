// Phase BH — public Stuart webhook receiver.
//
// URL (one per location): POST /api/v1/webhooks/stuart/:locationId
// Auth: Stuart is configured to send a custom header `X-OrderHub-Auth: <key>`;
// we reject anything whose key doesn't match the location's stored webhookAuthKey.

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../../../common/decorators/public.decorator";
import { BillingExempt } from "../../../common/guards/billing.guard";
import { StuartConfigService } from "./stuart-config.service";
import { StuartWebhookService } from "./stuart-webhook.service";

@ApiTags("webhooks")
@BillingExempt()
@Controller({ path: "webhooks/stuart", version: "1" })
export class StuartWebhookController {
  private readonly logger = new Logger(StuartWebhookController.name);

  constructor(
    private readonly config: StuartConfigService,
    private readonly webhook: StuartWebhookService,
  ) {}

  @Post(":locationId")
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 300 }, medium: { ttl: 60_000, limit: 300 } })
  @ApiOperation({ summary: "Receive a Stuart courier webhook" })
  async receive(
    @Param("locationId") locationId: string,
    @Headers("x-orderhub-auth") authKey: string | undefined,
    @Body() body: any,
  ) {
    const cfg = await this.config.getDecrypted(locationId);
    if (!cfg) {
      // Nothing configured — accept silently so Stuart stops retrying.
      this.logger.warn(`Stuart webhook for unconfigured location ${locationId}`);
      return { received: true, reason: "not_configured" };
    }
    if (!authKey || authKey !== cfg.webhookAuthKey) {
      throw new UnauthorizedException("Invalid Stuart webhook auth key");
    }
    try {
      const result = await this.webhook.handle(body);
      return { received: true, ...result };
    } catch (err: any) {
      this.logger.error(`Stuart webhook processing failed: ${err?.message ?? err}`);
      // 200 so Stuart doesn't hammer retries on a payload we can't use.
      return { received: true, ignored: true, reason: err?.message };
    }
  }
}
