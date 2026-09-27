import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { OrdersService } from "../../orders/orders.service";
import { KeetaAuthService } from "./keeta-auth.service";
import { KeetaClientService } from "./keeta-client.service";
import { kInt, keetaId } from "./keeta-json";
import {
  KEETA_DELIVERY_MODE,
  keetaMoney,
  transformKeetaOrder,
  type KeetaOrderInfo,
} from "./keeta-order.transformer";

// Phase KT-2 — Keeta order intake and inbound status.
//
// ── Routing an order to a kitchen ───────────────────────────────────────────
//
// Every Keeta webhook names a Keeta shopId. A store is routed by the
// BrandPlatformConnection (platform "KEETA") whose externalStoreId is that
// shopId — set when the operator mapped the store after authorizing. The
// connection also names our brand, so the order is pinned to it: one Keeta
// store is one of our brands at one location, which is how a dark kitchen
// running four brands on Keeta keeps four sets of tickets apart.
//
// ── Idempotency ─────────────────────────────────────────────────────────────
//
// Keeta retry a webhook "typically up to 3 times with 1-minute intervals" and
// tell developers to detect a retry by "whether the order ID has already been
// processed". ingestCanonical is create-only on (externalId, platform), and
// every status change below compares before it writes, so a replay is a no-op.

/** Keeta's rider lifecycle (1006 logisticsStatus) → our board. */
const LOGISTICS_STATUS: Record<number, string | null> = {
  0: null, // delivery request created
  10: null, // looking for a rider
  20: "ASSIGNED_DRIVER",
  25: "RIDER_ARRIVED",
  30: "OUT_FOR_DELIVERY", // collected
  50: "COMPLETED",
  // 99 = the DELIVERY was cancelled, not necessarily the order — Keeta may
  // re-dispatch. The order's own 1004 is what cancels it.
  99: null,
};

/** Keeta refund statuses that still need the merchant to answer. */
const REFUND_AWAITING_MERCHANT = new Set([1001]);

/** Who cancelled, per 1004's opType. */
const CANCEL_ACTOR: Record<number, string> = {
  0: "Keeta (system)",
  10: "the customer",
  20: "the restaurant",
  30: "Keeta customer service",
};

@Injectable()
export class KeetaOrderService {
  private readonly logger = new Logger(KeetaOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly client: KeetaClientService,
    private readonly auth: KeetaAuthService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /** The connection that owns a Keeta store. */
  async connectionForShop(shopId: string | null) {
    if (!shopId) return null;
    return this.prisma.brandPlatformConnection.findFirst({
      where: { platform: "KEETA", externalStoreId: shopId, status: { not: "not_connected" } },
      select: {
        id: true,
        tenantId: true,
        brandId: true,
        locationId: true,
        externalStoreId: true,
        metadata: true,
        location: { select: { country: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  /**
   * 1001 — a new order.
   *
   * Returns `retry: true` only for a failure that another delivery could fix
   * (our database, a transient Keeta error while decrypting). An order for a
   * store nobody has mapped will not map itself on the next attempt.
   */
  async ingest(
    info: KeetaOrderInfo,
    envelopeShopId?: string | null,
  ): Promise<{ orderId?: string; retry: boolean; reason?: string }> {
    const orderViewId = keetaId(info?.merchantOrder?.orderViewId ?? info?.baseOrder?.orderViewId);
    const shopId = keetaId(info?.merchantOrder?.shopId) ?? envelopeShopId ?? null;
    if (!orderViewId) return { retry: false, reason: "no_order_id" };

    const conn = await this.connectionForShop(shopId);
    if (!conn) {
      this.logger.error(
        `Keeta order ${orderViewId} for shop ${shopId ?? "?"} matches no connected store — dropped. ` +
          `Map the store under Locations → Brands → Keeta. Keeta auto-cancels unconfirmed orders after 5 minutes.`,
      );
      return { retry: false, reason: "unmapped_shop" };
    }

    const existing = await this.prisma.order.findFirst({
      where: { externalId: orderViewId, platform: "KEETA" as any },
      select: { id: true },
    });
    if (existing) return { orderId: existing.id, retry: false, reason: "duplicate" };

    try {
      const decrypted = await this.decryptIfAllowed(info, conn);
      const canonical = transformKeetaOrder(info, {
        country: conn.location?.country ?? "AE",
        brandId: conn.brandId,
        decrypted,
      });
      (canonical as any).deliveryType = (canonical.metadata as any)?.deliveryType ?? undefined;

      const created = await this.orders.ingestCanonical(canonical, conn.tenantId, conn.locationId);
      await this.prisma.brandPlatformConnection
        .update({ where: { id: conn.id }, data: { lastWebhookAt: new Date(), lastError: null } })
        .catch(() => undefined);

      this.activity?.record({
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        category: "ORDERS",
        channel: "KEETA",
        action: "order.received",
        status: "SUCCESS",
        message: `Keeta order ${canonical.displayId} received — accept within 5 minutes or Keeta cancels it`,
        details: { orderViewId, shopId, items: canonical.items.length, total: canonical.total },
      });
      this.logger.log(
        `Keeta order ${orderViewId} → ${created.id} (${canonical.displayId}) at ${conn.locationId}, total ${canonical.total}`,
      );
      return { orderId: created.id, retry: false };
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 300);
      this.logger.error(`Keeta order ${orderViewId} failed to ingest: ${message}`);
      this.activity?.record({
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        category: "ORDERS",
        channel: "KEETA",
        action: "order.received",
        status: "ERROR",
        message:
          `Keeta order ${orderViewId} could not be added to the board: ${message}. ` +
          `Handle it in the Keeta merchant app — it auto-cancels after 5 minutes unconfirmed.`,
      });
      return { retry: true, reason: "ingest_failed" };
    }
  }

  /**
   * Decrypt the customer's details — only when Keeta allow it.
   *
   * Keeta encrypt name/phone/address and permit /base/batchDecrypt only for
   * orders the shop delivers itself (or a 3PL does). A pickup or Keeta-rider
   * order is left encrypted on purpose: asking would be refused, and a failed
   * decrypt must never cost us the order.
   */
  private async decryptIfAllowed(info: KeetaOrderInfo, conn: { metadata: unknown; externalStoreId: string | null }) {
    const delivery = (info.merchantOrderDeliveries ?? [])[0];
    const selfDelivery =
      String(info.merchantOrder?.userGetMode ?? "").toLowerCase() !== "pickup" &&
      String(delivery?.deliveryMode ?? "") === KEETA_DELIVERY_MODE.SELF;
    const r = info.recipientInfo ?? {};
    const ciphers = [r.name, r.phone, r.addressName, r.houseNumber, r.addressStruct, r.detailAddressStruct].filter(
      (v): v is string => typeof v === "string" && v.startsWith("ENC_"),
    );
    const found = new Map<string, string>();
    if (selfDelivery && ciphers.length && conn.externalStoreId) {
      try {
        const token = await this.auth.tokenForConnection(conn);
        const res = await this.client.batchDecrypt(token, conn.externalStoreId, ciphers);
        res.forEach((v, k) => found.set(k, v));
      } catch (err: any) {
        this.logger.warn(`Keeta decrypt failed for order ${info.merchantOrder?.orderViewId}: ${err?.message}`);
      }
    }
    return { get: (s: string | undefined | null) => (s ? found.get(s) ?? (s.startsWith("ENC_") ? undefined : s) : undefined) };
  }

  /** Fetch the full order from Keeta — for a missed 1001, or a late settlement. */
  async fetchOrder(orderViewId: string, shopId: string): Promise<KeetaOrderInfo | null> {
    const conn = await this.connectionForShop(shopId);
    if (!conn) throw new NotFoundException(`No connected Keeta store ${shopId}`);
    const token = await this.auth.tokenForConnection(conn);
    const res = await this.client.request<{ orderInfo?: KeetaOrderInfo }>(
      "/order/get",
      { orderViewId: kInt(orderViewId), shopId: kInt(shopId) },
      { accessToken: token, retries: 1 },
    );
    return res?.orderInfo ?? null;
  }

  /** Pull an order we never received by webhook and put it on the board. */
  async pull(tenantId: string, orderViewId: string, shopId: string) {
    const conn = await this.connectionForShop(shopId);
    if (!conn || conn.tenantId !== tenantId) throw new NotFoundException("Keeta store not connected");
    const info = await this.fetchOrder(orderViewId, shopId);
    if (!info) throw new BadRequestException("Keeta returned no order");
    return this.ingest(info, shopId);
  }

  // ── inbound status ───────────────────────────────────────────────────────

  private async findOrder(orderViewId: string | null) {
    if (!orderViewId) return null;
    return this.prisma.order.findFirst({
      where: { externalId: orderViewId, platform: "KEETA" as any },
      select: {
        id: true,
        tenantId: true,
        brandId: true,
        locationId: true,
        status: true,
        fulfillmentType: true,
        metadata: true,
      },
    });
  }

  private async moveTo(
    order: { id: string; tenantId: string; status: string },
    next: string,
    extra: Record<string, unknown> = {},
  ) {
    if (order.status === next) return;
    await this.orders
      .updateStatus(order.id, order.tenantId, { status: next as any, ...extra } as any, "keeta", "WEBHOOK" as any)
      .catch((err: Error) =>
        // A refused transition is information — Keeta's lifecycle and our
        // board will not always agree on order, and their retries must not be
        // provoked by our own state machine.
        this.logger.warn(`Keeta ${order.status} → ${next} refused for ${order.id}: ${err.message}`),
      );
  }

  /** 1002 — accepted (from the Keeta merchant app, or echoing our own confirm). */
  async onAccepted(msg: { orderViewId?: unknown }) {
    const order = await this.findOrder(keetaId(msg.orderViewId));
    if (!order) return;
    if (order.status === "PENDING") await this.moveTo(order, "ACCEPTED");
  }

  /** 1003 — completed. */
  async onCompleted(msg: { orderViewId?: unknown }) {
    const order = await this.findOrder(keetaId(msg.orderViewId));
    if (!order || ["CANCELLED", "REJECTED", "COMPLETED"].includes(order.status)) return;
    await this.moveTo(order, "COMPLETED");
  }

  /**
   * 1004 — cancelled.
   *
   * Keeta customer service can cancel up to 30 days AFTER completion, and
   * their docs say those need no processing beyond recording. Flipping a
   * completed, paid, eaten order to CANCELLED would corrupt the day's
   * takings, so a late cancel is noted on the order and left there.
   */
  async onCancelled(msg: { orderViewId?: unknown; cancelReason?: string; opType?: number }) {
    const order = await this.findOrder(keetaId(msg.orderViewId));
    if (!order) return;
    const who = CANCEL_ACTOR[Number(msg.opType)] ?? "Keeta";
    const reason = `Cancelled by ${who}${msg.cancelReason ? `: ${msg.cancelReason}` : ""}`;
    if (order.status === "COMPLETED") {
      await this.patchMeta(order.id, { keetaLateCancel: { at: new Date().toISOString(), reason } });
      this.activity?.record({
        tenantId: order.tenantId,
        ...(order.brandId ? { brandId: order.brandId } : {}),
        locationId: order.locationId,
        category: "ORDERS",
        channel: "KEETA",
        action: "order.late_cancel",
        status: "WARNING",
        message: `Keeta cancelled an already-completed order after the fact — ${reason}. Left as completed; check the Keeta settlement.`,
      });
      return;
    }
    if (["CANCELLED", "REJECTED"].includes(order.status)) return;
    await this.moveTo(order, "CANCELLED", { cancelReason: reason });
  }

  /** 1006 — the Keeta rider moved. */
  async onDeliveryStatus(msg: {
    orderViewId?: unknown;
    logisticsStatus?: number;
    courierName?: string;
    courierPhone?: string;
    opTime?: number;
  }) {
    const order = await this.findOrder(keetaId(msg.orderViewId));
    if (!order) return;
    const status = Number(msg.logisticsStatus);
    const at = msg.opTime ? new Date(Number(msg.opTime)) : new Date();
    const courier: Record<string, unknown> = { courierStatus: `KEETA_${status}` };
    if (msg.courierName) courier.courierName = String(msg.courierName);
    if (msg.courierPhone) courier.courierPhone = String(msg.courierPhone);
    if (status === 20) courier.courierAssignedAt = at;
    if (status === 30) courier.courierPickedUpAt = at;
    if (status === 50) courier.courierDeliveredAt = at;
    await this.prisma.order.update({ where: { id: order.id }, data: courier as any }).catch(() => undefined);

    const next = LOGISTICS_STATUS[status];
    if (!next || ["CANCELLED", "REJECTED", "COMPLETED"].includes(order.status)) return;
    await this.moveTo(order, next);
  }

  /**
   * 1005 / 1007 — a refund request, or a change to one.
   *
   * Recorded on the order (one entry per afterSaleOrderId, latest status
   * wins) and, while it awaits the merchant, logged loudly: Keeta APPROVE IT
   * AUTOMATICALLY after 15 minutes without an answer.
   */
  async onRefund(kind: "full" | "partial", msg: Record<string, any>) {
    const order = await this.findOrder(keetaId(msg.orderViewId));
    if (!order) return;
    const meta = (order.metadata ?? {}) as Record<string, any>;
    const currency = String(msg.currency ?? meta.currency ?? "AED");
    const id = keetaId(msg.afterSaleOrderId) ?? `${kind}-${msg.opTime ?? Date.now()}`;
    const entry = {
      afterSaleOrderId: id,
      kind,
      status: Number(msg.status),
      amount: keetaMoney(msg.money, currency),
      currency,
      reason: msg.applyReason ?? null,
      handleReason: msg.handleReason ?? null,
      isAppeal: Number(msg.isAppeal ?? 0) === 1,
      pictures: safeJsonArray(msg.pictures),
      products: Array.isArray(msg.refundProducts)
        ? msg.refundProducts.map((p: any) => ({
            name: p?.nameI18n?.en || p?.name,
            count: p?.count,
            refund: keetaMoney(p?.refundPrice, currency),
          }))
        : undefined,
      updatedAt: new Date().toISOString(),
      respondBy:
        REFUND_AWAITING_MERCHANT.has(Number(msg.status)) && msg.opTime
          ? new Date(Number(msg.opTime) + 15 * 60_000).toISOString()
          : null,
    };
    const refunds: any[] = Array.isArray(meta.keetaRefunds) ? meta.keetaRefunds : [];
    const next = [...refunds.filter((r) => r?.afterSaleOrderId !== id), entry];
    await this.patchMeta(order.id, { keetaRefunds: next });

    const waiting = REFUND_AWAITING_MERCHANT.has(entry.status);
    this.activity?.record({
      tenantId: order.tenantId,
      ...(order.brandId ? { brandId: order.brandId } : {}),
      locationId: order.locationId,
      category: "ORDERS",
      channel: "KEETA",
      action: waiting ? "order.refund_requested" : "order.refund_updated",
      status: waiting ? "WARNING" : "INFO",
      message: waiting
        ? `Keeta customer asked for a ${kind} refund of ${entry.amount} ${currency}` +
          `${entry.reason ? ` ("${entry.reason}")` : ""}. Approve or reject within 15 minutes — Keeta approves it automatically after that.`
        : `Keeta refund ${id} is now status ${entry.status}`,
      details: entry,
    });
  }

  /** Approve or reject a pending refund request. */
  async answerRefund(
    tenantId: string,
    orderId: string,
    decision: "agree" | "reject",
    body: { rejectCode?: number; rejectReason?: string } = {},
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId, platform: "KEETA" as any },
      select: { id: true, externalId: true, metadata: true },
    });
    if (!order?.externalId) throw new NotFoundException("Keeta order not found");
    const shopId = String(((order.metadata as any) ?? {}).keetaShopId ?? "");
    const conn = await this.connectionForShop(shopId);
    if (!conn) throw new BadRequestException("This order's Keeta store is no longer connected");
    const token = await this.auth.tokenForConnection(conn);
    const fields: Record<string, unknown> = { orderViewId: kInt(order.externalId), shopId: kInt(shopId) };
    if (decision === "reject") {
      // 100000 other (reason required) · 100001 already prepared · 100002 already out for delivery
      const code = [100000, 100001, 100002].includes(Number(body.rejectCode)) ? Number(body.rejectCode) : 100000;
      fields.rejectCode = code;
      const reason = String(body.rejectReason ?? "").trim();
      if (code === 100000 && !reason) throw new BadRequestException("Give a reason when rejecting for 'other'.");
      if (reason) fields.rejectReason = reason;
    }
    await this.client.request(decision === "agree" ? "/order/agree" : "/order/reject", fields, { accessToken: token });
    return { ok: true };
  }

  private async patchMeta(orderId: string, patch: Record<string, unknown>) {
    const row = await this.prisma.order.findUnique({ where: { id: orderId }, select: { metadata: true } });
    const metadata = { ...((row?.metadata as any) ?? {}), ...patch };
    await this.prisma.order.update({ where: { id: orderId }, data: { metadata: metadata as any } });
  }
}

function safeJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
