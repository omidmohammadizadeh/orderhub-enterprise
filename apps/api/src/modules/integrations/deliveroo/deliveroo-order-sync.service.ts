// Phase BA-4 — outbound Deliveroo order sync.
//
// Pushes dashboard status changes back to Deliveroo so accepting / preparing /
// ready happens HERE, not in the Deliveroo portal:
//
//   ACCEPTED  → PATCH /order/v1/orders/{id} {status:"accepted"}
//               then POST /order/v1/orders/{id}/sync_status {status:"succeeded"}
//               (sync_status only after the PATCH returns 2xx or 409 — a 409
//               means "already accepted", e.g. the operator raced us in the
//               portal, and is fine)
//   REJECTED  → PATCH {status:"rejected", reject_reason:"busy"}
//   CANCELLED → POST /order/v1/orders/{id}/cancel
//   PREPARING → POST /order/v1/orders/{id}/prep_stage {stage:"in_kitchen"}
//   READY     → prep_stage {stage:"ready_for_collection"}
//   COMPLETED → prep_stage {stage:"collected"} (pickup orders only — rider
//               orders complete via Deliveroo's own rider webhooks)
//
// Wired via the "order.status_changed" in-process event OrdersService emits
// after every committed transition (same decoupling as the WhatsApp notifier —
// no OrdersModule↔DeliverooModule cycle). Inbound webhook-driven transitions
// (actorType=WEBHOOK) are skipped: they CAME from Deliveroo, echoing them back
// would just 409. Best-effort by design — a failed push is logged, never
// thrown; the kitchen keeps moving regardless.

import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { DeliverooClientService } from "./deliveroo-client.service";

interface OrderStatusChangedEvent {
  orderId: string;
  tenantId: string;
  locationId: string;
  fromStatus: string;
  toStatus: string;
  actorType?: string;
}

@Injectable()
export class DeliverooOrderSyncService {
  private readonly logger = new Logger(DeliverooOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: DeliverooClientService,
  ) {}

  @OnEvent("order.status_changed")
  async onStatusChanged(ev: OrderStatusChangedEvent): Promise<void> {
    try {
      // Inbound echo guard — this transition was driven BY Deliveroo.
      if (ev.actorType === "WEBHOOK") return;

      const order = await this.prisma.order.findUnique({
        where: { id: ev.orderId },
        select: {
          id: true,
          platform: true,
          integrationSource: true,
          viaHubrise: true,
          externalId: true,
          fulfillmentType: true,
        },
      });
      if (
        !order ||
        order.platform !== "DELIVEROO" ||
        order.viaHubrise ||
        order.integrationSource !== "DIRECT" ||
        !order.externalId
      ) {
        return; // not a direct-Deliveroo order — HubRise path handles its own
      }

      await this.push(order.externalId, ev.toStatus, order.fulfillmentType);
    } catch (err: any) {
      this.logger.error(
        `Deliveroo status push failed for order ${ev.orderId} → ${ev.toStatus}: ${err?.message ?? err}`,
      );
    }
  }

  /** Map our status to the Deliveroo call(s) and fire them. */
  private async push(
    deliverooOrderId: string,
    toStatus: string,
    fulfillmentType: string,
  ): Promise<void> {
    const id = encodeURIComponent(deliverooOrderId);
    const occurred_at = new Date().toISOString();

    switch (toStatus) {
      case "ACCEPTED": {
        await this.tolerating409(
          () =>
            this.client.request("PATCH", `/order/v1/orders/${id}`, {
              status: "accepted",
            }),
          "accept",
          deliverooOrderId,
        );
        // Confirm the order reached the POS. Required by Deliveroo's flow;
        // only sent after the accept PATCH succeeded (2xx) or 409'd.
        await this.client.request("POST", `/order/v1/orders/${id}/sync_status`, {
          status: "succeeded",
          occurred_at,
        });
        this.logger.log(`Deliveroo order ${deliverooOrderId} accepted + synced`);
        return;
      }
      case "REJECTED": {
        await this.tolerating409(
          () =>
            this.client.request("PATCH", `/order/v1/orders/${id}`, {
              status: "rejected",
              reject_reason: "busy",
            }),
          "reject",
          deliverooOrderId,
        );
        this.logger.log(`Deliveroo order ${deliverooOrderId} rejected`);
        return;
      }
      case "CANCELLED": {
        await this.tolerating409(
          () =>
            this.client.request("POST", `/order/v1/orders/${id}/cancel`, {
              reason: "CAPACITY_EXCEEDED",
            }),
          "cancel",
          deliverooOrderId,
        );
        this.logger.log(`Deliveroo order ${deliverooOrderId} cancelled`);
        return;
      }
      case "PREPARING":
        return this.prepStage(deliverooOrderId, "in_kitchen", occurred_at);
      case "READY":
        return this.prepStage(
          deliverooOrderId,
          "ready_for_collection",
          occurred_at,
        );
      case "COMPLETED": {
        // Rider-delivered orders complete via Deliveroo's rider events; only
        // customer-collection orders are completed from our side.
        if (fulfillmentType === "PICKUP") {
          return this.prepStage(deliverooOrderId, "collected", occurred_at);
        }
        return;
      }
      default:
        return; // courier-side + intermediate states are inbound-only
    }
  }

  private async prepStage(
    deliverooOrderId: string,
    stage: string,
    occurred_at: string,
  ): Promise<void> {
    await this.client.request(
      "POST",
      `/order/v1/orders/${encodeURIComponent(deliverooOrderId)}/prep_stage`,
      { stage, occurred_at },
    );
    this.logger.log(`Deliveroo order ${deliverooOrderId} prep_stage=${stage}`);
  }

  /**
   * Run a Deliveroo call, treating a 409 as success. Deliveroo returns 409
   * when the order is already in the requested state (e.g. accepted in the
   * portal before our push landed) — that's convergence, not failure.
   */
  private async tolerating409(
    fn: () => Promise<unknown>,
    label: string,
    deliverooOrderId: string,
  ): Promise<void> {
    try {
      await fn();
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (msg.includes("→ 409")) {
        this.logger.log(
          `Deliveroo ${label} for ${deliverooOrderId} returned 409 (already in state) — continuing`,
        );
        return;
      }
      throw err;
    }
  }
}
