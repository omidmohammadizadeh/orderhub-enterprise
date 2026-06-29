import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PaymentsService } from "../payments/payments.service";

// Phase AY — WhatsApp has no storefront-style status-polling loop, so a paid
// card order would otherwise rely solely on the Stripe webhook. For direct
// charges the PaymentIntent lives on the CONNECTED account, so the authorise
// event fires on the "Connected accounts" webhook scope and frequently never
// reaches us — leaving the order stuck at PENDING (invisible, never captured,
// customer never notified).
//
// This cron does what the storefront's poll does: reconcile pending WhatsApp
// card orders against Stripe directly (PaymentsService.reconcileOrderPayment),
// which flips them to AUTHORIZED → auto-accept (if on) → captured → "Card
// paid" → customer notified, webhook or not. Best-effort and idempotent.
@Injectable()
export class WhatsAppReconcileCron {
  private readonly logger = new Logger(WhatsAppReconcileCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  @Cron("*/20 * * * * *") // every 20 seconds
  async reconcilePending(): Promise<void> {
    if (this.running) return; // skip if a previous sweep is still in flight
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - 45 * 60 * 1000); // last 45 min
      const orders = await this.prisma.order.findMany({
        where: {
          orderSource: "WHATSAPP" as any,
          paymentMethod: "CARD" as any,
          paymentStatus: "PENDING" as any,
          createdAt: { gte: cutoff },
        },
        select: { id: true },
        take: 50,
      });
      if (orders.length === 0) return;
      this.logger.log(`Reconciling ${orders.length} pending WhatsApp card order(s) against Stripe`);
      for (const o of orders) {
        await this.payments
          .reconcileOrderPayment(o.id)
          .catch((err: any) =>
            this.logger.warn(`reconcile ${o.id} failed: ${err?.message ?? err}`),
          );
      }
    } catch (err: any) {
      this.logger.warn(`WhatsApp reconcile sweep failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
