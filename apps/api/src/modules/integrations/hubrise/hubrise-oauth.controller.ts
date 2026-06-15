// Phase AU — HubRise OAuth2 entry + callback endpoints.
//
//   GET /v1/integrations/hubrise/connect?locationId=...
//     — JWT-authed; builds the HubRise authorize URL with a signed
//       state param and returns it. Web sends operator there.
//
//   GET /v1/integrations/hubrise/callback?code=...&state=...
//     — public (HubRise hits it after consent); exchanges the code,
//       registers the per-location webhook, persists everything,
//       then 302-redirects the operator back into the dashboard.

import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import { BillingExempt } from "../../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { WebhookIngestionService } from "../../webhooks/webhook-ingestion.service";
import { HubRiseOauthService } from "./hubrise-oauth.service";

@ApiTags("hubrise")
@Controller({ path: "integrations/hubrise", version: "1" })
export class HubRiseOauthController {
  private readonly logger = new Logger(HubRiseOauthController.name);

  constructor(
    private readonly oauth: HubRiseOauthService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ingestion: WebhookIngestionService,
  ) {}

  @Get("connect")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the HubRise authorize URL for a location" })
  async connect(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
  ) {
    // Verify the operator actually has access to this location before
    // we mint a state token that grants the OAuth flow rights to it.
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId: user.tenantId } },
      select: { id: true },
    });
    if (!loc) throw new UnauthorizedException("Location not in your tenant");

    return {
      authorizeUrl: this.oauth.buildAuthorizeUrl({
        tenantId: user.tenantId,
        userId: user.userId,
        locationId,
      }),
    };
  }

  @Public()
  @Get("callback")
  @ApiOperation({ summary: "HubRise OAuth redirect lands here" })
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const appUrl = this.config.get<string>("app.appUrl") ?? "/";
    // If HubRise itself rejected the consent (operator cancelled,
    // app suspended, etc.), bounce back to the dashboard with the
    // reason in the query string so the UI can show it.
    if (error) {
      const back = new URL(`${appUrl}/dashboard/locations`);
      back.searchParams.set("hubrise_error", error);
      if (errorDescription)
        back.searchParams.set("hubrise_error_description", errorDescription);
      return res.redirect(back.toString());
    }
    if (!code || !state) {
      const back = new URL(`${appUrl}/dashboard/locations`);
      back.searchParams.set(
        "hubrise_error",
        "missing_code_or_state",
      );
      return res.redirect(back.toString());
    }

    try {
      const { locationId } = await this.oauth.handleCallback({ code, state });
      const back = new URL(`${appUrl}/dashboard/locations`);
      back.searchParams.set("hubrise_connected", locationId);
      return res.redirect(back.toString());
    } catch (err: any) {
      const back = new URL(`${appUrl}/dashboard/locations`);
      back.searchParams.set("hubrise_error", "callback_failed");
      back.searchParams.set(
        "hubrise_error_description",
        err?.message ?? "Unknown error",
      );
      return res.redirect(back.toString());
    }
  }

  // ── Global webhook receiver ────────────────────────────────────────
  //
  // HubRise sends EVERY order/catalog event to a single URL registered
  // in the partner app. The payload carries `location_id` (HubRise's
  // id), which we resolve to our internal Location via the
  // `hubriseLocationId` column. From there the event flows through the
  // same WebhookIngestionService chain as the per-location URLs.
  //
  // Two paths land on the same logic so we don't have to ask the
  // operator to re-register a URL they've already pasted into HubRise:
  //
  //   POST /v1/integrations/hubrise/webhook   ← preferred
  //   POST /v1/integrations/hubrise/callback  ← backward compat
  //
  // The GET version of /callback (just above) is the OAuth redirect
  // landing — completely separate flow.

  @Public()
  @BillingExempt()
  @Post(["webhook", "callback"])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "HubRise global webhook receiver" })
  async receiveWebhook(@Req() req: RawBodyRequest<Request>) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException(
        "Raw body unavailable — webhook bridge misconfigured",
      );
    }

    // Parse only enough to figure out which Location this belongs to.
    // The full payload goes through the existing ingestion path which
    // re-parses internally; we let it do the canonical work so a
    // single bug here can't desync the two interpretations.
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Webhook body is not valid JSON");
    }
    const hubriseLocationId: string | undefined =
      parsed?.location_id ?? parsed?.resource?.location_id;
    if (!hubriseLocationId) {
      this.logger.warn(
        "HubRise webhook arrived without a location_id field — ignoring",
      );
      // 200 so HubRise stops retrying. Any non-2xx triggers their
      // exponential-backoff retry queue, which would just keep
      // pinging this same bad payload.
      return { received: true, reason: "no_location_id" };
    }

    const location = await this.prisma.location.findFirst({
      where: { hubriseLocationId, deletedAt: null },
      select: { id: true },
    });
    if (!location) {
      this.logger.warn(
        `HubRise webhook for hubriseLocationId=${hubriseLocationId} but no Location is connected — ignoring`,
      );
      // Same as above: 200 to stop retries. If the operator connects
      // later, they can replay from HubRise's webhook log.
      return { received: true, reason: "location_not_connected" };
    }

    try {
      const result = await this.ingestion.ingest({
        platform: "HUBRISE",
        locationId: location.id,
        rawBody,
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      this.logger.log(
        `HubRise webhook → location ${location.id} → ${JSON.stringify(result)}`,
      );
      return { received: true, ...result };
    } catch (err: any) {
      this.logger.error(
        `HubRise webhook ingestion failed: ${err?.message}`,
      );
      // Rethrow only for genuine 5xx; auth/signature failures already
      // bubble up as 401/403 with a meaningful body so HubRise's log
      // tab tells the operator what went wrong.
      throw err;
    }
  }
}
