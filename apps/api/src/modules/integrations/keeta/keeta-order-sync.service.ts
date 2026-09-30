import { Injectable, Logger, Optional } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { KeetaAuthService } from "./keeta-auth.service";
import { KeetaApiError, KeetaClientService } from "./keeta-client.service";
import { kInt } from "./keeta-json";

// Phase KT-3 — our order status, pushed back to Keeta.
//
//   ACCEPTED                  → /order/confirm    (within 5 minutes, or Keeta
//                                                  cancel it and can close the
//                                                  store as a penalty)
//   READY                     → /order/prepare    (rider / customer told)
//   CANCELLED / REJECTED      → /order/cancel     (Keeta refund in full)
//   OUT_FOR_DELIVERY          → /order/dispatched (self-delivery only)
//   COMPLETED                 → /order/delivered  (self-delivery)
//                               /order/collect    (pickup — optional; Keeta
//                                                  auto-complete otherwise)
//
// Every one of these "does not support duplicate calls" and errors if the
// order was already handled in Keeta's own merchant app. So each is sent at
// most once (remembered on the order), and an "already" answer after a real
// state change on their side is logged, not escalated.
//
// A transition that a Keeta WEBHOOK caused is never echoed back: telling
// Keeta its own cancellation is at best noise, and a second /order/cancel is
// an error by definition.

export type KeetaOutbound = "confirm" | "prepare" | "cancel" | "dispatched" | "delivered" | "collect";

/** Map our status to the Keeta call it implies, for this kind of order. */
export function keetaOutboundFor(
  status: string,
  kind: { pickup: boolean; selfDelivery: boolean },
): KeetaOutbound | null {
  switch (status) {
    case "ACCEPTED":
      return "confirm";
    case "READY":
      return "prepare";
    case "CANCELLED":
    case "REJECTED":
      return "cancel";
    case "OUT_FOR_DELIVERY":
    case "DISPATCHED":
      return kind.selfDelivery ? "dispatched" : null;
    case "COMPLETED":
      if (kind.pickup) return "collect";
      if (kind.selfDelivery) return "delivered";
      return null;
    default:
      return null;
  }
}

/**
 * Keeta's four cancel codes, from whatever a member of staff typed.
 *   500001 insufficient ingredients · 500002 store temporarily closed
 *   500003 staff shortage · 500000 other (cancelReason then required)
 */
export function keetaCancelCode(raw: string | null | undefined): { cancelCode: number; cancelReason?: string } {
  const s = String(raw ?? "").trim();
  const l = s.toLowerCase();
  if (/out of stock|sold out|unavailable|ingredient|86|no stock|ran out/.test(l)) return { cancelCode: 500001 };
  if (/clos(ed|ing)|shut|not open|after hours/.test(l)) return { cancelCode: 500002 };
  if (/staff|short.?handed|no driver|busy|too many/.test(l)) return { cancelCode: 500003 };
  return { cancelCode: 500000, cancelReason: s || "Cancelled by the restaurant" };
}

@Injectable()
export class KeetaOrderSyncService {
  private readonly logger = new Logger(KeetaOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: KeetaClientService,
    private readonly auth: KeetaAuthService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  @OnEvent("order.status_changed")
  async onStatusChanged(payload: { orderId: string; tenantId: string; actorType?: string }): Promise<void> {
    if (payload.actorType === "WEBHOOK") return;
    if (!this.client.configured) return;
    try {
      await this.sync(payload.orderId, payload.tenantId);
    } catch (err: any) {
      // Never rethrow into the status transition — our order has already
      // moved, and rolling back a kitchen state staff can see to fix a
      // marketplace they cannot helps nobody.
      this.logger.error(`Keeta status sync threw for order ${payload.orderId}: ${err?.message}`);
    }
  }

  async sync(orderId: string, tenantId: string): Promise<{ sent: KeetaOutbound | null; reason?: string }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId, platform: "KEETA" as any },
      select: {
        id: true,
        tenantId: true,
        brandId: true,
        locationId: true,
        externalId: true,
        displayId: true,
        status: true,
        fulfillmentType: true,
        cancelReason: true,
        metadata: true,
      },
    });
    if (!order?.externalId) return { sent: null, reason: "not_keeta" };
    const meta = (order.metadata ?? {}) as Record<string, any>;
    if (meta.simulatedPlatform) return { sent: null, reason: "simulated" };

    const pickup = String(meta.keetaUserGetMode ?? "").toLowerCase() === "pickup" || order.fulfillmentType === "PICKUP";
    const selfDelivery = !pickup && meta.deliveryType === "MERCHANT";
    const action = keetaOutboundFor(String(order.status), { pickup, selfDelivery });
    if (!action) return { sent: null, reason: "no_counterpart" };

    const pushed = (meta.keetaPushed ?? {}) as Record<string, string>;
    if (pushed[action]) return { sent: null, reason: "already_sent" };

    const shopId = String(meta.keetaShopId ?? "");
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { platform: "KEETA", externalStoreId: shopId },
      select: { metadata: true, externalStoreId: true },
      orderBy: { updatedAt: "desc" },
    });
    if (!conn) {
      this.logger.warn(`Keeta ${action} for ${order.externalId}: shop ${shopId} is no longer connected`);
      return { sent: null, reason: "no_connection" };
    }

    const fields: Record<string, unknown> = {
      orderViewId: kInt(order.externalId),
      shopId: kInt(shopId),
      ...(action === "cancel" ? keetaCancelCode(order.cancelReason) : {}),
    };
    const path = `/order/${action}`;

    const log = {
      tenantId: order.tenantId,
      ...(order.brandId ? { brandId: order.brandId } : {}),
      locationId: order.locationId,
      category: "ORDERS" as const,
      channel: "KEETA",
      action: `order.${action}`,
    };
    try {
      const token = await this.auth.tokenForConnection(conn);
      await this.client.request(path, fields, { accessToken: token, retries: 1 });
      await this.remember(order.id, action);
      this.logger.log(`Keeta order ${order.externalId} → ${action}`);
      this.activity?.record({
        ...log,
        status: "SUCCESS",
        message: `Keeta order ${order.displayId ?? order.externalId}: ${action} sent`,
      });
      return { sent: action };
    } catch (err: any) {
      const msg = err instanceof KeetaApiError ? `${err.keetaCode}: ${err.keetaMessage}` : String(err?.message ?? err);
      // "Already accepted via a Keeta POS terminal", "status has progressed" —
      // Keeta already has the state we were about to give it. Remember the
      // call so we stop repeating it; say so, quietly.
      const already = /already|progress|duplicate|repeat|processed|status.*(not|invalid)/i.test(msg);
      if (already) await this.remember(order.id, action);
      this.logger.warn(`Keeta ${action} for ${order.externalId} failed: ${msg}`);
      this.activity?.record({
        ...log,
        status: already ? "INFO" : "ERROR",
        message: already
          ? `Keeta order ${order.displayId ?? order.externalId}: ${action} not needed — ${msg}`
          : `Keeta order ${order.displayId ?? order.externalId}: ${action} FAILED — ${msg}. ` +
            (action === "confirm"
              ? "Accept it in the Keeta merchant app now, or Keeta cancels it at 5 minutes."
              : "Update it in the Keeta merchant app."),
      });
      return { sent: null, reason: msg };
    }
  }

  private async remember(orderId: string, action: KeetaOutbound) {
    const row = await this.prisma.order.findUnique({ where: { id: orderId }, select: { metadata: true } });
    const meta = { ...((row?.metadata as any) ?? {}) };
    meta.keetaPushed = { ...(meta.keetaPushed ?? {}), [action]: new Date().toISOString() };
    await this.prisma.order.update({ where: { id: orderId }, data: { metadata: meta } }).catch(() => undefined);
  }
}
