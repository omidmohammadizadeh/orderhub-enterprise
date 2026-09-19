import { Injectable, Logger, Optional } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { GlovoApiError, GlovoClientService } from "./glovo-client.service";
import { glovoStatusFor, type GlovoOutboundStatus } from "./glovo-order.mappers";

// Phase GL-3 — our board status, pushed back to Glovo.
//
//   PUT /webhook/stores/{storeId}/orders/{orderId}/status  { status }
//   ACCEPTED | READY_FOR_PICKUP | OUT_FOR_DELIVERY | PICKED_UP_BY_CUSTOMER
//
// Glovo's FAQ: "Is it required to send these statuses? Yes… it gives us a
// better understanding of preparation time and helps us give an accurate ETA."
//
// ── Cancel is NOT an API call ───────────────────────────────────────────
// "It is not possible to cancel or refuse orders via the API or via our
// Webapp. You'll need to call the client or our support to cancel an order."
// So when staff cancel a Glovo order on our board we cannot tell Glovo — the
// courier is still coming and the customer still expects food. That is
// surfaced as an ERROR on the Logs page naming the action required, rather
// than silently doing nothing.
//
// ── Sent at most once per status ────────────────────────────────────────
// order.status_changed fires on every transition, and ACCEPTED→PREPARING both
// map to Glovo's ACCEPTED. Glovo answers a second ACCEPTED with an error
// ("this order has been already accepted"). A WebhookEvent row keyed
// `out:<orderId>:<status>` is the send-once latch; it is released again if the
// call fails so a later transition can retry.

@Injectable()
export class GlovoOrderSyncService {
  private readonly logger = new Logger(GlovoOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: GlovoClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  @OnEvent("order.status_changed")
  async onStatusChanged(payload: {
    orderId: string;
    tenantId: string;
    actorType?: string;
  }): Promise<void> {
    // A transition a Glovo webhook caused (their cancel, the courier's pickup)
    // is Glovo's own news — echoing it back is at best noise and, for a
    // cancel, would tell staff to phone Glovo about Glovo's own cancellation.
    if (payload.actorType === "WEBHOOK") return;
    try {
      await this.sync(payload.orderId, payload.tenantId);
    } catch (err: any) {
      // Never rethrow into the status transition — our order has already moved.
      this.logger.error(`Glovo status sync threw for order ${payload.orderId}: ${err?.message}`);
    }
  }

  async sync(orderId: string, tenantId: string): Promise<{ sent: GlovoOutboundStatus | null; reason?: string }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId, platform: "GLOVO" as any },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        brandId: true,
        externalId: true,
        displayId: true,
        status: true,
        fulfillmentType: true,
        metadata: true,
      },
    });
    if (!order?.externalId) return { sent: null, reason: "not_glovo" };

    const meta = (order.metadata ?? {}) as Record<string, any>;
    // A simulated order has a made-up id Glovo has never heard of.
    if (meta.simulatedPlatform) return { sent: null, reason: "simulated" };

    const status = String(order.status);
    if (status === "CANCELLED" || status === "REJECTED") {
      this.activity?.record({
        tenantId: order.tenantId,
        locationId: order.locationId,
        brandId: order.brandId,
        category: "ORDERS",
        channel: "GLOVO",
        action: "order.cancel.push",
        status: "ERROR",
        message:
          `Glovo order ${order.displayId ?? order.externalId} was ${status.toLowerCase()} here, but Glovo has no ` +
          `cancel API — phone Glovo support to cancel it, or the courier will still come.`,
        details: { glovoOrderId: order.externalId },
      });
      return { sent: null, reason: "cancel_not_supported" };
    }

    const glovoStatus = glovoStatusFor(status, order.fulfillmentType as string | null);
    if (!glovoStatus) return { sent: null, reason: "no_glovo_equivalent" };
    if (!this.client.configured) return { sent: null, reason: "not_configured" };

    const storeId = await this.storeIdFor(order);
    if (!storeId) {
      this.logger.warn(`Glovo order ${order.externalId}: no store id — cannot push ${glovoStatus}`);
      return { sent: null, reason: "no_store_id" };
    }

    const latchId = `out:${order.externalId}:${glovoStatus}`;
    if (!(await this.acquireLatch(latchId, order))) {
      return { sent: null, reason: "already_sent" };
    }

    const path =
      `/webhook/stores/${encodeURIComponent(storeId)}` +
      `/orders/${encodeURIComponent(order.externalId)}/status`;
    try {
      await this.client.request("PUT", path, { body: { status: glovoStatus }, retries: 2 });
      this.logger.log(`Glovo order ${order.externalId} → ${glovoStatus}`);
      this.activity?.record({
        tenantId: order.tenantId,
        locationId: order.locationId,
        brandId: order.brandId,
        category: "ORDERS",
        channel: "GLOVO",
        action: "order.status.push",
        status: "SUCCESS",
        message: `Glovo order ${order.displayId ?? order.externalId} marked ${glovoStatus.replace(/_/g, " ").toLowerCase()} on Glovo`,
        details: { glovoOrderId: order.externalId, glovoStatus },
      });
      return { sent: glovoStatus };
    } catch (err: any) {
      const text = err instanceof GlovoApiError ? err.responseText : String(err?.message ?? err);
      // "already accepted" is the store's auto-accept (or the Partner Webapp)
      // getting there first. Harmless — keep the latch, it IS accepted.
      if (glovoStatus === "ACCEPTED" && /already\s+accepted/i.test(text)) {
        this.logger.log(`Glovo order ${order.externalId} was already accepted on Glovo's side`);
        return { sent: null, reason: "already_accepted" };
      }
      await this.releaseLatch(latchId);
      this.logger.error(`Glovo ${glovoStatus} failed for order ${order.externalId}: ${err?.message}`);
      this.activity?.record({
        tenantId: order.tenantId,
        locationId: order.locationId,
        brandId: order.brandId,
        category: "ORDERS",
        channel: "GLOVO",
        action: "order.status.push",
        status: "ERROR",
        message: `Could not tell Glovo order ${order.displayId ?? order.externalId} is ${glovoStatus.replace(/_/g, " ").toLowerCase()}: ${err?.message}`,
        details: { glovoOrderId: order.externalId, glovoStatus },
      });
      return { sent: null, reason: "request_failed" };
    }
  }

  /** The store id Glovo stamped on the order, else the connection's. */
  private async storeIdFor(order: {
    tenantId: string;
    locationId: string;
    brandId: string | null;
    metadata: unknown;
  }): Promise<string | null> {
    const fromOrder = (order.metadata as any)?.glovo?.storeId;
    if (fromOrder) return String(fromOrder);
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "GLOVO",
        tenantId: order.tenantId,
        locationId: order.locationId,
        ...(order.brandId ? { brandId: order.brandId } : {}),
        status: { not: "not_connected" },
      },
      select: { externalStoreId: true },
    });
    return conn?.externalStoreId ?? null;
  }

  private async acquireLatch(
    externalEventId: string,
    order: { tenantId: string; locationId: string; id: string },
  ): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          platform: "GLOVO",
          externalEventId,
          tenantId: order.tenantId,
          locationId: order.locationId,
          orderId: order.id,
          rawPayload: {},
          metadata: { direction: "outbound" },
          processedAt: new Date(),
        },
      });
      return true;
    } catch (e: any) {
      if (e?.code === "P2002") return false;
      // Bookkeeping failed for another reason — sending twice is better than
      // never telling Glovo the food is ready.
      this.logger.warn(`Glovo status latch write failed (${externalEventId}): ${e?.message}`);
      return true;
    }
  }

  private async releaseLatch(externalEventId: string): Promise<void> {
    await this.prisma.webhookEvent
      .delete({
        where: { platform_externalEventId: { platform: "GLOVO", externalEventId } },
      })
      .catch(() => undefined);
  }
}
