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
  Controller,
  Get,
  Query,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { HubRiseOauthService } from "./hubrise-oauth.service";

@ApiTags("hubrise")
@Controller({ path: "integrations/hubrise", version: "1" })
export class HubRiseOauthController {
  constructor(
    private readonly oauth: HubRiseOauthService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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
}
