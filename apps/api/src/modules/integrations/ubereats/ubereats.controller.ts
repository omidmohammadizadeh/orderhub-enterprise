import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { UberEatsOauthService } from "./ubereats-oauth.service";
import { UberEatsConnectionService } from "./ubereats-connection.service";
import { UberEatsClientService } from "./ubereats-client.service";

// Phase UE-1/2 — operator-facing Uber Eats endpoints.
//
//   GET  /v1/integrations/ubereats/connect?brandId&locationId → authorize URL
//   GET  /v1/integrations/ubereats/oauth/callback              ← Uber redirect
//   POST /v1/integrations/ubereats/stores                      → store picker
//   POST /v1/integrations/ubereats/provision                   → pos_data
//   GET  /v1/integrations/ubereats/connection?brandId&locationId
//   GET/POST status / pause / resume / publish-prep per connection
@ApiTags("ubereats")
@Controller({ path: "integrations/ubereats", version: "1" })
export class UberEatsController {
  constructor(
    private readonly oauth: UberEatsOauthService,
    private readonly connections: UberEatsConnectionService,
    private readonly config: ConfigService,
    private readonly client: UberEatsClientService,
  ) {}

  // Public config/connectivity probe — booleans + a live token-mint check
  // (safe: tokens are cached per scope-set, so repeated hits can't burn
  // Uber's 100/hr mint limit; no secrets are ever echoed).
  @Public()
  @Get("health")
  @ApiOperation({ summary: "Uber Eats integration config + token-mint check" })
  async health() {
    const configured = this.client.configured;
    const redirectUriSet = !!this.oauth.redirectUri;
    if (!configured) {
      return { configured, redirectUriSet, tokenMint: "skipped (no credentials)" };
    }
    try {
      await this.client.getToken(["eats.store"]);
      return { configured, redirectUriSet, tokenMint: "ok" };
    } catch (err: any) {
      return {
        configured,
        redirectUriSet,
        tokenMint: `failed: ${String(err?.message ?? err).slice(0, 200)}`,
      };
    }
  }

  @Get("connect")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Get the Uber Eats authorize URL for a brand+location" })
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Query("brandId") brandId: string,
    @Query("locationId") locationId: string,
  ) {
    return {
      authorizeUrl: this.oauth.buildAuthorizeUrl({
        tenantId: user.tenantId,
        userId: user.userId,
        brandId,
        locationId,
      }),
    };
  }

  @Public()
  @Get("oauth/callback")
  @ApiOperation({ summary: "Uber Eats OAuth redirect lands here" })
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string | undefined,
    @Res() res: Response,
  ) {
    const back = this.dashboardUrl("/dashboard/integrations");
    if (error) {
      back.searchParams.set("ubereats_error", error);
      return res.redirect(back.toString());
    }
    if (!code || !state) {
      back.searchParams.set("ubereats_error", "missing_code_or_state");
      return res.redirect(back.toString());
    }
    try {
      const { brandId, locationId } = await this.oauth.handleCallback({
        code,
        state,
      });
      back.searchParams.set("ubereats_connected", "1");
      back.searchParams.set("brandId", brandId);
      back.searchParams.set("locationId", locationId);
      return res.redirect(back.toString());
    } catch (err: any) {
      back.searchParams.set("ubereats_error", "callback_failed");
      back.searchParams.set(
        "ubereats_error_description",
        err?.message ?? "Unknown error",
      );
      return res.redirect(back.toString());
    }
  }

  /**
   * APP_URL in production may be scheme-less ("www.example.com") — bare
   * `new URL(appUrl + path)` throws Invalid URL and turned the OAuth landing
   * into a 500 (same latent bug existed in the HubRise callback). Normalise
   * the scheme and fall back to the public site if it's still unparseable.
   */
  private dashboardUrl(path: string): URL {
    let base = (this.config.get<string>("app.appUrl") ?? "").trim();
    if (base && !/^https?:\/\//i.test(base)) base = `https://${base}`;
    try {
      const u = new URL(`${base.replace(/\/$/, "")}${path}`);
      // "orderhub-web" (a bare Render service name) parses but isn't a real
      // public host — no dot means the operator would land on a dead URL.
      if (!u.hostname.includes(".")) throw new Error("not a public host");
      return u;
    } catch {
      return new URL(`https://www.orderhubsolutions.com${path}`);
    }
  }

  @Post("stores")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List the authorised merchant's Uber Eats stores" })
  stores(
    @Body() body: { brandId: string; locationId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.listMerchantStores(
      user.tenantId,
      body.brandId,
      body.locationId,
    );
  }

  @Post("provision")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Activate the integration on a chosen Uber Eats store" })
  provision(
    @Body() body: { brandId: string; locationId: string; storeId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.provision(user.tenantId, body);
  }

  @Get("connection")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Read the Uber Eats connection for a brand+location" })
  connection(
    @CurrentUser() user: AuthenticatedUser,
    @Query("brandId") brandId: string,
    @Query("locationId") locationId: string,
  ) {
    return this.connections.get(user.tenantId, brandId, locationId);
  }

  @Post(":connectionId/disconnect")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disconnect an Uber Eats store" })
  disconnect(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.disconnect(user.tenantId, connectionId);
  }

  @Get(":connectionId/status")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Get the Uber Eats store ONLINE/OFFLINE status" })
  status(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.storeStatus(user.tenantId, connectionId);
  }

  @Post(":connectionId/pause")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Pause the Uber Eats store (OFFLINE)" })
  pause(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.setStoreOnline(
      user.tenantId,
      connectionId,
      false,
      "PAUSED_BY_RESTAURANT",
    );
  }

  @Post(":connectionId/resume")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resume the Uber Eats store (ONLINE)" })
  resume(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.setStoreOnline(user.tenantId, connectionId, true);
  }

  @Post(":connectionId/publish-prep")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Push the location's prep time to Uber Eats" })
  publishPrep(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.publishPrepTime(user.tenantId, connectionId);
  }
}
