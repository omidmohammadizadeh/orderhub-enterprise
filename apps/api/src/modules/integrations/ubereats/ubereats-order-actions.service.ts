// Phase UE-4b — the rest of Uber's Order Fulfillment suite. These were all
// exercised in the Base44-era certification, so they must return 200s in the
// sandbox checklist:
//
//   adjust-price               {amount_e5, tax_rate?, reason, custom_reason?}
//   update-ready-time          {ready_for_pickup_time}
//   validate-item-fulfillment  {issue_type, action_type?, item, …}
//   resolve-fulfillment-issues {fulfillment_issues:[{issue_type, action_type,
//                               item, suspend_until?, store_response?}]}
//   get-replacement-recommendations {id, order_id, store_id}
//
// All bodies are spec-shaped (partner OpenAPI, Order Fulfillment API 1.0.0).
// Callers reference OUR order id; we resolve the Uber order/store ids.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { UberEatsClientService } from "./ubereats-client.service";

const SCOPES = ["eats.order"];
// validate-item-fulfillment + resolve-fulfillment-issues require BOTH scopes
// (the spec lists them together in one security block = AND). eats.order
// alone → 401.
const FULFILLMENT_SCOPES = ["eats.order", "eats.store.orders.read"];

export type AdjustPriceReason =
  | "REQUESTED_ADD_ONS"
  | "BIGGER_SIZE"
  | "NEW_ITEM_ADDED"
  | "ITEM_SOLD_OUT"
  | "REMOVED_ITEM"
  | "ADD_ON_UNAVAILABLE"
  | "OTHER";

@Injectable()
export class UberEatsOrderActionsService {
  private readonly logger = new Logger(UberEatsOrderActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: UberEatsClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /** Common tenant/brand/location context for activity rows. */
  private async logCtx(tenantId: string, orderId: string) {
    const o = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: { brandId: true, locationId: true, orderNumber: true },
    });
    return {
      tenantId,
      brandId: o?.brandId ?? null,
      locationId: o?.locationId ?? null,
      orderNumber: o?.orderNumber ?? null,
    };
  }

  private record(
    ctx: { tenantId: string; brandId: string | null; locationId: string | null },
    action: string,
    ok: boolean,
    message: string,
    details: Record<string, unknown>,
  ) {
    this.activity?.record({
      tenantId: ctx.tenantId,
      brandId: ctx.brandId,
      locationId: ctx.locationId,
      category: "ORDERS",
      channel: "UBER_EATS",
      action,
      status: ok ? "SUCCESS" : "ERROR",
      message,
      details,
    });
  }

  /**
   * Fetch the live Uber order (expand=carts,payment) and return the first
   * cart line — used to auto-build valid validate/resolve/replacement
   * payloads for certification testing without the operator hand-typing ids.
   */
  private async firstCartItem(uberOrderId: string): Promise<{
    cartItemId: string | null;
    itemId: string | null;
    title: string | null;
  }> {
    try {
      const resp = await this.client.request<any>(
        "GET",
        `/v1/delivery/order/${encodeURIComponent(uberOrderId)}?expand=carts,payment`,
        { scopes: SCOPES },
      );
      const order = resp?.order ?? resp;
      const cart = Array.isArray(order?.carts) ? order.carts[0] : undefined;
      const it = cart?.items?.[0];
      return {
        cartItemId: it?.cart_item_id ? String(it.cart_item_id) : null,
        itemId: it?.id ? String(it.id) : (it?.external_data ?? null),
        title: it?.title ? String(it.title) : null,
      };
    } catch {
      return { cartItemId: null, itemId: null, title: null };
    }
  }

  /** Resolve OUR order → the Uber order id (+ store id from ingest metadata). */
  private async uberOrder(tenantId: string, orderId: string) {
    const row = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId, platform: "UBER_EATS" },
      select: { id: true, externalId: true, metadata: true },
    });
    if (!row?.externalId) {
      throw new NotFoundException("Uber Eats order not found");
    }
    const storeId =
      ((row.metadata as any)?.uberStoreId as string | undefined) ?? "";
    return { uberOrderId: row.externalId, storeId };
  }

  /**
   * Adjust the order price (item sold out, size change, add-on unavailable…).
   * `amountPounds` is the NEW price for the affected scope in pounds; Uber
   * wants amount_e5 (×10^5).
   */
  async adjustPrice(
    tenantId: string,
    orderId: string,
    dto: {
      amountPounds: number;
      taxRate?: number | string;
      reason: AdjustPriceReason;
      customReason?: string;
    },
  ) {
    if (!Number.isFinite(Number(dto.amountPounds))) {
      throw new BadRequestException("amountPounds is required");
    }
    const { uberOrderId } = await this.uberOrder(tenantId, orderId);
    const ctx = await this.logCtx(tenantId, orderId);
    const meta: { status?: number } = {};
    try {
      const res = await this.client.request<any>(
        "POST",
        `/v1/delivery/order/${encodeURIComponent(uberOrderId)}/adjust-price`,
        {
          scopes: SCOPES,
          meta,
          body: {
            amount_e5: Math.round(Number(dto.amountPounds) * 100_000),
            ...(dto.taxRate != null ? { tax_rate: String(dto.taxRate) } : {}),
            reason: dto.reason,
            ...(dto.customReason ? { custom_reason: dto.customReason } : {}),
          },
        },
      );
      this.record(ctx, "order.adjust_price", true,
        `Order #${ctx.orderNumber ?? orderId} price adjusted £${dto.amountPounds} (${dto.reason}) — Uber responded ${meta.status ?? 200} OK`,
        { uberOrderId, amountPounds: dto.amountPounds, reason: dto.reason, uberHttpStatus: meta.status, response: res });
      return { ok: true, uberHttpStatus: meta.status, ...(res ?? {}) };
    } catch (err: any) {
      this.record(ctx, "order.adjust_price", false,
        `Order #${ctx.orderNumber ?? orderId} price adjust failed: ${err?.message ?? err}`,
        { uberOrderId, uberError: String(err?.message ?? err) });
      throw err;
    }
  }

  /** Push a new ready-for-pickup time (kitchen running behind/ahead). */
  async updateReadyTime(
    tenantId: string,
    orderId: string,
    dto: { minutesFromNow?: number; readyAt?: string },
  ) {
    const readyAt = dto.readyAt
      ? new Date(dto.readyAt)
      : new Date(Date.now() + (dto.minutesFromNow ?? 15) * 60_000);
    if (Number.isNaN(readyAt.getTime())) {
      throw new BadRequestException("Invalid ready time");
    }
    const { uberOrderId } = await this.uberOrder(tenantId, orderId);
    const ctx = await this.logCtx(tenantId, orderId);
    const meta: { status?: number } = {};
    try {
      await this.client.request(
        "POST",
        `/v1/delivery/order/${encodeURIComponent(uberOrderId)}/update-ready-time`,
        { scopes: SCOPES, meta, body: { ready_for_pickup_time: readyAt.toISOString() } },
      );
      this.record(ctx, "order.update_ready_time", true,
        `Order #${ctx.orderNumber ?? orderId} ready time → ${readyAt.toLocaleTimeString()} — Uber responded ${meta.status ?? 200} OK`,
        { uberOrderId, readyForPickupTime: readyAt.toISOString(), uberHttpStatus: meta.status });
      return { ok: true, readyForPickupTime: readyAt.toISOString(), uberHttpStatus: meta.status };
    } catch (err: any) {
      this.record(ctx, "order.update_ready_time", false,
        `Order #${ctx.orderNumber ?? orderId} ready-time update failed: ${err?.message ?? err}`,
        { uberOrderId, uberError: String(err?.message ?? err) });
      throw err;
    }
  }

  /**
   * Validate how an item issue should be handled BEFORE resolving it
   * (out-of-item / partial availability / found item). Body passes through
   * spec-shaped; we only inject the Uber order id.
   */
  async validateItemFulfillment(
    tenantId: string,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    const { uberOrderId } = await this.uberOrder(tenantId, orderId);
    const ctx = await this.logCtx(tenantId, orderId);
    // Auto-build a minimal FOUND_ITEM payload from the live order's first
    // line when the caller sends nothing (cert "test" button).
    if (!body?.issue_type || !body?.item) {
      const first = await this.firstCartItem(uberOrderId);
      if (!first.cartItemId) {
        throw new BadRequestException(
          "Could not resolve a cart_item_id from the order — is it still active on Uber?",
        );
      }
      body = {
        issue_type: "FOUND_ITEM",
        item: {
          cart_item_id: first.cartItemId,
          scanned_barcode: { value: "0000000000000" },
        },
        item_availability: {
          items_available: {
            amount: 1,
            in_sellable_unit: {
              measurement_unit: { measurement_type: "MEASUREMENT_TYPE_COUNT" },
              amount_e5: 100000,
            },
          },
        },
      };
    }
    const meta: { status?: number } = {};
    try {
      const res = await this.client.request<any>(
        "POST",
        `/v1/delivery/order/${encodeURIComponent(uberOrderId)}/validate-item-fulfillment`,
        { scopes: FULFILLMENT_SCOPES, meta, body },
      );
      this.record(ctx, "order.validate_item", true,
        `Order #${ctx.orderNumber ?? orderId} item fulfillment validated — Uber responded ${meta.status ?? 200} OK`,
        { uberOrderId, uberHttpStatus: meta.status, results: res?.results });
      return res ?? { ok: true };
    } catch (err: any) {
      this.record(ctx, "order.validate_item", false,
        `Order #${ctx.orderNumber ?? orderId} validate-item failed: ${err?.message ?? err}`,
        { uberOrderId, uberError: String(err?.message ?? err) });
      throw err;
    }
  }

  /** Resolve fulfillment issues (restaurant shape: fulfillment_issues[]). */
  async resolveFulfillmentIssues(
    tenantId: string,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    const { uberOrderId } = await this.uberOrder(tenantId, orderId);
    const ctx = await this.logCtx(tenantId, orderId);
    let issues = (body as any)?.fulfillment_issues;
    // Auto-build an OUT_OF_ITEM / ASK_CUSTOMER issue for the first line when
    // the caller sends nothing (cert "test" button). ASK_CUSTOMER is the
    // restaurant action type — Uber asks the customer to adjust/cancel.
    if (!Array.isArray(issues) || issues.length === 0) {
      const first = await this.firstCartItem(uberOrderId);
      if (!first.cartItemId) {
        throw new BadRequestException(
          "Could not resolve a cart_item_id from the order — is it still active on Uber?",
        );
      }
      issues = [
        {
          issue_type: "OUT_OF_ITEM",
          action_type: "ASK_CUSTOMER",
          item: { cart_item_id: first.cartItemId },
          store_response: "Item temporarily unavailable — please choose an alternative.",
        },
      ];
      body = { fulfillment_issues: issues };
    }
    const meta: { status?: number } = {};
    try {
      const res = await this.client.request<any>(
        "POST",
        `/v1/delivery/order/${encodeURIComponent(uberOrderId)}/resolve-fulfillment-issues`,
        { scopes: FULFILLMENT_SCOPES, meta, body },
      );
      this.record(ctx, "order.resolve_fulfillment", true,
        `Order #${ctx.orderNumber ?? orderId} fulfillment issue(s) resolved (${issues.length}) — Uber responded ${meta.status ?? 200} OK`,
        { uberOrderId, uberHttpStatus: meta.status, response: res });
      return res ?? { ok: true };
    } catch (err: any) {
      this.record(ctx, "order.resolve_fulfillment", false,
        `Order #${ctx.orderNumber ?? orderId} resolve-fulfillment failed: ${err?.message ?? err}`,
        { uberOrderId, uberError: String(err?.message ?? err) });
      throw err;
    }
  }

  /** Replacement recommendations for a sold-out item. */
  async replacementRecommendations(
    tenantId: string,
    orderId: string,
    dto: { itemId?: string; storeId?: string },
  ) {
    const { uberOrderId, storeId } = await this.uberOrder(tenantId, orderId);
    const ctx = await this.logCtx(tenantId, orderId);
    const store = dto.storeId || storeId;
    if (!store) {
      throw new BadRequestException(
        "No Uber store id on this order — reconnect the store.",
      );
    }
    // Auto-resolve the first item id when none supplied (cert "test" button).
    let itemId = dto.itemId;
    if (!itemId) {
      const first = await this.firstCartItem(uberOrderId);
      itemId = first.itemId ?? first.cartItemId ?? undefined;
    }
    if (!itemId) {
      throw new BadRequestException("Could not resolve an item id from the order.");
    }
    const meta: { status?: number } = {};
    try {
      const res = await this.client.request<any>(
        "POST",
        `/v1/delivery/get-replacement-recommendations`,
        {
          scopes: SCOPES,
          meta,
          body: { id: itemId, order_id: uberOrderId, store_id: store },
        },
      );
      const count = res?.replacement_recommendations?.length ?? 0;
      this.record(ctx, "order.replacement_recs", true,
        `Order #${ctx.orderNumber ?? orderId} replacement recommendations: ${count} — Uber responded ${meta.status ?? 200} OK`,
        { uberOrderId, itemId, uberHttpStatus: meta.status, count });
      return res ?? { replacement_recommendations: [] };
    } catch (err: any) {
      this.record(ctx, "order.replacement_recs", false,
        `Order #${ctx.orderNumber ?? orderId} replacement-recommendations failed: ${err?.message ?? err}`,
        { uberOrderId, uberError: String(err?.message ?? err) });
      throw err;
    }
  }
}
