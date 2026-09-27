import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { KeetaAuthService } from "./keeta-auth.service";
import { KeetaClientService } from "./keeta-client.service";
import { KeetaConnectionService } from "./keeta-connection.service";
import { KeetaMenuPublishService } from "./keeta-menu-publish.service";
import { KeetaOrderService } from "./keeta-order.service";
import { KeetaStoreService } from "./keeta-store.service";
import { KeetaWebhookLogService } from "./keeta-webhook-log.service";

// Phase KT — Keeta management for the dashboard.
//
// Connection routes live under connections/:connectionId/… so no :param route
// can swallow a literal one (the payments/:paymentId/refund lesson). Every
// authenticated route resolves its target against the caller's tenant.

/** Every event id we subscribe to. 1202 is missing from Keeta's own table. */
export const KEETA_EVENT_IDS = [1, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1101, 1102, 1201, 1202, 1301, 1302, 1303];

const MANAGERS = ["MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN"] as const;

@ApiTags("keeta")
@ApiBearerAuth()
@Controller({ path: "integrations/keeta", version: "1" })
export class KeetaController {
  constructor(
    private readonly config: ConfigService,
    private readonly client: KeetaClientService,
    private readonly auth: KeetaAuthService,
    private readonly connections: KeetaConnectionService,
    private readonly menus: KeetaMenuPublishService,
    private readonly store: KeetaStoreService,
    private readonly orders: KeetaOrderService,
    private readonly seen: KeetaWebhookLogService,
  ) {}

  // ── authorization ──

  @Post("authorize")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Start Keeta merchant authorization — returns the URL to open" })
  authorize(@Body() body: { brandId?: string; locationId?: string }, @CurrentUser() user: AuthenticatedUser) {
    return this.auth.start(user.tenantId, body ?? {});
  }

  @Get("authorizations")
  @Roles(...MANAGERS)
  authorizations(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.list(user.tenantId);
  }

  @Post("authorizations/:id/refresh-shops")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  async refreshShops(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const mine = (await this.auth.list(user.tenantId)).find((a) => a.id === id);
    if (!mine) return { shops: [] };
    return { shops: await this.auth.reloadShops(id) };
  }

  // ── connections ──

  @Post("connect")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Map an authorized Keeta store to a brand at a location" })
  connect(
    @Body() body: { brandId: string; locationId: string; authorizationId: string; shopId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connections.connect(user.tenantId, body);
  }

  @Get("connections")
  @Roles(...MANAGERS)
  list(@CurrentUser() user: AuthenticatedUser, @Query("brandId") brandId?: string) {
    return this.connections.list(user.tenantId, brandId);
  }

  @Get("connections/:connectionId/health")
  @Roles(...MANAGERS)
  health(@Param("connectionId") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.connections.health(user.tenantId, id);
  }

  @Post("connections/:connectionId/disconnect")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  disconnect(@Param("connectionId") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.connections.disconnect(user.tenantId, id);
  }

  @Post("connections/:connectionId/pause")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Suspend the Keeta store (delivery and pickup together — Keeta have no timed close)" })
  pause(@Param("connectionId") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.store.setOpen(user.tenantId, id, false);
  }

  @Post("connections/:connectionId/resume")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  resume(@Param("connectionId") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.store.setOpen(user.tenantId, id, true);
  }

  @Post("connections/:connectionId/publish-hours")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  publishHours(@Param("connectionId") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.store.publishHours(user.tenantId, id);
  }

  @Get("connections/:connectionId/store")
  @Roles(...MANAGERS)
  storeDetails(@Param("connectionId") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.store.details(user.tenantId, id);
  }

  // ── menus ──

  @Post("menus/:menuId/publish")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Publish a menu to the brand's Keeta store (full replace; async — result on webhook 1202)" })
  publish(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: { locationId?: string },
  ) {
    return this.menus.publishMenu({ tenantId: user.tenantId, menuId, locationId: body?.locationId });
  }

  @Get("menus/:menuId/dry-run")
  @Roles(...MANAGERS)
  dryRun(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.menus.dryRun({ tenantId: user.tenantId, menuId, locationId });
  }

  // ── orders ──

  @Post("orders/pull")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Fetch a Keeta order we never received by webhook and add it to the board" })
  pull(@Body() body: { orderViewId: string; shopId: string }, @CurrentUser() user: AuthenticatedUser) {
    return this.orders.pull(user.tenantId, String(body.orderViewId), String(body.shopId));
  }

  @Post("orders/:orderId/refund/agree")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  agreeRefund(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.orders.answerRefund(user.tenantId, orderId, "agree");
  }

  @Post("orders/:orderId/refund/reject")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  rejectRefund(
    @Param("orderId") orderId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { rejectCode?: number; rejectReason?: string },
  ) {
    return this.orders.answerRefund(user.tenantId, orderId, "reject", body ?? {});
  }

  // ── platform setup ──

  /**
   * Point every Keeta event at our webhook, on the Test or Formal store set
   * (KEETA_ENV). Signed by the app alone. The Dev Portal's "Edit application"
   * screen does the same by hand.
   */
  @Post("register-webhooks")
  @Roles("PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  async registerWebhooks() {
    const api = String(this.config.get<string>("app.apiUrl") ?? "").replace(/\/+$/, "");
    const url = (process.env.KEETA_WEBHOOK_URL ?? "").trim() || `${api}/api/v1/integrations/keeta/webhook`;
    const isTest = this.client.env !== "production";
    const results: Array<{ eventId: number; ok: boolean; error?: string }> = [];
    for (const eventId of KEETA_EVENT_IDS) {
      try {
        await this.client.setCallbackUrl(eventId, url, isTest);
        results.push({ eventId, ok: true });
      } catch (e: any) {
        results.push({ eventId, ok: false, error: String(e?.message ?? e) });
      }
    }
    return { url, storeSet: isTest ? "Test Store" : "Formal Store", results };
  }

  @Get("diagnostics")
  @Roles("PLATFORM_ADMIN")
  diagnostics() {
    const api = String(this.config.get<string>("app.apiUrl") ?? "").replace(/\/+$/, "");
    return {
      configured: this.client.configured,
      appId: this.client.appId || null,
      environment: this.client.env,
      apiBase: this.client.baseUrl,
      webhookUrl: (process.env.KEETA_WEBHOOK_URL ?? "").trim() || `${api}/api/v1/integrations/keeta/webhook`,
      oauthRedirectUri: this.client.oauthRedirectUri || null,
      webhookSigMode: process.env.KEETA_WEBHOOK_SIG_MODE === "enforce" ? "enforce" : "observe",
      matchedSigVariant: this.seen.matchedVariant(),
      recentWebhooks: this.seen.recent(),
    };
  }

  /** Deployment probe — presence only, never a value. */
  @Public()
  @Get("health")
  probe() {
    return {
      configured: this.client.configured,
      environment: this.client.env,
      apiBase: this.client.baseUrl,
      redirectConfigured: !!this.client.oauthRedirectUri,
      build: process.env.RENDER_GIT_COMMIT ?? null,
    };
  }
}
