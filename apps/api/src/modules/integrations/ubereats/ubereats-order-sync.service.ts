// Phase UE-4 — outbound Uber Eats order sync.
//
// Pushes dashboard status changes back to Uber so accepting / readying an
// order happens HERE, not in Uber's tablet app (Order Fulfillment API,
// shapes from the partner OpenAPI spec):
//
//   ACCEPTED  → POST /v1/delivery/order/{id}/accept
//               { ready_for_pickup_time, external_reference_id, accepted_by }
//               (must land within 11.5 min of the notification or Uber
//               auto-cancels)
//   REJECTED  → POST .../deny   { deny_reason: { type, info } }
//   CANCELLED → POST .../cancel { cancellation_reason: { type, info } }
//   READY     → POST .../ready  {}
//
// Wired via the "order.status_changed" in-process event (same decoupling as
// the Deliveroo sync — no OrdersModule↔UberEatsModule cycle). WEBHOOK-actor
// transitions are skipped (they CAME from Uber). Best-effort: a failed push
// is logged, never thrown.

import { Injectable, Logger, Optional } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { UberEatsClientService } from "./ubereats-client.service";

interface OrderStatusChangedEvent {
  orderId: string;
  tenantId: string;
  locationId: string;
  fromStatus: string;
  toStatus: string;
  actorType?: string;
}

const SCOPES = ["eats.order"];
// Merchant-fulfilled ("self-delivery") status updates use a dedicated
// endpoint + scope. Only DELIVERY_BY_MERCHANT orders drive these — for
// DELIVERY_BY_UBER the courier handles delivery and Uber reports state to us.
const RESTAURANT_DELIVERY_SCOPES = ["eats.store.orders.restaurantdelivery.status"];

// Valid Uber deny/cancel reason types (Order Fulfillment API deny_reason enum,
// shared by cancel). Map our internal reason text/code onto one of these.
const UBER_REASON_TYPES = new Set([
  "ITEM_ISSUE",
  "KITCHEN_CLOSED",
  "CUSTOMER_CALLED_TO_CANCEL",
  "RESTAURANT_TOO_BUSY",
  "ORDER_VALIDATION",
  "STORE_CLOSED",
  "TECHNICAL_FAILURE",
  "POS_NOT_READY",
  "POS_OFFLINE",
  "CAPACITY",
  "ADDRESS",
  "SPECIAL_INSTRUCTIONS",
  "PRICING",
  "UNKNOWN",
  "OTHER",
]);

/** Best-effort map of our free-text/coded cancel reason → a valid Uber type. */
function mapReasonType(reason: string | null | undefined, fallback: string): string {
  if (!reason) return fallback;
  const up = reason.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (UBER_REASON_TYPES.has(up)) return up;
  if (/OUT.?OF.?(ITEM|STOCK)|MISSING|UNAVAILABLE/.test(up)) return "ITEM_ISSUE";
  if (/CLOSED|CLOSING/.test(up)) return "KITCHEN_CLOSED";
  if (/BUSY|CAPACITY/.test(up)) return "RESTAURANT_TOO_BUSY";
  if (/CUSTOMER/.test(up)) return "CUSTOMER_CALLED_TO_CANCEL";
  return fallback;
}

@Injectable()
export class UberEatsOrderSyncService {
  private readonly logger = new Logger(UberEatsOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: UberEatsClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  @OnEvent("order.status_changed")
  async onStatusChanged(ev: OrderStatusChangedEvent): Promise<void> {
    let logCtx: {
      tenantId: string;
      brandId?: string | null;
      locationId?: string | null;
      externalId?: string;
    } | null = null;
    try {
      if (ev.actorType === "WEBHOOK") return; // inbound echo guard

      const order = await this.prisma.order.findUnique({
        where: { id: ev.orderId },
        select: {
          id: true,
          tenantId: true,
          brandId: true,
          locationId: true,
          platform: true,
          integrationSource: true,
          viaHubrise: true,
          externalId: true,
          orderNumber: true,
          cancelReason: true,
          fulfillmentType: true,
          location: { select: { prepTime: true } },
        },
      });
      if (
        !order ||
        order.platform !== "UBER_EATS" ||
        order.viaHubrise ||
        order.integrationSource !== "DIRECT" ||
        !order.externalId
      ) {
        return; // not a direct Uber Eats order — HubRise path handles its own
      }
      logCtx = {
        tenantId: order.tenantId,
        brandId: order.brandId,
        locationId: order.locationId,
        externalId: order.externalId,
      };

      const pushed = await this.push(order, ev.toStatus);
      if (pushed) {
        const ack = pushed.httpStatus
          ? ` — Uber responded ${pushed.httpStatus} OK`
          : "";
        this.activity?.record({
          tenantId: order.tenantId,
          brandId: order.brandId,
          locationId: order.locationId,
          category: "ORDERS",
          channel: "UBER_EATS",
          action: `order.${pushed.action}`,
          status: "SUCCESS",
          message: `Order #${order.orderNumber ?? order.id} ${pushed.action} pushed to Uber Eats${ack}`,
          details: {
            uberOrderId: order.externalId,
            toStatus: ev.toStatus,
            uberHttpStatus: pushed.httpStatus ?? null,
          },
        });
      }
    } catch (err: any) {
      this.logger.error(
        `Uber Eats status push failed for order ${ev.orderId} → ${ev.toStatus}: ${err?.message ?? err}`,
      );
      if (logCtx) {
        this.activity?.record({
          tenantId: logCtx.tenantId,
          brandId: logCtx.brandId,
          locationId: logCtx.locationId,
          category: "ORDERS",
          channel: "UBER_EATS",
          action: "order.push",
          status: "ERROR",
          message: `Pushing ${ev.toStatus} to Uber Eats failed: ${err?.message ?? err}`,
          details: {
            uberOrderId: logCtx.externalId,
            toStatus: ev.toStatus,
            uberError: String(err?.message ?? err),
          },
        });
      }
    }
  }

  private async push(
    order: {
      id: string;
      externalId: string | null;
      orderNumber: number | null;
      cancelReason?: string | null;
      fulfillmentType?: string | null;
      location: { prepTime: number | null } | null;
    },
    toStatus: string,
  ): Promise<{ action: string; httpStatus?: number } | null> {
    const id = encodeURIComponent(order.externalId!);
    // Out-param the client fills with Uber's HTTP status so the activity
    // log can show the acknowledgment ("200 OK") Uber expects us to get.
    const meta: { status?: number } = {};

    switch (toStatus) {
      case "ACCEPTED": {
        const prepMinutes = order.location?.prepTime ?? 15;
        const readyAt = new Date(
          Date.now() + prepMinutes * 60_000,
        ).toISOString();
        await this.tolerateConflict(
          () =>
            this.client.request(
              "POST",
              `/v1/delivery/order/${id}/accept`,
              {
                scopes: SCOPES,
                meta,
                body: {
                  ready_for_pickup_time: readyAt,
                  external_reference_id: String(order.orderNumber ?? order.id),
                  accepted_by: "OrderHub POS",
                },
              },
            ),
          "accept",
          order.externalId!,
        );
        return { action: "accepted", httpStatus: meta.status };
      }
      case "REJECTED": {
        const type = mapReasonType(order.cancelReason, "RESTAURANT_TOO_BUSY");
        await this.tolerateConflict(
          () =>
            this.client.request("POST", `/v1/delivery/order/${id}/deny`, {
              scopes: SCOPES,
              meta,
              body: {
                deny_reason: {
                  type,
                  info: order.cancelReason || "Rejected on the restaurant POS",
                },
              },
            }),
          "deny",
          order.externalId!,
        );
        return { action: "denied", httpStatus: meta.status };
      }
      case "CANCELLED": {
        const type = mapReasonType(order.cancelReason, "OTHER");
        await this.tolerateConflict(
          () =>
            this.client.request("POST", `/v1/delivery/order/${id}/cancel`, {
              scopes: SCOPES,
              meta,
              body: {
                cancellation_reason: {
                  type,
                  info: order.cancelReason || "Cancelled by the restaurant",
                },
              },
            }),
          "cancel",
          order.externalId!,
        );
        return { action: "cancelled", httpStatus: meta.status };
      }
      case "READY": {
        await this.markReady(id, order.externalId!, meta);
        return { action: "ready", httpStatus: meta.status };
      }
      case "OUT_FOR_DELIVERY":
      case "DISPATCHED": {
        // Only merchant-fulfilled (self-delivery) orders report this — for
        // Uber-courier orders Uber drives the delivery state itself.
        if (!this.isMerchantDelivery(order)) return null;
        await this.restaurantDeliveryStatus(id, order.externalId!, "started", meta);
        return { action: "out for delivery", httpStatus: meta.status };
      }
      case "COMPLETED":
      case "DELIVERED": {
        if (this.isMerchantDelivery(order)) {
          // Self-delivery order dropped off → tell Uber it's delivered.
          await this.restaurantDeliveryStatus(
            id,
            order.externalId!,
            "delivered",
            meta,
          );
          return { action: "delivered", httpStatus: meta.status };
        }
        // Pickup: Uber has NO "collected" endpoint — a pickup order completes
        // when the customer collects it (via the pickup PIN). The correct POS
        // signal is "ready for pickup", so marking collected sends /ready
        // (idempotent; 409 if already ready). Base44-confirmed.
        await this.markReady(id, order.externalId!, meta);
        return { action: "ready (collected)", httpStatus: meta.status };
      }
      default:
        return null; // PREPARING/driver states have no Uber-side call
    }
  }

  /** True for self-delivery (merchant-fulfilled) orders. */
  private isMerchantDelivery(order: { fulfillmentType?: string | null }): boolean {
    return order.fulfillmentType === "MERCHANT_DELIVERY";
  }

  /**
   * Merchant-fulfilled delivery status (self-delivery): started → out for
   * delivery, delivered → dropped off.
   *   POST /v1/eats/orders/{id}/restaurantdelivery/status  { status }
   * Scope eats.store.orders.restaurantdelivery.status. 409-tolerant.
   */
  private async restaurantDeliveryStatus(
    id: string,
    externalId: string,
    status: "started" | "delivered",
    meta: { status?: number },
  ): Promise<void> {
    await this.tolerateConflict(
      () =>
        this.client.request(
          "POST",
          `/v1/eats/orders/${id}/restaurantdelivery/status`,
          { scopes: RESTAURANT_DELIVERY_SCOPES, meta, body: { status } },
        ),
      `restaurantdelivery:${status}`,
      externalId,
    );
  }

  /**
   * Mark an order ready for pickup. Primary endpoint is
   * POST /v1/delivery/order/{id}/ready; on 404 fall back to the legacy
   * POST /v1/eats/orders/{id}/mark_ready_for_pickup (Base44 uses the same
   * dual-endpoint approach). Empty body, 409-tolerant.
   */
  private async markReady(
    id: string,
    externalId: string,
    meta: { status?: number },
  ): Promise<void> {
    await this.tolerateConflict(
      async () => {
        try {
          await this.client.request(
            "POST",
            `/v1/delivery/order/${id}/ready`,
            { scopes: SCOPES, meta, body: {} },
          );
        } catch (err: any) {
          if (String(err?.message ?? "").includes("404")) {
            await this.client.request(
              "POST",
              `/v1/eats/orders/${id}/mark_ready_for_pickup`,
              { scopes: SCOPES, meta, body: {} },
            );
            return;
          }
          throw err;
        }
      },
      "ready",
      externalId,
    );
  }

  /**
   * 409/conflict responses mean "already in that state" (e.g. the operator
   * raced Uber's tablet, or a retry) — log + treat as success.
   */
  private async tolerateConflict(
    fn: () => Promise<unknown>,
    action: string,
    externalId: string,
  ): Promise<void> {
    try {
      await fn();
      this.logger.log(`Uber Eats ${action} pushed for ${externalId}`);
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (msg.includes("409") || msg.toLowerCase().includes("conflict")) {
        this.logger.warn(
          `Uber Eats ${action} for ${externalId} was already applied (409) — continuing`,
        );
        return;
      }
      throw err;
    }
  }
}
