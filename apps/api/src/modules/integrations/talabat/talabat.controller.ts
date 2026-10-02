import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { TalabatAuthError, TalabatClientService, publicApiOrigin } from "./talabat-client.service";
import { TalabatConnectionService } from "./talabat-connection.service";
import { TalabatMenuPublishService } from "./talabat-menu-publish.service";
import { TalabatOrderSyncService } from "./talabat-order-sync.service";
import { TalabatReportService } from "./talabat-report.service";
import { TalabatStoreService } from "./talabat-store.service";
import { TalabatWebhookLogService } from "./talabat-webhook-log.service";
import type { TalabatClosedReason } from "./talabat-types";

// Phase TB — Talabat management for the dashboard.
//
// Connection routes live under connections/:connectionId/… and order routes
// under orders/:orderId/…, so no :param route can swallow a literal one (the
// payments/:paymentId/refund lesson). Every route resolves its target against
// the caller's tenant before doing anything.

const MANAGERS = ["MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN"] as const;
const OWNERS = ["TENANT_OWNER", "PLATFORM_ADMIN"] as const;

@ApiTags("talabat")
@ApiBearerAuth()
@Controller({ path: "integrations/talabat", version: "1" })
export class TalabatController {
  constructor(
    private readonly client: TalabatClientService,
    private readonly connections: TalabatConnectionService,
    private readonly menus: TalabatMenuPublishService,
    private readonly store: TalabatStoreService,
    private readonly sync: TalabatOrderSyncService,
    private readonly reports: TalabatReportService,
    private readonly seen: TalabatWebhookLogService,
  ) {}

  // ── health ──

  @Get("diagnostics")
  @Roles(...OWNERS)
  @ApiOperation({ summary: "Talabat credentials, login check, plugin URL and recent middleware calls" })
  async diagnostics() {
    const out: Record<string, unknown> = {
      environment: this.client.env,
      sandbox: this.client.sandbox,
      ...(this.client.sandbox
        ? {
            sandboxWarning:
              "The sandbox is ON: the 'middleware' below is this server answering as Talabat. Nothing here says " +
              "whether Talabat accept our credentials — unset TALABAT_SANDBOX to find out.",
          }
        : {}),
      baseUrl: this.client.baseUrl,
      configured: this.client.configured(),
      missing: this.client.missingConfig(),
      usernameSet: !!process.env.TALABAT_USERNAME,
      passwordSet: !!process.env.TALABAT_PASSWORD,
      pluginSecretSet: !!process.env.TALABAT_PLUGIN_SECRET,
      pluginBaseUrl: `${publicApiOrigin()}/api/v1/talabat-plugin`,
      retryInSeconds: this.client.cooldownSeconds,
      middlewareEverVerified: this.seen.everVerified,
      recentCalls: this.seen.recent(10),
    };
    if (!this.client.configured()) {
      out.login = `not configured — missing ${this.client.missingConfig().join(", ")}`;
      return out;
    }
    try {
      const token = await this.client.accessToken();
      out.login = { ok: true, tokenLength: token.length };
    } catch (err) {
      out.login =
        err instanceof TalabatAuthError
          ? { ok: false, status: err.status, talabatSaid: err.body.slice(0, 800) }
          : { ok: false, error: (err as Error).message };
    }
    return out;
  }

  @Post("retry")
  @Roles(...OWNERS)
  @HttpCode(HttpStatus.OK)
  retry() {
    this.client.resetCooldown();
    return { ok: true };
  }

  @Get("plugin-calls")
  @Roles(...OWNERS)
  pluginCalls(@Query("limit") limit?: string) {
    return this.seen.recent(Math.min(50, Math.max(1, Number(limit) || 25)));
  }

  // ── connections ──

  @Get("connections")
  @Roles(...MANAGERS)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("brandId") brandId?: string,
    @Query("locationId") locationId?: string,
  ) {
    return this.connections.list(user.tenantId, { brandId, locationId });
  }

  @Post("connections")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Connect (or edit) a brand at a location to its Talabat vendor" })
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      brandId: string;
      locationId: string;
      remoteId?: string;
      chainCode?: string;
      platformVendorId?: string;
      globalEntityId?: string;
      platformKey?: string;
      defaultPrepMinutes?: number;
      defaultDeliveryMinutes?: number;
    },
  ) {
    return this.connections.connect(user.tenantId, body);
  }

  @Post("connections/:connectionId/disconnect")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  disconnect(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") id: string) {
    return this.connections.disconnect(user.tenantId, id);
  }

  @Get("activation-sheet")
  @Roles(...MANAGERS)
  @ApiOperation({ summary: "The integration + vendor details Talabat ask for at activation, filled in" })
  async activationSheet(@CurrentUser() user: AuthenticatedUser) {
    const rows = await this.connections.list(user.tenantId);
    const full = await Promise.all(rows.map((r) => this.connections.get(user.tenantId, r.id)));
    return this.connections.activationSheet(full.filter((c) => c.status !== "not_connected"));
  }

  // ── catalog ──

  @Get("connections/:connectionId/catalog/preview")
  @Roles(...MANAGERS)
  @ApiOperation({ summary: "Build the Talabat catalog without sending it — every refusal, named" })
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param("connectionId") id: string,
    @Query("menuId") menuId?: string,
  ) {
    return this.menus.dryRun(user.tenantId, id, menuId || undefined);
  }

  @Post("connections/:connectionId/catalog/publish")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param("connectionId") id: string,
    @Body() body: { menuId?: string },
  ) {
    return this.menus.publish(user.tenantId, id, body?.menuId || undefined);
  }

  @Get("connections/:connectionId/catalog/logs")
  @Roles(...MANAGERS)
  catalogLogs(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") id: string) {
    return this.menus.importLogs(user.tenantId, id);
  }

  /** The publish modal's entry point — by menu, like Glovo and Keeta. */
  @Post("menus/:menuId/publish")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  publishMenu(
    @CurrentUser() user: AuthenticatedUser,
    @Param("menuId") menuId: string,
    @Body() body: { locationId?: string; brandId?: string },
  ) {
    return this.menus.publishMenu({ tenantId: user.tenantId, menuId, ...body });
  }

  // ── store availability ──

  @Get("connections/:connectionId/availability")
  @Roles(...MANAGERS)
  async availability(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") id: string) {
    const c = await this.connections.get(user.tenantId, id);
    return { talabat: await this.store.getAvailability(c), lastPushed: (c.metadata as any)?.talabatAvailability ?? null };
  }

  @Post("connections/:connectionId/availability")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  async setAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param("connectionId") id: string,
    @Body() body: { open: boolean; minutes?: number; reason?: TalabatClosedReason },
  ) {
    const c = await this.connections.get(user.tenantId, id);
    return this.store.setAvailability(c, { open: !!body?.open, minutes: body?.minutes, reason: body?.reason });
  }

  // ── reconciliation + promotions ──

  @Post("connections/:connectionId/reconcile")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Compare Talabat's last 24h of orders with the board; optionally pull missed ones in" })
  async reconcile(
    @CurrentUser() user: AuthenticatedUser,
    @Param("connectionId") id: string,
    @Body() body: { hours?: number; importMissing?: boolean },
  ) {
    const c = await this.connections.get(user.tenantId, id);
    return this.reports.reconcile(c, body ?? {});
  }

  @Get("promotions")
  @Roles(...MANAGERS)
  @ApiOperation({ summary: "Talabat discounts by promotion and by who funded them" })
  promotions(
    @CurrentUser() user: AuthenticatedUser,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("locationId") locationId?: string,
    @Query("brandId") brandId?: string,
  ) {
    return this.reports.promotions(user.tenantId, { from, to, locationId, brandId });
  }

  // ── per-order actions ──

  @Post("orders/:orderId/prep-time")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Move the Talabat rider pickup time (AWT prep-time adjustment)" })
  prepTime(
    @CurrentUser() user: AuthenticatedUser,
    @Param("orderId") orderId: string,
    @Body() body: { minutes?: number; expectedPickupAt?: string },
  ) {
    return this.sync.adjustPrepTime(user.tenantId, orderId, body ?? {});
  }

  @Post("orders/:orderId/modify")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove or reduce out-of-stock lines on an accepted Talabat order" })
  modify(
    @CurrentUser() user: AuthenticatedUser,
    @Param("orderId") orderId: string,
    @Body() body: { changes: Array<{ productId: string; remove?: boolean; quantity?: number }> },
  ) {
    return this.sync.modifyProducts(user.tenantId, orderId, body?.changes ?? []);
  }

  @Post("orders/:orderId/resync")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Re-send whatever Talabat haven't heard about this order yet" })
  resync(@CurrentUser() user: AuthenticatedUser, @Param("orderId") orderId: string) {
    return this.sync.sync(orderId, user.tenantId);
  }
}
