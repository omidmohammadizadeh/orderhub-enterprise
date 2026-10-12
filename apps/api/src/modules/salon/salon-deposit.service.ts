import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OnEvent } from "@nestjs/event-emitter";
import { Cron, CronExpression } from "@nestjs/schedule";
import { round2 } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { OrdersService } from "../orders/orders.service";
import { PaymentsService } from "../payments/payments.service";
import { storedLines, summariseLines } from "./salon-lines";
import { SalonNotifyService } from "./salon-notify.service";

// Online deposits.
//
// A deposit is an ordinary Order — one line, "Deposit — Skin fade" — paid
// through the same Stripe payment link the till sends. That buys everything
// the money side already does: the shop's own Connect account, the platform
// fee, the Payment row, payouts, the refund ledger and the takings reports.
//
// The appointment holds its slot as PENDING_PAYMENT while the guest is on
// Stripe's page. It confirms when the order is paid (webhook → events below,
// or the guest landing back on their booking page), and lets the slot go if
// nobody pays within HOLD_MINUTES.

const HOLD_MINUTES = 20;

@Injectable()
export class SalonDepositService {
  private readonly logger = new Logger(SalonDepositService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly notify: SalonNotifyService,
    private readonly config: ConfigService,
  ) {}

  private webUrl(): string {
    return (this.config.get<string>("WEB_URL") ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
  }

  /** Create the deposit order and a Stripe page for it. */
  async start(appointmentId: string): Promise<{ url: string }> {
    const appt = await this.prisma.salonAppointment.findUnique({ where: { id: appointmentId } });
    if (!appt) throw new NotFoundException("Booking not found");
    const amount = round2(Number(appt.depositAmount));
    if (amount <= 0) throw new BadRequestException("No deposit due");
    const summary = summariseLines(storedLines(appt.services));
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
        items: [
          {
            name: `Deposit — ${summary}`.slice(0, 180),
            quantity: 1,
            unitPrice: amount,
            totalPrice: amount,
            notes: `Booking ${appt.reference}`,
          },
        ],
        subtotal: amount,
        total: amount,
        specialInstructions: `Salon deposit for booking ${appt.reference}`,
        paymentMethod: "PAYMENT_LINK",
        paymentProvider: "STRIPE",
        paymentStatus: "PENDING",
        // Off the staff board until it's paid — the diary is where it lives.
        guestPrepay: true,
        idempotencyKey: `salon-deposit:${appt.id}`,
      } as any,
      appt.tenantId,
    );
    await this.prisma.salonAppointment.update({
      where: { id: appt.id },
      data: { depositOrderId: order.id },
    });
    const back = `${this.webUrl()}/salon/booking/${appt.manageToken}`;
    const { url } = await this.payments.createCheckoutSession({
      tenantId: appt.tenantId,
      orderId: order.id,
      successUrl: `${back}?paid=1`,
      cancelUrl: `${back}?cancelled=1`,
      customerEmail: appt.customerEmail ?? undefined,
      captureMethod: "automatic",
    });
    return { url };
  }

  /** Guest came back from Stripe without paying: a fresh page for the same deposit. */
  async resume(manageToken: string): Promise<{ url: string }> {
    const appt = await this.prisma.salonAppointment.findUnique({ where: { manageToken } });
    if (!appt || appt.status !== "PENDING_PAYMENT") throw new BadRequestException("Nothing to pay on this booking");
    if (!appt.depositOrderId) return this.start(appt.id);
    const back = `${this.webUrl()}/salon/booking/${appt.manageToken}`;
    return this.payments.createCheckoutSession({
      tenantId: appt.tenantId,
      orderId: appt.depositOrderId,
      successUrl: `${back}?paid=1`,
      cancelUrl: `${back}?cancelled=1`,
      customerEmail: appt.customerEmail ?? undefined,
      captureMethod: "automatic",
    });
  }

  /**
   * Bring an appointment in line with its orders: a paid deposit confirms
   * it; a paid checkout completes it. Idempotent — every path calls it.
   */
  async sync(appointmentId: string): Promise<void> {
    const appt = await this.prisma.salonAppointment.findUnique({ where: { id: appointmentId } });
    if (!appt) return;
    if (appt.depositOrderId && appt.depositStatus === "PENDING") {
      const dep = await this.prisma.order.findUnique({
        where: { id: appt.depositOrderId },
        select: { paymentStatus: true },
      });
      if (dep?.paymentStatus === "PAID") {
        const { count } = await this.prisma.salonAppointment.updateMany({
          where: { id: appt.id, depositStatus: "PENDING" },
          data: {
            depositStatus: "PAID",
            depositPaidAt: new Date(),
            ...(appt.status === "PENDING_PAYMENT" ? { status: "CONFIRMED" } : {}),
          },
        });
        if (count > 0) {
          this.logger.log(`Deposit paid for salon booking ${appt.reference}`);
          if (appt.status === "PENDING_PAYMENT") this.notify.appointment("confirmed", appt.id);
          this.emit(appt.locationId, appt.id);
        }
      }
    }
    if (appt.orderId && appt.status !== "COMPLETED" && appt.status !== "CANCELLED") {
      const sale = await this.prisma.order.findUnique({
        where: { id: appt.orderId },
        select: { paymentStatus: true, tipAmount: true, status: true },
      });
      if (sale?.paymentStatus === "PAID") {
        const { count } = await this.prisma.salonAppointment.updateMany({
          where: { id: appt.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            tipAmount: Number(sale.tipAmount ?? 0),
            ...(appt.depositStatus === "PAID" ? { depositStatus: "APPLIED" } : {}),
          },
        });
        if (count > 0) {
          if (appt.queueEntryId) {
            await this.prisma.salonQueueEntry.updateMany({
              where: { id: appt.queueEntryId, status: { notIn: ["DONE", "LEFT"] } },
              data: { status: "DONE", finishedAt: new Date() },
            });
          }
          this.emit(appt.locationId, appt.id);
        }
      }
    }
  }

  @OnEvent("order.status_changed")
  async onOrderStatus(payload: { orderId?: string }) {
    await this.syncForOrder(payload?.orderId);
  }

  @OnEvent("payment.authorized")
  async onPaymentAuthorized(payload: { orderId?: string }) {
    await this.syncForOrder(payload?.orderId);
  }

  @OnEvent("order.settled_in_full")
  async onSettled(payload: { orderId?: string }) {
    await this.syncForOrder(payload?.orderId);
  }

  async syncForOrder(orderId?: string) {
    if (!orderId) return;
    try {
      const appts = await this.prisma.salonAppointment.findMany({
        where: { OR: [{ depositOrderId: orderId }, { orderId }] },
        select: { id: true },
      });
      for (const a of appts) await this.sync(a.id);
    } catch (e: any) {
      this.logger.warn(`Salon sync for order ${orderId} failed: ${e?.message}`);
    }
  }

  /**
   * Give the deposit back: Stripe refund on the shop's account, a Refund row
   * and ledger entry, the deposit order marked REFUNDED.
   */
  async refund(appointmentId: string, reason: string): Promise<boolean> {
    const appt = await this.prisma.salonAppointment.findUnique({ where: { id: appointmentId } });
    if (!appt?.depositOrderId || appt.depositStatus !== "PAID") return false;
    const order = await this.prisma.order.findUnique({
      where: { id: appt.depositOrderId },
      include: { payments: true, location: { select: { currency: true } } },
    });
    const card = order?.payments.find(
      (p: any) => p.provider === "STRIPE" && p.status === "SUCCEEDED" && p.stripePaymentIntentId,
    );
    if (!order || !card) {
      this.logger.warn(`Deposit refund for ${appt.reference}: no Stripe payment found`);
      await this.prisma.salonAppointment.update({
        where: { id: appt.id },
        data: { staffNotes: [appt.staffNotes, "Deposit refund couldn't be sent automatically — refund it from Payments."].filter(Boolean).join("\n") },
      });
      return false;
    }
    const amountMinor = Math.round(Number(appt.depositAmount) * 100);
    try {
      const stripeRefundId = await this.payments.refundStripeAmount(card as any, amountMinor, {
        kind: "salon_deposit",
        reference: appt.reference,
      });
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.refund.create({
          data: {
            tenantId: order.tenantId,
            paymentId: card.id,
            orderId: order.id,
            method: "CARD",
            stripeRefundId,
            amount: round2(amountMinor / 100),
            reason,
            status: "SUCCEEDED",
            isPartial: false,
            note: `Salon deposit ${appt.reference}`,
          } as any,
        });
        await tx.ledgerEntry.create({
          data: {
            tenantId: order.tenantId,
            paymentId: card.id,
            refundId: created.id,
            type: "REFUND",
            amount: round2(amountMinor / 100),
            currency: String((card as any).currency ?? order.location?.currency ?? "GBP").toLowerCase(),
            description: `Salon deposit refunded (${appt.reference}): ${reason}`,
            reference: stripeRefundId,
            metadata: { kind: "salon_deposit" },
          } as any,
        });
        await tx.payment.update({ where: { id: card.id }, data: { status: "REFUNDED" } as any });
        await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "REFUNDED" } as any });
        await tx.salonAppointment.update({ where: { id: appt.id }, data: { depositStatus: "REFUNDED" } });
      });
      return true;
    } catch (e: any) {
      this.logger.warn(`Deposit refund for ${appt.reference} failed: ${e?.message}`);
      await this.prisma.salonAppointment.update({
        where: { id: appt.id },
        data: {
          staffNotes: [appt.staffNotes, `Deposit refund failed (${e?.message ?? "Stripe error"}) — refund it from Payments.`]
            .filter(Boolean)
            .join("\n"),
        },
      });
      return false;
    }
  }

  /**
   * Every minute: confirm deposits that were paid but missed by the events,
   * and let go of slots held for a guest who never paid.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweep() {
    try {
      const pending = await this.prisma.salonAppointment.findMany({
        where: { status: "PENDING_PAYMENT" },
        select: { id: true, createdAt: true, locationId: true, depositOrderId: true },
        take: 200,
      });
      const cutoff = Date.now() - HOLD_MINUTES * 60_000;
      for (const a of pending) {
        await this.sync(a.id);
        if (a.createdAt.getTime() > cutoff) continue;
        const { count } = await this.prisma.salonAppointment.updateMany({
          where: { id: a.id, status: "PENDING_PAYMENT" },
          data: {
            status: "CANCELLED",
            depositStatus: "EXPIRED",
            cancelledAt: new Date(),
            cancelReason: "Deposit not paid in time",
          },
        });
        if (count > 0) {
          if (a.depositOrderId) {
            await this.prisma.order.updateMany({
              where: { id: a.depositOrderId, paymentStatus: { not: "PAID" }, status: "PENDING" },
              data: { status: "CANCELLED" },
            });
          }
          this.emit(a.locationId, a.id);
        }
      }
    } catch (e: any) {
      this.logger.warn(`Salon deposit sweep failed: ${e?.message}`);
    }
  }

  private emit(locationId: string, appointmentId: string) {
    this.socket.emitToLocation(locationId, "salon:changed" as any, { kind: "updated", appointmentId } as any);
  }
}
