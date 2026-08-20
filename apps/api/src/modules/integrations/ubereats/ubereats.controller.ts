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
import { UberEatsMenuPublishService } from "./ubereats-menu-publish.service";
import { UberEatsClientService } from "./ubereats-client.service";
import {
  UberEatsOrderActionsService,
  type AdjustPriceReason,
} from "./ubereats-order-actions.service";
import { UberEatsPromotionsService } from "./ubereats-promotions.service";
import {
  UberEatsReportingService,
  type UberReportType,
} from "./ubereats-reporting.service";

// Phase UE-1/2 — operator-facing Uber Eats endpoints.
//
//   GET  /v1/integrations/ubereats/connect?brandId&locationId → authorize URL
//   GET  /v1/integrations/ubereats/oauth/callback              ← Uber redirect
//   POST /v1/integrations/ubereats/stores                      → store picker
//   POST /v1/integrations/ubereats/link-store                  → link chosen store
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
    private readonly orderActions: UberEatsOrderActionsService,
    private readonly promotions: UberEatsPromotionsService,
    private readonly reporting: UberEatsReportingService,
    private readonly menuPublish: UberEatsMenuPublishService,
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
    const build = (process.env.RENDER_GIT_COMMIT ?? "dev").slice(0, 7);
    if (!configured) {
      return { configured, redirectUriSet, build, tokenMint: "skipped (no credentials)" };
    }
    try {
      await this.client.getToken(["eats.store"]);
      // Which client-credentials scopes is the app ACTUALLY whitelisted for?
      // Uber silently drops unapproved scopes at mint time, so this is the
      // authoritative answer (e.g. pause/resume needs eats.store.status.write).
      const scopes = await this.client.probeScopes([
        "eats.store",
        "eats.store.status.write",
        "eats.order",
        "eats.store.orders.read",
        "eats.store.orders.write",
        "eats.store.orders.restaurantdelivery.status",
        "eats.store.promotion.write",
        "eats.store.promotion.read",
        "eats.report",
      ]);
      return { configured, redirectUriSet, build, tokenMint: "ok", scopes };
    } catch (err: any) {
      return {
        configured,
        redirectUriSet,
        build,
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
    // The Uber Eats connect UI lives in Locations → Brands (no standalone
    // integrations page). Land there; the Brands drawer reads these params.
    const back = this.dashboardUrl("/dashboard/locations");
    if (error) {
      back.searchParams.set("ubereats_error", error);
      return res.redirect(back.toString());
    }
    if (!code || !state) {
      back.searchParams.set("ubereats_error", "missing_code_or_state");
      return res.redirect(back.toString());
    }
    try {
      const { tenantId, brandId, locationId } = await this.oauth.handleCallback({
        code,
        state,
      });
      // Auto-connect the store the merchant just authorised (one → done;
      // several → land on the picker).
      const result = await this.connections.autoLinkAfterOauth(
        tenantId,
        brandId,
        locationId,
      );
      back.searchParams.set(
        "ubereats_connected",
        result.connected ? "1" : "pick",
      );
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

  @Post("link-store")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Connect a chosen Uber Eats store to this brand+location" })
  linkStore(
    @Body() body: { brandId: string; locationId: string; storeId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.linkStore(user.tenantId, body);
  }

  // ── Store API suite (certification checklist) ────────────────────────

  @Get("app-stores")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Get Stores — all stores this app is authorised against" })
  appStores(@Query("pageToken") pageToken?: string) {
    return this.connections.listAppStores(pageToken);
  }

  @Get(":connectionId/details")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Get Store Details from Uber Eats" })
  storeDetails(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.storeDetails(user.tenantId, connectionId);
  }

  @Post(":connectionId/update-info")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update Store Information (contact/location/pickup instructions)" })
  updateStoreInfo(
    @Param("connectionId") connectionId: string,
    @Body()
    body: {
      contact?: { email?: string; name?: string; phone_number?: string };
      location?: Record<string, string>;
      pickupInstructions?: string;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.updateStoreInfo(user.tenantId, connectionId, body);
  }

  @Post(":connectionId/fulfillment-config")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update Fulfillment Configuration (BYOC min ETD)" })
  updateFulfillmentConfig(
    @Param("connectionId") connectionId: string,
    @Body() body: { customMinEtdMinutes: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.updateFulfillmentConfig(
      user.tenantId,
      connectionId,
      body,
    );
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

  @Get(":connectionId/orders")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "List the store's active orders on Uber Eats (recovery)" })
  listOrders(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.listStoreOrders(user.tenantId, connectionId);
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

  @Post(":connectionId/publish-hours")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Push opening hours + prep time to Uber Eats (hours ride the menu's service_availability; prep via update-store-prep-time)",
  })
  async publishHours(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // 1) Prep time — dedicated Store API endpoint.
    const prep = await this.connections.publishPrepTime(
      user.tenantId,
      connectionId,
    );
    // 2) Hours — Uber has no store-hours endpoint; they're the menu's
    //    service_availability, so republish the store's menu with the
    //    location's current hours baked in.
    const { storeId } = await this.connections.storeIdFor(
      user.tenantId,
      connectionId,
    );
    const menu = storeId
      ? await this.menuPublish.pushHoursToStore(storeId)
      : { ok: false, reason: "no_store" };
    return { prep, menu };
  }

  @Get(":connectionId/holiday-hours")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Get the Uber Eats store's holiday hours" })
  getHolidayHours(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.getHolidayHours(user.tenantId, connectionId);
  }

  @Post(":connectionId/holiday-hours")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Set the Uber Eats store's holiday hours (overwrites the complete set)",
  })
  setHolidayHours(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    dto: {
      holidays: Array<{
        date: string;
        closed?: boolean;
        periods?: Array<{ start: string; end: string }>;
      }>;
    },
  ) {
    return this.connections.setHolidayHours(user.tenantId, connectionId, dto);
  }

  @Get(":connectionId/overview")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "HubRise-style status panel: store details + live status + integration details, with per-endpoint HTTP acknowledgments",
  })
  overview(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.overview(user.tenantId, connectionId);
  }

  @Post(":connectionId/reactivate")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Re-push POS integration data (re-registers order/scheduled/release/delivery webhooks) after Uber re-integrates the store",
  })
  reactivate(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.reactivate(user.tenantId, connectionId);
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

  // ── Promotions (Marketplace Promotions suite — certification checklist) ──
  // Creation/revoke run automatically from Marketing campaigns with the
  // UBER_EATS channel; these reads back the live state from Uber.

  @Get(":connectionId/promotions")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "List the store's live Uber Eats promotions" })
  listPromotions(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.promotions.listStorePromotions(user.tenantId, connectionId);
  }

  @Get("promotions/:promotionId")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Get one Uber Eats promotion" })
  getPromotion(@Param("promotionId") promotionId: string) {
    return this.promotions.getPromotion(promotionId);
  }

  // ── Reporting (Marketplace Reporting suite — certification checklist) ──

  @Post("reports")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Request an Uber Eats report (async; eats.report.success webhook delivers download URLs)" })
  createReport(
    @Body()
    body: {
      reportType: UberReportType;
      startDate: string;
      endDate: string;
      storeIds?: string[];
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reporting.createReport(user.tenantId, body);
  }

  @Get("reports")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "List requested Uber Eats reports with status + download links" })
  listReports(@CurrentUser() user: AuthenticatedUser) {
    return this.reporting.listReports(user.tenantId);
  }

  // ── Order actions (Order Fulfillment suite — certification checklist) ──

  @Post("order/:orderId/adjust-price")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Adjust an Uber Eats order's price (sold-out item etc.)" })
  adjustPrice(
    @Param("orderId") orderId: string,
    @Body()
    body: {
      amountPounds: number;
      taxRate?: number | string;
      reason: AdjustPriceReason;
      customReason?: string;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orderActions.adjustPrice(user.tenantId, orderId, body);
  }

  @Post(":connectionId/pos-data/patch")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "PATCH the store's Uber POS integration data" })
  patchPosData(
    @Param("connectionId") connectionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.patchPosData(user.tenantId, connectionId, body ?? {});
  }

  /**
   * Remove the POS integration from the Uber store (DELETE pos_data).
   *
   * Distinct from :connectionId/disconnect, which only unlinks our own row.
   * This tells Uber to deprovision, which is what makes the
   * store.deprovisioned webhook fire and lets the store be cleanly
   * re-activated afterwards.
   */
  @Post(":connectionId/deprovision")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Deprovision the Uber store from our integration" })
  deprovision(
    @Param("connectionId") connectionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.deprovision(user.tenantId, connectionId);
  }

  @Post("order/:orderId/ready-time")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update the ready-for-pickup time on Uber Eats" })
  updateReadyTime(
    @Param("orderId") orderId: string,
    @Body() body: { minutesFromNow?: number; readyAt?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orderActions.updateReadyTime(user.tenantId, orderId, body);
  }

  @Post("order/:orderId/validate-item-fulfillment")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Validate an item fulfillment issue with Uber Eats" })
  validateItemFulfillment(
    @Param("orderId") orderId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orderActions.validateItemFulfillment(
      user.tenantId,
      orderId,
      body,
    );
  }

  @Post("order/:orderId/resolve-fulfillment-issues")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resolve fulfillment issues on an Uber Eats order" })
  resolveFulfillmentIssues(
    @Param("orderId") orderId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orderActions.resolveFulfillmentIssues(
      user.tenantId,
      orderId,
      body,
    );
  }

  @Post("order/:orderId/replacement-recommendations")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Get replacement recommendations for a sold-out item" })
  replacementRecommendations(
    @Param("orderId") orderId: string,
    @Body() body: { itemId: string; storeId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orderActions.replacementRecommendations(
      user.tenantId,
      orderId,
      body,
    );
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
