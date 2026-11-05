// Eat For Less — paying shops every Thursday.
//
// Customers' card payments stay in Eat For Less's own Stripe balance (3-day
// hold). On Thursday each shop is sent last week's (Mon–Sun) share: card
// orders less commission and ad spend, less the commission on its cash
// orders, less its part of anything refunded since, less anything it still
// owed. The money goes to its Express account and straight on to its bank.
// A week that leaves the shop owing pays nothing and carries the debt on.
//
// Runs every morning: Thursday works the week out and pays it; any other day
// only retries what Stripe refused. After the shops, Eat For Less's own
// commission is paid to its bank, never touching money still owed to shops.

import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EmailService } from "../../infrastructure/email/email.service";
import { PaymentsService } from "../payments/payments.service";
import { londonDateKey, nextWeekStart } from "./efl-ads-rules";
import { eflApplicationFeePence } from "./efl-rules";
import { clawbackPence, dueWeekStart, settle, sharePence } from "./efl-settlement-rules";

const PAID_CARD = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];
const NOT_A_SALE = ["CANCELLED", "REJECTED", "FAILED"];
/** Card payments taken on the weekly-payout flow, not the older destination charges. */
const SETTLE_PAYMENT = { some: { metadata: { path: ["flow"], equals: "settle" } } };
/** How far back a refund can still be taken from a later payout. */
const CLAWBACK_DAYS = 180;

const orderMoney = {
  id: true,
  total: true,
  subtotal: true,
  discount: true,
  eflCommissionPercent: true,
  eflAdRecovered: true,
  paymentStatus: true,
  payments: { select: { metadata: true } },
} as const;

/** The order as the settlement rules read it, refunds included. */
function asMoney(o: any) {
  const refunded = (o.payments ?? [])
    .map((p: any) => Number(p?.metadata?.refundedPence ?? 0))
    .reduce((a: number, b: number) => Math.max(a, b), 0);
  return { ...o, paymentStatus: String(o.paymentStatus), refundedPence: refunded };
}

@Injectable()
export class EflSettlementService {
  private readonly logger = new Logger(EflSettlementService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
    @Optional() private readonly email?: EmailService,
  ) {}

  @Cron("0 0 10 * * *", { timeZone: "Europe/London" })
  async morningRun() {
    if (process.env.EFL_PAYOUTS_ENABLED === "false" || this.running) return;
    if (!this.payments.eflStripeClient()) return;
    this.running = true;
    try {
      await this.run(new Date());
    } catch (e) {
      this.logger.error(`EFL payout run failed: ${(e as Error).message}`);
      await this.alert(`The payout run itself failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Work out the due week, pay whatever is unpaid, then pay Eat For Less its own share. */
  async run(now: Date) {
    const week = dueWeekStart(now);
    const created = await this.prepareWeek(week);
    const outcome = await this.payOutstanding();
    if (outcome.failed.length) await this.alert(outcome.failed.map((f) => `${f.shop}: ${f.error}`).join("\n"));
    // Safe even with a refused payout: what it owes the shop is held back.
    await this.payPlatform().catch((e) => this.logger.warn(`EFL platform payout skipped: ${(e as Error).message}`));
    this.logger.log(
      `EFL payouts ${londonDateKey(week)}: ${created} worked out, ${outcome.paid} paid, ${outcome.failed.length} failed`,
    );
    return { week: londonDateKey(week), created, ...outcome };
  }

  // ── Working a week out ────────────────────────────────────────────────

  /** One row per shop with a payout account, once. Returns how many were new. */
  async prepareWeek(weekStart: Date): Promise<number> {
    const listings = await this.prisma.eflListing.findMany({
      where: { stripeAccountId: { not: null } },
      select: { id: true, locationId: true },
    });
    let created = 0;
    for (const l of listings) {
      const exists = await this.prisma.eflPayout.findUnique({
        where: { listingId_weekStart: { listingId: l.id, weekStart } },
        select: { id: true },
      });
      if (exists) continue;
      if (await this.prepareOne(l, weekStart)) created++;
    }
    return created;
  }

  private async prepareOne(listing: { id: string; locationId: string }, weekStart: Date): Promise<boolean> {
    const end = nextWeekStart(weekStart);
    const inWeek = { gte: weekStart, lt: end };

    const [cardOrders, cashOrders, earlierLines, previous] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          locationId: listing.locationId,
          orderSource: "EAT_FOR_LESS",
          createdAt: inWeek,
          paymentStatus: { in: PAID_CARD as any },
          payments: SETTLE_PAYMENT as any,
        },
        select: orderMoney,
      }),
      this.prisma.order.findMany({
        where: {
          locationId: listing.locationId,
          orderSource: "EAT_FOR_LESS",
          createdAt: inWeek,
          paymentMethod: "CASH",
          status: { notIn: NOT_A_SALE as any },
        },
        select: { subtotal: true, discount: true, eflCommissionPercent: true, eflAdRecovered: true },
      }),
      this.prisma.eflPayoutLine.findMany({
        where: {
          payout: {
            listingId: listing.id,
            weekStart: { lt: weekStart, gte: new Date(weekStart.getTime() - CLAWBACK_DAYS * 86_400_000) },
          },
        },
        select: { id: true, orderId: true, toShopPence: true, clawedBackPence: true },
      }),
      this.prisma.eflPayout.findFirst({
        where: { listingId: listing.id, weekStart: { lt: weekStart } },
        orderBy: { weekStart: "desc" },
        select: { carriedOutPence: true },
      }),
    ]);

    // Lines are written once, so an order already paid out (a late-arriving
    // row, a rerun) can't be paid twice.
    const settled = new Set(
      (
        await this.prisma.eflPayoutLine.findMany({
          where: { orderId: { in: cardOrders.map((o) => o.id) } },
          select: { orderId: true },
        })
      ).map((l) => l.orderId),
    );
    const lines = cardOrders
      .filter((o) => !settled.has(o.id))
      .map((o) => ({ orderId: o.id, toShopPence: sharePence(asMoney(o)) }));
    const cardPence = lines.reduce((t, l) => t + l.toShopPence, 0);
    const cashCommissionPence = cashOrders.reduce((t, o) => t + eflApplicationFeePence(o), 0);

    // Refunds since: only orders that have been refunded at all are worth a look.
    const refundedNow = earlierLines.length
      ? await this.prisma.order.findMany({
          where: {
            id: { in: earlierLines.map((l) => l.orderId) },
            paymentStatus: { in: ["REFUNDED", "PARTIALLY_REFUNDED"] as any },
          },
          select: orderMoney,
        })
      : [];
    const byId = new Map(refundedNow.map((o) => [o.id, o]));
    const clawbacks = earlierLines
      .filter((l) => byId.has(l.orderId))
      .map((l) => ({ id: l.id, pence: clawbackPence(l, sharePence(asMoney(byId.get(l.orderId)))) }))
      .filter((c) => c.pence > 0);
    const refundsPence = clawbacks.reduce((t, c) => t + c.pence, 0);

    const carriedInPence = previous?.carriedOutPence ?? 0;
    if (!lines.length && !cashCommissionPence && !refundsPence && !carriedInPence) return false;

    const { amountPence, carriedOutPence } = settle({ cardPence, cashCommissionPence, refundsPence, carriedInPence });
    await this.prisma.$transaction([
      this.prisma.eflPayout.create({
        data: {
          listingId: listing.id,
          weekStart,
          status: amountPence > 0 ? "PENDING" : "NOTHING_DUE",
          cardPence,
          cashCommissionPence,
          refundsPence,
          carriedInPence,
          amountPence,
          carriedOutPence,
          lines: { create: lines },
        },
      }),
      ...clawbacks.map((c) =>
        this.prisma.eflPayoutLine.update({ where: { id: c.id }, data: { clawedBackPence: { increment: c.pence } } }),
      ),
    ]);
    return true;
  }

  // ── Moving the money ──────────────────────────────────────────────────

  /** Send every unpaid payout: to the shop's Stripe account, then on to its bank. */
  async payOutstanding(): Promise<{ paid: number; failed: Array<{ shop: string; error: string }> }> {
    const stripe = this.payments.eflStripeClient();
    const rows = await this.prisma.eflPayout.findMany({
      where: { status: { in: ["PENDING", "FAILED", "TRANSFERRED"] } },
      orderBy: { weekStart: "asc" },
      include: {
        listing: { select: { stripeAccountId: true, stripePayoutsEnabled: true, location: { select: { name: true } } } },
      },
    });
    let paid = 0;
    const failed: Array<{ shop: string; error: string }> = [];
    for (const row of rows) {
      const shop = row.listing.location?.name ?? row.listingId;
      const account = row.listing.stripeAccountId;
      try {
        if (!account || !row.listing.stripePayoutsEnabled) {
          throw new Error("payout setup isn't finished, so Stripe can't pay this shop");
        }
        let transferId = row.stripeTransferId;
        if (!transferId) {
          const transfer = await stripe.transfers.create(
            {
              amount: row.amountPence,
              currency: "gbp",
              destination: account,
              transfer_group: `efl_payout_${row.id}`,
              description: `Eat For Less, week of ${londonDateKey(row.weekStart)}`,
              metadata: { payoutId: row.id, listingId: row.listingId, week: londonDateKey(row.weekStart) },
            },
            // A retry after a timeout finds the transfer that did go, not a second one.
            { idempotencyKey: `efl-payout-${row.id}` },
          );
          transferId = transfer.id as string;
          await this.prisma.eflPayout.update({
            where: { id: row.id },
            data: { status: "TRANSFERRED", stripeTransferId: transferId, error: null },
          });
        }
        // Shops are paid when we say, not on Stripe's own timetable.
        await stripe.accounts.update(account, { settings: { payouts: { schedule: { interval: "manual" } } } });
        const payout = await stripe.payouts.create(
          {
            amount: row.amountPence,
            currency: "gbp",
            statement_descriptor: "EAT FOR LESS",
            metadata: { payoutId: row.id, week: londonDateKey(row.weekStart) },
          },
          { stripeAccount: account, idempotencyKey: `efl-bank-${row.id}` },
        );
        await this.prisma.eflPayout.update({
          where: { id: row.id },
          data: { status: "PAID", stripePayoutId: payout.id as string, paidAt: new Date(), error: null },
        });
        paid++;
      } catch (e) {
        const error = String((e as Error)?.message ?? e).slice(0, 500);
        // Once the transfer went, the money is the shop's: keep TRANSFERRED
        // so the retry only makes the bank payout.
        const fresh = await this.prisma.eflPayout.findUnique({ where: { id: row.id }, select: { stripeTransferId: true } });
        await this.prisma.eflPayout.update({
          where: { id: row.id },
          data: { status: fresh?.stripeTransferId ? "TRANSFERRED" : "FAILED", error, attempts: { increment: 1 } },
        });
        this.logger.warn(`EFL payout ${row.id} for ${shop} not finished: ${error}`);
        failed.push({ shop, error });
      }
    }
    return { paid, failed };
  }

  /**
   * Eat For Less's own share to its bank: the available balance less every
   * penny still owed to shops (orders not yet paid out, payouts not yet
   * sent). Its Stripe payouts are manual, or this sweep would take the
   * shops' money too.
   */
  async payPlatform(): Promise<number> {
    const stripe = this.payments.eflStripeClient();
    const balance = await stripe.balance.retrieve();
    const available = (balance.available ?? [])
      .filter((b: any) => b.currency === "gbp")
      .reduce((t: number, b: any) => t + Number(b.amount ?? 0), 0);

    const owedOrders = await this.prisma.order.findMany({
      where: {
        orderSource: "EAT_FOR_LESS",
        paymentStatus: { in: PAID_CARD as any },
        payments: SETTLE_PAYMENT as any,
        createdAt: { gte: new Date(Date.now() - CLAWBACK_DAYS * 86_400_000) },
      },
      select: orderMoney,
    });
    const settled = new Set(
      (
        await this.prisma.eflPayoutLine.findMany({
          where: { orderId: { in: owedOrders.map((o) => o.id) } },
          select: { orderId: true },
        })
      ).map((l) => l.orderId),
    );
    const unsettled = owedOrders.filter((o) => !settled.has(o.id)).reduce((t, o) => t + sharePence(asMoney(o)), 0);
    const unsent = await this.prisma.eflPayout.aggregate({
      where: { status: { in: ["PENDING", "FAILED"] } },
      _sum: { amountPence: true },
    });
    const buffer = Math.max(0, Number(this.config.get<string>("EFL_PLATFORM_PAYOUT_BUFFER_PENCE") ?? 0) || 0);
    const amount = available - unsettled - (unsent._sum.amountPence ?? 0) - buffer;
    if (amount < 100) return 0;
    await stripe.payouts.create(
      { amount, currency: "gbp", metadata: { kind: "eat_for_less_commission" } },
      { idempotencyKey: `efl-platform-${londonDateKey(new Date())}-${amount}` },
    );
    this.logger.log(`EFL commission payout £${(amount / 100).toFixed(2)}`);
    return amount;
  }

  // ── For the Console and the shop ──────────────────────────────────────

  async forLocation(locationId: string, take = 12) {
    return this.prisma.eflPayout.findMany({
      where: { listing: { locationId } },
      orderBy: { weekStart: "desc" },
      take,
      select: payoutView,
    });
  }

  async forWeek(weekStart: Date) {
    return this.prisma.eflPayout.findMany({
      where: { weekStart },
      orderBy: { createdAt: "asc" },
      select: { ...payoutView, listing: { select: { locationId: true, location: { select: { name: true } } } } },
    });
  }

  private async alert(body: string) {
    const to =
      this.config.get<string>("EFL_PAYOUT_ALERT_EMAIL") ??
      this.config.get<string>("BILLING_ALERT_EMAIL") ??
      "hello@eatforless.co.uk";
    if (!this.email) return;
    await this.email
      .send({
        to,
        subject: "Eat For Less: a shop payout didn't go through",
        html: `<p>These payouts didn't finish. They're retried every morning at 10:00.</p><pre style="white-space:pre-wrap">${body
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")}</pre>`,
      })
      .catch((e) => this.logger.warn(`EFL payout alert not sent: ${(e as Error).message}`));
  }
}

const payoutView = {
  id: true,
  weekStart: true,
  status: true,
  cardPence: true,
  cashCommissionPence: true,
  refundsPence: true,
  carriedInPence: true,
  amountPence: true,
  carriedOutPence: true,
  error: true,
  paidAt: true,
} as const;
