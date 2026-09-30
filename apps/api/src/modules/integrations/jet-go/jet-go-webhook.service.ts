// Phase BJ — JET Go courier webhook handler.
//
// JET posts nine event types to one endpoint, each as { id, type, timestamp,
// data }. Everything routes off data.requestId, which is the id our dispatch
// stored in Order.courierJobId, with data.metadata.orderId as a backstop.
//
// Things this handler exists to get right:
//
//  • ASSIGNED does NOT mean a courier is coming. JET's own docs say an offer may
//    go to several couriers and you can get several ASSIGNED events. The real
//    confirmation is IN_TRANSIT_TO_COLLECT, so only that moves the order.
//  • orderTrackerURL is CA-only and comes back as the literal string
//    "Not available" elsewhere. Storing that would put a dead "Track courier"
//    link in front of a customer.
//  • CANCELJOBSTATUS carries status true/false — false means the cancellation
//    FAILED and the courier is still coming, so clearing the order then would
//    lose a live delivery.
//  • JET retries nothing. A missed webhook is gone, which is why there is a
//    manual "refresh status" path in the dispatch service.

import { forwardRef, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { WalletService } from "../../wallet/wallet.service";
import { ActivityLogService } from "../../logs/activity-log.service";

/** Courier job statuses, mapped to our OrderStatus. null = record it but don't
 *  move the order. */
const STATUS_MAP: Record<string, string | null> = {
  UNASSIGNED: null,
  // An offer out to couriers — not an acceptance. Deliberately null.
  ASSIGNED: null,
  IN_TRANSIT_TO_COLLECT: "ASSIGNED_DRIVER",
  ARRIVED_TO_COLLECT: "ASSIGNED_DRIVER",
  COLLECTED: "OUT_FOR_DELIVERY",
  IN_TRANSIT_TO_DELIVER: "OUT_FOR_DELIVERY",
  ARRIVED_TO_DELIVER: "OUT_FOR_DELIVERY",
  DELIVERED: "COMPLETED",
  CANCELLED: "CANCELLED",
  // A return means the food is coming back to the shop. That is a money and
  // refund decision, so it is surfaced and left to the operator rather than
  // silently cancelling a paid order.
  RETURN_INITIATED: null,
  IN_TRANSIT_TO_RETURN: null,
  RETURNED: null,
};

const COURIER_FIELDS_CLEARED = {
  courierProvider: null,
  courierJobId: null,
  courierDeliveryId: null,
  courierName: null,
  courierPhone: null,
  courierPhoneAccessCode: null,
  courierTrackingUrl: null,
  courierStatus: null,
  courierAssignedAt: null,
  courierPickedUpAt: null,
  courierDeliveredAt: null,
  courierEtaAt: null,
  courierPickupEtaAt: null,
  courierLat: null,
  courierLng: null,
  courierLocationAt: null,
  deliveryType: null,
};

@Injectable()
export class JetGoWebhookService {
  private readonly logger = new Logger(JetGoWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
    private readonly wallet: WalletService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  private str(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
  }

  private asDate(v: unknown): Date | null {
    if (typeof v !== "string" || !v.trim()) return null;
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  /** JET sends "Not available" (CA-only feature) rather than omitting the field. */
  private trackingUrl(v: unknown): string | null {
    const s = this.str(v);
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) return null;
    return s;
  }

  private async findOrder(data: any) {
    const requestId = this.str(data?.requestId);
    if (requestId) {
      const byRequest = await this.db().order.findFirst({
        where: { courierProvider: "JET_GO", courierJobId: requestId },
      });
      if (byRequest) return byRequest;
    }
    // Backstop: the metadata we sent on /delivery comes back on every event, so a
    // requestId that somehow didn't match still resolves.
    const metaOrderId = this.str(data?.metadata?.orderId);
    if (metaOrderId) {
      const byMeta = await this.db().order.findUnique({ where: { id: metaOrderId } });
      if (byMeta) return byMeta;
    }
    return null;
  }

  /** Merge a patch into Order.metadata.jetGo without clobbering the rest. */
  private async mergeJetGoMeta(order: any, patch: Record<string, unknown>) {
    const meta = ((order.metadata ?? {}) as Record<string, any>) ?? {};
    const jetGo = { ...((meta.jetGo ?? {}) as Record<string, any>), ...patch };
    await this.db().order.update({
      where: { id: order.id },
      data: { metadata: { ...meta, jetGo } },
    });
  }

  async handle(body: any): Promise<{ ok: boolean; reason?: string; type?: string }> {
    const type = this.str(body?.type).toUpperCase();
    const data = body?.data ?? {};
    if (!type) return { ok: false, reason: "no_type" };

    const order = await this.findOrder(data);
    if (!order) {
      this.logger.warn(
        `JET Go ${type} for unknown request ${this.str(data?.requestId) || "(none)"} — ignoring`,
      );
      return { ok: true, reason: "order_not_found", type };
    }

    switch (type) {
      case "DELIVERYCREATED":
        return this.onDeliveryCreated(order, data, type);
      case "COURIERJOBSTATUS":
        return this.onCourierJobStatus(order, data, type);
      case "COURIERCOLLECTIONTIME":
        return this.onCollectionTime(order, data, type);
      case "COURIERDELIVERYTIME":
        return this.onDeliveryTime(order, data, type);
      case "COURIERLOCATION":
        return this.onCourierLocation(order, data, type);
      case "CANCELJOBSTATUS":
        return this.onCancelJobStatus(order, data, type);
      case "DELIVERYREJECTED":
        return this.onDeliveryRejected(order, data, type);
      case "PROOFOFDELIVERY":
        return this.onProofOfDelivery(order, data, type);
      case "PICTUREASPROOFOFDELIVERY":
        return this.onPictureProof(order, data, type);
      default:
        this.logger.log(`JET Go webhook type ${type} not handled — acknowledged`);
        return { ok: true, reason: "unhandled_type", type };
    }
  }

  /** The confirmation that /delivery's 202 actually became a delivery. */
  private async onDeliveryCreated(order: any, data: any, type: string) {
    const deliveryId = this.str(data?.deliveryId);
    await this.db().order.update({
      where: { id: order.id },
      data: {
        courierStatus: "CREATED",
        ...(deliveryId ? { courierDeliveryId: deliveryId } : {}),
      },
    });
    this.activity?.record({
      tenantId: order.tenantId,
      locationId: order.locationId,
      category: "ORDERS",
      channel: "JET_GO",
      action: "courier.created",
      status: "SUCCESS",
      message: `JET Go confirmed the delivery for order ${order.displayId ?? order.id}`,
      details: { requestId: this.str(data?.requestId), deliveryId },
    });
    this.logger.log(`JET Go DELIVERYCREATED order=${order.id} delivery=${deliveryId || "?"}`);
    return { ok: true, type };
  }

  private async onCourierJobStatus(order: any, data: any, type: string) {
    const status = this.str(data?.status).toUpperCase();
    const courier = data?.courier ?? {};
    const isReturn = data?.deliveryProperties?.isReturn === true;

    const updates: Record<string, any> = {};
    if (status) updates.courierStatus = status;
    const deliveryId = this.str(data?.deliveryId);
    if (deliveryId && !order.courierDeliveryId) updates.courierDeliveryId = deliveryId;
    const courierName = this.str(courier?.name);
    if (courierName) updates.courierName = courierName;
    const tracking = this.trackingUrl(data?.orderTrackerURL);
    if (tracking) updates.courierTrackingUrl = tracking;

    const at = this.asDate(data?.timestamp) ?? new Date();
    // IN_TRANSIT_TO_COLLECT is the first status that means a courier is actually
    // committed, so that is when the order gets an assignment time.
    if (status === "IN_TRANSIT_TO_COLLECT" && !order.courierAssignedAt) {
      updates.courierAssignedAt = at;
    }
    if (status === "COLLECTED" && !order.courierPickedUpAt) updates.courierPickedUpAt = at;
    if (status === "DELIVERED" && !order.courierDeliveredAt) updates.courierDeliveredAt = at;

    if (Object.keys(updates).length) {
      await this.db().order.update({ where: { id: order.id }, data: updates });
    }

    if (isReturn || status.includes("RETURN")) {
      this.activity?.record({
        tenantId: order.tenantId,
        locationId: order.locationId,
        category: "ORDERS",
        channel: "JET_GO",
        action: "courier.return",
        status: "WARNING",
        message:
          `JET Go is returning order ${order.displayId ?? order.id} to the shop (${status || "return"}) — ` +
          `decide whether to refund the customer.`,
        details: {
          requestId: this.str(data?.requestId),
          reason: this.str(data?.deliveryProperties?.reasonForReturn) || null,
        },
      });
    }

    const next = STATUS_MAP[status] ?? null;
    if (next && next !== order.status) {
      try {
        await this.orders.updateStatus(
          order.id,
          order.tenantId,
          {
            status: next as any,
            cancelReason:
              next === "CANCELLED" ? "JET Go courier cancelled the delivery" : undefined,
          } as any,
          "jet-go-webhook",
          "WEBHOOK" as any,
        );
      } catch (err: any) {
        this.logger.warn(`Order ${order.id} → ${next} rejected: ${err?.message ?? err}`);
      }
    }

    this.logger.log(
      `JET Go COURIERJOBSTATUS order=${order.id} status=${status || "?"} → ${next ?? "(unchanged)"}`,
    );
    return { ok: true, type };
  }

  /** ETA at the SHOP. Kept apart from the customer ETA on purpose. */
  private async onCollectionTime(order: any, data: any, type: string) {
    const eta = this.asDate(data?.courierETA);
    if (!eta) return { ok: true, reason: "no_eta", type };
    await this.db().order.update({
      where: { id: order.id },
      data: { courierPickupEtaAt: eta },
    });
    return { ok: true, type };
  }

  /** ETA at the CUSTOMER. */
  private async onDeliveryTime(order: any, data: any, type: string) {
    const eta = this.asDate(data?.postPurchaseDeliveryEta);
    if (!eta) return { ok: true, reason: "no_eta", type };
    await this.db().order.update({ where: { id: order.id }, data: { courierEtaAt: eta } });
    return { ok: true, type };
  }

  private async onCourierLocation(order: any, data: any, type: string) {
    const lat = Number(data?.latitude);
    const lng = Number(data?.longitude);
    // 0,0 is the Atlantic, not a courier. A pin with no timestamp is a lie, so
    // the position and the time it was taken are always written together.
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      return { ok: true, reason: "no_location", type };
    }
    await this.db().order.update({
      where: { id: order.id },
      data: {
        courierLat: lat,
        courierLng: lng,
        courierLocationAt: this.asDate(data?.timestamp) ?? new Date(),
      },
    });
    return { ok: true, type };
  }

  /** Fires for our own cancel call AND when a JET agent or the platform's
   *  unassigned-delivery timeout cancels for us. */
  private async onCancelJobStatus(order: any, data: any, type: string) {
    // `status` is documented as true/false and arrives as either a boolean or a
    // string. false means the cancellation was REFUSED — the courier is still
    // coming, so touching the order would lose a live delivery.
    const raw = data?.status;
    const succeeded = raw === true || this.str(raw).toLowerCase() === "true";
    const message = this.str(data?.message);

    if (!succeeded) {
      await this.db().order.update({
        where: { id: order.id },
        data: { courierStatus: "CANCELLATION_FAILURE" },
      });
      this.activity?.record({
        tenantId: order.tenantId,
        locationId: order.locationId,
        category: "ORDERS",
        channel: "JET_GO",
        action: "courier.cancel_failed",
        status: "ERROR",
        message: `JET Go refused to cancel order ${order.displayId ?? order.id}${message ? `: ${message}` : ""} — the courier is still coming.`,
        details: { requestId: this.str(data?.requestId), jetMessage: message },
      });
      return { ok: true, reason: "cancellation_refused", type };
    }

    // Did WE ask for this, or did JET cancel on us? A platform-side cancellation
    // (no courier found before the timeout, or a JET agent) means the shop paid
    // our dispatch fee for a courier that never came, so that fee goes back.
    // Operator-requested cancellations don't refund, or cancel/re-dispatch would
    // be a free loop.
    const weAskedForIt = order.courierStatus === "CANCELLATION_REQUESTED";

    // Clearing courierProvider is also the idempotency guard: a duplicate
    // CANCELJOBSTATUS no longer resolves to this order, so nothing refunds twice.
    await this.db().order.update({
      where: { id: order.id },
      data: { ...COURIER_FIELDS_CLEARED },
    });

    if (!weAskedForIt) {
      try {
        await this.wallet.refundDispatch({
          tenantId: order.tenantId,
          locationId: order.locationId,
          orderId: order.id,
          amountMinor: this.wallet.dispatchFeeMinor(),
          createdBy: null,
        });
      } catch (err: any) {
        this.logger.warn(
          `JET Go dispatch-fee refund failed for order ${order.id}: ${err?.message ?? err}`,
        );
      }
    }

    // The order itself survives. The food is still made and still owed to the
    // customer — it just has no courier — so it goes back on the board as READY
    // for the operator to re-dispatch or drive themselves.
    if (!["COMPLETED", "CANCELLED"].includes(String(order.status))) {
      try {
        await this.orders.updateStatus(
          order.id,
          order.tenantId,
          { status: "READY" as any } as any,
          "jet-go-webhook",
          "WEBHOOK" as any,
        );
      } catch (err: any) {
        this.logger.warn(
          `Order ${order.id} → READY after JET Go cancellation rejected: ${err?.message ?? err}`,
        );
      }
    }

    this.activity?.record({
      tenantId: order.tenantId,
      locationId: order.locationId,
      category: "ORDERS",
      channel: "JET_GO",
      action: weAskedForIt ? "courier.cancelled" : "courier.cancelled_by_jet",
      status: weAskedForIt ? "INFO" : "WARNING",
      message: weAskedForIt
        ? `JET Go confirmed the cancellation for order ${order.displayId ?? order.id}.`
        : `JET Go cancelled order ${order.displayId ?? order.id}${message ? `: ${message}` : ""} — it needs dispatching again. The dispatch fee was refunded.`,
      details: { requestId: this.str(data?.requestId), jetMessage: message },
    });

    this.logger.log(
      `JET Go CANCELJOBSTATUS order=${order.id} confirmed (${weAskedForIt ? "operator-requested" : "platform-initiated, fee refunded"})`,
    );
    return { ok: true, type };
  }

  /** EU-only: the delivery request failed asynchronously, after our 202. The
   *  wallet fee has to come back — no courier was ever booked. */
  private async onDeliveryRejected(order: any, data: any, type: string) {
    const message = this.str(data?.message);
    await this.db().order.update({
      where: { id: order.id },
      data: { ...COURIER_FIELDS_CLEARED },
    });
    try {
      await this.wallet.refundDispatch({
        tenantId: order.tenantId,
        locationId: order.locationId,
        orderId: order.id,
        amountMinor: this.wallet.dispatchFeeMinor(),
        createdBy: null,
      });
    } catch (err: any) {
      this.logger.warn(
        `JET Go dispatch-fee refund failed for order ${order.id}: ${err?.message ?? err}`,
      );
    }
    this.activity?.record({
      tenantId: order.tenantId,
      locationId: order.locationId,
      category: "ORDERS",
      channel: "JET_GO",
      action: "courier.rejected",
      status: "ERROR",
      message: `JET Go rejected the delivery for order ${order.displayId ?? order.id}${message ? `: ${message}` : ""}. The dispatch fee was refunded — dispatch it again.`,
      details: { requestId: this.str(data?.requestId), jetMessage: message },
    });
    this.logger.warn(`JET Go DELIVERYREJECTED order=${order.id}: ${message || "(no reason)"}`);
    return { ok: true, type };
  }

  /** PIN-protected deliveries: status CREATED carries the PIN the customer has to
   *  give the courier, then VALID/INVALID once it's entered. The shop needs the
   *  PIN to answer "what's my code?", so it's stored on the order. */
  private async onProofOfDelivery(order: any, data: any, type: string) {
    const status = this.str(data?.status).toUpperCase();
    const pin = this.str(data?.pinCode);
    await this.mergeJetGoMeta(order, {
      ...(pin ? { pinCode: pin } : {}),
      ...(status ? { pinStatus: status } : {}),
      pinUpdatedAt: new Date().toISOString(),
    });
    if (status === "INVALID") {
      this.activity?.record({
        tenantId: order.tenantId,
        locationId: order.locationId,
        category: "ORDERS",
        channel: "JET_GO",
        action: "courier.pin_invalid",
        status: "WARNING",
        message: `A JET Go courier entered the wrong delivery PIN for order ${order.displayId ?? order.id}.`,
        details: { requestId: this.str(data?.requestId) },
      });
    }
    return { ok: true, type };
  }

  /** Photo proof. The URLs expire in about five minutes, so the timestamp beside
   *  them is what stops the dashboard offering a dead link as if it were live. */
  private async onPictureProof(order: any, data: any, type: string) {
    const urls = Array.isArray(data?.urls)
      ? data.urls.filter((u: unknown) => typeof u === "string")
      : this.str(data?.urls)
        ? [this.str(data.urls)]
        : [];
    if (!urls.length) return { ok: true, reason: "no_urls", type };
    await this.mergeJetGoMeta(order, {
      proofPhotoUrls: urls,
      proofPhotoAt: new Date().toISOString(),
    });
    return { ok: true, type };
  }
}
