// Phase BH — Stuart courier webhook handler.
//
// Stuart posts job/delivery updates as the courier moves through its stages.
// We resolve the local Order by its leg (courierDeliveryId — one job can carry
// several orders), falling back to courierJobId, write the driver-tracking columns
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

  /**
   * One Stuart job can carry several orders (a multi-drop run), each its own
   * delivery. A JOB event lists every leg under `deliveries`; a DELIVERY event
   * is one leg, pointing back at its job. Either way each leg is applied to
   * its own order.
   *
   * This used to find "the order with this job id" and apply the event to it.
   * With one order per job that was the same thing; on a run every order
   * shares the job id, so one arbitrary order took every update and the rest
   * never moved.
   */
  async handle(body: any): Promise<{ ok: boolean; reason?: string }> {
    // Stuart wraps the resource under `data` on v2 webhooks; tolerate a bare body.
    const data = body?.data ?? body ?? {};
    const str = (v: unknown) => {
      const s = v == null ? "" : String(v).trim();
      return s || null;
    };

    // JOB event: every leg is listed. Apply each to its own order.
    if (Array.isArray(data.deliveries) && data.deliveries.length > 0) {
      const jobId = str(data.id);
      let applied = 0;
      for (const leg of data.deliveries) {
        if (await this.applyLeg(leg, str(leg?.id), jobId, data)) applied += 1;
      }
      return applied > 0 ? { ok: true } : { ok: true, reason: "order_not_found" };
    }

    // DELIVERY event: `data` is the leg and points at its job. Without a job
    // reference it is a bare job event, whose top-level id is the job's.
    const jobId = str(data.job?.id) ?? str(data.id);
    const legId = data.job ? str(data.id) : null;
    if (!jobId && !legId) return { ok: false, reason: "no_job_id" };
    const applied = await this.applyLeg(data, legId, jobId, null);
    return applied ? { ok: true } : { ok: true, reason: "order_not_found" };
  }

  /**
   * The order a leg belongs to.
   *
   * By the leg's own delivery id first. Otherwise by job id — but only when
   * exactly one order is on that job, which is every single dispatch, old or
   * new. When several orders share the job (a run) and the event doesn't say
   * which leg it is, it is not guessed at: applying it to "the first order on
   * the job" is precisely the bug this replaced.
   */
  private async orderForLeg(legId: string | null, jobId: string | null) {
    if (legId) {
      const byLeg = await this.db().order.findFirst({
        where: { courierProvider: "STUART", courierDeliveryId: legId },
      });
      if (byLeg) return byLeg;
    }
    if (jobId) {
      const onJob = await this.db().order.findMany({
        where: { courierProvider: "STUART", courierJobId: jobId },
        take: 2,
      });
      if (onJob.length === 1) return onJob[0];
      if (onJob.length > 1) {
        this.logger.warn(
          `Stuart webhook for run ${jobId} named no leg — not applying it to a guessed order`,
        );
      }
    }
    return null;
  }

  /** Apply one leg's state to its order. Resolves true when an order matched. */
  private async applyLeg(
    delivery: any,
    legId: string | null,
    jobId: string | null,
    job: any | null,
  ): Promise<boolean> {
    const order = await this.orderForLeg(legId, jobId);
    if (!order) {
      // Job we don't know (or webhook arrived before dispatch persisted).
      this.logger.warn(
        `Stuart webhook for unknown job ${jobId ?? "?"} leg ${legId ?? "?"} — ignoring`,
      );
      return false;
    }

    // Driver and status are per leg, with the job's as a fallback — one
    // courier carries the whole run, so the job's driver is every leg's.
    const driver = delivery?.driver ?? job?.driver ?? {};
    const status: string | undefined = delivery?.status ?? job?.status;

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

    // Each leg has its own tracking link (it follows the courier to THAT
    // customer's door). The job's link is only a fallback for a one-leg job —
    // on a run it would overwrite every order's link with the same one.
    const trackingUrl =
      delivery?.tracking_url ??
      (job && job.deliveries?.length === 1 ? job.tracking_url : undefined);
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
      `Stuart webhook job=${jobId} leg=${legId ?? "?"} order=${order.id} status=${status ?? "?"} → ${nextStatus ?? "(unchanged)"} fields=${Object.keys(updates).length}`,
    );
    return true;
  }
}
