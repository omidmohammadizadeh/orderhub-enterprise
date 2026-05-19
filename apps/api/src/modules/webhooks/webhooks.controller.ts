import {
  Controller,
  Post,
  Param,
  Req,
  RawBodyRequest,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import { WebhookIngestionService } from "./webhook-ingestion.service";

const PLATFORM_TO_INTEGRATION: Record<string, string> = {
  "uber-eats": "UBER_EATS",
  deliveroo: "DELIVEROO",
  "just-eat": "JUST_EAT",
  hubrise: "HUBRISE",
};

@ApiTags("webhooks")
@BillingExempt() // Provider webhooks must always be accepted regardless of billing state
@Controller({ path: "webhooks", version: "1" })
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly ingestion: WebhookIngestionService) {}

  // POST /api/v1/webhooks/:platform/:locationId
  // Public — signature verification is the auth mechanism.
  @Post(":platform/:locationId")
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ webhook: { ttl: 60000, limit: 300 } })
  @ApiOperation({ summary: "Receive platform webhook" })
  async receive(
    @Param("platform") platformSlug: string,
    @Param("locationId") locationId: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const platform = PLATFORM_TO_INTEGRATION[platformSlug.toLowerCase()];
    if (!platform) {
      throw new BadRequestException(`Unknown platform: ${platformSlug}`);
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException("Raw body unavailable — check NestJS rawBody config");
    }

    const headers = req.headers as Record<string, string | string[] | undefined>;

    try {
      const result = await this.ingestion.ingest({ platform, locationId, rawBody, headers });
      this.logger.log(`Webhook processed: ${platform}/${locationId} → ${JSON.stringify(result)}`);
      return { received: true, ...result };
    } catch (err) {
      if (err instanceof NotFoundException) {
        // No active integration — return 200 so the platform stops retrying
        this.logger.warn(`No active integration for ${platform}/${locationId} — discarding`);
        return { received: true };
      }
      throw err;
    }
  }
}
