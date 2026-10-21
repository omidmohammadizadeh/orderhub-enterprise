import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { linesTotal, loyaltyRewardDiscount, loyaltyRewardKind, round2 } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { applyCredit, checkoutTotal, linesForCheckout, storedLines, type CheckoutLine } from "./salon-lines";
import { SalonDepositService } from "./salon-deposit.service";
import { SalonBookingService } from "./salon-booking.service";
import { readSalonSettings } from "./salon-settings";

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

    // A loyalty reward comes off first, on the line it's FOR — the receipt
    // should say the skin fade was free, not the haircut next to it.
    let rewardValue = 0;
    if (input.loyaltyRewardId) {
      const reward = await this.prisma.loyaltyReward.findFirst({
        where: {
          id: input.loyaltyRewardId,
          tenantId,
          locationId: appt.locationId,
          ...(input.loyaltyMemberId ? { memberId: input.loyaltyMemberId } : {}),
          claimedAt: null,
        },
        select: { label: true, amountOff: true, percentOff: true, maxDiscount: true, minOrder: true },
      });
      if (!reward) throw new BadRequestException("That reward has already been used or isn't on this card");
      if (loyaltyRewardKind(reward) !== "FREE_ITEM") {
        // Money off (£ or %): spread across the lines like the deposit.
        const { amount, short } = loyaltyRewardDiscount(reward, checkoutTotal(lines));
        if (short > 0) {
          throw new BadRequestException(`That reward needs ${short.toFixed(2)} more on the bill before it can be used.`);
        }
        rewardValue = amount;
        if (rewardValue > 0) lines = applyCredit(lines, rewardValue, `Reward: ${reward.label}`).lines;
      } else {
        const loc = await this.prisma.location.findUnique({ where: { id: appt.locationId }, select: { settings: true } });
        const chosen = readSalonSettings(loc?.settings).loyaltyRewardServiceId;
        const chosenName = services.find((l) => l.serviceId === chosen)?.name;
        const label = reward.label.toLowerCase();
        let at = chosenName ? lines.findIndex((l) => l.name === chosenName) : -1;
        if (at < 0) at = lines.findIndex((l) => !l.name.startsWith("+ ") && label.includes(l.name.toLowerCase()));
        if (at < 0) at = lines.findIndex((l) => !l.name.startsWith("+ "));
        const line = lines[at];
        if (line) {
          rewardValue = round2(line.unitPrice);
          lines[at] = { ...line, unitPrice: 0, quantity: 1, notes: [line.notes, `Loyalty reward — ${reward.label}`].filter(Boolean).join(" · ") };
        }
      }
    }

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
        totalPrice: Math.max(0, Math.round((linesTotal(services) - discount - rewardValue) * 100) / 100),
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
    try {
      return { appointmentId: appt.id, ...(await this.checkout(tenantId, appt.id, body, actorUserId)) };
    } catch (e) {
      // The visit only existed to be paid for: don't leave it in the diary.
      await this.prisma.salonAppointment.delete({ where: { id: appt.id } }).catch(() => undefined);
      this.booking.emit(appt.locationId, "updated", appt.id);
      throw e;
    }
  }
}
