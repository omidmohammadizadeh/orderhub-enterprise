import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { currencyForCountry } from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { PaymentsService } from "../payments.service";
import { DojoLocationConfig, DojoService } from "./dojo.service";
import { activeDojoLock as activeLock, DojoLock } from "./dojo-lock";

// Pay at Table — OUR side of Dojo's "EPOS Data API (REST)".
//
// Dojo's card machine is the client here: a waiter picks a table on the
// machine, it asks us for that table's open bill, locks it, takes the card,
// then tells us to record the payment. Contract verified against Dojo's
// published spec (docs.dojo.tech/epos-data/bundled.json, "EPOS Data API
// (REST) 1.0") — Pay at Table requires SearchOrders, GetOrderById,
// GetOrderBillById and RecordOrderPaymentById; the lock trio is optional but
// all-or-nothing, and we implement it.
//
// ── What a Dojo "order" is for us ──────────────────────────────────────────
//
// An open TABLE TAB: an order with a tableId that isn't closed. That's the
// only thing a waiter can sensibly pay at a table, and it keeps Dojo away
// from takeaway/delivery orders entirely.
//
// ── Money ──────────────────────────────────────────────────────────────────
//
// record-payment is the one write. It never trusts the body: the payment
// intent is fetched from Dojo with the shop's own key and must be for the
// amount claimed (DojoService.intentCovers). The "still owed" check and the
// insert run under a row lock on the order, so two machines paying the same
// table at once can't both pass and overpay. Anything we refuse is answered
// with Conflict — Dojo's documented behaviour is to reverse the payment, so
// the customer is never charged for something we didn't record.

export type EposErrorType = "NotFound" | "UnexpectedError" | "InvalidRequest" | "Conflict";

/** An error in the exact EPOSError shape Dojo expects. */
export class EposError extends HttpException {
  constructor(errorType: EposErrorType, debugMessage: string, status?: number) {
    super(
      { errorType, debugMessage, traceId: randomUUID() },
      status ??
        (errorType === "NotFound"
          ? HttpStatus.NOT_FOUND
          : errorType === "Conflict"
            ? HttpStatus.CONFLICT
            : errorType === "InvalidRequest"
              ? HttpStatus.BAD_REQUEST
              : HttpStatus.INTERNAL_SERVER_ERROR),
    );
  }
}

export interface Money {
  value: number;
  currencyCode: string;
}

export interface EposContext {
  loc: {
    id: string;
    name: string;
    country: string | null;
    address: unknown;
    phone: string | null;
    city?: string | null;
    postcode?: string | null;
  };
  cfg: DojoLocationConfig;
  tenantId: string;
}

/** Tabs that are still open. Mirrors OrdersService.addRound's EDITABLE set. */
const OPEN_TAB_STATUSES = ["PENDING", "ACCEPTED", "PREPARING", "READY"] as const;

const STATUS_MAP: Record<string, string> = {
  PENDING: "Submitted",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  READY: "Ready",
  COMPLETED: "Finalized",
  CANCELLED: "Canceled",
  REJECTED: "Canceled",
  FAILED: "Failed",
};

const minor = (gbp: unknown) => Math.round(Number(gbp ?? 0) * 100);

/** Area ids are derived from the free-text Table.area; keep them URL-safe. */
export function areaIdOf(area: string | null | undefined): string {
  const a = (area ?? "").trim();
  return a ? `area-${Buffer.from(a.toLowerCase()).toString("base64url")}` : "area-main";
}

@Injectable()
export class DojoEposService {
  private readonly logger = new Logger(DojoEposService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dojo: DojoService,
    private readonly payments: PaymentsService,
  ) {}

  private currency(ctx: EposContext): string {
    // Dojo takes GBP and EUR only; DojoService refuses to charge anything else.
    return currencyForCountry(ctx.loc.country).toUpperCase() === "EUR" ? "EUR" : "GBP";
  }

  private money(ctx: EposContext, gbp: unknown): Money {
    return { value: minor(gbp), currencyCode: this.currency(ctx) };
  }

  // ── Areas + tables ────────────────────────────────────────────────────────

  async listAreas(ctx: EposContext) {
    const tables = await this.prisma.table.findMany({
      where: { locationId: ctx.loc.id, isActive: true },
      select: { area: true },
    });
    const seen = new Map<string, string>();
    for (const t of tables) {
      const name = (t.area ?? "").trim() || "Main";
      seen.set(areaIdOf(t.area), name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }

  async searchTables(ctx: EposContext, body: { areaId?: string; cursor?: { limit?: number; after?: string } }) {
    const tables = await this.prisma.table.findMany({
      where: { locationId: ctx.loc.id, isActive: true, outOfService: false },
      orderBy: [{ area: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, seats: true, area: true },
    });
    const filtered = body?.areaId ? tables.filter((t) => areaIdOf(t.area) === body.areaId) : tables;
    const page = this.paginate(filtered, body?.cursor);
    return {
      data: page.rows.map((t) => ({
        id: t.id,
        name: t.name,
        ...(t.seats ? { maxCovers: t.seats } : {}),
        areaId: areaIdOf(t.area),
      })),
      ...(page.after ? { after: page.after } : {}),
    };
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  private orderInclude = {
    items: { select: { name: true, quantity: true, unitPrice: true, totalPrice: true, modifiers: true, notes: true, menuItemId: true, id: true } },
    // metadata carries refundedMinor: a PART-refunded payment keeps status
    // SUCCEEDED, so counting its full amount as paid would tell the terminal
    // the table owes less than it does.
    payments: { where: { status: "SUCCEEDED" }, select: { amount: true, tipAmount: true, provider: true, providerChargeId: true, stripePaymentIntentId: true, id: true, metadata: true } },
  } as const;

  private async loadTab(ctx: EposContext, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, locationId: ctx.loc.id, tenantId: ctx.tenantId, tableId: { not: null } },
      include: this.orderInclude as any,
    });
    if (!order) throw new EposError("NotFound", `No table order ${orderId} at this location`);
    return order as any;
  }

  async searchOrders(
    ctx: EposContext,
    body: { dineIn?: { tableId?: string }; payableOnly?: boolean; cursor?: { limit?: number; after?: string } },
  ) {
    const orders = await this.prisma.order.findMany({
      where: {
        locationId: ctx.loc.id,
        tenantId: ctx.tenantId,
        tableId: body?.dineIn?.tableId ? body.dineIn.tableId : { not: null },
        status: { in: [...OPEN_TAB_STATUSES] as any },
      },
      orderBy: { createdAt: "asc" },
      include: this.orderInclude as any,
    });
    const mapped = (await Promise.all(orders.map((o) => this.toDojoOrder(ctx, o as any)))).filter(
      (o) => !body?.payableOnly || o.payable,
    );
    const page = this.paginate(mapped, body?.cursor);
    return { data: page.rows, ...(page.after ? { after: page.after } : {}) };
  }

  async getOrder(ctx: EposContext, orderId: string) {
    return this.toDojoOrder(ctx, await this.loadTab(ctx, orderId));
  }

  async getBill(ctx: EposContext, orderId: string) {
    const order = await this.getOrder(ctx, orderId);
    const addr = (ctx.loc.address ?? {}) as Record<string, any>;
    const addressLines = [addr.line1 ?? addr.addressLine1, addr.line2 ?? addr.addressLine2, addr.city ?? ctx.loc.city]
      .filter((l) => typeof l === "string" && l.trim())
      .map((l: string) => l.trim());
    const postcode = (addr.postcode ?? addr.postal_code ?? ctx.loc.postcode ?? "").toString().trim();
    const header: any[] = [{ lineType: "MerchantName", merchantName: { name: ctx.loc.name } }];
    if (addressLines.length && postcode) {
      header.push({ lineType: "MerchantAddress", merchantAddress: { addressLines, postcode } });
    }
    if (ctx.loc.phone) {
      header.push({ lineType: "MerchantPhoneNumber", merchantPhoneNumber: { phoneNumber: ctx.loc.phone } });
    }
    header.push({ lineType: "HorizontalLine", horizontalLine: { line: "Single" } });
    return {
      header: { lines: header },
      order,
      footer: {
        lines: [
          { lineType: "HorizontalLine", horizontalLine: { line: "Single" } },
          { lineType: "Text", text: { value: "Thank you for dining with us", size: "Body", align: "Center" } },
        ],
      },
    };
  }

  /** Map one of our table orders onto Dojo's Order schema. */
  async toDojoOrder(ctx: EposContext, order: any) {
    const items = (order.items ?? []).map((it: any) => {
      const qty = Math.max(1, Number(it.quantity ?? 1));
      const perUnit = Math.round(minor(it.totalPrice) / qty);
      const mods = Array.isArray(it.modifiers) ? (it.modifiers as any[]) : [];
      const modLines = mods
        .filter((m) => m && typeof m.name === "string")
        .map((m, i) => ({
          name: m.name,
          quantity: Math.max(1, Number(m.quantity ?? 1)),
          perModifier: minor(m.price),
          plu: `mod-${i}`,
        }));
      const modsPerUnit = modLines.reduce((s, m) => s + m.perModifier * m.quantity, 0);
      // Dojo wants the BASE price before modifiers. Our line totals are the
      // source of truth, so derive the base from them; if our modifier prices
      // don't reconcile (legacy data), list the modifiers at 0 rather than
      // show the waiter a bill that doesn't add up.
      const reconciles = modsPerUnit <= perUnit;
      return {
        name: it.name,
        plu: it.menuItemId ?? it.id,
        quantity: qty,
        amountPerItem: { value: reconciles ? perUnit - modsPerUnit : perUnit, currencyCode: this.currency(ctx) },
        ...(it.notes ? { note: it.notes } : {}),
        ...(modLines.length
          ? {
              modifiers: modLines.map((m) => ({
                name: m.name,
                quantity: m.quantity,
                plu: m.plu,
                amountPerModifier: { value: reconciles ? m.perModifier : 0, currencyCode: this.currency(ctx) },
              })),
            }
          : {}),
      };
    });

    // What a payment is still worth to the shop. A fully refunded row isn't
    // SUCCEEDED so it never reaches here; a partly refunded one does, and only
    // the part we kept counts towards the bill.
    const keptMinor = (p: any) =>
      Math.max(0, minor(p.amount) - Number((p.metadata as any)?.refundedMinor ?? 0));
    const payments = (order.payments ?? [])
      .filter((p: any) => keptMinor(p) > 0)
      .map((p: any) => ({
        paymentIntentId: p.providerChargeId ?? p.stripePaymentIntentId ?? p.id,
        paidAmount: { value: keptMinor(p), currencyCode: this.currency(ctx) },
        ...(Number(p.tipAmount) > 0 ? { tipsAmount: this.money(ctx, p.tipAmount) } : {}),
      }));
    const paidMinor = (order.payments ?? []).reduce((s: number, p: any) => s + keptMinor(p), 0);
    const tipsMinor = (order.payments ?? []).reduce((s: number, p: any) => s + minor(p.tipAmount), 0);
    const totalMinor = minor(order.total);
    const open = (OPEN_TAB_STATUSES as readonly string[]).includes(order.status);
    const payable = open && order.paymentStatus !== "PAID" && totalMinor - paidMinor > 0;

    const table = order.tableId
      ? await this.prisma.table.findUnique({ where: { id: order.tableId }, select: { name: true, serverId: true } })
      : null;

    return {
      id: order.id,
      reference: order.displayId ?? order.id.slice(-8),
      displayName: table?.name ? `Table ${table.name}` : order.displayId ?? "Table order",
      status: STATUS_MAP[order.status] ?? "Accepted",
      createdAt: new Date(order.createdAt).toISOString(),
      updatedAt: new Date(order.updatedAt).toISOString(),
      items,
      ...(Number(order.discount) > 0
        ? { discounts: [{ name: order.discountType ?? "Discount", amountTotal: this.money(ctx, order.discount) }] }
        : {}),
      ...(Number(order.taxAmount) > 0
        ? { taxLines: [{ name: "VAT", amountTotal: this.money(ctx, order.taxAmount) }] }
        : {}),
      ...(Number(order.serviceCharge) > 0 ? { serviceChargeAmount: this.money(ctx, order.serviceCharge) } : {}),
      totalAmount: { value: totalMinor, currencyCode: this.currency(ctx) },
      paidAmount: { value: paidMinor, currencyCode: this.currency(ctx) },
      ...(tipsMinor > 0 ? { tipsAmount: { value: tipsMinor, currencyCode: this.currency(ctx) } } : {}),
      payments,
      payable,
      ...(order.customerName ? { customer: { name: order.customerName } } : {}),
      details: {
        orderType: "DineIn",
        dineIn: {
          tableId: order.tableId,
          ...(table?.serverId ? { waiterId: table.serverId } : {}),
        },
      },
    };
  }

  // ── Locks ─────────────────────────────────────────────────────────────────

  private async writeLock(orderId: string, metadata: unknown, lock: DojoLock | null) {
    const next = { ...((metadata ?? {}) as Record<string, any>) };
    if (lock) next.dojoLock = lock;
    else delete next.dojoLock;
    await this.prisma.order.update({ where: { id: orderId }, data: { metadata: next as any } });
  }

  async createLock(ctx: EposContext, orderId: string, body: { lockId?: string; expiry?: string }) {
    if (!body?.lockId || !body?.expiry || Number.isNaN(Date.parse(body.expiry))) {
      throw new EposError("InvalidRequest", "lockId and a valid expiry are required");
    }
    const order = await this.loadTab(ctx, orderId);
    const existing = activeLock(order.metadata);
    if (existing && existing.lockId !== body.lockId) {
      throw new EposError("Conflict", "This table is already being paid on another card machine");
    }
    if (!(OPEN_TAB_STATUSES as readonly string[]).includes(order.status)) {
      throw new EposError("Conflict", "This table's order is already closed");
    }
    await this.writeLock(order.id, order.metadata, { lockId: body.lockId, expiry: body.expiry });
    return this.getOrder(ctx, orderId);
  }

  async extendLock(ctx: EposContext, orderId: string, lockId: string, body: { expiry?: string }) {
    if (!body?.expiry || Number.isNaN(Date.parse(body.expiry))) {
      throw new EposError("InvalidRequest", "A valid expiry is required");
    }
    const order = await this.loadTab(ctx, orderId);
    const lock = ((order.metadata ?? {}) as any).dojoLock as DojoLock | undefined;
    if (!lock || lock.lockId !== lockId) throw new EposError("NotFound", "No such lock on this order");
    await this.writeLock(order.id, order.metadata, { lockId, expiry: body.expiry });
    return {};
  }

  async deleteLock(ctx: EposContext, orderId: string, lockId: string) {
    const order = await this.loadTab(ctx, orderId);
    const lock = ((order.metadata ?? {}) as any).dojoLock as DojoLock | undefined;
    // Releasing a lock that's already gone is success — Dojo retries.
    if (lock && lock.lockId === lockId) await this.writeLock(order.id, order.metadata, null);
    return this.getOrder(ctx, orderId);
  }

  // ── Record payment ────────────────────────────────────────────────────────

  async recordPayment(
    ctx: EposContext,
    orderId: string,
    body: { paymentIntentId?: string; paidAmount?: Money; tipsAmount?: Money; lockId?: string },
    requester: { waiterId?: string; deviceId?: string },
  ) {
    const piId = body?.paymentIntentId;
    const paidMinor = Number(body?.paidAmount?.value);
    const tipsMinor = Math.max(0, Number(body?.tipsAmount?.value ?? 0)) || 0;
    if (!piId || !Number.isInteger(paidMinor) || paidMinor <= 0) {
      throw new EposError("InvalidRequest", "paymentIntentId and a positive paidAmount are required");
    }
    if (body.paidAmount?.currencyCode && body.paidAmount.currencyCode.toUpperCase() !== this.currency(ctx)) {
      throw new EposError("Conflict", `This location takes ${this.currency(ctx)}`);
    }

    // Idempotency: Dojo may retry. The same intent on the same order is a
    // success; on a different order it's a mistake we must refuse.
    const already = await (this.prisma as any).payment.findFirst({
      where: { providerChargeId: piId },
      select: { orderId: true },
    });
    if (already) {
      if (already.orderId !== orderId) {
        throw new EposError("Conflict", "That payment is already recorded against another order");
      }
      return this.getOrder(ctx, orderId);
    }

    const order = await this.loadTab(ctx, orderId);
    const lock = activeLock(order.metadata);
    if (lock && body.lockId && lock.lockId !== body.lockId) {
      throw new EposError("Conflict", "Another card machine holds this table");
    }

    // The money check. Never skip, never trust the body's amount.
    const client = this.dojo.clientFor(ctx.cfg);
    let pi;
    try {
      pi = await client.getPaymentIntent(piId);
    } catch (err: any) {
      // We can't prove the money exists; refusing makes Dojo reverse it,
      // which is the safe direction (never an unrecorded charge).
      throw new EposError("UnexpectedError", `Couldn't verify the payment with Dojo: ${err?.message}`, 502);
    }
    if (!this.dojo.intentCovers(pi, paidMinor, true)) {
      throw new EposError("Conflict", "The payment on the card machine doesn't match the amount being recorded");
    }

    const paidGbp = paidMinor / 100;
    const tipGbp = tipsMinor / 100;
    const created = await this.prisma.$transaction(async (tx: any) => {
      // Row lock: serialise every payment against this order.
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
      const fresh = await tx.order.findUnique({
        where: { id: orderId },
        select: { total: true, status: true, paymentStatus: true },
      });
      if (!fresh || !(OPEN_TAB_STATUSES as readonly string[]).includes(fresh.status) || fresh.paymentStatus === "PAID") {
        throw new EposError("Conflict", "This table is already paid or closed");
      }
      const rows = await tx.payment.findMany({
        where: { orderId, status: "SUCCEEDED" },
        select: { amount: true },
      });
      const paidSoFar = rows.reduce((s: number, p: any) => s + minor(p.amount), 0);
      const remaining = minor(fresh.total) - paidSoFar;
      if (paidMinor > remaining + 1) {
        throw new EposError("Conflict", `Only ${(remaining / 100).toFixed(2)} is still owed on this table`);
      }
      return tx.payment.create({
        data: {
          tenantId: ctx.tenantId,
          orderId,
          provider: "DOJO",
          providerChargeId: piId,
          amount: paidGbp,
          tipAmount: tipGbp,
          currency: this.currency(ctx).toLowerCase(),
          // PROCESSING, then settleCardPresentPayment banks it — the one path
          // that decides PAID and closes the table.
          status: "PROCESSING",
          method: "CARD",
          platformFee: 0,
          netAmount: paidGbp,
          metadata: {
            source: "dojo_pay_at_table",
            // Always a PART as far as settlement is concerned: the order only
            // flips PAID when the banked parts cover it.
            split: true,
            dojoStatus: pi.status,
            ...(body.lockId ? { lockId: body.lockId } : {}),
            ...(requester.waiterId ? { waiterId: requester.waiterId } : {}),
            ...(requester.deviceId ? { deviceId: requester.deviceId } : {}),
            ...(ctx.cfg.environment === "sandbox" ? { sandbox: true } : {}),
          },
        },
      });
    });

    await this.payments.settleCardPresentPayment(created, piId);
    this.logger.log(
      `Dojo Pay at Table: recorded ${paidGbp.toFixed(2)}${tipGbp ? ` + ${tipGbp.toFixed(2)} tip` : ""} on order ${orderId} (${piId})`,
    );
    // Return the order even if it has now closed — Dojo reads it back.
    const after = await this.prisma.order.findUnique({ where: { id: orderId }, include: this.orderInclude as any });
    return this.toDojoOrder(ctx, after as any);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Offset cursor. Opaque to Dojo; `after` is simply the next index. */
  private paginate<T>(rows: T[], cursor?: { limit?: number; after?: string }) {
    const limit = Math.min(Math.max(Number(cursor?.limit) || 100, 1), 100);
    const start = cursor?.after && /^\d+$/.test(cursor.after) ? Number(cursor.after) : 0;
    const slice = rows.slice(start, start + limit);
    const next = start + limit < rows.length ? String(start + limit) : null;
    return { rows: slice, after: next };
  }
}
