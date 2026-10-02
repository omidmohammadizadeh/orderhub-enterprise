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

/**
 * The route below is pinned to exactly these slugs, and that constraint is
 * load-bearing rather than cosmetic.
 *
 * `webhooks/:platform/:locationId` matches ANY two segments under /webhooks,
 * which includes every dedicated receiver we have — webhooks/jet-go/:token,
 * webhooks/stuart/:locationId, webhooks/uber-direct/:locationId,
 * webhooks/yango/…, webhooks/careem/…, webhooks/stripe/…. Express hands a
 * request to the first route registered that matches, and HubRiseModule imports
 * WebhooksModule, so this controller registers early and swallowed all of them:
 * a real JET Go courier webhook came back "400 Unknown platform: jet-go" while
 * the dedicated handler sat unused.
 *
 * Ordering the modules differently would have fixed it until the next module
 * imported WebhooksModule. Naming the four slugs in the path means anything
 * else simply doesn't match here and falls through to its own controller, no
 * matter what order modules load in.
 */
const PLATFORM_SLUG_PATTERN = Object.keys(PLATFORM_TO_INTEGRATION).join("|");

@ApiTags("webhooks")
@BillingExempt() // Provider webhooks must always be accepted regardless of billing state
@Controller({ path: "webhooks", version: "1" })
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly ingestion: WebhookIngestionService) {}

  // POST /api/v1/webhooks/:platform/:locationId
  // Public — signature verification is the auth mechanism.
  @Post(`:platform(${PLATFORM_SLUG_PATTERN})/:locationId`)
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60_000, limit: 300 }, medium: { ttl: 60_000, limit: 300 } })
  @ApiOperation({ summary: "Receive platform webhook" })
  async receive(
    @Param("platform") platformSlug: string,
    @Param("locationId") locationId: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const platform = PLATFORM_TO_INTEGRATION[platformSlug.toLowerCase()];
    if (!platform) {
      // Unreachable while the path pattern above is in place — kept so that
      // loosening the route can never silently start accepting anything.
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
