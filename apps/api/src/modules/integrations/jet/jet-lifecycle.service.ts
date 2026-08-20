import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import {
  describeJetCancellation,
  mapJetCancellationStatus,
  mapJetDriverStatus,
} from "./jet-order.mappers";

// Phase JE-2 — JET Connect order-lifecycle notifications.
//
// Four inbound webhooks, all fire-and-forget notifications rather than
// requests: cancellation, driver status, restaurant temporarily offline, and
// an order that failed JET's own validation.
//
// The driver handler is modelled on HubRiseDeliverySyncService: write the flat
// courier columns, then bump Order.status through updateStatus with
// actorType "WEBHOOK" so the operator's PLATFORM gate is bypassed cleanly and
// the state machine's fast-forward rule applies (a courier routinely reports
// "delivered" while the kitchen still shows PREPARING).
//
// Everything here is inbound-only. Nothing in this file writes to JET.

export interface JetLifecycleResult {
  handled: boolean;
  reason?: string;
  orderId?: string;
}

@Injectable()
export class JetLifecycleService {
  private readonly logger = new Logger(JetLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  // ── Cancellation ─────────────────────────────────────────────────────

  /**
   * `{ orderID, reason: { code }, initiatedBy?: { code }, happenedAt }`
   *
   * The reason code decides whether this lands as CANCELLED or REJECTED —
   * see mapJetCancellationStatus. That is not cosmetic: "the restaurant
   * refused it" and "the customer changed their mind" mean different things to
   * the operator's reporting and to whether the cancellation counts against
   * them.
   */
  async handleCancellation(payload: any): Promise<JetLifecycleResult> {
    const jetOrderId = String(payload?.orderID ?? payload?.orderId ?? "").trim();
    if (!jetOrderId) return { handled: false, reason: "no_order_id" };

    const order = await this.findOrder(jetOrderId);
    if (!order) {
      // A cancellation can outrun the order itself, or belong to a restaurant
      // that is not ours. Either way there is nothing to cancel.
      this.logger.warn(
        `JET cancellation for unknown order ${jetOrderId} — ignoring`,
      );
      return { handled: false, reason: "order_not_found" };
    }

    const code = payload?.reason?.code;
    const initiatedBy = payload?.initiatedBy?.code;
    const status = mapJetCancellationStatus(code);
    const reason = describeJetCancellation(code, initiatedBy);

    if (order.status === status) return { handled: false, reason: "no_change", orderId: order.id };

    try {
      await this.orders.updateStatus(
        order.id,
        order.tenantId,
        { status: status as any, cancelReason: reason } as any,
        "jet-cancel-webhook",
        "WEBHOOK",
      );
      this.logger.log(
        `JET cancellation ${jetOrderId}: ${order.status} → ${status} (${code ?? "no code"})`,
      );
      this.activity?.record({
        tenantId: order.tenantId,
        locationId: order.locationId,
        brandId: order.brandId,
        category: "ORDERS",
        channel: "JUST_EAT",
        action: "order.cancelled",
        status: "WARNING",
        message: `Just Eat order ${order.displayId ?? jetOrderId}: ${reason}`,
        details: { jetOrderId, code, initiatedBy, status },
      });
      return { handled: true, orderId: order.id };
    } catch (err: any) {
      // An already-terminal order refuses the transition. Log and swallow —
      // the notification is still acknowledged, since JET retrying will not
      // make an ended order cancellable.
      this.logger.warn(
        `JET cancellation ${jetOrderId} → ${status} rejected: ${err?.message}`,
      );
      return { handled: false, reason: "transition_rejected", orderId: order.id };
    }
  }

  // ── Driver status ────────────────────────────────────────────────────

  /**
   * `{ orderID, driverStatus: { code }, happenedAt }`
   *
   * Only four codes exist: driverArrivingAtRestaurant, driverAtRestaurant,
   * onItsWay, delivered. Unlike Deliveroo there is no status history to
   * reconcile and no missing terminal event, so this is a straight mapping —
   * but the milestone timestamps are still FIRST-VALUE-WINS so a redelivered
   * notification cannot overwrite the real pickup time with a later one.
   */
  async handleDriverStatus(payload: any): Promise<JetLifecycleResult> {
    const jetOrderId = String(payload?.orderID ?? payload?.orderId ?? "").trim();
    if (!jetOrderId) return { handled: false, reason: "no_order_id" };

    const code = String(payload?.driverStatus?.code ?? "").trim();
    const mapped = mapJetDriverStatus(code);

    const order = await this.findOrder(jetOrderId);
    if (!order) {
      this.logger.warn(
        `JET driver status for unknown order ${jetOrderId} — ignoring`,
      );
      return { handled: false, reason: "order_not_found" };
    }

    // JET's own timestamp for the event, so a delayed delivery is recorded at
    // the moment it happened rather than the moment we processed it.
    const happenedAt = this.parseDate(payload?.happenedAt) ?? new Date();
    const o = order as any;
    const updates: Record<string, any> = {};
    if (code) updates.courierStatus = code;
    if (mapped === "ASSIGNED_DRIVER" && !o.courierAssignedAt) {
      updates.courierAssignedAt = happenedAt;
    }
    if (mapped === "OUT_FOR_DELIVERY" && !o.courierPickedUpAt) {
      updates.courierPickedUpAt = happenedAt;
    }
    if (mapped === "COMPLETED" && !o.courierDeliveredAt) {
      updates.courierDeliveredAt = happenedAt;
    }
    if (Object.keys(updates).length) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: updates as any,
      });
    }

    let statusChanged = false;
    if (mapped && mapped !== order.status) {
      try {
        await this.orders.updateStatus(
          order.id,
          order.tenantId,
          { status: mapped as any } as any,
          "jet-driver-webhook",
          "WEBHOOK",
        );
        statusChanged = true;
      } catch (err: any) {
        // The courier lifecycle runs ahead of the kitchen one. The courier
        // columns are already written, so the drawer still shows the truth
        // even when the board's status refuses to move.
        this.logger.warn(
          `JET driver status ${jetOrderId} → ${mapped} rejected: ${err?.message}`,
        );
      }
    }

    this.logger.log(
      `JET driver ${jetOrderId}: code=${code || "?"} ` +
        `order_status=${mapped ?? "(unchanged)"} fields=${Object.keys(updates).length}`,
    );
    return {
      handled: Object.keys(updates).length > 0 || statusChanged,
      orderId: order.id,
      ...(mapped ? {} : { reason: `unmapped_code:${code}` }),
    };
  }

  // ── Restaurant temporarily offline ───────────────────────────────────

  /**
   * `{ restaurantId, lastChangedTimeStampUtc, collection|delivery|dineIn:
   *    { isOffline, allowRestaurantOverride? } }`
   *
   * JET telling US that a service type went offline (or came back) on their
   * side — someone paused the shop in their tooling, or JET paused it.
   *
   * DELIBERATELY DOES NOT PAUSE US. It would be easy to mirror this onto our
   * own ChannelPause and call it "keeping things in sync", but this webhook
   * fires for JET-side decisions the operator did not make on our dashboard,
   * and a marketplace's pause silently stopping the shop's own online ordering
   * and POS is a surprise nobody asked for. We record the state, surface it in
   * the activity feed, and leave the decision with the operator.
   */
  async handleRestaurantTempOffline(payload: any): Promise<JetLifecycleResult> {
    const restaurantId = String(payload?.restaurantId ?? "").trim();
    if (!restaurantId) return { handled: false, reason: "no_restaurant_id" };

    const conn = await this.findConnectionByRestaurant(restaurantId);
    if (!conn) {
      this.logger.warn(
        `JET temp-offline for unknown restaurant ${restaurantId} — ignoring`,
      );
      return { handled: false, reason: "restaurant_not_connected" };
    }

    const services = {
      collection: !!payload?.collection?.isOffline,
      delivery: !!payload?.delivery?.isOffline,
      dineIn: !!payload?.dineIn?.isOffline,
    };
    const offline = Object.entries(services)
      .filter(([, isOffline]) => isOffline)
      .map(([name]) => name);

    const metadata = { ...((conn.metadata as any) ?? {}) };
    metadata.jetServiceStatus = {
      ...services,
      lastChangedAt:
        payload?.lastChangedTimeStampUtc ?? new Date().toISOString(),
      recordedAt: new Date().toISOString(),
    };
    await this.prisma.brandPlatformConnection
      .update({
        where: { id: conn.id },
        data: { metadata: metadata as any, lastWebhookAt: new Date() },
      })
      .catch((e: any) =>
        this.logger.warn(
          `JET temp-offline bookkeeping for ${conn.id} failed: ${e?.message}`,
        ),
      );

    this.activity?.record({
      tenantId: conn.tenantId,
      locationId: conn.locationId,
      brandId: conn.brandId,
      category: "STATUS",
      channel: "JUST_EAT",
      action: "store.status_changed",
      status: offline.length ? "WARNING" : "INFO",
      message: offline.length
        ? `Just Eat took ${offline.join(", ")} offline for this restaurant`
        : "Just Eat brought this restaurant back online",
      details: { restaurantId, ...services },
    });

    this.logger.log(
      `JET temp-offline ${restaurantId} → ${conn.id}: ` +
        `collection=${services.collection} delivery=${services.delivery} dineIn=${services.dineIn}`,
    );
    return { handled: true };
  }

  // ── Failed order (backup flow) ───────────────────────────────────────

  /**
   * `{ validationError, unknownReference?, menuId?, order? }`
   *
   * An order that failed validation on JET'S side — before it ever reached us
   * — so the restaurant has to key it in from the tablet. Note the nested
   * `order` here is a DIFFERENT schema from the Receive Order payload:
   * camelCase, `friendlyOrderReference`, `fulfilment.method`, items keyed by
   * `reference` rather than `plu`. We deliberately do not try to ingest it;
   * an order JET refused is not one we should put on the board as live.
   *
   * What matters is that a human finds out. `unknownReference` is usually the
   * whole story — a PLU on JET's menu that our last publish did not include —
   * and it is exactly the signal the 97% menu-injection target is about.
   */
  async handleFailedOrder(payload: any): Promise<JetLifecycleResult> {
    const validationError = String(payload?.validationError ?? "").trim();
    const unknownReference = payload?.unknownReference
      ? String(payload.unknownReference)
      : null;
    const order = payload?.order ?? {};
    const reference =
      order?.friendlyOrderReference ?? order?.orderId ?? order?.id ?? null;

    // The order payload carries no posLocationId, so route on whatever
    // restaurant identifier it does hold; failing that, log without a tenant.
    const restaurantId = String(
      order?.restaurantId ?? order?.location?.id ?? payload?.restaurantId ?? "",
    ).trim();
    const conn = restaurantId
      ? await this.findConnectionByRestaurant(restaurantId)
      : null;

    this.logger.error(
      `JET REJECTED an order before it reached us (ref ${reference ?? "?"}): ` +
        `${validationError || "no reason given"}` +
        (unknownReference ? ` — unknown item reference "${unknownReference}"` : "") +
        (payload?.menuId ? ` (menu ${payload.menuId})` : "") +
        `. It is going to the restaurant's backup flow and must be keyed in by hand.`,
    );

    if (conn) {
      this.activity?.record({
        tenantId: conn.tenantId,
        locationId: conn.locationId,
        brandId: conn.brandId,
        category: "ORDERS",
        channel: "JUST_EAT",
        action: "order.failed_validation",
        status: "ERROR",
        message:
          `Just Eat could not validate order ${reference ?? ""}`.trim() +
          (unknownReference
            ? ` — item "${unknownReference}" is not on the published menu`
            : validationError
              ? ` — ${validationError}`
              : ""),
        details: {
          validationError,
          unknownReference,
          menuId: payload?.menuId ?? null,
          reference,
        },
      });
    }

    return { handled: true, reason: conn ? undefined : "restaurant_not_connected" };
  }

  // ── Shared ───────────────────────────────────────────────────────────

  private async findOrder(jetOrderId: string) {
    return this.prisma.order.findFirst({
      where: { externalId: jetOrderId, platform: "JUST_EAT" },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        brandId: true,
        status: true,
        displayId: true,
        courierAssignedAt: true,
        courierPickedUpAt: true,
        courierDeliveredAt: true,
      },
    });
  }

  /**
   * Resolve a connection from JET's own restaurant identifier.
   *
   * They send `restaurantId` here, which is the reference the operator entered
   * as restaurantReference — but a restaurant configured with a single shared
   * identifier will have it as the POS location id instead, so both are tried.
   */
  private async findConnectionByRestaurant(restaurantId: string) {
    const byReference = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "JUST_EAT",
        metadata: { path: ["restaurantReference"], equals: restaurantId },
      },
    });
    if (byReference) return byReference;
    return this.prisma.brandPlatformConnection.findFirst({
      where: { platform: "JUST_EAT", externalStoreId: restaurantId },
    });
  }

  private parseDate(value: unknown): Date | null {
    if (!value) return null;
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? null : d;
  }
}
