import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { computeServiceCharge } from "./service-charge";

// Void / comp a line off a bill.
//
// Two different acts that look the same on screen and must NOT be conflated
// in the books:
//   VOID — rung in by mistake. It should never have been on the bill.
//   COMP — deliberately given away (a complaint, a regular, a birthday).
//          Real food left the kitchen and someone decided not to charge.
//
// Both zero the line. Only the reason tells you whether you have a training
// problem or a generosity problem, which is exactly why the reason is
// mandatory and why the two are reported separately.
//
// Gated on a manager PIN because the person who wants to remove a charge is
// often the person who took the money. The PIN is bcrypt-hashed into
// Location.settings.managerPinHash — never stored or logged in the clear.

const VOID_TYPES = new Set(["VOID", "COMP"]);

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

@Injectable()
export class VoidItemsService {
  private readonly logger = new Logger(VoidItemsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly socket: SocketService,
  ) {}

  /** Set (or replace) a location's manager PIN. Stored hashed. */
  async setManagerPin(tenantId: string, locationId: string, pin: string) {
    const clean = String(pin ?? "").trim();
    if (!/^\d{4,8}$/.test(clean)) {
      throw new BadRequestException("PIN must be 4 to 8 digits");
    }
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, settings: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
    const settings = (loc.settings ?? {}) as Record<string, any>;
    await this.prisma.location.update({
      where: { id: locationId },
      data: {
        settings: {
          ...settings,
          managerPinHash: await bcrypt.hash(clean, 10),
        } as any,
      },
    });
    return { ok: true };
  }

  async hasManagerPin(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { settings: true },
    });
    return { configured: !!(loc?.settings as any)?.managerPinHash };
  }

  private async assertPin(locationId: string, pin: string) {
    const loc = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { settings: true },
    });
    const hash = (loc?.settings as any)?.managerPinHash as string | undefined;
    if (!hash) {
      throw new BadRequestException(
        "No manager PIN is set for this location — set one in settings first.",
      );
    }
    const ok = await bcrypt.compare(String(pin ?? ""), hash);
    // Deliberately vague: a precise "wrong PIN" vs "no PIN" distinction
    // would help someone guessing.
    if (!ok) throw new ForbiddenException("Incorrect manager PIN");
  }

  /**
   * Zero one line and recompute the bill.
   *
   * The row is KEPT, not deleted. A deleted line is indistinguishable from
   * one that was never rung in, which is precisely the audit trail you need
   * when money goes missing. The original price is preserved in metadata so
   * reporting can total what was written off.
   */
  async voidItem(args: {
    tenantId: string;
    orderId: string;
    itemId: string;
    pin: string;
    reason: string;
    type: string;
    userId: string;
  }) {
    const type = String(args.type ?? "VOID").toUpperCase();
    if (!VOID_TYPES.has(type)) {
      throw new BadRequestException("Type must be VOID or COMP");
    }
    const reason = String(args.reason ?? "").trim();
    if (reason.length < 3) {
      throw new BadRequestException("Give a reason (at least 3 characters)");
    }

    const order = await this.prisma.order.findFirst({
      where: { id: args.orderId, tenantId: args.tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!order.locationId) {
      throw new BadRequestException("Order has no location");
    }
    if (order.paymentStatus === "PAID") {
      // Past this point it's a refund, not a void — a different act with
      // different money movement, and it must not masquerade as this one.
      throw new BadRequestException(
        "This bill is already paid — refund it instead of voiding a line.",
      );
    }

    const item = order.items.find((i) => i.id === args.itemId);
    if (!item) throw new NotFoundException("Item not found on this order");
    const meta = (item.metadata ?? {}) as Record<string, any>;
    if (meta.void) {
      throw new BadRequestException("That line has already been voided");
    }

    await this.assertPin(order.locationId, args.pin);

    const wasWorth = Number(item.totalPrice);

    // Recompute the bill from the surviving lines rather than subtracting,
    // so rounding can't drift over several voids on one tab.
    const newSubtotal = round2(
      order.items
        .filter((i) => i.id !== item.id)
        .reduce((s, i) => s + Number(i.totalPrice), 0),
    );
    const loc = await this.prisma.location.findUnique({
      where: { id: order.locationId },
      select: { settings: true },
    });
    const newServiceCharge = computeServiceCharge({
      settings: loc?.settings ?? null,
      fulfillmentType: order.fulfillmentType,
      subtotal: newSubtotal,
      discount: Number(order.discount ?? 0),
    }).amount;

    await this.prisma.$transaction([
      this.prisma.orderItem.update({
        where: { id: item.id },
        data: {
          unitPrice: 0,
          totalPrice: 0,
          metadata: {
            ...meta,
            void: {
              type,
              reason,
              by: args.userId,
              at: new Date().toISOString(),
              // What it was worth before we wrote it off.
              originalTotal: wasWorth,
              originalUnitPrice: Number(item.unitPrice),
            },
          } as any,
        },
      }),
      this.prisma.order.update({
        where: { id: order.id },
        data: {
          subtotal: newSubtotal,
          serviceCharge: newServiceCharge,
          total: round2(
            newSubtotal -
              Number(order.discount ?? 0) +
              Number(order.deliveryFee ?? 0) +
              Number(order.taxAmount ?? 0) +
              newServiceCharge,
          ),
        },
      }),
      this.prisma.orderStatusHistory.create({
        data: {
          orderId: order.id,
          tenantId: args.tenantId,
          fromStatus: order.status,
          toStatus: order.status,
          actorType: "STAFF",
          changedBy: args.userId,
          note: `${type} — ${item.quantity}× ${item.name} (£${wasWorth.toFixed(
            2,
          )}): ${reason}`,
        },
      }),
    ]);

    // The kitchen may already be cooking it. Resync so the station drops
    // the line, and refresh the staff board's totals.
    this.events.emit("order.items_edited", {
      orderId: order.id,
      locationId: order.locationId,
    });
    this.socket.emitOrderUpdated(order.locationId, {
      orderId: order.id,
      tenantId: order.tenantId,
      locationId: order.locationId,
      platform: order.platform,
      orderSource: order.orderSource,
      fulfillmentType: order.fulfillmentType,
      displayId: order.displayId,
      status: order.status,
      total: Number(order.total),
      itemCount: order.items.reduce((s, i) => s + (i.quantity ?? 0), 0),
      customerName: (order as any).customerName ?? "",
      scheduledFor: order.scheduledFor?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
    } as any);

    this.logger.log(
      `${type} on ${order.id}: ${item.name} £${wasWorth.toFixed(2)} by ${args.userId} — ${reason}`,
    );

    return this.prisma.order.findUnique({
      where: { id: order.id },
      include: { items: true },
    });
  }
}
