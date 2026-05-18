import {
  Controller,
  Post,
  Param,
  Req,
  RawBodyRequest,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { WebhookIngestionService } from "./webhook-ingestion.service";

const PLATFORM_TO_INTEGRATION: Record<string, string> = {
  "uber-eats": "UBER_EATS",
  deliveroo: "DELIVEROO",
  "just-eat": "JUST_EAT",
  hubrise: "HUBRISE",
};

@ApiTags("webhooks")
@Controller({ path: "webhooks", version: "1" })
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly ingestion: WebhookIngestionService,
    private readonly prisma: PrismaService,
  ) {}

  // POST /api/v1/webhooks/:platform/:locationId
  // Public — signature verification is the auth mechanism.
  // Uses the "webhook" throttle tier: 300 req/min per IP, generous enough
  // for legitimate platform bursts but blocks flood attacks.
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

    // Resolve the integration to get the webhook secret and tenantId
    const integration = await this.prisma.integration.findFirst({
      where: {
        locationId,
        platform: platform as any,
        status: "ACTIVE",
      },
      include: { location: { include: { brand: { select: { tenantId: true } } } } },
    });

    if (!integration) {
      this.logger.warn(`No active integration for ${platform}/${locationId}`);
      // Return 200 to prevent platform retrying — we'll just discard
      return { received: true };
    }

    const credentials = integration.credentials as Record<string, string>;
    const secret: string = credentials.webhookSecret ?? credentials.secret ?? "";
    const tenantId: string = integration.location.brand.tenantId;

    const headers = req.headers as Record<string, string | string[] | undefined>;

    const result = await this.ingestion.ingest({
      platform,
      rawBody,
      headers,
      secret,
      tenantId,
      locationId,
    });

    this.logger.log(`Webhook processed: ${platform}/${locationId} → ${JSON.stringify(result)}`);
    return { received: true, ...result };
  }
}
