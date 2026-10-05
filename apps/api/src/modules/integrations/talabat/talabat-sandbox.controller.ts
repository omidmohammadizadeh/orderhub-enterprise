import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
import { randomUUID } from "crypto";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { TalabatConnectionService, talabatSettings } from "./talabat-connection.service";
import { TalabatMenuPublishService } from "./talabat-menu-publish.service";
import { TalabatSandboxService } from "./talabat-sandbox.service";

// Phase TB-7 — the sandbox's two faces.
//
//   /api/v1/talabat-sandbox/middleware/…  Delivery Hero's middleware, as our
//        client sees it (TALABAT_API_BASE resolves here when the sandbox is
//        on). Public, because our client authenticates with the sandbox's own
//        bearer token, as it would with theirs.
//
//   /api/v1/talabat-sandbox/…             operator buttons: place a sandbox
//        order, have "Talabat" cancel it / send the rider / warn the rider is
//        waiting / close the vendor / ask for the menu — all of which arrive
//        on our REAL plugin endpoints, JWT-signed.
//
// Everything 404s unless TALABAT_SANDBOX=true and TALABAT_ENV isn't production.

const MANAGERS = ["MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN"] as const;
const TOKENS = new Set<string>();

@ApiExcludeController()
@Controller({ path: "talabat-sandbox", version: "1" })
export class TalabatSandboxController {
  constructor(
    private readonly sandbox: TalabatSandboxService,
    private readonly connections: TalabatConnectionService,
    private readonly menus: TalabatMenuPublishService,
  ) {}

  private assertEnabled() {
    if (!this.sandbox.enabled) throw new NotFoundException();
  }

  private bearer(auth?: string) {
    const t = String(auth ?? "").replace(/^Bearer\s+/i, "");
    if (!TOKENS.has(t)) throw new BadRequestException({ code: "POS_ERROR", message: "Unauthorized" });
  }

  private reply(res: Response, method: string, path: string, out: { status: number; body: unknown }, note: string, body?: unknown) {
    this.sandbox.record({ method, path, status: out.status, note, body });
    res.status(out.status);
    return out.body ?? undefined;
  }

  // ════ The fake middleware ══════════════════════════════════════════════

  @Public()
  @Post("middleware/v2/login")
  @HttpCode(200)
  login(@Body() body: any) {
    this.assertEnabled();
    if (body?.grant_type !== "client_credentials" || !body?.username || !body?.password) {
      this.sandbox.record({ method: "POST", path: "/v2/login", status: 400, note: "grant_type/username/password missing" });
      throw new BadRequestException({ code: "INVALID_REQUEST", message: "username, password and grant_type=client_credentials are required" });
    }
    const token = `sandbox-${randomUUID()}`;
    TOKENS.add(token);
    this.sandbox.record({ method: "POST", path: "/v2/login", status: 200, note: `token for ${body.username}` });
    return { access_token: token, token_type: "bearer", expires_in: 1800 };
  }

  @Public()
  @Post("middleware/v2/order/status/:token")
  orderStatus(@Param("token") token: string, @Body() body: any, @Headers("authorization") auth: string, @Res({ passthrough: true }) res: Response) {
    this.assertEnabled();
    this.bearer(auth);
    const out = this.sandbox.orderStatus(token, body);
    return this.reply(res, "POST", `/v2/order/status/${token}`, out, String(body?.status ?? "?"), body);
  }

  @Public()
  @Post("middleware/v2/orders/:token/preparation-completed")
  prepared(@Param("token") token: string, @Headers("authorization") auth: string, @Res({ passthrough: true }) res: Response) {
    this.assertEnabled();
    this.bearer(auth);
    return this.reply(res, "POST", `/v2/orders/${token}/preparation-completed`, this.sandbox.prepared(token), "food ready");
  }

  @Public()
  @Post("middleware/v2/orders/:token/adjust-preparation-time")
  adjustPrep(@Param("token") token: string, @Body() body: any, @Headers("authorization") auth: string, @Res({ passthrough: true }) res: Response) {
    this.assertEnabled();
    this.bearer(auth);
    return this.reply(res, "POST", `/v2/orders/${token}/adjust-preparation-time`, this.sandbox.adjustPrep(token, body), "prep time", body);
  }

  @Public()
  @Post("middleware/v2/order/:token/modifications/product")
  modify(@Param("token") token: string, @Body() body: any, @Headers("authorization") auth: string, @Res({ passthrough: true }) res: Response) {
    this.assertEnabled();
    this.bearer(auth);
    const out = this.sandbox.modify(token, body);
    // The result arrives later, on our plugin — as theirs does.
    if (out.then) setTimeout(() => void out.then!().catch(() => undefined), 1500).unref?.();
    return this.reply(res, "POST", `/v2/order/${token}/modifications/product`, out, "product modification", body);
  }

  @Public()
  @Put("middleware/v2/chains/:chain/catalog")
  catalog(@Param("chain") chain: string, @Body() body: any, @Headers("authorization") auth: string, @Res({ passthrough: true }) res: Response) {
    this.assertEnabled();
    this.bearer(auth);
    const quick = !body?.catalog?.items ? ["catalog.items is required"] : [];
    if (quick.length) return this.reply(res, "PUT", `/v2/chains/${chain}/catalog`, { status: 400, body: { message: quick[0] } }, "rejected");
    const id = randomUUID();
    const errors = this.sandbox.validateCatalog(body);
    const productCount = Object.values(body.catalog.items).filter((i: any) => i.type === "Product").length;
    this.sandbox.catalogs.unshift({ id, chainCode: chain, vendors: body.vendors ?? [], status: "in_progress", at: new Date().toISOString(), errors, productCount });
    // Async, like theirs: progress then outcome on the callbackUrl we gave.
    if (body.callbackUrl) {
      setTimeout(() => {
        const entry = this.sandbox.catalogs.find((c) => c.id === id);
        if (entry) entry.status = errors.length ? "failed" : "done";
        const path = new URL(body.callbackUrl).pathname.replace(/^\/api\/v1\/talabat-plugin/, "");
        void this.sandbox
          .callPlugin("POST", path, {
            catalogImportId: id,
            status: errors.length ? "failed" : "done",
            message: errors.length ? errors.slice(0, 5).join("; ") : "Catalog imported",
            details: (body.vendors ?? []).map((v: string) => ({
              status: errors.length ? "failed" : "done",
              posVendorId: v,
              platformVendorId: `tb-${v}`,
              globalEntityId: "TB_AE",
            })),
          })
          .catch(() => undefined);
      }, 2000).unref?.();
    }
    return this.reply(res, "PUT", `/v2/chains/${chain}/catalog`, { status: 202, body: { status: "submitted", catalogImportId: id } }, `${productCount} products, ${errors.length} problem(s)`);
  }

  @Public()
  @Get("middleware/v2/chains/:chain/vendors/:vendor/menu-import-logs")
  importLogs(@Param("chain") chain: string, @Param("vendor") vendor: string, @Headers("authorization") auth: string) {
    this.assertEnabled();
    this.bearer(auth);
    return this.sandbox.catalogs.filter((c) => c.chainCode === chain && c.vendors.includes(vendor));
  }

  @Public()
  @Put("middleware/v2/chains/:chain/vendors/:vendor/catalog/items/availability")
  itemAvailability(@Param("vendor") vendor: string, @Body() body: any, @Headers("authorization") auth: string, @Res({ passthrough: true }) res: Response) {
    this.assertEnabled();
    this.bearer(auth);
    const bad =
      !Array.isArray(body?.items) || !body.items.length
        ? "items must be a non-empty list"
        : !["ITEM", "TOPPING"].includes(body?.type)
          ? "type must be ITEM or TOPPING"
          : typeof body?.isAvailable !== "boolean"
            ? "isAvailable is required"
            : body?.willBeAvailable === "AT_TIMESTAMP" && !body?.atTimeStamp
              ? "atTimeStamp is required with AT_TIMESTAMP"
              : body?.isAvailable && body?.willBeAvailable
                ? "willBeAvailable must be omitted when isAvailable is true"
                : null;
    if (bad) return this.reply(res, "PUT", `/…/${vendor}/catalog/items/availability`, { status: 400, body: { message: bad } }, bad, body);
    this.sandbox.itemAvailability.unshift({ at: new Date().toISOString(), vendor, type: body.type, items: body.items, isAvailable: body.isAvailable, until: body.atTimeStamp });
    return this.reply(res, "PUT", `/…/${vendor}/catalog/items/availability`, { status: 204, body: null }, `${body.type} ×${body.items.length} → ${body.isAvailable ? "available" : "unavailable"}`, body);
  }

  @Public()
  @Get("middleware/v2/chains/:chain/remoteVendors/:vendor/availability")
  async getAvailability(@Param("vendor") vendor: string, @Headers("authorization") auth: string) {
    this.assertEnabled();
    this.bearer(auth);
    this.sandbox.record({ method: "GET", path: `/…/remoteVendors/${vendor}/availability`, status: 200, note: "availability" });
    return this.sandbox.vendorAvailability(vendor, await this.platformIdFor(vendor));
  }

  @Public()
  @Put("middleware/v2/chains/:chain/remoteVendors/:vendor/availability")
  async putAvailability(@Param("vendor") vendor: string, @Body() body: any, @Headers("authorization") auth: string, @Res({ passthrough: true }) res: Response) {
    this.assertEnabled();
    this.bearer(auth);
    const out = this.sandbox.setVendorAvailability(vendor, body, await this.platformIdFor(vendor));
    return this.reply(res, "PUT", `/…/remoteVendors/${vendor}/availability`, out, String(body?.availabilityState ?? "?"), body);
  }

  @Public()
  @Get("middleware/v2/chains/:chain/orders/ids")
  orderIds(@Query("status") status: string, @Headers("authorization") auth: string) {
    this.assertEnabled();
    this.bearer(auth);
    const want = status === "cancelled" ? ["CANCELLED", "REJECTED"] : ["ACCEPTED", "PREPARED", "PICKED_UP"];
    const ids = [...this.sandbox.orders.values()].filter((o) => want.includes(o.state)).map((o) => String(o.order.token));
    return { orderIdentifiers: ids, count: ids.length };
  }

  @Public()
  @Get("middleware/v2/chains/:chain/orders/:orderId")
  orderDetail(@Param("orderId") orderId: string, @Headers("authorization") auth: string) {
    this.assertEnabled();
    this.bearer(auth);
    const o = this.sandbox.orders.get(orderId);
    if (!o) throw new NotFoundException();
    return { order: { ...o.order, status: ["CANCELLED", "REJECTED"].includes(o.state) ? "cancelled" : "accepted" } };
  }

  private async platformIdFor(remoteId: string): Promise<string> {
    const c = await this.connections.byRemoteId(remoteId);
    return String((c && talabatSettings(c).platformVendorId) || `tb-${remoteId}`);
  }

  // ════ Operator buttons ═════════════════════════════════════════════════

  @Get("status")
  @Roles(...MANAGERS)
  status() {
    return {
      enabled: this.sandbox.enabled,
      orders: [...this.sandbox.orders.values()].map((o) => ({
        token: o.order.token,
        remoteId: o.remoteId,
        remoteOrderId: o.remoteOrderId,
        state: o.state,
        riderAccepted: o.riderAccepted,
        history: o.history,
      })),
      catalogs: this.sandbox.catalogs.slice(0, 10),
      itemAvailability: this.sandbox.itemAvailability.slice(0, 20),
      vendorAvailability: Object.fromEntries(this.sandbox.availability),
    };
  }

  @Get("calls")
  @Roles(...MANAGERS)
  calls(@Query("limit") limit?: string) {
    this.assertEnabled();
    return this.sandbox.recent(Math.min(200, Math.max(1, Number(limit) || 50)));
  }

  @Post("reset")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  reset() {
    this.assertEnabled();
    this.sandbox.reset();
    return { ok: true };
  }

  /** Place an order the way Talabat would, onto our real plugin endpoint. */
  @Post("connections/:connectionId/simulate-order")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  async simulateOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param("connectionId") id: string,
    @Body() body: { kind?: "OWN_DELIVERY" | "VENDOR_DELIVERY" | "PICKUP"; test?: boolean; withDiscount?: boolean; itemCount?: number },
  ) {
    this.assertEnabled();
    const c = await this.connections.get(user.tenantId, id);
    const preview = await this.menus.dryRun(user.tenantId, c.id);
    if (!preview.catalog) {
      throw new BadRequestException(`The menu can't be published to Talabat yet: ${preview.problems.filter((p) => p.level === "error").slice(0, 3).map((p) => p.message).join(" · ")}`);
    }
    const s = talabatSettings(c);
    const order = this.sandbox.buildOrder({
      catalog: preview.catalog,
      remoteId: c.externalStoreId!,
      chainCode: s.chainCode ?? "sandbox-chain",
      platformVendorId: s.platformVendorId ?? `tb-${c.externalStoreId}`,
      kind: body?.kind ?? "OWN_DELIVERY",
      test: body?.test,
      withDiscount: body?.withDiscount,
      itemCount: body?.itemCount,
    });
    this.sandbox.orders.set(String(order.token), {
      order,
      remoteId: c.externalStoreId!,
      chainCode: s.chainCode ?? "sandbox-chain",
      remoteOrderId: null,
      state: "RECEIVED",
      riderAccepted: false,
      modificationPending: false,
      history: [{ at: new Date().toISOString(), event: "dispatched" }],
    });
    const res = await this.sandbox.callPlugin("POST", `/order/${encodeURIComponent(c.externalStoreId!)}`, order);
    const ackId = (res.data as any)?.remoteResponse?.remoteOrderId ?? null;
    const entry = this.sandbox.orders.get(String(order.token))!;
    entry.remoteOrderId = ackId;
    entry.history.push({ at: new Date().toISOString(), event: `plugin answered ${res.status}`, detail: res.data });
    this.sandbox.record({ method: "→ plugin", path: `/order/${c.externalStoreId}`, status: res.status, note: ackId ? `acked as ${ackId}` : "no remoteOrderId" });
    return { token: order.token, httpStatus: res.status, ack: res.data, orderId: ackId };
  }

  /** "Talabat" sends one of the posOrderStatus notifications. */
  @Post("orders/:token/notify")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  async notify(
    @Param("token") token: string,
    @Body() body: { status: string; message?: string },
  ) {
    this.assertEnabled();
    const o = this.sandbox.orders.get(token);
    if (!o?.remoteOrderId) throw new NotFoundException("No acknowledged sandbox order with that token");
    if (body?.status === "RIDER_ACCEPTED") {
      // Not a plugin notification — flips the state that blocks prep-time
      // changes once vendor and rider have both accepted.
      o.riderAccepted = true;
      o.history.push({ at: new Date().toISOString(), event: "rider accepted the job" });
      return { ok: true };
    }
    const now = new Date();
    const payload: Record<string, unknown> = { status: body.status, message: body.message ?? body.status };
    if (body.status === "SHOW_RIDER_WAITING_WARNING") {
      payload.occurredAt = now.toISOString();
      payload.riderWaitingWarnings = { waitingStartsAt: now.toISOString(), waitingFeeAppliesAt: new Date(now.getTime() + 5 * 60_000).toISOString() };
    }
    if (body.status === "HIDE_RIDER_WAITING_WARNING") {
      payload.occurredAt = now.toISOString();
      payload.riderWaitingWarnings = null;
    }
    if (body.status === "ORDER_CANCELLED") o.state = "CANCELLED";
    if (body.status === "ORDER_PICKED_UP") o.state = "PICKED_UP";
    const res = await this.sandbox.callPlugin("PUT", `/remoteId/${encodeURIComponent(o.remoteId)}/remoteOrder/${encodeURIComponent(o.remoteOrderId)}/posOrderStatus`, payload);
    o.history.push({ at: now.toISOString(), event: `${body.status} → plugin ${res.status}` });
    this.sandbox.record({ method: "→ plugin", path: "posOrderStatus", status: res.status, note: body.status });
    return { httpStatus: res.status };
  }

  /** "Talabat" close (or reopen) the vendor and tell our plugin. */
  @Post("connections/:connectionId/notify-availability")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  async notifyAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param("connectionId") id: string,
    @Body() body: { closed: boolean; reason?: string; minutes?: number; changeable?: boolean },
  ) {
    this.assertEnabled();
    const c = await this.connections.get(user.tenantId, id);
    const now = Date.now();
    const closures = body?.closed
      ? [
          {
            reason: body.reason ?? "TOO_MANY_REJECTED_ORDERS",
            start: new Date(now - 1000).toISOString(),
            ...(body.minutes ? { end: new Date(now + body.minutes * 60_000).toISOString() } : {}),
            changeable: body.changeable ?? false,
          },
        ]
      : [];
    this.sandbox.availability.set(c.externalStoreId!, {
      state: body?.closed ? (body.minutes ? "CLOSED_UNTIL" : "CLOSED") : "OPEN",
      closedReason: body?.closed ? closures[0]!.reason : null,
      closedUntil: closures[0]?.end ?? null,
      changeable: body?.closed ? (body.changeable ?? false) : true,
    });
    const res = await this.sandbox.callPlugin("PUT", `/remoteId/${encodeURIComponent(c.externalStoreId!)}/availability`, {
      timestamp: new Date(now).toISOString(),
      closures,
    });
    this.sandbox.record({ method: "→ plugin", path: "availability", status: res.status, note: body?.closed ? "closed" : "open" });
    return { httpStatus: res.status };
  }

  /** "Talabat" ask for the menu. */
  @Post("connections/:connectionId/request-menu")
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.OK)
  async requestMenu(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") id: string) {
    this.assertEnabled();
    const c = await this.connections.get(user.tenantId, id);
    const importId = randomUUID();
    const res = await this.sandbox.callPlugin(
      "GET",
      `/menuimport/${encodeURIComponent(c.externalStoreId!)}?vendorCode=${encodeURIComponent(talabatSettings(c).platformVendorId ?? "sandbox")}&menuImportId=${importId}`,
    );
    this.sandbox.record({ method: "→ plugin", path: "menuimport", status: res.status, note: importId });
    return { httpStatus: res.status, menuImportId: importId };
  }
}
