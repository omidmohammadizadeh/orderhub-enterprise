import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { transformGlovoOrder } from "./glovo-order.transformer";
import {
  describeGlovoCancellation,
  glovoOrderIdFrom,
  glovoStoreIdFrom,
  mapGlovoCancellationStatus,
} from "./glovo-order.mappers";

// Phase GL-2 — Glovo order intake + inbound lifecycle.
//
// Three webhooks, all POSTed by Glovo to URLs we register with them by hand:
//   dispatched  — the order (mandatory). Sent when Glovo decides the kitchen
//                 should start, from the courier's ETA and the store's prep
//                 time — NOT when the customer pays.
//   picked-up   — the same Order body again, once the courier has the bag.
//   cancelled   — { order_id, store_id, cancel_reason, payment_strategy }.
//
// The contract (spec, Status Codes FAQ + ResponseDescription): answer 2xx
// within 10 seconds; anything else is retried up to three times with backoff,
// and "you should deduplicate order IDs to avoid processing the same order
// information more than once". On a persistent error Glovo takes no action —
// "We assume the Partner will prepare the order" — and the order is still on
// the store's Glovo Partner Webapp. So:
//
//   - A failed ingest answers 5xx, so Glovo's retry gets a second chance.
//   - Idempotency is two layers deep: a WebhookEvent row per (kind, order id)
//     marked processed only once the order exists, and Order's own
//     @@unique([externalId, platform]) underneath it. A redelivery of a
//     processed order is a no-op; a redelivery of a FAILED one is retried.

export type GlovoWebhookKind = "dispatched" | "picked_up" | "cancelled";

export interface GlovoIntakeResult {
  /** HTTP status the controller should answer with. */
  httpStatus: 200 | 401 | 500;
  handled: boolean;
  reason?: string;
  orderId?: string;
}

interface Connection {
  id: string;
  tenantId: string;
  brandId: string;
  locationId: string;
}

@Injectable()
export class GlovoOrderService {
  private readonly logger = new Logger(GlovoOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /**
   * Record a delivery, and say whether it still needs processing.
   *
   * `firstSeen` alone is not enough (that was the JET shape): Glovo retries a
   * delivery we FAILED, and a first-seen check would wave the retry through as
   * a duplicate and lose the order. So a row that exists but was never marked
   * processed is processed again.
   */
  async recordDelivery(args: {
    kind: GlovoWebhookKind;
    glovoOrderId: string;
    payload: unknown;
    tokenOk: boolean;
  }): Promise<{ alreadyProcessed: boolean }> {
    const externalEventId = `${args.kind}:${args.glovoOrderId}`;
    const where = {
      platform_externalEventId: { platform: "GLOVO", externalEventId },
    };
    const existing = await this.prisma.webhookEvent.findUnique({
      where,
      select: { id: true, processedAt: true, retryCount: true },
    });
    if (existing) {
      if (existing.processedAt) return { alreadyProcessed: true };
      await this.prisma.webhookEvent
        .update({ where, data: { retryCount: { increment: 1 } } })
        .catch(() => undefined);
      return { alreadyProcessed: false };
    }
    try {
      await this.prisma.webhookEvent.create({
        data: {
          platform: "GLOVO",
          externalEventId,
          rawPayload: (args.payload ?? {}) as any,
          metadata: { kind: args.kind, tokenOk: args.tokenOk },
        },
      });
    } catch (e: any) {
      // A concurrent redelivery won the insert. Not an error: whichever
      // request processes first creates the order, and Order's own unique key
      // makes the second a no-op.
      if (e?.code !== "P2002") {
        this.logger.warn(`Glovo webhook persist failed: ${e?.message}`);
      }
    }
    return { alreadyProcessed: false };
  }

  private async markProcessed(
    kind: GlovoWebhookKind,
    glovoOrderId: string,
    data: { tenantId?: string; locationId?: string; orderId?: string; error?: string },
  ): Promise<void> {
    await this.prisma.webhookEvent
      .update({
        where: {
          platform_externalEventId: {
            platform: "GLOVO",
            externalEventId: `${kind}:${glovoOrderId}`,
          },
        },
        data: {
          ...(data.error ? { processingError: data.error } : { processedAt: new Date(), processingError: null }),
          ...(data.tenantId ? { tenantId: data.tenantId } : {}),
          ...(data.locationId ? { locationId: data.locationId } : {}),
          ...(data.orderId ? { orderId: data.orderId } : {}),
        },
      })
      .catch(() => undefined);
  }

  /** The connection a store id routes to — the ONLY way an order finds a tenant. */
  async resolveConnection(storeId: string): Promise<Connection | null> {
    return this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "GLOVO",
        externalStoreId: storeId,
        status: { not: "not_connected" },
      },
      select: { id: true, tenantId: true, brandId: true, locationId: true },
    });
  }

  // ── dispatched ─────────────────────────────────────────────────────────

  async ingestOrder(payload: any): Promise<GlovoIntakeResult> {
    const glovoOrderId = glovoOrderIdFrom(payload);
    if (!glovoOrderId) {
      this.logger.error(
        `Glovo order has no order_id (keys=${Object.keys(payload ?? {}).join(",")}) — cannot ingest`,
      );
      // Retrying the same body will not grow an id.
      return { httpStatus: 200, handled: false, reason: "no_order_id" };
    }

    const storeId = glovoStoreIdFrom(payload);
    const conn = storeId ? await this.resolveConnection(storeId) : null;
    if (!conn) {
      const reason = storeId
        ? `No connected Glovo store for store_id "${storeId}"`
        : "The order carried no store_id";
      this.logger.error(`Glovo order ${glovoOrderId}: ${reason}`);
      await this.markProcessed("dispatched", glovoOrderId, { error: reason });
      // 200: a retry cannot fix a store mapping, and the order is still on the
      // shop's Glovo Partner Webapp.
      return { httpStatus: 200, handled: false, reason: "store_not_connected" };
    }

    try {
      const country = await this.locationCountry(conn.locationId);
      const transformed = transformGlovoOrder(payload, { country });
      if (!transformed) throw new Error("Order payload could not be normalised");
      const { canonical, warnings } = transformed;
      for (const w of warnings) this.logger.warn(`Glovo order ${glovoOrderId}: ${w}`);

      // A direct integration knows its brand from the connection — never
      // guessed from a name.
      (canonical as any).brandId = conn.brandId;
      (canonical as any).deliveryType = (canonical.metadata as any)?.deliveryType ?? undefined;

      const created = await this.orders.ingestCanonical(canonical, conn.tenantId, conn.locationId);
      await this.writeCourierFields(created.id, canonical);
      await this.touchConnection(conn.id);
      await this.markProcessed("dispatched", glovoOrderId, {
        tenantId: conn.tenantId,
        locationId: conn.locationId,
        orderId: created.id,
      });

      this.logger.log(
        `Glovo order ${glovoOrderId} (code ${canonical.displayId}) → order ${created.id} ` +
          `at store ${storeId} — ${canonical.items.length} line(s), total ${canonical.total}`,
      );
      this.activity?.record({
        tenantId: conn.tenantId,
        locationId: conn.locationId,
        brandId: conn.brandId,
        category: "ORDERS",
        channel: "GLOVO",
        action: "order.received",
        status: "SUCCESS",
        message: `Glovo order ${canonical.displayId} received`,
        details: {
          glovoOrderId,
          storeId,
          items: canonical.items.length,
          total: canonical.total,
          fulfillmentType: canonical.fulfillmentType,
          ...(warnings.length ? { warnings } : {}),
        },
      });
      return { httpStatus: 200, handled: true, orderId: created.id };
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 300);
      this.logger.error(`Glovo order ${glovoOrderId} failed to ingest: ${message}`);
      await this.markProcessed("dispatched", glovoOrderId, {
        tenantId: conn.tenantId,
        locationId: conn.locationId,
        error: message,
      });
      this.activity?.record({
        tenantId: conn.tenantId,
        locationId: conn.locationId,
        brandId: conn.brandId,
        category: "ORDERS",
        channel: "GLOVO",
        action: "order.received",
        status: "ERROR",
        message: `Glovo order ${payload?.order_code ?? glovoOrderId} could not be added to the board: ${message}. It is still on the Glovo Partner Webapp.`,
        details: { glovoOrderId, storeId },
      });
      // 5xx so Glovo retries — the retry is processed, not skipped.
      return { httpStatus: 500, handled: false, reason: "ingest_failed" };
    }
  }

  // ── picked up ──────────────────────────────────────────────────────────

  /**
   * The courier has the bag. Same Order body as dispatched.
   *
   * If we never got the dispatched notification (it failed, or the webhook was
   * registered late) the order is ingested from this copy first, so the board
   * still has a record of food that left the building.
   */
  async handlePickedUp(payload: any): Promise<GlovoIntakeResult> {
    const glovoOrderId = glovoOrderIdFrom(payload);
    if (!glovoOrderId) return { httpStatus: 200, handled: false, reason: "no_order_id" };

    let order = await this.findScopedOrder(glovoOrderId, glovoStoreIdFrom(payload));
    if (!order) {
      const ingested = await this.ingestOrder(payload);
      if (!ingested.handled) {
        await this.markProcessed("picked_up", glovoOrderId, { error: ingested.reason });
        return { ...ingested, httpStatus: ingested.httpStatus === 500 ? 500 : 200 };
      }
      order = await this.findScopedOrder(glovoOrderId, glovoStoreIdFrom(payload));
      if (!order) return { httpStatus: 200, handled: false, reason: "order_not_found" };
    }

    const pickedUpAt = new Date();
    const courierName = String(payload?.courier?.name ?? "").trim();
    const courierPhone = String(payload?.courier?.phone_number ?? "").trim();
    await this.prisma.order
      .update({
        where: { id: order.id },
        data: {
          courierStatus: "PICKED_UP",
          ...(order.courierPickedUpAt ? {} : { courierPickedUpAt: pickedUpAt }),
          ...(courierName ? { courierName } : {}),
          ...(courierPhone ? { courierPhone } : {}),
        } as any,
      })
      .catch((e: any) =>
        this.logger.warn(`Glovo picked-up ${glovoOrderId}: courier fields not written: ${e?.message}`),
      );

    const terminal = ["COMPLETED", "CANCELLED", "REJECTED", "FAILED"];
    if (order.status !== "OUT_FOR_DELIVERY" && !terminal.includes(order.status)) {
      try {
        await this.orders.updateStatus(
          order.id,
          order.tenantId,
          { status: "OUT_FOR_DELIVERY" } as any,
          "glovo-picked-up-webhook",
          "WEBHOOK",
        );
      } catch (err: any) {
        this.logger.warn(`Glovo picked-up ${glovoOrderId} → OUT_FOR_DELIVERY rejected: ${err?.message}`);
      }
    }

    await this.markProcessed("picked_up", glovoOrderId, {
      tenantId: order.tenantId,
      locationId: order.locationId,
      orderId: order.id,
    });
    this.activity?.record({
      tenantId: order.tenantId,
      locationId: order.locationId,
      brandId: order.brandId,
      category: "ORDERS",
      channel: "GLOVO",
      action: "order.driver_status",
      status: "INFO",
      message: `Glovo order ${order.displayId ?? glovoOrderId}: courier collected the order${courierName ? ` (${courierName})` : ""}`,
      details: { glovoOrderId },
    });
    return { httpStatus: 200, handled: true, orderId: order.id };
  }

  // ── cancelled ──────────────────────────────────────────────────────────

  /**
   * `{ order_id, store_id, cancel_reason, payment_strategy }`.
   *
   * Scoped by store_id as well as order id: one Glovo token serves every
   * tenant, so a cancellation naming a store must only ever touch an order
   * that store's connection owns.
   */
  async handleCancellation(payload: any): Promise<GlovoIntakeResult> {
    const glovoOrderId = glovoOrderIdFrom(payload);
    if (!glovoOrderId) return { httpStatus: 200, handled: false, reason: "no_order_id" };

    const order = await this.findScopedOrder(glovoOrderId, glovoStoreIdFrom(payload));
    if (!order) {
      this.logger.warn(`Glovo cancellation for unknown order ${glovoOrderId} — ignoring`);
      await this.markProcessed("cancelled", glovoOrderId, { error: "order_not_found" });
      return { httpStatus: 200, handled: false, reason: "order_not_found" };
    }

    const reasonCode = payload?.cancel_reason ?? null;
    const status = mapGlovoCancellationStatus(reasonCode);
    const reason = describeGlovoCancellation(reasonCode, payload?.payment_strategy);

    if (order.status !== status) {
      try {
        await this.orders.updateStatus(
          order.id,
          order.tenantId,
          { status, cancelReason: reason } as any,
          "glovo-cancel-webhook",
          "WEBHOOK",
        );
      } catch (err: any) {
        // An already-terminal order refuses the transition; the notification
        // is still acknowledged — Glovo retrying cannot change that.
        this.logger.warn(`Glovo cancellation ${glovoOrderId} → ${status} rejected: ${err?.message}`);
      }
    }

    await this.markProcessed("cancelled", glovoOrderId, {
      tenantId: order.tenantId,
      locationId: order.locationId,
      orderId: order.id,
    });
    this.activity?.record({
      tenantId: order.tenantId,
      locationId: order.locationId,
      brandId: order.brandId,
      category: "ORDERS",
      channel: "GLOVO",
      action: "order.cancelled",
      status: "WARNING",
      message: `Glovo order ${order.displayId ?? glovoOrderId}: ${reason}`,
      details: { glovoOrderId, reasonCode, paymentStrategy: payload?.payment_strategy ?? null, status },
    });
    return { httpStatus: 200, handled: true, orderId: order.id };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * Find our order for a Glovo order id — and, when the notification names a
   * store, only if that store's connection is the one the order belongs to.
   */
  private async findScopedOrder(glovoOrderId: string, storeId: string | null) {
    const order = await this.prisma.order.findFirst({
      where: { externalId: glovoOrderId, platform: "GLOVO" as any },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        brandId: true,
        status: true,
        displayId: true,
        courierPickedUpAt: true,
      },
    });
    if (!order) return null;
    if (storeId) {
      const conn = await this.resolveConnection(storeId);
      if (
        !conn ||
        conn.tenantId !== order.tenantId ||
        conn.locationId !== order.locationId ||
        (order.brandId && conn.brandId !== order.brandId)
      ) {
        this.logger.error(
          `Glovo notification for order ${glovoOrderId} names store "${storeId}", ` +
            `which does not own that order — ignoring`,
        );
        return null;
      }
    }
    return order as typeof order & { status: string };
  }

  private async locationCountry(locationId: string): Promise<string | null> {
    const loc = await this.prisma.location
      .findUnique({ where: { id: locationId }, select: { country: true } })
      .catch(() => null);
    return loc?.country ?? null;
  }

  private async touchConnection(connectionId: string): Promise<void> {
    await this.prisma.brandPlatformConnection
      .update({ where: { id: connectionId }, data: { lastWebhookAt: new Date() } })
      .catch(() => undefined);
  }

  /** Courier name/phone and pickup ETA onto the flat courier columns. Best-effort. */
  private async writeCourierFields(
    orderId: string,
    canonical: { metadata: Record<string, unknown> },
  ): Promise<void> {
    const courier = (canonical.metadata as any)?.courier;
    if (!courier?.name && !courier?.phone) return;
    await this.prisma.order
      .update({
        where: { id: orderId },
        data: {
          ...(courier.name ? { courierName: courier.name } : {}),
          ...(courier.phone ? { courierPhone: courier.phone } : {}),
        } as any,
      })
      .catch((e: any) =>
        this.logger.warn(`Glovo order ${orderId}: could not write courier fields: ${e?.message}`),
      );
  }
}
