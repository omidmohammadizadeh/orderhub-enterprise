// Retail R1 — item-level returns: scan the receipt, pick what came back,
// refund it, put it back on the shelf.
//
// Order of operations is the whole design:
//   1. price the return from what is still returnable (never trust the client
//      for amounts),
//   2. move the money with the provider — and stop dead if that fails,
//   3. only then book everything in ONE transaction: the Refund, its lines,
//      the ledger entry, the payment/order status and the restock.
// A provider refund that succeeds followed by a failed write is logged loudly
// with the provider's refund id so it can be booked by hand; the reverse — a
// refund booked that the customer never received — cannot happen.

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { randomUUID } from "crypto";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { OrdersService } from "../orders/orders.service";
import { VoidItemsService } from "../orders/void-items.service";
import { PaymentsService } from "../payments/payments.service";
import { RetailStockService, type StockMove } from "./retail-stock.service";
import {
  parseReceiptScan,
  priceReturn,
  resolveVariantForLine,
  returnableQuantities,
  toMajor,
  toMinor,
  type VariantRef,
} from "./retail.logic";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

/** May authorise a return without the manager PIN. Cashiers and staff need it. */
export const RETURN_MANAGER_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
];

export type RefundMethod = "ORIGINAL" | "CASH";

export interface CreateReturnInput {
  orderId: string;
  lines: Array<{ orderItemId: string; quantity: number; restock?: boolean }>;
  refundMethod?: RefundMethod;
  reason?: string;
  managerPin?: string;
}

const RETURNABLE_PAYMENT = new Set(["PAID", "PARTIALLY_REFUNDED"]);

@Injectable()
export class RetailReturnsService {
  private readonly logger = new Logger(RetailReturnsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly voids: VoidItemsService,
    private readonly payments: PaymentsService,
    private readonly stock: RetailStockService,
    private readonly socket: SocketService,
    private readonly events: EventEmitter2,
  ) {}

  /** Refunds already made against this order, by either the new or old path. */
  private async priorRefunds(orderId: string) {
    return this.prisma.refund.findMany({
      where: {
        status: { in: ["SUCCEEDED", "PENDING"] },
        OR: [{ orderId }, { payment: { orderId } }],
      },
      include: { lines: { select: { orderItemId: true, quantity: true, restock: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  private async scopedOrder(user: AuthenticatedUser, where: Prisma.OrderWhereInput, locationId?: string) {
    const access = await this.orders.resolveOrderAccessWhere(user, locationId);
    if (!access) throw new ForbiddenException("You don't have access to this location");
    return this.prisma.order.findFirst({
      where: { AND: [access, where] },
      include: {
        items: { orderBy: { createdAt: "asc" } },
        payments: true,
        location: { select: { id: true, name: true, currency: true, businessType: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Find the sale a receipt belongs to — from the receipt's QR, or the number
   * printed on it — and say what can still come back and how it can be paid.
   */
  async findSale(user: AuthenticatedUser, locationId: string, scan: string) {
    const parsed = parseReceiptScan(scan);
    if (!parsed) throw new BadRequestException("Scan the receipt, or type the order number");
    let where: Prisma.OrderWhereInput;
    if (parsed.kind === "orderId") {
      where = { id: parsed.orderId };
    } else {
      const or: Prisma.OrderWhereInput[] = [{ displayId: parsed.value.toUpperCase() }];
      if (/^\d{1,9}$/.test(parsed.value)) or.push({ orderNumber: Number(parsed.value) });
      where = { OR: or };
    }
    const order = await this.scopedOrder(user, where, locationId);
    if (!order) throw new NotFoundException("No sale found for that receipt at this shop");
    return this.describe(order);
  }

  private async describe(order: any) {
    const prior = await this.priorRefunds(order.id);
    const priorLines = prior.flatMap((r) => r.lines);
    const left = returnableQuantities(
      order.items.map((i: any) => ({ id: i.id, name: i.name, quantity: i.quantity, totalMinor: toMinor(i.totalPrice) })),
      priorLines,
    );
    const refundedMinor = prior.reduce((s, r) => s + toMinor(r.amount), 0);
    const card = this.cardPayment(order.payments);
    return {
      order: {
        id: order.id,
        displayId: order.displayId,
        orderNumber: order.orderNumber,
        createdAt: order.createdAt,
        status: order.status,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        total: Number(order.total),
        subtotal: Number(order.subtotal),
        discount: Number(order.discount),
        currency: order.location?.currency ?? "GBP",
        locationName: order.location?.name ?? null,
      },
      items: order.items.map((i: any) => ({
        id: i.id,
        name: i.name,
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
        totalPrice: Number(i.totalPrice),
        returnable: left.get(i.id) ?? 0,
      })),
      refunded: refundedMinor / 100,
      refundable: Math.max(0, toMinor(order.total) - refundedMinor) / 100,
      canReturn: RETURNABLE_PAYMENT.has(order.paymentStatus),
      // What "refund to original payment" will actually do for this sale.
      original: card
        ? card.provider === "STRIPE" && card.stripePaymentIntentId
          ? { method: "CARD", provider: "STRIPE", supported: true }
          : {
              method: "CARD",
              provider: card.provider,
              supported: false,
              note: "Paid on a card machine that needs the customer's card present — refund as cash, or use Refund on card machine from the order.",
            }
        : { method: "CASH", provider: null, supported: true },
      returns: prior.map((r) => ({
        id: r.id,
        amount: Number(r.amount),
        method: r.method,
        reason: r.reason,
        createdAt: r.createdAt,
        lines: r.lines,
      })),
    };
  }

  /** The card payment a refund would go back to, if the sale was paid by card. */
  private cardPayment(payments: any[]) {
    return (
      (payments ?? [])
        .filter((p) => p.status === "SUCCEEDED" || p.status === "REFUNDED")
        .filter((p) => p.method !== "CASH")
        .sort((a, b) => Number(b.amount) - Number(a.amount))[0] ?? null
    );
  }

  async createReturn(user: AuthenticatedUser, input: CreateReturnInput) {
    const order: any = await this.scopedOrder(user, { id: input.orderId });
    if (!order) throw new NotFoundException("Sale not found");
    if (!RETURNABLE_PAYMENT.has(order.paymentStatus)) {
      throw new BadRequestException(
        order.paymentStatus === "REFUNDED"
          ? "This sale has already been refunded in full"
          : "This sale hasn't been paid, so there is nothing to refund",
      );
    }

    // A cashier can take a return, but only with a manager standing there.
    if (!RETURN_MANAGER_ROLES.includes(String(user.role))) {
      if (!input.managerPin) throw new ForbiddenException("A manager PIN is needed for returns");
      await this.voids.assertPin(order.locationId, input.managerPin);
    }
    const reason = String(input.reason ?? "").trim() || null;

    // 1. Price it from the database, never from the request.
    const prior = await this.priorRefunds(order.id);
    let priced: ReturnType<typeof priceReturn>;
    try {
      priced = priceReturn({
        items: order.items.map((i: any) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          totalMinor: toMinor(i.totalPrice),
        })),
        prior: prior.flatMap((r) => r.lines),
        request: (input.lines ?? []).map((l) => ({ orderItemId: l.orderItemId, quantity: Number(l.quantity) })),
        subtotalMinor: toMinor(order.subtotal),
        discountMinor: toMinor(order.discount),
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const refundedMinor = prior.reduce((s, r) => s + toMinor(r.amount), 0);
    const leftMinor = Math.max(0, toMinor(order.total) - refundedMinor);
    let amountMinor = priced.reduce((s, l) => s + l.amountMinor, 0);
    // Rounding across several partial returns can drift a penny past what
    // was paid; the order total is the hard ceiling.
    if (amountMinor > leftMinor) {
      if (amountMinor - leftMinor > priced.length) {
        throw new BadRequestException("That is more than is left to refund on this sale");
      }
      const over = amountMinor - leftMinor;
      priced[priced.length - 1]!.amountMinor -= over;
      amountMinor = leftMinor;
    }
    if (amountMinor <= 0) throw new BadRequestException("Nothing to refund");

    // 2. Move the money.
    const method: RefundMethod = input.refundMethod === "CASH" ? "CASH" : "ORIGINAL";
    const card = method === "ORIGINAL" ? this.cardPayment(order.payments) : null;
    let paidBack: "CASH" | "CARD" = "CASH";
    let providerRefundId: string | null = null;
    if (card) {
      if (card.provider !== "STRIPE" || !card.stripePaymentIntentId) {
        throw new BadRequestException(
          "This sale was paid on a card machine that needs the customer's card present. Refund it as cash, or use Refund on card machine from the order.",
        );
      }
      const alreadyOnCard = prior
        .filter((r) => r.paymentId === card.id)
        .reduce((s, r) => s + toMinor(r.amount), 0);
      const cardLeft = toMinor(card.amount) + toMinor(card.tipAmount) - alreadyOnCard;
      if (amountMinor > cardLeft) {
        throw new BadRequestException(
          `Only ${toMajor(cardLeft)} is left to refund on the card — refund the rest as cash`,
        );
      }
      providerRefundId = await this.payments.refundStripeAmount(card, amountMinor, {
        kind: "retail_return",
        reason: reason ?? "",
      });
      paidBack = "CARD";
    }

    // 3. Book it all at once.
    const variants = await this.variantsFor(order);
    const fullyRefunded = refundedMinor + amountMinor >= toMinor(order.total);
    try {
      const refund = await this.prisma.$transaction(async (tx) => {
        const created = await tx.refund.create({
          data: {
            tenantId: order.tenantId,
            paymentId: card?.id ?? null,
            orderId: order.id,
            method: paidBack,
            stripeRefundId: providerRefundId,
            amount: toMajor(amountMinor),
            reason,
            status: "SUCCEEDED",
            isPartial: !fullyRefunded,
            processedBy: user.userId ?? null,
            note: "Retail return",
          },
        });
        const moves: StockMove[] = [];
        for (const line of priced) {
          const lineId = randomUUID();
          const restock = input.lines.find((l) => l.orderItemId === line.orderItemId)?.restock !== false;
          await tx.refundLine.create({
            data: {
              id: lineId,
              refundId: created.id,
              orderItemId: line.orderItemId,
              quantity: line.quantity,
              amount: toMajor(line.amountMinor),
              restock,
            },
          });
          const item = order.items.find((i: any) => i.id === line.orderItemId);
          const v = item ? resolveVariantForLine(item, variants.byItem, variants.byId) : null;
          if (restock && v?.trackStock) {
            moves.push({
              tenantId: order.tenantId,
              locationId: order.locationId,
              variantId: v.id,
              type: "RETURN",
              quantity: line.quantity,
              reason: reason ?? "Customer return",
              orderId: order.id,
              refundId: created.id,
              recordedBy: user.userId ?? null,
              dedupeKey: `return:${lineId}`,
            });
          }
        }
        await tx.ledgerEntry.create({
          data: {
            tenantId: order.tenantId,
            paymentId: card?.id ?? null,
            refundId: created.id,
            type: "REFUND",
            amount: toMajor(amountMinor),
            currency: String(card?.currency ?? order.location?.currency ?? "GBP").toLowerCase(),
            description: `Return on order #${order.orderNumber ?? order.displayId ?? order.id} (${paidBack.toLowerCase()})${reason ? `: ${reason}` : ""}`,
            reference: providerRefundId ?? created.id,
            metadata: { kind: "retail_return", lines: priced.length },
          },
        });
        if (card) {
          const cardRefunded =
            prior.filter((r) => r.paymentId === card.id).reduce((s, r) => s + toMinor(r.amount), 0) + amountMinor;
          if (cardRefunded >= toMinor(card.amount) + toMinor(card.tipAmount)) {
            await tx.payment.update({ where: { id: card.id }, data: { status: "REFUNDED" } });
          }
        }
        await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED" },
        });
        await this.stock.applyMoves(moves, tx);
        return created;
      });

      this.socket.emitToTenant(order.tenantId, "order:updated" as any, {
        orderId: order.id,
        paymentStatus: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
      } as any);
      this.events.emit("activity.log", {
        tenantId: order.tenantId,
        locationId: order.locationId,
        brandId: order.brandId ?? null,
        category: "ORDERS",
        channel: order.platform ?? "POS",
        action: "order.returned",
        status: "INFO",
        message: `Return on order #${order.orderNumber ?? order.displayId ?? order.id}: ${priced.reduce((s, l) => s + l.quantity, 0)} item(s), ${toMajor(amountMinor)} back by ${paidBack.toLowerCase()}`,
        details: { orderId: order.id, refundId: refund.id, method: paidBack },
      });

      const sale: any = await this.scopedOrder(user, { id: order.id });
      return { refundId: refund.id, amount: amountMinor / 100, method: paidBack, sale: await this.describe(sale) };
    } catch (err) {
      if (providerRefundId) {
        this.logger.error(
          `RETURN NOT BOOKED: Stripe refund ${providerRefundId} (${toMajor(amountMinor)}) went through for order ${order.id} but writing it failed: ${(err as Error).message}. Book it by hand.`,
        );
      }
      throw err;
    }
  }

  private async variantsFor(order: any) {
    const itemIds = [...new Set(order.items.map((i: any) => i.menuItemId).filter(Boolean))] as string[];
    const explicit = order.items
      .map((i: any) => i.metadata?.variantId)
      .filter((v: unknown): v is string => typeof v === "string");
    const rows: VariantRef[] = itemIds.length || explicit.length
      ? await this.prisma.productVariant.findMany({
          where: { tenantId: order.tenantId, OR: [{ menuItemId: { in: itemIds } }, { id: { in: explicit } }] },
          select: { id: true, menuItemId: true, sku: true, trackStock: true },
        })
      : [];
    const byItem = new Map<string, VariantRef[]>();
    const byId = new Map<string, VariantRef>();
    for (const v of rows) {
      byId.set(v.id, v);
      byItem.set(v.menuItemId, [...(byItem.get(v.menuItemId) ?? []), v]);
    }
    return { byItem, byId };
  }
}
