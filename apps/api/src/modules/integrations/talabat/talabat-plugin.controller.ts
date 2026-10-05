import { Body, Controller, Get, Headers, HttpCode, Logger, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { Public } from "../../../common/decorators/public.decorator";
import { BillingExempt } from "../../../common/guards/billing.guard";
import { TalabatClientService } from "./talabat-client.service";
import { TalabatConnectionService } from "./talabat-connection.service";
import { verifyTalabatJwt } from "./talabat-jwt";
import { TalabatMenuPublishService } from "./talabat-menu-publish.service";
import { TalabatOrderService } from "./talabat-order.service";
import { TalabatStoreService } from "./talabat-store.service";
import { TalabatWebhookLogService, type TalabatPluginCall } from "./talabat-webhook-log.service";
import type {
  TalabatCatalogCallback,
  TalabatOrder,
  TalabatOrderStatusUpdate,
  TalabatVendorAvailabilityUpdate,
} from "./talabat-types";

// Phase TB-1 — the POS Plugin API: what Delivery Hero's middleware calls on us.
//
// Our plugin BASE URL (given to Talabat at activation) is
//
//   {API}/api/v1/talabat-plugin
//
// and the middleware appends the spec's paths to it:
//
//   POST /order/{remoteId}                                           new order
//   PUT  /remoteId/{remoteId}/remoteOrder/{remoteOrderId}/posOrderStatus
//                                     cancelled, picked up, rider arrived,
//                                     rider waiting, modification result
//   PUT  /remoteId/{remoteId}/availability                 vendor open/closed
//   GET  /menuimport/{remoteId}?vendorCode&menuImportId    "send us your menu"
//   POST /catalog-callback/{connectionId}      our catalog import's progress
//                                              (the callbackUrl WE supply)
//
// ── Auth ────────────────────────────────────────────────────────────────────
//
// Every call carries a JWT signed with the secret issued with our credentials,
// with `service: middleware` (talabat-jwt.ts). A bad or missing token is a
// 401 — one of the codes their contract lists, and not one they retry — so a
// forged order never reaches a kitchen. Unlike Careem's always-200, there is
// nothing to hide: the middleware already knows this endpoint exists.
//
// ── Response codes ──────────────────────────────────────────────────────────
//
// The middleware treats anything outside [200, 201, 202, 400, 401, 429, 450,
// 500, 502] as unexpected, retries on 429/5xx, and reads the order ack body
// for remoteResponse.remoteOrderId. Every handler here answers inside that set.

@ApiExcludeController()
@BillingExempt() // order intake is never gated by our own billing status
@Controller({ path: "talabat-plugin", version: "1" })
export class TalabatPluginController {
  private readonly logger = new Logger(TalabatPluginController.name);

  constructor(
    private readonly client: TalabatClientService,
    private readonly connections: TalabatConnectionService,
    private readonly orders: TalabatOrderService,
    private readonly store: TalabatStoreService,
    private readonly menu: TalabatMenuPublishService,
    private readonly seen: TalabatWebhookLogService,
  ) {}

  /** Verify, record, and answer 401 on failure. Returns true when verified. */
  private auth(
    endpoint: TalabatPluginCall["endpoint"],
    authorization: string | undefined,
    req: Request,
    res: Response,
    ctx: { remoteId?: string | null; ref?: string | null },
  ): boolean {
    const v = verifyTalabatJwt(authorization, this.client.pluginSecret ?? undefined);
    if (v.ok) return true;
    this.logger.error(
      `Talabat ${endpoint} REJECTED: JWT ${v.reason} (remoteId=${ctx.remoteId ?? "-"} ip=${req.ip ?? "?"})`,
    );
    this.seen.record({
      at: new Date().toISOString(),
      endpoint,
      remoteId: ctx.remoteId ?? null,
      ref: ctx.ref ?? null,
      jwt: v.reason,
      httpStatus: 401,
      outcome: v.reason === "no_secret" ? "TALABAT_PLUGIN_SECRET is not set" : "rejected",
      preview: JSON.stringify(req.body ?? {}).slice(0, 2000),
    });
    res.status(401);
    return false;
  }

  private note(row: Omit<TalabatPluginCall, "at" | "jwt">) {
    this.seen.record({ ...row, at: new Date().toISOString(), jwt: "ok" });
  }

  @Public()
  @Post("order/:remoteId")
  @HttpCode(200)
  async dispatch(
    @Param("remoteId") remoteId: string,
    @Body() body: TalabatOrder,
    @Headers("authorization") authorization: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.auth("order", authorization, req, res, { remoteId, ref: body?.token ?? null })) {
      return { reason: "UNAUTHORIZED" };
    }
    const result = await this.orders.dispatch(remoteId, body);
    this.note({
      endpoint: "order",
      remoteId,
      ref: body?.token ?? null,
      httpStatus: result.httpStatus,
      outcome: result.orderId ? `order ${result.orderId}` : String(result.body?.message ?? "refused"),
      preview: JSON.stringify(body ?? {}).slice(0, 4000),
    });
    res.status(result.httpStatus);
    return result.body;
  }

  @Public()
  @Put("remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus")
  @HttpCode(200)
  async orderStatus(
    @Param("remoteId") remoteId: string,
    @Param("remoteOrderId") remoteOrderId: string,
    @Body() body: TalabatOrderStatusUpdate,
    @Headers("authorization") authorization: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.auth("status", authorization, req, res, { remoteId, ref: remoteOrderId })) return {};
    let result: { httpStatus: number; handled: boolean; reason?: string };
    try {
      result = await this.orders.applyStatus(remoteId, remoteOrderId, body);
    } catch (err: any) {
      this.logger.error(`Talabat posOrderStatus ${body?.status} for ${remoteOrderId} failed: ${err?.message}`);
      result = { httpStatus: 500, handled: false, reason: "internal_error" };
    }
    this.note({
      endpoint: "status",
      remoteId,
      ref: remoteOrderId,
      httpStatus: result.httpStatus,
      outcome: `${body?.status ?? "?"} → ${result.handled ? "applied" : result.reason}`,
      preview: JSON.stringify(body ?? {}).slice(0, 2000),
    });
    res.status(result.httpStatus);
    return {};
  }

  @Public()
  @Put("remoteId/:remoteId/availability")
  @HttpCode(200)
  async availability(
    @Param("remoteId") remoteId: string,
    @Body() body: TalabatVendorAvailabilityUpdate,
    @Headers("authorization") authorization: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.auth("availability", authorization, req, res, { remoteId })) return {};
    const conn = await this.connections.byRemoteId(remoteId);
    if (!conn) {
      this.note({ endpoint: "availability", remoteId, ref: null, httpStatus: 404, outcome: "unknown vendor", preview: JSON.stringify(body ?? {}).slice(0, 2000) });
      res.status(404);
      return {};
    }
    // "acknowledge receipt immediately and handle any internal state updates
    // asynchronously" — so the write isn't awaited.
    void this.store.onVendorAvailability(conn, body).catch((e) => this.logger.warn(`Talabat availability apply failed: ${e?.message}`));
    this.note({ endpoint: "availability", remoteId, ref: body?.timestamp ?? null, httpStatus: 200, outcome: `${body?.closures?.length ?? 0} closure(s)`, preview: JSON.stringify(body ?? {}).slice(0, 2000) });
    return {};
  }

  @Public()
  @Get("menuimport/:remoteId")
  @HttpCode(202)
  async menuImport(
    @Param("remoteId") remoteId: string,
    @Query("vendorCode") vendorCode: string | undefined,
    @Query("menuImportId") menuImportId: string | undefined,
    @Headers("authorization") authorization: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.auth("menuimport", authorization, req, res, { remoteId, ref: menuImportId ?? null })) return;
    const conn = await this.connections.byRemoteId(remoteId);
    if (!conn) {
      res.status(404);
      return;
    }
    // "A synchronous 202 response code should be sent with no response body,
    // then the menu should be submitted". We answer with the Catalog Import
    // API — the one new integrations are required to use — rather than the
    // deprecated XML endpoint the trigger was designed around.
    void this.menu
      .publish(conn.tenantId, conn.id)
      .catch((e) => this.logger.error(`Talabat-triggered menu import for ${remoteId} failed: ${e?.message}`));
    this.note({
      endpoint: "menuimport",
      remoteId,
      ref: menuImportId ?? null,
      httpStatus: 202,
      outcome: `catalog publish started${vendorCode ? ` (vendor ${vendorCode})` : ""}`,
      preview: "",
    });
  }

  @Public()
  @Post("catalog-callback/:connectionId")
  @HttpCode(200)
  async catalogCallback(
    @Param("connectionId") connectionId: string,
    @Body() body: TalabatCatalogCallback,
    @Headers("authorization") authorization: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.auth("catalog-callback", authorization, req, res, { ref: body?.catalogImportId ?? null })) return;
    const known = await this.menu.onCatalogCallback(connectionId, body);
    this.note({
      endpoint: "catalog-callback",
      remoteId: null,
      ref: body?.catalogImportId ?? null,
      httpStatus: known ? 200 : 204,
      outcome: `${body?.status ?? "?"}${known ? "" : " (unknown connection — stop sending)"}`,
      preview: JSON.stringify(body ?? {}).slice(0, 2000),
    });
    // 204 = "stop listening for further updates" in their contract.
    if (!known) res.status(204);
  }
}
