// Phase UE-4 — Uber Eats inbound order routing.
//
// The webhook receiver has already HMAC-verified + idempotently recorded the
// event. Here a valid, first-seen event becomes real work:
//
//   orders.notification / orders.scheduled.notification
//     → GET /v1/delivery/order/{id} (scope eats.order) → mapUberEatsOrder →
//       OrdersService.ingestCanonical for the connected brand+location.
//   orders.cancel / orders.failure
//     → updateStatus(CANCELLED, actorType=WEBHOOK).
//   orders.release  (Fast Order Release — courier hit the geofence)
//     → updateStatus(RIDER_ARRIVED) best-effort.
//
// Uber requires accept/deny within 11.5 minutes of the notification; the
// operator does that on the POS exactly like Deliveroo orders, and the
// outbound sync service pushes it back.

import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { OrdersService } from "../../orders/orders.service";
import { UberEatsClientService } from "./ubereats-client.service";
import { mapUberEatsOrder } from "./ubereats-order.mappers";

@Injectable()
export class UberEatsOrderService {
  private readonly logger = new Logger(UberEatsOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly client: UberEatsClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  async route(
    event: string,
    body: any,
  ): Promise<{ handled: boolean; reason?: string; orderId?: string }> {
    switch (event) {
      case "orders.notification":
      case "orders.scheduled.notification":
        return this.handleNotification(body);
      case "orders.cancel":
      case "orders.failure":
        return this.handleTerminal(body, "CANCELLED");
      case "orders.release":
        return this.handleRelease(body);
      default:
        return { handled: false, reason: `unrouted_event:${event}` };
    }
  }

  private orderIdFrom(body: any): string {
    return String(
      body?.meta?.resource_id ?? body?.resource_id ?? body?.order_id ?? "",
    );
  }

  private storeIdFrom(body: any, order?: any): string {
    return String(
      order?.store?.id ?? body?.meta?.user_id ?? body?.store_id ?? "",
    );
  }

  // ── orders.notification → ingestCanonical ──────────────────────────────

  private async handleNotification(body: any) {
    const orderId = this.orderIdFrom(body);
    if (!orderId) return { handled: false, reason: "no_order_id" };

    // Fetch the full order — notification webhooks only carry ids.
    const resp = await this.client.request<any>(
      "GET",
      `/v1/delivery/order/${encodeURIComponent(orderId)}`,
      { scopes: ["eats.order"] },
    );
    const order = resp?.order ?? resp;
    if (!order?.id) {
      this.logger.warn(`Uber Eats order ${orderId}: fetch returned no order`);
      return { handled: false, reason: "order_fetch_empty" };
    }

    // Shape probe (same discipline as Deliveroo) — pins any field drift from
    // real traffic without blocking ingestion.
    try {
      const j = (v: unknown) => JSON.stringify(v ?? null)?.slice(0, 400);
      this.logger.log(
        `Uber Eats order shape: fulfillment=${order?.fulfillment_type} state=${order?.state} ` +
          `customers=${j(order?.customers)} prep=${j(order?.preparation_time)}`,
      );
    } catch {
      /* diagnostics only */
    }

    const storeId = this.storeIdFrom(body, order);
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "UBER_EATS",
        externalStoreId: storeId,
        status: { not: "not_connected" },
      },
      select: { tenantId: true, brandId: true, locationId: true },
    });
    if (!conn) {
      this.logger.warn(
        `Uber Eats order ${orderId}: no connected brand for store ${storeId} — ignoring`,
      );
      return { handled: false, reason: "store_not_connected" };
    }

    const canonical = mapUberEatsOrder(order);
    if (!canonical) {
      this.logger.warn(`Uber Eats order ${orderId}: mapper returned null`);
      return { handled: false, reason: "normalize_null" };
    }
    (canonical as any).brandId = conn.brandId ?? undefined;
    (canonical as any).deliveryType =
      (canonical.metadata as any)?.deliveryType ?? undefined;

    const created = await this.orders.ingestCanonical(
      canonical,
      conn.tenantId,
      conn.locationId,
    );
    this.logger.log(
      `Uber Eats order ${orderId} → order ${created.id} (store ${storeId})`,
    );
    // (order.received is logged centrally by OrdersService.ingestCanonical.)
    return { handled: true, orderId: created.id };
  }

  // ── cancel / failure / release ──────────────────────────────────────────

  private async handleTerminal(body: any, status: "CANCELLED") {
    const externalId = this.orderIdFrom(body);
    if (!externalId) return { handled: false, reason: "no_order_id" };

    const row = await this.prisma.order.findFirst({
      where: { externalId, platform: "UBER_EATS" },
      select: { id: true, tenantId: true, status: true },
    });
    if (!row) {
      this.logger.warn(
        `Uber Eats ${status} for unknown order ${externalId} — ignoring`,
      );
      return { handled: false, reason: "order_not_found" };
    }
    if (row.status === status) return { handled: false, reason: "no_change" };

    try {
      await this.orders.updateStatus(
        row.id,
        row.tenantId,
        {
          status: status as any,
          cancelReason: "Cancelled on Uber Eats",
        } as any,
        "ubereats-webhook",
        "WEBHOOK",
      );
      this.activity?.record({
        tenantId: row.tenantId,
        category: "ORDERS",
        channel: "UBER_EATS",
        action: "order.cancelled",
        status: "WARNING",
        message: `Uber Eats cancelled order ${externalId}`,
        details: { uberOrderId: externalId, orderId: row.id },
      });
      return { handled: true, orderId: row.id };
    } catch (err: any) {
      this.logger.warn(
        `Uber Eats ${status} ${externalId} rejected: ${err?.message}`,
      );
      return { handled: false, reason: "transition_rejected", orderId: row.id };
    }
  }

  private async handleRelease(body: any) {
    const externalId = this.orderIdFrom(body);
    if (!externalId) return { handled: false, reason: "no_order_id" };
    const row = await this.prisma.order.findFirst({
      where: { externalId, platform: "UBER_EATS" },
      select: { id: true, tenantId: true, status: true },
    });
    if (!row) return { handled: false, reason: "order_not_found" };
    try {
      await this.orders.updateStatus(
        row.id,
        row.tenantId,
        { status: "RIDER_ARRIVED" as any } as any,
        "ubereats-webhook",
        "WEBHOOK",
      );
      return { handled: true, orderId: row.id };
    } catch (err: any) {
      // Out-of-sequence release (e.g. order still PENDING) — log + move on.
      this.logger.warn(
        `Uber Eats orders.release for ${externalId} rejected: ${err?.message}`,
      );
      return { handled: false, reason: "transition_rejected", orderId: row.id };
    }
  }
}
