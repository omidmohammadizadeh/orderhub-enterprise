// Phase BA-3b — Deliveroo inbound order routing.
//
// The webhook receiver (deliveroo-webhook.controller) has already
// HMAC-verified the request and recorded it idempotently. This service
// is where a *valid, first-seen* event turns into real work:
//
//   order.new           → resolve the connected store from the payload's
//                         site id → normalise → OrdersService.ingestCanonical
//   order.status_update → map Deliveroo's order status → our OrderStatus and
//                         drive OrdersService.updateStatus(actorType="WEBHOOK")
//   rider.status_update → write the courier-tracking columns + advance the
//                         order through the ASSIGNED_DRIVER → RIDER_ARRIVED →
//                         OUT_FOR_DELIVERY → COMPLETED chain.
//
// Mirrors HubRiseDeliverySyncService: inbound-only, best-effort, and the
// WEBHOOK actor type bypasses the operator PLATFORM-gate cleanly. Outbound
// accept/reject/cancel/sync_status/prep_stage lands in Phase 4.

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { DeliverooAdapter } from "../../webhooks/adapters/deliveroo.adapter";
import {
  mapDeliverooOrderStatus,
  mapDeliverooRiderStatus,
  deliverooSiteIdFrom,
  deliverooOrderIdFrom,
} from "./deliveroo-order.mappers";

@Injectable()
export class DeliverooOrderService {
  private readonly logger = new Logger(DeliverooOrderService.name);

  // The webhook adapter is a pure, dependency-free normaliser. We reuse it
  // rather than duplicating Deliveroo's money/item/address parsing.
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly adapter: DeliverooAdapter,
  ) {}

  /** Top-level dispatch for a verified, first-seen webhook event. */
  async route(
    event: string,
    body: any,
  ): Promise<{ handled: boolean; reason?: string; orderId?: string }> {
    const e = (event ?? "").toLowerCase();
    if (e.includes("rider")) return this.handleRiderUpdate(body);
    if (e === "order.new" || e === "new_order" || e.includes("new")) {
      return this.handleOrderNew(body);
    }
    if (e.includes("status") || e === "cancel_order") {
      return this.handleStatusUpdate(body, e);
    }
    // menu.* / anything else — nothing to do here (menu results land in Phase 5).
    return { handled: false, reason: `unrouted_event:${event}` };
  }

  // ── order.new → ingestCanonical ─────────────────────────

  /**
   * Shape probe — Deliveroo's customer/delivery layouts vary by
   * fulfillment_type and the docs don't enumerate them. Logging the raw
   * objects (truncated) lets us pin the real field names from production
   * traffic instead of guessing. Remove once the shapes are confirmed.
   */
  private logPayloadShape(kind: string, order: any): void {
    try {
      const j = (v: unknown) => JSON.stringify(v ?? null)?.slice(0, 500);
      this.logger.log(
        `Deliveroo ${kind} shape: fulfillment_type=${order?.fulfillment_type ?? "?"} ` +
          `customer=${j(order?.customer)} delivery=${j(order?.delivery)}`,
      );
    } catch {
      /* diagnostics only */
    }
  }

  async handleOrderNew(body: any): Promise<{ handled: boolean; reason?: string; orderId?: string }> {
    const order = body?.body?.order ?? body?.order ?? body?.body ?? body;
    this.logPayloadShape("order.new", order);
    const externalId = deliverooOrderIdFrom(order, body?.body ?? body);
    if (!externalId) {
      this.logger.warn(
        `Deliveroo order.new without an order id (keys=${Object.keys(order ?? {}).join(",")})`,
      );
      return { handled: false, reason: "no_order_id" };
    }

    const siteId = deliverooSiteIdFrom(order, body?.body ?? body);
    if (!siteId) {
      this.logger.warn(
        `Deliveroo order.new ${externalId}: could not find a site id (order keys=${Object.keys(order ?? {}).join(",")})`,
      );
      return { handled: false, reason: "no_site_id" };
    }

    // Resolve the connected brand/location for this Deliveroo site.
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "DELIVEROO",
        externalStoreId: siteId,
        status: { not: "not_connected" },
      },
      select: { tenantId: true, brandId: true, locationId: true },
    });
    if (!conn) {
      this.logger.warn(
        `Deliveroo order.new ${externalId}: no connected brand for site ${siteId} — ignoring`,
      );
      return { handled: false, reason: "site_not_connected" };
    }

    // Reuse the proven adapter normaliser (money/items/address/customer).
    const canonical = this.adapter.normalize({ order }, conn.locationId);
    if (!canonical) {
      this.logger.warn(`Deliveroo order.new ${externalId}: adapter returned null`);
      return { handled: false, reason: "normalize_null" };
    }

    // Direct integration: we know the brand from the connection (no name
    // hint needed). deliveryType comes from the adapter's fulfillment_type
    // mapping (deliveroo rider → PLATFORM so the operator UI gates post-READY
    // steps and rider webhooks drive them; restaurant fleet → MERCHANT;
    // pickup/dine-in → none). Fallback keeps older payloads gated.
    (canonical as any).brandId = conn.brandId ?? undefined;
    (canonical as any).deliveryType =
      (canonical.metadata as any)?.deliveryType ??
      (canonical.fulfillmentType === "PICKUP" ||
      canonical.fulfillmentType === "DINE_IN"
        ? undefined
        : "PLATFORM");

    const created = await this.orders.ingestCanonical(
      canonical,
      conn.tenantId,
      conn.locationId,
    );
    this.logger.log(
      `Deliveroo order.new ${externalId} → order ${created.id} (site ${siteId})`,
    );
    return { handled: true, orderId: created.id };
  }

  // ── order.status_update → updateStatus ──────────────────

  async handleStatusUpdate(
    body: any,
    eventName = "",
  ): Promise<{ handled: boolean; reason?: string; orderId?: string }> {
    const order = body?.body?.order ?? body?.order ?? body?.body ?? body;
    this.logPayloadShape("status_update", order);
    const externalId = deliverooOrderIdFrom(order, body?.body ?? body);
    if (!externalId) return { handled: false, reason: "no_order_id" };

    const rawStatus = order?.status ?? body?.body?.status ?? body?.status;
    // Legacy `cancel_order` carries the cancellation intent in the event name
    // itself — it may not ship an explicit status field.
    const mapped =
      mapDeliverooOrderStatus(rawStatus) ??
      (eventName === "cancel_order" ? "CANCELLED" : null);
    if (!mapped) return { handled: false, reason: `unmapped_status:${rawStatus}` };

    const row = await this.prisma.order.findFirst({
      where: { externalId, platform: "DELIVEROO" },
      select: { id: true, tenantId: true, status: true },
    });
    if (!row) {
      // status_update can race ahead of order.new — 200 + ignore; the
      // eventual order.new (or a retry) lands the order.
      this.logger.warn(
        `Deliveroo status_update for unknown order ${externalId} — ignoring`,
      );
      return { handled: false, reason: "order_not_found" };
    }
    if (row.status === mapped) return { handled: false, reason: "no_change" };

    try {
      await this.orders.updateStatus(
        row.id,
        row.tenantId,
        {
          status: mapped as any,
          cancelReason:
            mapped === "CANCELLED"
              ? "Cancelled on Deliveroo"
              : mapped === "REJECTED"
                ? "Rejected on Deliveroo"
                : undefined,
        } as any,
        "deliveroo-webhook",
        "WEBHOOK",
      );
      this.logger.log(
        `Deliveroo status_update ${externalId}: ${row.status} → ${mapped}`,
      );
      return { handled: true, orderId: row.id };
    } catch (err: any) {
      // Illegal transition (out-of-order echo) — log + swallow, same as HubRise.
      this.logger.warn(
        `Deliveroo status_update ${externalId} → ${mapped} rejected: ${err?.message}`,
      );
      return { handled: false, reason: "transition_rejected", orderId: row.id };
    }
  }

  // ── rider.status_update → courier columns + status ──────

  async handleRiderUpdate(body: any): Promise<{ handled: boolean; reason?: string; orderId?: string }> {
    const inner = body?.body ?? body;
    const order = inner?.order ?? inner;
    const externalId = deliverooOrderIdFrom(order, inner);
    if (!externalId) return { handled: false, reason: "no_order_id" };

    const rider = inner?.rider ?? order?.rider ?? {};
    const rawStatus = inner?.status ?? order?.status ?? rider?.status;

    const row = await this.prisma.order.findFirst({
      where: { externalId, platform: "DELIVEROO" },
    });
    const o = row as any;
    if (!o) {
      this.logger.warn(
        `Deliveroo rider update for unknown order ${externalId} — ignoring`,
      );
      return { handled: false, reason: "order_not_found" };
    }

    const mapped = mapDeliverooRiderStatus(rawStatus);

    // Write courier-tracking columns. Timestamps are set once (first event
    // wins) so a re-delivered event can't clobber the original pickup time.
    const updates: Record<string, any> = {};
    const riderName = rider?.name ?? rider?.rider_name ?? inner?.rider_name;
    const riderPhone =
      rider?.contact_number ?? rider?.phone ?? rider?.phone_number;
    if (riderName) updates.courierName = riderName;
    if (riderPhone) updates.courierPhone = riderPhone;
    if (rawStatus) updates.courierStatus = String(rawStatus);
    if (mapped === "ASSIGNED_DRIVER" && !o.courierAssignedAt) {
      updates.courierAssignedAt = new Date();
    }
    if (mapped === "OUT_FOR_DELIVERY" && !o.courierPickedUpAt) {
      updates.courierPickedUpAt = new Date();
    }
    if (mapped === "COMPLETED" && !o.courierDeliveredAt) {
      updates.courierDeliveredAt = new Date();
    }
    if (Object.keys(updates).length) {
      await this.prisma.order.update({
        where: { id: o.id },
        data: updates as any,
      });
    }

    // Advance the order lifecycle if the rider moved into a new stage.
    let statusChanged = false;
    if (mapped && mapped !== o.status) {
      try {
        await this.orders.updateStatus(
          o.id,
          o.tenantId,
          { status: mapped as any } as any,
          "deliveroo-rider-webhook",
          "WEBHOOK",
        );
        statusChanged = true;
      } catch (err: any) {
        this.logger.warn(
          `Deliveroo rider ${externalId} → ${mapped} rejected: ${err?.message}`,
        );
      }
    }

    this.logger.log(
      `Deliveroo rider ${externalId}: status=${rawStatus ?? "?"} order_status=${mapped ?? "(unchanged)"} fields=${Object.keys(updates).length}`,
    );
    return {
      handled: Object.keys(updates).length > 0 || statusChanged,
      orderId: o.id,
    };
  }
}
