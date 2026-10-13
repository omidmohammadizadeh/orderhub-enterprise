import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { linesTotal, round2 } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { applyCredit, checkoutTotal, linesForCheckout, storedLines, type CheckoutLine } from "./salon-lines";
import { SalonDepositService } from "./salon-deposit.service";
import { SalonBookingService } from "./salon-booking.service";

// Checkout: an appointment becomes a sale.
//
// The bill is an ordinary POS walk-in Order, so the till's own payment
// screens take it from here — cash, the card machine (Stripe or Dojo), a
// payment link — and receipts, loyalty stamps, refunds and takings all work
// unchanged. At a SALON location a paid walk-in completes the moment it is
// paid (OrdersService.maybeCompleteRetailSale), and the order.status_changed
// event that fires then marks the appointment COMPLETED (SalonDepositService).

const METHODS = ["CASH", "CARD_TERMINAL", "PAYMENT_LINK", "EXTERNAL"] as const;
type Method = (typeof METHODS)[number];

export interface CheckoutInput {
  paymentMethod: Method;
  tipAmount?: number;
  /** A money-off for this visit (manager's discretion). */
  discount?: number;
  /** Final prices for "from" services: index into the appointment's services. */
  prices?: Array<{ index: number; price: number }>;
  /** Products sold with the visit (wax, shampoo). */
  extras?: Array<{ name: string; price: number; quantity?: number }>;
  loyaltyMemberId?: string;
  loyaltyRewardId?: string;
}

@Injectable()
export class SalonCheckoutService {
  private readonly logger = new Logger(SalonCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly deposits: SalonDepositService,
    private readonly booking: SalonBookingService,
  ) {}

  /** What the checkout panel shows before anyone presses Pay. */
  async preview(tenantId: string, appointmentId: string) {
    const appt = await this.prisma.salonAppointment.findFirst({
      where: { id: appointmentId, tenantId },
      include: { staff: { select: { name: true } } },
    });
    if (!appt) throw new NotFoundException("Appointment not found");
    const lines = linesForCheckout(storedLines(appt.services), appt.staff?.name ?? null);
    const deposit = appt.depositStatus === "PAID" ? Number(appt.depositAmount) : 0;
    const existing = appt.orderId
      ? await this.prisma.order.findUnique({
          where: { id: appt.orderId },
          select: { id: true, total: true, paymentStatus: true, paymentMethod: true, status: true, orderNumber: true },
        })
      : null;
    return {
      lines,
      subtotal: checkoutTotal(lines),
      deposit,
      dueBeforeTip: round2(Math.max(0, checkoutTotal(lines) - deposit)),
      existingOrder:
        existing && existing.status !== "CANCELLED"
          ? { ...existing, total: Number(existing.total) }
          : null,
    };
  }

  async checkout(tenantId: string, appointmentId: string, input: CheckoutInput, actorUserId?: string) {
    const appt = await this.prisma.salonAppointment.findFirst({
      where: { id: appointmentId, tenantId },
      include: { staff: { select: { id: true, name: true } } },
    });
    if (!appt) throw new NotFoundException("Appointment not found");
    if (!["CONFIRMED", "CHECKED_IN", "IN_SERVICE"].includes(appt.status)) {
      throw new BadRequestException("Only an open appointment can be checked out");
    }
    const method = String(input.paymentMethod ?? "").toUpperCase() as Method;
    if (!METHODS.includes(method)) throw new BadRequestException("Pick how they're paying");

    // A bill already started and not paid: replace it rather than leave two.
    if (appt.orderId) {
      const prev = await this.prisma.order.findUnique({
        where: { id: appt.orderId },
        select: { id: true, paymentStatus: true, status: true },
      });
      if (prev?.paymentStatus === "PAID") {
        await this.deposits.sync(appt.id);
        throw new BadRequestException("This appointment is already paid");
      }
      if (prev && prev.status !== "CANCELLED") {
        await this.prisma.order.update({ where: { id: prev.id }, data: { status: "CANCELLED" } });
        await this.prisma.orderStatusHistory.create({
          data: {
            orderId: prev.id,
            tenantId,
            fromStatus: prev.status,
            toStatus: "CANCELLED",
            actorType: "STAFF",
            changedBy: actorUserId ?? "salon",
            note: "Salon bill restarted at checkout",
          } as any,
        });
      }
    }

    // Settle "from" prices first — that's what the visit actually cost.
    const services = storedLines(appt.services);
    for (const p of input.prices ?? []) {
      const line = services[Number(p.index)];
      const price = Number(p.price);
      if (!line || !Number.isFinite(price) || price < 0) continue;
      line.price = round2(price);
    }
    let lines: CheckoutLine[] = linesForCheckout(services, appt.staff?.name ?? null);
    for (const x of input.extras ?? []) {
      const name = String(x?.name ?? "").trim().slice(0, 120);
      const price = round2(Number(x?.price));
      const qty = Math.max(1, Math.min(50, Math.round(Number(x?.quantity ?? 1))));
      if (!name || !Number.isFinite(price) || price < 0) continue;
      lines.push({ name, unitPrice: price, quantity: qty });
    }
    if (lines.length === 0) throw new BadRequestException("Nothing to charge for");

    const deposit = appt.depositStatus === "PAID" ? Number(appt.depositAmount) : 0;
    if (deposit > 0) lines = applyCredit(lines, deposit, `${deposit.toFixed(2)} deposit paid online`).lines;
    const discount = round2(Math.max(0, Number(input.discount) || 0));
    if (discount > 0) lines = applyCredit(lines, discount, "Discount").lines;

    const tip = round2(Math.max(0, Number(input.tipAmount) || 0));
    const subtotal = checkoutTotal(lines);
    const total = round2(subtotal + tip);
    // Nothing left to pay (the deposit covered it): settle it as paid now.
    const paidNow = method === "EXTERNAL" || total === 0;

    const order = await this.orders.create(
      {
        locationId: appt.locationId,
        orderSource: "POS",
        fulfillmentType: "PICKUP",
        isWalkIn: true,
        customerInfo: {
          name: appt.customerName,
          ...(appt.customerPhone ? { phone: appt.customerPhone } : {}),
          ...(appt.customerEmail ? { email: appt.customerEmail } : {}),
        },
        items: lines.map((l) => ({
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          totalPrice: round2(l.unitPrice * l.quantity),
          ...(l.notes ? { notes: l.notes } : {}),
        })),
        subtotal,
        tipAmount: tip,
        total,
        specialInstructions: `Appointment ${appt.reference}${appt.staff?.name ? ` with ${appt.staff.name}` : ""}`,
        paymentMethod: paidNow ? "EXTERNAL" : method,
        paymentStatus: paidNow ? "PAID" : "PENDING",
        // Two quick taps on Pay make ONE bill; a deliberate re-checkout (the
        // previous bill was replaced above) gets a new key.
        idempotencyKey: `salon-checkout:${appt.id}:${appt.orderId ?? "first"}`,
        ...(input.loyaltyMemberId ? { loyaltyMemberId: input.loyaltyMemberId } : {}),
        ...(input.loyaltyMemberId && input.loyaltyRewardId ? { loyaltyRewardId: input.loyaltyRewardId } : {}),
      } as any,
      tenantId,
      actorUserId,
    );

    await this.prisma.salonAppointment.update({
      where: { id: appt.id },
      data: {
        orderId: order.id,
        services: services as any,
        // Takings for reports and commission: the services as charged, after
        // any discount (deposits are payment, not discount, so they stay in).
        totalPrice: Math.max(0, Math.round((linesTotal(services) - discount) * 100) / 100),
        ...(appt.status !== "IN_SERVICE" ? { status: "IN_SERVICE", startedAt: appt.startedAt ?? new Date() } : {}),
      },
    });
    await this.deposits.sync(appt.id);
    this.booking.emit(appt.locationId, "updated", appt.id);
    return {
      orderId: order.id,
      orderNumber: (order as any).orderNumber ?? null,
      amount: Number((order as any).total ?? total),
      paymentMethod: paidNow ? "EXTERNAL" : method,
      paid: paidNow,
    };
  }

  /**
   * A walk-in sale at the chair with no booking: make the appointment on the
   * spot (now, with this barber, squeezed in) and check it out. Commission
   * and the barber's takings then count it like any other visit.
   */
  async quickSale(
    tenantId: string,
    body: {
      locationId: string;
      staffId: string;
      services: Array<{ serviceId: string; addonIds?: string[] }>;
      customerName?: string;
      customerPhone?: string;
    } & CheckoutInput,
    actorUserId?: string,
  ) {
    const appt = await this.booking.book(
      {
        locationId: body.locationId,
        staffId: body.staffId,
        startsAt: new Date().toISOString(),
        services: body.services,
        customerName: (body.customerName ?? "").trim() || "Walk-in",
        customerPhone: body.customerPhone ?? null,
        source: "WALK_IN",
        force: true,
        silent: true,
      },
      { tenantId, online: false, actorUserId },
    );
    return { appointmentId: appt.id, ...(await this.checkout(tenantId, appt.id, body, actorUserId)) };
  }
}
