// Phase BI — Uber Direct courier webhook handler.
//
// Uber posts delivery-status + courier-update events. We resolve the local
// Order by courierJobId (= Uber delivery id), write the driver-tracking columns
// and fast-forward Order.status via OrdersService.updateStatus(actor=WEBHOOK) —
// same shape as HubRise/Stuart.

import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";

@Injectable()
export class UberDirectWebhookService {
  private readonly logger = new Logger(UberDirectWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  /** Uber Direct delivery status → our OrderStatus. null = leave as-is. */
  private mapStatus(status: string | undefined): string | null {
    if (!status) return null;
    const s = status.toLowerCase();
    if (["pending"].includes(s)) return null;
    if (["pickup"].includes(s)) return "ASSIGNED_DRIVER";
    if (["pickup_complete", "dropoff"].includes(s)) return "OUT_FOR_DELIVERY";
    if (["delivered"].includes(s)) return "COMPLETED";
    if (["canceled", "cancelled", "returned"].includes(s)) return "CANCELLED";
    return null;
  }

  async handle(body: any): Promise<{ ok: boolean; reason?: string }> {
    const data = body?.data ?? body ?? {};
    const deliveryId = String(
      body?.delivery_id ?? data?.id ?? body?.id ?? "",
    ).trim();
    if (!deliveryId) return { ok: false, reason: "no_delivery_id" };

    const order = await this.db().order.findFirst({
      where: { courierProvider: "UBER_DIRECT", courierJobId: deliveryId },
    });
    if (!order) {
      this.logger.warn(
        `Uber Direct webhook for unknown delivery ${deliveryId} — ignoring`,
      );
      return { ok: true, reason: "order_not_found" };
    }

    const courier = data?.courier ?? {};
    const status: string | undefined = body?.status ?? data?.status;

    const updates: Record<string, any> = {};
    if (status) updates.courierStatus = status;
    if (courier?.name) updates.courierName = courier.name;
    if (courier?.phone_number) updates.courierPhone = courier.phone_number;

    // Courier position, when the network sends one. Same reasoning as the
    // Deliveroo path: store the point with the time it was taken, never
    // invent freshness, and refuse 0,0.
    const cLat = Number(courier?.location?.lat ?? courier?.latitude);
    const cLng = Number(courier?.location?.lng ?? courier?.location?.lon ?? courier?.longitude);
    if (
      Number.isFinite(cLat) &&
      Number.isFinite(cLng) &&
      !(cLat === 0 && cLng === 0)
    ) {
      updates.courierLat = cLat;
      updates.courierLng = cLng;
      updates.courierLocationAt = new Date();
    }

    const trackingUrl = data?.tracking_url ?? body?.tracking_url;
    if (trackingUrl) updates.courierTrackingUrl = trackingUrl;
    if (courier?.name && !order.courierAssignedAt) {
      updates.courierAssignedAt = new Date();
    }
    const pickedAt = data?.pickup?.status_timestamp ?? data?.picked_up_at;
    const deliveredAt = data?.dropoff?.status_timestamp ?? data?.delivered_at;
    if (pickedAt && !order.courierPickedUpAt) {
      const d = new Date(pickedAt);
      if (Number.isFinite(d.getTime())) updates.courierPickedUpAt = d;
    }
    if (deliveredAt && !order.courierDeliveredAt) {
      const d = new Date(deliveredAt);
      if (Number.isFinite(d.getTime())) updates.courierDeliveredAt = d;
    }

    if (Object.keys(updates).length) {
      await this.db().order.update({ where: { id: order.id }, data: updates });
    }

    const nextStatus = this.mapStatus(status);
    if (nextStatus && nextStatus !== order.status) {
      try {
        await this.orders.updateStatus(
          order.id,
          order.tenantId,
          {
            status: nextStatus as any,
            cancelReason:
              nextStatus === "CANCELLED"
                ? "Uber Direct courier cancelled the delivery"
                : undefined,
          } as any,
          "uber-direct-webhook",
          "WEBHOOK" as any,
        );
      } catch (err: any) {
        this.logger.warn(
          `Order ${order.id} → ${nextStatus} rejected: ${err?.message ?? err}`,
        );
      }
    }

    this.logger.log(
      `Uber Direct webhook delivery=${deliveryId} order=${order.id} status=${status ?? "?"} → ${nextStatus ?? "(unchanged)"} fields=${Object.keys(updates).length}`,
    );
    return { ok: true };
  }
}
