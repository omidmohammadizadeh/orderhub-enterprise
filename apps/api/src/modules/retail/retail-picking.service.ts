// Retail R3 — picking online orders at a shop.
//
// A grocery order is not cooked, it is picked: someone walks the aisles with
// a tablet, ticks off what they found, swaps what they didn't for something
// close (if the shopper allowed it), and hands the bag to a courier. Only
// then is the price final — so the money is settled here:
//   - a card payment is refunded the shortfall (missing items in full, a
//     substitute never costs more than what it replaced);
//   - cash on delivery/collection simply collects less (the order total is
//     reduced before the driver sets off).
// Same order of operations as till returns: price from the database, move
// the money (stop dead if that fails), then book it all in one transaction.

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
import { PaymentsService } from "../payments/payments.service";
import { RetailStockService, type StockMove } from "./retail-stock.service";
import {
  normalizePick,
  priceShortfall,
  resolveVariantForLine,
  toMajor,
  toMinor,
  type PickState,
  type VariantRef,
} from "./retail.logic";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

/** Statuses an order is picked in (and READY, so the hand-off stays on screen). */
const ON_PICK_LIST = ["ACCEPTED", "PREPARING", "READY"] as const;

@Injectable()
export class RetailPickingService {
  private readonly logger = new Logger(RetailPickingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly stock: RetailStockService,
    private readonly socket: SocketService,
    private readonly events: EventEmitter2,
  ) {}

  private async scoped(user: AuthenticatedUser, orderId: string) {
    const access = await this.orders.resolveOrderAccessWhere(user);
    if (!access) throw new ForbiddenException("You don't have access to this order");
    const order: any = await this.prisma.order.findFirst({
      where: { AND: [access, { id: orderId }] },
      include: {
        items: { orderBy: { createdAt: "asc" } },
        payments: true,
        location: { select: { id: true, currency: true, businessType: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  // ── The list ──────────────────────────────────────────────────────────────

  /**
   * Online orders waiting to be picked (or just picked, awaiting a courier),
   * each line with its aisle, barcodes, the shopper's substitution choice and
   * what has been picked so far. Walk-in till sales never appear here.
   */
  async list(user: AuthenticatedUser, locationId: string) {
    const access = await this.orders.resolveOrderAccessWhere(user, locationId);
    if (!access) return { orders: [] };
    const orders: any[] = await this.prisma.order.findMany({
      where: {
        AND: [
          access,
          {
            locationId,
            status: { in: [...ON_PICK_LIST] },
            isWalkIn: false,
            tableId: null,
          },
        ],
      },
      include: { items: { orderBy: { createdAt: "asc" } } },
      orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
      take: 100,
    });

    const itemIds = [...new Set(orders.flatMap((o) => o.items.map((i: any) => i.menuItemId)).filter(Boolean))];
    const [aisles, variants] = await Promise.all([
      itemIds.length
        ? this.prisma.menuItemOnCategory.findMany({
            where: { itemId: { in: itemIds } },
            select: { itemId: true, category: { select: { name: true, sortOrder: true } } },
          })
        : [],
      itemIds.length
        ? this.prisma.productVariant.findMany({
            where: { menuItemId: { in: itemIds }, isActive: true },
            select: { id: true, menuItemId: true, barcode: true, sku: true, name: true },
          })
        : [],
    ]);
    // An item can sit in several categories; the lowest-sorted one is its aisle.
    const aisleOf = new Map<string, { name: string; sortOrder: number }>();
    for (const a of aisles) {
      const cur = aisleOf.get(a.itemId);
      if (!cur || a.category.sortOrder < cur.sortOrder) aisleOf.set(a.itemId, a.category);
    }
    const barcodesOf = new Map<string, string[]>();
    for (const v of variants) {
      if (v.barcode) barcodesOf.set(v.menuItemId, [...(barcodesOf.get(v.menuItemId) ?? []), v.barcode]);
    }

    return {
      orders: orders.map((o) => {
        const lines = o.items.map((i: any) => {
          const meta = (i.metadata ?? {}) as Record<string, any>;
          const aisle = i.menuItemId ? aisleOf.get(i.menuItemId) : undefined;
          return {
            id: i.id,
            name: i.name,
            quantity: i.quantity,
            unitPrice: Number(i.unitPrice),
            notes: i.notes,
            modifiers: i.modifiers,
            aisle: aisle?.name ?? "Other",
            aisleOrder: aisle?.sortOrder ?? 9999,
            barcodes: i.menuItemId ? (barcodesOf.get(i.menuItemId) ?? []) : [],
            variantId: typeof meta.variantId === "string" ? meta.variantId : null,
            substitution: meta.substitution === "NONE" ? "NONE" : "BEST_MATCH",
            pick: (meta.pick as PickState | undefined) ?? null,
          };
        });
        lines.sort((a: any, b: any) => a.aisleOrder - b.aisleOrder || a.aisle.localeCompare(b.aisle));
        return {
          id: o.id,
          displayId: o.displayId,
          orderNumber: o.orderNumber,
          status: o.status,
          fulfillmentType: o.fulfillmentType,
          orderSource: o.orderSource,
          customerName: (o.customerInfo as any)?.name ?? "",
          scheduledFor: o.scheduledFor,
          createdAt: o.createdAt,
          specialInstructions: o.specialInstructions ?? null,
          paymentMethod: o.paymentMethod,
          paymentStatus: o.paymentStatus,
          total: Number(o.total),
          picking: (o.metadata as any)?.picking ?? null,
          lines,
        };
      }),
    };
  }

  // ── Picking ───────────────────────────────────────────────────────────────

  /** Move an accepted order onto the picker (PREPARING). Harmless to repeat. */
  async start(user: AuthenticatedUser, orderId: string) {
    const order = await this.scoped(user, orderId);
    if (order.status === "ACCEPTED") {
      await this.orders.updateStatus(order.id, order.tenantId, { status: "PREPARING" } as any, user.userId);
    } else if (order.status !== "PREPARING") {
      throw new BadRequestException(`This order is ${order.status.toLowerCase().replace(/_/g, " ")}, not waiting to be picked`);
    }
    return { ok: true };
  }

  async setLine(user: AuthenticatedUser, orderId: string, itemId: string, input: PickState) {
    const order = await this.scoped(user, orderId);
    if ((order.metadata as any)?.picking?.completedAt) {
      throw new BadRequestException("Picking is already finished for this order");
    }
    if (order.status === "ACCEPTED") {
      await this.orders.updateStatus(order.id, order.tenantId, { status: "PREPARING" } as any, user.userId);
    } else if (order.status !== "PREPARING") {
      throw new BadRequestException("This order isn't being picked");
    }
    const item = order.items.find((i: any) => i.id === itemId);
    if (!item) throw new NotFoundException("That item isn't on this order");
    const meta = (item.metadata ?? {}) as Record<string, any>;
    let pick: PickState;
    try {
      pick = normalizePick(item, input);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    if (pick.sub && meta.substitution === "NONE") {
      throw new BadRequestException("The customer asked for no substitute on this item");
    }
    await this.prisma.orderItem.update({
      where: { id: item.id },
      data: {
        metadata: {
          ...meta,
          pick: { ...pick, by: user.userId, at: new Date().toISOString() },
        } as Prisma.InputJsonValue,
      },
    });
    return { id: item.id, pick };
  }

  // ── Finishing ─────────────────────────────────────────────────────────────

  async complete(user: AuthenticatedUser, orderId: string) {
    const order = await this.scoped(user, orderId);
    if ((order.metadata as any)?.picking?.completedAt) {
      throw new BadRequestException("Picking is already finished for this order");
    }
    if (!["ACCEPTED", "PREPARING"].includes(order.status)) {
      throw new BadRequestException("This order isn't being picked");
    }

    const lines = order.items.map((i: any) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      totalMinor: toMinor(i.totalPrice),
      pick: ((i.metadata as any)?.pick as PickState | undefined) ?? null,
    }));
    const shortfall = priceShortfall({
      lines,
      subtotalMinor: toMinor(order.subtotal),
      discountMinor: toMinor(order.discount),
    });
    const handedOver = shortfall.lines.some((l, i) => l.missing < lines[i]!.quantity);
    if (!handedOver) {
      throw new BadRequestException("Nothing was picked — cancel the order instead, which refunds it in full");
    }
    const refundMinor = Math.min(shortfall.refundMinor, toMinor(order.total));

    // 1. Money.
    const card = this.cardPayment(order.payments);
    let stripeRefundId: string | null = null;
    let settledBy: "CARD" | "CASH_COLLECT" | "OWED" | "NONE" = "NONE";
    if (refundMinor > 0) {
      if (card?.provider === "STRIPE" && card.stripePaymentIntentId) {
        // A hosted-checkout card is held, then captured on accept. If the
        // capture hasn't landed yet, take it now — a refund needs a charge.
        if (card.status !== "SUCCEEDED") {
          await this.payments.captureForOrder(order.id);
        }
        stripeRefundId = await this.payments.refundStripeAmount(card, refundMinor, {
          kind: "picking_shortfall",
        });
        settledBy = "CARD";
      } else if (card) {
        // Tap / Dojo: no partial refund path from here yet. Recorded as owed
        // so it's visible on the order, and staff refund it by hand.
        settledBy = "OWED";
      } else {
        // Cash (or pay on collection): nothing to give back — collect less.
        settledBy = "CASH_COLLECT";
      }
    }

    // 2. Book it.
    const variants = await this.variantsFor(order);
    const subItemIds = order.items
      .map((i: any) => (i.metadata as any)?.pick?.sub?.variantId)
      .filter((v: unknown): v is string => typeof v === "string");
    const subVariants = subItemIds.length
      ? await this.prisma.productVariant.findMany({
          where: { id: { in: subItemIds }, tenantId: order.tenantId },
          select: { id: true, trackStock: true },
        })
      : [];
    try {
      await this.prisma.$transaction(async (tx) => {
        const moves: StockMove[] = [];
        const zeroed = new Set<string>();
        for (const [idx, l] of shortfall.lines.entries()) {
          const item = order.items[idx];
          const v = resolveVariantForLine(item, variants.byItem, variants.byId);
          // Couldn't find all of them on the shelf: the shelf is empty. The
          // sale already took the ordered quantity off the books, so book the
          // count at zero and the storefront stops selling it.
          if ((l.missing > 0 || l.substituted > 0) && v?.trackStock && !zeroed.has(v.id)) {
            zeroed.add(v.id);
            const level = await tx.productStockLevel.findUnique({
              where: { variantId_locationId: { variantId: v.id, locationId: order.locationId } },
              select: { quantity: true },
            });
            const now = level?.quantity ?? 0;
            if (now !== 0) {
              moves.push({
                tenantId: order.tenantId,
                locationId: order.locationId,
                variantId: v.id,
                type: "COUNT_CORRECTION",
                quantity: -now,
                reason: "None left on the shelf at picking",
                orderId: order.id,
                recordedBy: user.userId,
              });
            }
          }
          const sub = item.metadata?.pick?.sub;
          const sv = sub?.variantId ? subVariants.find((x) => x.id === sub.variantId) : null;
          if (sv?.trackStock && l.substituted > 0) {
            moves.push({
              tenantId: order.tenantId,
              locationId: order.locationId,
              variantId: sv.id,
              type: "SALE_DEDUCTION",
              quantity: -l.substituted,
              reason: `Substitute for ${item.name}`,
              orderId: order.id,
              recordedBy: user.userId,
              dedupeKey: `sub:${item.id}`,
            });
          }
          await tx.orderItem.update({
            where: { id: item.id },
            data: {
              metadata: { ...(item.metadata ?? {}), pickCompletedAt: new Date().toISOString() } as Prisma.InputJsonValue,
            },
          });
        }

        const picking = {
          completedAt: new Date().toISOString(),
          completedBy: user.userId,
          refund: refundMinor / 100,
          settledBy,
          missing: shortfall.lines.reduce((s, l) => s + l.missing, 0),
          substituted: shortfall.lines.reduce((s, l) => s + l.substituted, 0),
        };
        const orderUpdate: Prisma.OrderUpdateInput = {
          metadata: { ...((order.metadata as any) ?? {}), picking } as Prisma.InputJsonValue,
        };

        if (settledBy === "CARD") {
          const refund = await tx.refund.create({
            data: {
              tenantId: order.tenantId,
              paymentId: card.id,
              orderId: order.id,
              method: "CARD",
              stripeRefundId,
              amount: toMajor(refundMinor),
              reason: "Items unavailable at picking",
              status: "SUCCEEDED",
              isPartial: refundMinor < toMinor(order.total),
              processedBy: user.userId,
              note: "Picking shortfall",
            },
          });
          for (const l of shortfall.lines) {
            if (l.refundMinor <= 0) continue;
            await tx.refundLine.create({
              data: {
                id: randomUUID(),
                refundId: refund.id,
                orderItemId: l.id,
                quantity: l.missing + l.substituted,
                amount: toMajor(l.refundMinor),
                restock: false, // never left the shelf
              },
            });
          }
          await tx.ledgerEntry.create({
            data: {
              tenantId: order.tenantId,
              paymentId: card.id,
              refundId: refund.id,
              type: "REFUND",
              amount: toMajor(refundMinor),
              currency: String(card.currency ?? order.location?.currency ?? "GBP").toLowerCase(),
              description: `Unavailable items on order #${order.orderNumber ?? order.displayId ?? order.id}`,
              reference: stripeRefundId ?? refund.id,
              metadata: { kind: "picking_shortfall" },
            },
          });
          orderUpdate.paymentStatus = refundMinor >= toMinor(order.total) ? "REFUNDED" : "PARTIALLY_REFUNDED";
        } else if (settledBy === "CASH_COLLECT") {
          // The driver / counter collects the corrected amount.
          orderUpdate.subtotal = toMajor(Math.max(0, toMinor(order.subtotal) - refundMinor));
          orderUpdate.total = toMajor(Math.max(0, toMinor(order.total) - refundMinor));
        }
        await tx.order.update({ where: { id: order.id }, data: orderUpdate });
        await this.stock.applyMoves(moves, tx);
      });
    } catch (err) {
      if (stripeRefundId) {
        this.logger.error(
          `PICKING REFUND NOT BOOKED: Stripe refund ${stripeRefundId} (${toMajor(refundMinor)}) went through for order ${order.id} but writing it failed: ${(err as Error).message}. Book it by hand.`,
        );
      }
      throw err;
    }

    // 3. Ready for the courier / collection.
    if (order.status === "ACCEPTED") {
      await this.orders.updateStatus(order.id, order.tenantId, { status: "PREPARING" } as any, user.userId);
    }
    await this.orders.updateStatus(order.id, order.tenantId, { status: "READY" } as any, user.userId);

    this.events.emit("activity.log", {
      tenantId: order.tenantId,
      locationId: order.locationId,
      brandId: order.brandId ?? null,
      category: "ORDERS",
      channel: order.platform ?? "DIRECT",
      action: "order.picked",
      status: refundMinor > 0 ? "WARNING" : "INFO",
      message:
        `Order #${order.orderNumber ?? order.displayId ?? order.id} picked` +
        (refundMinor > 0
          ? ` — ${toMajor(refundMinor)} ${settledBy === "CARD" ? "refunded to card" : settledBy === "OWED" ? "OWED to the customer (refund by hand)" : "less to collect"}`
          : ""),
      details: { orderId: order.id, refund: refundMinor / 100, settledBy },
    });

    return {
      refund: refundMinor / 100,
      settledBy,
      missing: shortfall.lines.reduce((s, l) => s + l.missing, 0),
      substituted: shortfall.lines.reduce((s, l) => s + l.substituted, 0),
    };
  }

  private cardPayment(payments: any[]) {
    return (
      (payments ?? [])
        .filter((p) => ["SUCCEEDED", "PROCESSING"].includes(p.status))
        .filter((p) => p.method !== "CASH")
        .sort((a, b) => Number(b.amount) - Number(a.amount))[0] ?? null
    );
  }

  private async variantsFor(order: any) {
    const itemIds = [...new Set(order.items.map((i: any) => i.menuItemId).filter(Boolean))] as string[];
    const explicit = order.items
      .map((i: any) => i.metadata?.variantId)
      .filter((v: unknown): v is string => typeof v === "string");
    const rows: VariantRef[] =
      itemIds.length || explicit.length
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
