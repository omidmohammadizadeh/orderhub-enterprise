// Phase BH — Stuart courier webhook handler.
//
// Stuart posts job/delivery updates as the courier moves through its stages.
// We resolve the local Order by courierJobId, write the driver-tracking columns
// (name/phone/tracking + timestamps) and bump Order.status to the matching
// stage via OrdersService.updateStatus(actor="WEBHOOK") — the same shape the
// HubRise delivery sync uses.

import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";

@Injectable()
export class StuartWebhookService {
  private readonly logger = new Logger(StuartWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  /** Stuart delivery/job status → our OrderStatus. null = leave order as-is. */
  private mapStatus(status: string | undefined): string | null {
    if (!status) return null;
    const s = status.toLowerCase();
    if (["new", "searching", "pending", "scheduled"].includes(s)) return null;
    if (["in_progress", "picking", "waiting_at_pickup", "almost_picking"].includes(s))
      return "ASSIGNED_DRIVER";
    if (["delivering", "in_delivery", "almost_delivering"].includes(s))
      return "OUT_FOR_DELIVERY";
    if (["delivered", "finished"].includes(s)) return "COMPLETED";
    if (["canceled", "cancelled", "expired", "voided"].includes(s))
      return "CANCELLED";
    return null;
  }

  async handle(body: any): Promise<{ ok: boolean; reason?: string }> {
    // Stuart wraps the resource under `data` on v2 webhooks; tolerate a bare body.
    const data = body?.data ?? body ?? {};
    const isDelivery = !!(data.job || data.driver || data.tracking_url);
    const delivery = isDelivery ? data : Array.isArray(data.deliveries) ? data.deliveries[0] : null;

    // The Stuart job id — matches Order.courierJobId (stored at dispatch).
    const jobId = String(
      data.job?.id ?? delivery?.job?.id ?? data.id ?? "",
    ).trim();
    if (!jobId) return { ok: false, reason: "no_job_id" };

    const order = await this.db().order.findFirst({
      where: { courierProvider: "STUART", courierJobId: jobId },
    });
    if (!order) {
      // Job we don't know (or webhook arrived before dispatch persisted).
      this.logger.warn(`Stuart webhook for unknown job ${jobId} — ignoring`);
      return { ok: true, reason: "order_not_found" };
    }

    const driver = delivery?.driver ?? data.driver ?? {};
    const status: string | undefined = delivery?.status ?? data.status;

    const updates: Record<string, any> = {};
    if (status) updates.courierStatus = status;
    if (driver?.name) updates.courierName = driver.name;
    if (driver?.phone) updates.courierPhone = driver.phone;

    // Courier position, when the network sends one. Same reasoning as the
    // Deliveroo path: store the point with the time it was taken, never
    // invent freshness, and refuse 0,0.
    const cLat = Number(driver?.latitude ?? driver?.location?.lat);
    const cLng = Number(driver?.longitude ?? driver?.location?.lng);
    if (
      Number.isFinite(cLat) &&
      Number.isFinite(cLng) &&
      !(cLat === 0 && cLng === 0)
    ) {
      updates.courierLat = cLat;
      updates.courierLng = cLng;
      updates.courierLocationAt = new Date();
    }

    const trackingUrl = delivery?.tracking_url ?? data.tracking_url;
    if (trackingUrl) updates.courierTrackingUrl = trackingUrl;

    const pickedAt = delivery?.pickup_at ?? delivery?.picked_at;
    const deliveredAt = delivery?.dropoff_at ?? delivery?.delivered_at;
    if (driver?.name && !order.courierAssignedAt) {
      updates.courierAssignedAt = new Date();
    }
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
                ? "Stuart courier cancelled the delivery"
                : undefined,
          } as any,
          "stuart-webhook",
          "WEBHOOK" as any,
        );
      } catch (err: any) {
        this.logger.warn(
          `Order ${order.id} → ${nextStatus} rejected: ${err?.message ?? err}`,
        );
      }
    }

    this.logger.log(
      `Stuart webhook job=${jobId} order=${order.id} status=${status ?? "?"} → ${nextStatus ?? "(unchanged)"} fields=${Object.keys(updates).length}`,
    );
    return { ok: true };
  }
}
