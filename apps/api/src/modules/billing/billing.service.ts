import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { Decimal } from "@prisma/client/runtime/library";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// String-literal enum mirrors for Phase F (until prisma generate runs)
const SubscriptionStatus = {
  TRIALING: "TRIALING",
  ACTIVE: "ACTIVE",
  PAST_DUE: "PAST_DUE",
  CANCELLED: "CANCELLED",
  PAUSED: "PAUSED",
  INCOMPLETE: "INCOMPLETE",
} as const;
type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

const InvoiceStatus = {
  DRAFT: "DRAFT",
  OPEN: "OPEN",
  PAID: "PAID",
  VOID: "VOID",
  UNCOLLECTIBLE: "UNCOLLECTIBLE",
} as const;
type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export interface CreateSubscriptionDto {
  planId: string;
  stripeCustomerId?: string;
}

export interface UpdateSubscriptionDto {
  planId: string;
}

export interface GenerateInvoiceDto {
  lineItems: Array<{
    description: string;
    quantity: number;
    unitAmount: number;
  }>;
  dueDate?: string;
  currency?: string;
}

function generateInvoiceNumber(): string {
  const prefix = "INV";
  const date = new Date();
  const yyyyMM = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
  const random = Math.floor(Math.random() * 900_000 + 100_000);
  return `${prefix}-${yyyyMM}-${random}`;
}

// Alias for the Phase F Prisma models not yet in the generated client
type PrismaAny = any;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly db: PrismaAny;

  constructor(private readonly prisma: PrismaService) {
    // Cast once to avoid repetitive `as any` throughout — Phase F models will be
    // properly typed once `prisma generate` is re-run against schema v4.
    this.db = prisma as any;
  }

  // ── Plans ──────────────────────────────────────────────────────────────────

  async getPlans() {
    return this.db.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { pricePerMonth: "asc" },
    });
  }

  async getPlanById(planId: string) {
    const plan = await this.db.subscriptionPlan.findUnique({
      where: { id: planId },
    });
    if (!plan) throw new NotFoundException("Subscription plan not found");
    return plan;
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  async getSubscription(tenantId: string) {
    const subscription = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      include: {
        plan: true,
        invoices: {
          orderBy: { createdAt: "desc" },
          take: 5,
          select: {
            id: true,
            number: true,
            status: true,
            amountDue: true,
            amountPaid: true,
            createdAt: true,
            dueDate: true,
          },
        },
      },
    });
    if (!subscription) throw new NotFoundException("No active subscription found");
    return subscription;
  }

  async createSubscription(tenantId: string, dto: CreateSubscriptionDto) {
    const existing = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
    });
    if (existing) {
      throw new ConflictException(
        "Tenant already has a subscription. Use PATCH /subscription to change plan.",
      );
    }

    const plan = await this.getPlanById(dto.planId);

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const subscription = await this.db.tenantSubscription.create({
      data: {
        tenantId,
        planId: plan.id,
        stripeCustomerId: dto.stripeCustomerId ?? null,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        locationCount: 1,
        metadata: {},
      },
      include: { plan: true },
    });

    this.logger.log(
      `Subscription created for tenant ${tenantId}: plan=${plan.name}`,
    );
    return subscription;
  }

  async updateSubscription(tenantId: string, dto: UpdateSubscriptionDto) {
    const subscription = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!subscription) throw new NotFoundException("No active subscription found");

    if (subscription.status === SubscriptionStatus.CANCELLED) {
      throw new BadRequestException(
        "Cannot upgrade/downgrade a cancelled subscription",
      );
    }

    const newPlan = await this.getPlanById(dto.planId);

    if (newPlan.id === subscription.planId) {
      return subscription; // No-op
    }

    const updated = await this.db.tenantSubscription.update({
      where: { tenantId },
      data: {
        planId: newPlan.id,
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
        metadata: {
          ...(subscription.metadata as Record<string, unknown>),
          previousPlanId: subscription.planId,
          planChangedAt: new Date().toISOString(),
        },
      },
      include: { plan: true },
    });

    this.logger.log(
      `Subscription updated for tenant ${tenantId}: ${subscription.plan.name} → ${newPlan.name}`,
    );
    return updated;
  }

  async cancelSubscription(tenantId: string) {
    const subscription = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
    });
    if (!subscription) throw new NotFoundException("No active subscription found");

    if (subscription.status === SubscriptionStatus.CANCELLED) {
      throw new BadRequestException("Subscription is already cancelled");
    }

    const updated = await this.db.tenantSubscription.update({
      where: { tenantId },
      data: {
        cancelAtPeriodEnd: true,
        metadata: {
          ...(subscription.metadata as Record<string, unknown>),
          cancelRequestedAt: new Date().toISOString(),
        },
      },
      include: { plan: true },
    });

    this.logger.log(
      `Subscription scheduled for cancellation at period end: tenant ${tenantId}`,
    );
    return updated;
  }

  // ── Invoices ───────────────────────────────────────────────────────────────

  async getInvoices(tenantId: string, limit = 20) {
    return this.db.invoice.findMany({
      where: { tenantId },
      include: { lineItems: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async getInvoice(invoiceId: string, tenantId: string) {
    const invoice = await this.db.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: {
        lineItems: true,
        subscription: {
          include: { plan: { select: { name: true, displayName: true } } },
        },
      },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  async generateInvoice(
    tenantId: string,
    subscriptionId: string,
    dto: GenerateInvoiceDto,
  ) {
    const subscription = await this.db.tenantSubscription.findFirst({
      where: { id: subscriptionId, tenantId },
    });
    if (!subscription) {
      throw new NotFoundException("Subscription not found");
    }

    if (!dto.lineItems || dto.lineItems.length === 0) {
      throw new BadRequestException("At least one line item is required");
    }

    const amountDue = dto.lineItems
      .reduce((sum: Decimal, item) => {
        const lineTotal = new Decimal(item.unitAmount.toFixed(2)).mul(item.quantity);
        return sum.add(lineTotal);
      }, new Decimal("0"))
      .toDecimalPlaces(2);

    const invoiceNumber = generateInvoiceNumber();
    const currency = (dto.currency ?? "gbp").toLowerCase();

    const invoice = await this.db.invoice.create({
      data: {
        tenantId,
        subscriptionId,
        number: invoiceNumber,
        status: InvoiceStatus.OPEN,
        amountDue,
        amountPaid: new Decimal("0"),
        currency,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        lineItems: {
          create: dto.lineItems.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            unitAmount: new Decimal(item.unitAmount.toFixed(2)),
            amount: new Decimal(item.unitAmount.toFixed(2))
              .mul(item.quantity)
              .toDecimalPlaces(2),
          })),
        },
      },
      include: { lineItems: true },
    });

    this.logger.log(
      `Invoice generated: ${invoiceNumber} — ${amountDue} ${currency} for tenant ${tenantId}`,
    );
    return invoice;
  }

  // ── Stripe Webhook Billing Events ──────────────────────────────────────────

  async handleStripeWebhookBilling(event: any) {
    this.logger.log(`Billing webhook received: ${event.type}`);

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const stripeSub = event.data.object;
        const stripeCustomerId = stripeSub.customer as string;
        const stripeSubId = stripeSub.id as string;

        const subscription = await this.db.tenantSubscription.findFirst({
          where: {
            OR: [{ stripeSubId }, { stripeCustomerId }],
          },
        });

        if (!subscription) {
          this.logger.warn(
            `No TenantSubscription found for Stripe sub ${stripeSubId}`,
          );
          break;
        }

        const status = this.mapStripeSubStatus(stripeSub.status);

        await this.db.tenantSubscription.update({
          where: { id: subscription.id },
          data: {
            stripeSubId,
            status,
            currentPeriodStart: stripeSub.current_period_start
              ? new Date(stripeSub.current_period_start * 1000)
              : subscription.currentPeriodStart,
            currentPeriodEnd: stripeSub.current_period_end
              ? new Date(stripeSub.current_period_end * 1000)
              : subscription.currentPeriodEnd,
            cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
            trialEndsAt: stripeSub.trial_end
              ? new Date(stripeSub.trial_end * 1000)
              : null,
          },
        });
        break;
      }

      case "customer.subscription.deleted": {
        const stripeSub = event.data.object;
        await this.db.tenantSubscription.updateMany({
          where: { stripeSubId: stripeSub.id },
          data: { status: SubscriptionStatus.CANCELLED },
        });
        break;
      }

      case "invoice.paid": {
        const stripeInvoice = event.data.object;
        await this.db.invoice.updateMany({
          where: { stripeInvoiceId: stripeInvoice.id },
          data: {
            status: InvoiceStatus.PAID,
            amountPaid: new Decimal((stripeInvoice.amount_paid / 100).toFixed(2)),
            paidAt: new Date(),
          },
        });
        break;
      }

      case "invoice.payment_failed": {
        const stripeInvoice = event.data.object;
        if (stripeInvoice.subscription) {
          await this.db.tenantSubscription.updateMany({
            where: { stripeSubId: stripeInvoice.subscription },
            data: { status: SubscriptionStatus.PAST_DUE },
          });
        }
        break;
      }

      case "invoice.finalized": {
        const stripeInvoice = event.data.object;

        const subscription = await this.db.tenantSubscription.findFirst({
          where: { stripeSubId: stripeInvoice.subscription ?? "" },
        });

        if (subscription) {
          const existingInvoice = await this.db.invoice.findUnique({
            where: { stripeInvoiceId: stripeInvoice.id },
          });

          if (!existingInvoice) {
            await this.db.invoice.create({
              data: {
                tenantId: subscription.tenantId,
                subscriptionId: subscription.id,
                stripeInvoiceId: stripeInvoice.id,
                number: stripeInvoice.number ?? generateInvoiceNumber(),
                status: InvoiceStatus.OPEN,
                amountDue: new Decimal((stripeInvoice.amount_due / 100).toFixed(2)),
                amountPaid: new Decimal("0"),
                currency: stripeInvoice.currency ?? "gbp",
                dueDate: stripeInvoice.due_date
                  ? new Date(stripeInvoice.due_date * 1000)
                  : null,
                pdfUrl: stripeInvoice.invoice_pdf ?? null,
              },
            });
          }
        }
        break;
      }

      default:
        this.logger.debug(`Unhandled billing webhook type: ${event.type}`);
    }

    return { received: true };
  }

  // ── Feature Access ─────────────────────────────────────────────────────────

  async checkFeatureAccess(tenantId: string, featureKey: string): Promise<boolean> {
    const subscription = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: { select: { features: true, isActive: true } } },
    });

    if (!subscription) return false;
    if (
      subscription.status !== SubscriptionStatus.ACTIVE &&
      subscription.status !== SubscriptionStatus.TRIALING
    ) {
      return false;
    }

    const features = subscription.plan.features as string[];
    return features.includes(featureKey);
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private mapStripeSubStatus(stripeStatus: string): SubscriptionStatus {
    switch (stripeStatus) {
      case "trialing":
        return SubscriptionStatus.TRIALING;
      case "active":
        return SubscriptionStatus.ACTIVE;
      case "past_due":
        return SubscriptionStatus.PAST_DUE;
      case "canceled":
      case "cancelled":
        return SubscriptionStatus.CANCELLED;
      case "paused":
        return SubscriptionStatus.PAUSED;
      case "incomplete":
      case "incomplete_expired":
        return SubscriptionStatus.INCOMPLETE;
      default:
        return SubscriptionStatus.INCOMPLETE;
    }
  }
}
