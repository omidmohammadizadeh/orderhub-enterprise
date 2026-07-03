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

import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
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

@Injectable()
export class UberEatsOrderSyncService {
  private readonly logger = new Logger(UberEatsOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: UberEatsClientService,
  ) {}

  @OnEvent("order.status_changed")
  async onStatusChanged(ev: OrderStatusChangedEvent): Promise<void> {
    try {
      if (ev.actorType === "WEBHOOK") return; // inbound echo guard

      const order = await this.prisma.order.findUnique({
        where: { id: ev.orderId },
        select: {
          id: true,
          platform: true,
          integrationSource: true,
          viaHubrise: true,
          externalId: true,
          orderNumber: true,
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

      await this.push(order, ev.toStatus);
    } catch (err: any) {
      this.logger.error(
        `Uber Eats status push failed for order ${ev.orderId} → ${ev.toStatus}: ${err?.message ?? err}`,
      );
    }
  }

  private async push(
    order: {
      id: string;
      externalId: string | null;
      orderNumber: number | null;
      location: { prepTime: number | null } | null;
    },
    toStatus: string,
  ): Promise<void> {
    const id = encodeURIComponent(order.externalId!);

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
        return;
      }
      case "REJECTED": {
        await this.tolerateConflict(
          () =>
            this.client.request("POST", `/v1/delivery/order/${id}/deny`, {
              scopes: SCOPES,
              body: {
                deny_reason: {
                  type: "RESTAURANT_TOO_BUSY",
                  info: "Rejected on the restaurant POS",
                },
              },
            }),
          "deny",
          order.externalId!,
        );
        return;
      }
      case "CANCELLED": {
        await this.tolerateConflict(
          () =>
            this.client.request("POST", `/v1/delivery/order/${id}/cancel`, {
              scopes: SCOPES,
              body: {
                cancellation_reason: {
                  type: "OTHER",
                  info: "Cancelled by the restaurant",
                },
              },
            }),
          "cancel",
          order.externalId!,
        );
        return;
      }
      case "READY": {
        await this.tolerateConflict(
          () =>
            this.client.request("POST", `/v1/delivery/order/${id}/ready`, {
              scopes: SCOPES,
              body: {},
            }),
          "ready",
          order.externalId!,
        );
        return;
      }
      default:
        return; // PREPARING/driver states have no Uber-side call
    }
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
