import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { SocketService } from "../../../infrastructure/socket/socket.service";
import { OrdersService } from "../../orders/orders.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { TalabatConnectionService, type TalabatConnectionRow } from "./talabat-connection.service";
import { transformTalabatOrder, talabatOrderKind } from "./talabat-order.transformer";
import type { TalabatOrder, TalabatOrderStatusUpdate } from "./talabat-types";

// Phase TB-2 — a dispatched Talabat order lands on the board, and the
// middleware's later notifications move it.
//
// ── The dispatch contract (POS Plugin API, "Dispatch Order") ────────────────
//
//   • "quick validation of the request, persist the order, and if everything
//     went well acknowledge" — within "a few seconds", or the middleware times
//     out and RETRIES, which "could lead to order duplication on the plugin
//     side".
//   • The acknowledgement MUST carry remoteOrderId — without it "you can not
//     receive any upcoming order updates" (cancellations included).
//   • 400 = invalid request; 429/5xx = retried up to 10 times with backoff
//     (30 s minimum, up to 240 s apart).
//   • Accept/reject is a SEPARATE, asynchronous call to the order's
//     callbackUrls (talabat-order-sync.service.ts). The synchronous
//     "reject by answering 400" flow is explicitly unsupported for new work.
//
// So: persist, ack with OUR order id as remoteOrderId, and let the board (or
// location auto-accept) drive the accept. Duplicates are absorbed twice over —
// a WebhookEvent row per token, and Order's @@unique([externalId, platform])
// underneath — and a retried dispatch acks with the SAME remoteOrderId.

export interface TalabatDispatchResult {
  httpStatus: 200 | 400 | 500;
  body: Record<string, unknown>;
  orderId?: string;
}

@Injectable()
export class TalabatOrderService {
  private readonly logger = new Logger(TalabatOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly connections: TalabatConnectionService,
    @Optional() private readonly activity?: ActivityLogService,
    @Optional() private readonly socket?: SocketService,
  ) {}

  // ── Dispatch ───────────────────────────────────────────────────────────

  async dispatch(remoteId: string, payload: TalabatOrder): Promise<TalabatDispatchResult> {
    const token = String(payload?.token ?? "").trim();
    if (!token) {
      // Retrying the same body will not grow a token. 400 tells them it is
      // the request, not us.
      return { httpStatus: 400, body: { reason: "MENU_ACCOUNT_SETTINGS", message: "Order has no token" } };
    }

    const conn = await this.connections.byRemoteId(remoteId);
    if (!conn) {
      this.logger.error(`Talabat order ${token} dispatched to unknown remoteId "${remoteId}"`);
      await this.recordEvent(`dispatch:${token}`, payload, { error: `unknown remoteId ${remoteId}` });
      // Validation failure, per their contract — and the spec's own advice is
      // that a POS should reject a mapping problem with MENU_ACCOUNT_SETTINGS.
      return {
        httpStatus: 400,
        body: {
          reason: "MENU_ACCOUNT_SETTINGS",
          message: `No OrderHub vendor is connected for remoteId ${remoteId}`,
        },
      };
    }

    // A retry of an order we already have: ack again with the same id.
    const existing = await this.prisma.order.findFirst({
      where: { externalId: token, platform: "TALABAT" as any },
      select: { id: true, tenantId: true, locationId: true },
    });
    if (existing) {
      if (existing.tenantId !== conn.tenantId || existing.locationId !== conn.locationId) {
        // Same token, different vendor. Never ack another tenant's order id.
        this.logger.error(`Talabat token ${token} re-dispatched to a different vendor (${remoteId})`);
        return { httpStatus: 400, body: { reason: "MENU_ACCOUNT_SETTINGS", message: "Order belongs to another vendor" } };
      }
      return { httpStatus: 200, body: ack(existing.id), orderId: existing.id };
    }

    await this.recordEvent(`dispatch:${token}`, payload, {});
    try {
      const country = await this.locationCountry(conn.locationId);
      const { canonical, warnings } = transformTalabatOrder(payload, { country, remoteId });
      for (const w of warnings) this.logger.warn(`Talabat order ${token}: ${w}`);

      // Brand comes from the connection, never guessed from a name.
      (canonical as any).brandId = conn.brandId;
      (canonical as any).deliveryType = (canonical.metadata as any)?.deliveryType ?? undefined;
      (canonical as any).paymentMethod = (canonical.metadata as any)?.paymentMethod;
      (canonical as any).paymentStatus = (canonical.metadata as any)?.paymentStatus;
      await this.linkMenuItems(canonical.items as any[], conn);

      const created = await this.orders.ingestCanonical(canonical, conn.tenantId, conn.locationId, {
        // "Plugins should handle test orders carefully and make sure that the
        // order won't be prepared in the kitchen." Sandbox orders stay out of
        // sales figures; the ticket itself says DO NOT PREPARE.
        isSandbox: payload.test === true,
      });
      await this.markProcessed(`dispatch:${token}`, { tenantId: conn.tenantId, locationId: conn.locationId, orderId: created.id });
      await this.touch(conn.id);

      const talabat = (canonical.metadata as any)?.talabat ?? {};
      this.activity?.record({
        tenantId: conn.tenantId,
        locationId: conn.locationId,
        brandId: conn.brandId,
        category: "ORDERS",
        channel: "TALABAT",
        action: "order.received",
        status: warnings.length ? "WARNING" : "SUCCESS",
        message:
          `Talabat order ${canonical.displayId} received` +
          (talabat.test ? " (TEST order — do not prepare)" : "") +
          (talabat.expiresAt ? `. Accept or reject by ${new Date(talabat.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC or Talabat cancel it` : ""),
        details: {
          token,
          code: talabat.code,
          kind: talabatOrderKind(payload),
          total: canonical.total,
          promotions: talabat.promotions?.total ? talabat.promotions : undefined,
          ...(warnings.length ? { warnings } : {}),
        },
      });
      return { httpStatus: 200, body: ack(created.id), orderId: created.id };
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 300);
      this.logger.error(`Talabat order ${token} failed to ingest: ${message}`);
      await this.markProcessed(`dispatch:${token}`, { tenantId: conn.tenantId, locationId: conn.locationId, error: message });
      this.activity?.record({
        tenantId: conn.tenantId,
        locationId: conn.locationId,
        brandId: conn.brandId,
        category: "ORDERS",
        channel: "TALABAT",
        action: "order.received",
        status: "ERROR",
        message: `Talabat order ${payload?.shortCode ?? token} could not be added to the board: ${message}`,
        details: { token },
      });
      // 500 so the middleware retries (up to 10×) — a transient DB failure
      // deserves another go; Talabat cancel it with NO_RESPONSE otherwise.
      return { httpStatus: 500, body: { reason: "TECHNICAL_PROBLEM", message } };
    }
  }

  // ── Status updates from the middleware ─────────────────────────────────

  /**
   * PUT /remoteId/{remoteId}/remoteOrder/{remoteOrderId}/posOrderStatus
   *
   * remoteOrderId is the id we acked with — OUR order id — so the lookup is
   * direct, and scoped to the vendor the path names.
   */
  async applyStatus(
    remoteId: string,
    remoteOrderId: string,
    update: TalabatOrderStatusUpdate,
  ): Promise<{ httpStatus: 200 | 404; handled: boolean; reason?: string }> {
    const conn = await this.connections.byRemoteId(remoteId);
    if (!conn) return { httpStatus: 404, handled: false, reason: "unknown_vendor" };
    const order = await this.prisma.order.findFirst({
      where: {
        id: remoteOrderId,
        platform: "TALABAT" as any,
        tenantId: conn.tenantId,
        locationId: conn.locationId,
      },
      select: { id: true, tenantId: true, locationId: true, brandId: true, status: true, displayId: true, metadata: true, fulfillmentType: true },
    });
    if (!order) return { httpStatus: 404, handled: false, reason: "unknown_order" };

    const status = String(update?.status ?? "");
    const meta = (order.metadata ?? {}) as any;
    const kind: string = meta?.talabat?.kind ?? "OWN_DELIVERY";
    const log = (level: "SUCCESS" | "INFO" | "WARNING" | "ERROR", message: string, details?: any) =>
      this.activity?.record({
        tenantId: order.tenantId,
        locationId: order.locationId,
        brandId: order.brandId,
        category: "ORDERS",
        channel: "TALABAT",
        action: `order.talabat.${status.toLowerCase()}`,
        status: level,
        message: `Talabat order ${order.displayId ?? order.id}: ${message}`,
        details,
      });

    switch (status) {
      case "ORDER_CANCELLED": {
        await this.moveTo(order, "CANCELLED", update.message || "Cancelled by Talabat");
        log("WARNING", `cancelled by Talabat${update.message ? ` — ${update.message}` : ""}. Stop preparing it.`);
        break;
      }
      case "ORDER_PICKED_UP": {
        if (kind === "PICKUP") {
          await this.moveTo(order, "COMPLETED");
        } else {
          await this.prisma.order
            .update({ where: { id: order.id }, data: { courierStatus: "PICKED_UP", courierPickedUpAt: new Date() } as any })
            .catch(() => undefined);
          await this.moveTo(order, "OUT_FOR_DELIVERY");
        }
        log("INFO", kind === "PICKUP" ? "collected by the customer" : "collected by the rider");
        break;
      }
      case "COURIER_ARRIVED_AT_VENDOR": {
        await this.moveTo(order, "RIDER_ARRIVED");
        log("INFO", "Talabat rider has arrived to collect");
        break;
      }
      case "SHOW_RIDER_WAITING_WARNING":
      case "HIDE_RIDER_WAITING_WARNING": {
        // AWT — Talabat's rider is waiting on the kitchen, and past
        // waitingFeeAppliesAt the restaurant pays for the wait. Shown on the
        // order (metadata) and the Logs page; hidden again when they say so.
        const show = status === "SHOW_RIDER_WAITING_WARNING";
        await this.patchTalabatMeta(order.id, meta, {
          riderWaiting: show
            ? {
                since: update.riderWaitingWarnings?.waitingStartsAt ?? update.occurredAt ?? new Date().toISOString(),
                feeFrom: update.riderWaitingWarnings?.waitingFeeAppliesAt ?? null,
                at: update.occurredAt ?? new Date().toISOString(),
              }
            : null,
        });
        this.socket?.emitToTenant(order.tenantId, "order:updated" as any, { orderId: order.id } as any);
        if (show) {
          const fee = update.riderWaitingWarnings?.waitingFeeAppliesAt;
          log(
            "WARNING",
            `the Talabat rider is waiting for this order` +
              (fee ? ` — a waiting fee applies from ${new Date(fee).toISOString().slice(11, 16)} UTC` : "") +
              ". Hand it over or mark it ready.",
          );
        } else {
          log("INFO", "rider waiting warning cleared");
        }
        break;
      }
      case "PRODUCT_ORDER_MODIFICATION_SUCCESSFUL": {
        if (update.updatedOrder) await this.applyModifiedOrder(order, update.updatedOrder);
        await this.patchTalabatMeta(order.id, meta, { modification: { status: "SUCCESSFUL", at: new Date().toISOString() } });
        log("SUCCESS", "Talabat accepted the item changes; the order now shows the updated items");
        break;
      }
      case "PRODUCT_ORDER_MODIFICATION_FAILED": {
        await this.patchTalabatMeta(order.id, meta, {
          modification: { status: "FAILED", code: update.message ?? null, at: new Date().toISOString() },
        });
        log("ERROR", `Talabat refused the item changes (${update.message ?? "no reason given"}). The order is unchanged.`);
        break;
      }
      default:
        // "The list can be extended to include more statuses." Acknowledge
        // and record; never fail on something new.
        log("INFO", `status ${status || "(empty)"} received`, { update });
        this.logger.warn(`Talabat posOrderStatus "${status}" for ${order.id} — not handled`);
        return { httpStatus: 200, handled: false, reason: "unknown_status" };
    }
    await this.touch(conn.id);
    return { httpStatus: 200, handled: true };
  }

  /** Replace the order's lines and money with Talabat's modified version. */
  private async applyModifiedOrder(
    order: { id: string; tenantId: string; locationId: string; metadata: unknown },
    updated: TalabatOrder,
  ): Promise<void> {
    const remoteId = String((order.metadata as any)?.talabat?.remoteId ?? "");
    const country = await this.locationCountry(order.locationId);
    const { canonical } = transformTalabatOrder(updated, { country, remoteId });
    const prevMeta = (order.metadata ?? {}) as any;
    await this.prisma.$transaction([
      this.prisma.orderItem.deleteMany({ where: { orderId: order.id } }),
      this.prisma.orderItem.createMany({
        data: canonical.items.map((i) => ({
          orderId: order.id,
          name: i.name,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          totalPrice: i.totalPrice,
          modifiers: i.modifiers as any,
          notes: i.notes ?? null,
          metadata: i.sku ? ({ sku: i.sku } as any) : ({} as any),
        })),
      }),
      this.prisma.order.update({
        where: { id: order.id },
        data: {
          subtotal: canonical.subtotal,
          discount: canonical.discount,
          deliveryFee: canonical.deliveryFee,
          taxAmount: canonical.taxAmount,
          total: canonical.total,
          metadata: {
            ...prevMeta,
            talabat: {
              ...(prevMeta.talabat ?? {}),
              ...((canonical.metadata as any)?.talabat ?? {}),
              // The accept-side bookkeeping is ours, not in the new payload.
              sent: prevMeta.talabat?.sent ?? {},
            },
            talabatRawModified: updated,
          } as any,
        },
      }),
    ]);
    this.socket?.emitToTenant(order.tenantId, "order:updated" as any, { orderId: order.id } as any);
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /** remoteCode IS our MenuItem id for a plain item — link it so KDS routing rules match. */
  private async linkMenuItems(items: Array<{ sku?: string; menuItemId?: string }>, conn: TalabatConnectionRow) {
    const ids = [...new Set(items.map((i) => String(i.sku ?? "")).filter(Boolean))];
    if (!ids.length) return;
    // MenuItem has no brand relation to filter through, so tenant ownership
    // is checked via the tenant's brand ids.
    const brands = await this.prisma.brand
      .findMany({ where: { tenantId: conn.tenantId }, select: { id: true } })
      .catch(() => [] as Array<{ id: string }>);
    const found = brands.length
      ? await this.prisma.menuItem
          .findMany({ where: { id: { in: ids }, brandId: { in: brands.map((b) => b.id) } }, select: { id: true } })
          .catch(() => [] as Array<{ id: string }>)
      : [];
    const known = new Set(found.map((f) => f.id));
    for (const i of items) if (i.sku && known.has(i.sku)) i.menuItemId = i.sku;
  }

  private async moveTo(order: { id: string; tenantId: string; status: string }, status: string, cancelReason?: string) {
    if (order.status === status) return;
    try {
      await this.orders.updateStatus(
        order.id,
        order.tenantId,
        { status, ...(cancelReason ? { cancelReason } : {}) } as any,
        "talabat",
        "WEBHOOK" as any,
      );
    } catch (err: any) {
      // Their lifecycle and our state machine won't always agree on order;
      // a refused transition is information, never a failed notification.
      this.logger.warn(`Talabat ${order.status} → ${status} refused for ${order.id}: ${err?.message}`);
    }
  }

  private async patchTalabatMeta(orderId: string, meta: any, patch: Record<string, unknown>) {
    await this.prisma.order
      .update({
        where: { id: orderId },
        data: { metadata: { ...meta, talabat: { ...(meta?.talabat ?? {}), ...patch } } as any },
      })
      .catch((e: any) => this.logger.warn(`Talabat metadata write failed for ${orderId}: ${e?.message}`));
  }

  private async recordEvent(externalEventId: string, payload: unknown, meta: Record<string, unknown>) {
    try {
      await this.prisma.webhookEvent.create({
        data: { platform: "TALABAT", externalEventId, rawPayload: (payload ?? {}) as any, metadata: meta as any },
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        await this.prisma.webhookEvent
          .update({
            where: { platform_externalEventId: { platform: "TALABAT", externalEventId } },
            data: { retryCount: { increment: 1 } },
          })
          .catch(() => undefined);
      } else {
        this.logger.warn(`Talabat webhook persist failed: ${e?.message}`);
      }
    }
  }

  private async markProcessed(
    externalEventId: string,
    data: { tenantId?: string; locationId?: string; orderId?: string; error?: string },
  ) {
    await this.prisma.webhookEvent
      .update({
        where: { platform_externalEventId: { platform: "TALABAT", externalEventId } },
        data: {
          ...(data.error ? { processingError: data.error } : { processedAt: new Date(), processingError: null }),
          ...(data.tenantId ? { tenantId: data.tenantId } : {}),
          ...(data.locationId ? { locationId: data.locationId } : {}),
          ...(data.orderId ? { orderId: data.orderId } : {}),
        },
      })
      .catch(() => undefined);
  }

  private async locationCountry(locationId: string): Promise<string | null> {
    const loc = await this.prisma.location
      .findUnique({ where: { id: locationId }, select: { country: true } })
      .catch(() => null);
    return loc?.country ?? null;
  }

  private async touch(connectionId: string) {
    await this.prisma.brandPlatformConnection
      .update({ where: { id: connectionId }, data: { lastWebhookAt: new Date() } })
      .catch(() => undefined);
  }
}

/** The acknowledgement shape the spec requires: remoteResponse.remoteOrderId. */
function ack(orderId: string) {
  return { remoteResponse: { remoteOrderId: orderId } };
}
