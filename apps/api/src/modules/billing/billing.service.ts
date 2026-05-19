import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { Decimal } from "@prisma/client/runtime/library";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { StripeService } from "./stripe.service";

// String-literal enum mirrors (until prisma generate runs against Phase R migration)
const SubscriptionStatus = {
  TRIALING: "TRIALING",
  ACTIVE: "ACTIVE",
  PAST_DUE: "PAST_DUE",
  CANCELLED: "CANCELLED",
  PAUSED: "PAUSED",
  INCOMPLETE: "INCOMPLETE",
  FREE_PILOT: "FREE_PILOT",
  UNPAID: "UNPAID",
} as const;
type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

// How many days past a failed payment before we move to UNPAID
const GRACE_PERIOD_DAYS = 7;

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
  // Optional — may be null if Stripe is not configured (FREE_PILOT phase)
  public readonly stripeService?: StripeService;

  constructor(
    private readonly prisma: PrismaService,
    stripeService?: StripeService,
  ) {
    // Cast once to avoid repetitive `as any` throughout — Phase F models will be
    // properly typed once `prisma generate` is re-run against schema v4.
    this.db = prisma as any;
    this.stripeService = stripeService;
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

        // Sync payment method status when Stripe reports a default method is attached
        const paymentMethodStatus = stripeSub.default_payment_method
          ? "attached"
          : subscription.paymentMethodStatus ?? null;

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
            paymentMethodStatus,
          },
        });
        break;
      }

      case "customer.updated": {
        const customer = event.data.object;
        const stripeCustomerId = customer.id as string;

        const updates: Record<string, any> = {};
        // Sync billing email if Stripe customer email changed
        if (customer.email) {
          updates.billingEmail = customer.email;
        }
        // A default payment method set means the card is attached and usable
        if (customer.invoice_settings?.default_payment_method) {
          updates.paymentMethodStatus = "attached";
        }

        if (Object.keys(updates).length > 0) {
          await this.db.tenantSubscription.updateMany({
            where: { stripeCustomerId },
            data: updates,
          });
        }
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

      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const stripeInvoice = event.data.object;

        // Update invoice record
        await this.db.invoice.updateMany({
          where: { stripeInvoiceId: stripeInvoice.id },
          data: {
            status: InvoiceStatus.PAID,
            amountPaid: new Decimal((stripeInvoice.amount_paid / 100).toFixed(2)),
            paidAt: new Date(),
          },
        });

        // Sync lastInvoiceStatus on the subscription record so billing pages
        // always show the most recent invoice outcome without a separate query.
        if (stripeInvoice.subscription) {
          await this.db.tenantSubscription.updateMany({
            where: { stripeSubId: stripeInvoice.subscription },
            data: { lastInvoiceStatus: "PAID" },
          });

          // If this payment clears a PAST_DUE subscription, restore it to ACTIVE.
          // customer.subscription.updated will also fire with status=active, but this
          // ensures grace period is cleared immediately on the payment event.
          await this.db.tenantSubscription.updateMany({
            where: {
              stripeSubId: stripeInvoice.subscription,
              status: SubscriptionStatus.PAST_DUE,
            },
            data: {
              status: SubscriptionStatus.ACTIVE,
              gracePeriodEndsAt: null,
            },
          });
        }
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object;
        const stripeCustomerId = session.customer as string;
        const stripeSubId = session.subscription as string;

        if (!stripeSubId) break; // one-time payment, not a subscription

        const sub = await this.db.tenantSubscription.findFirst({
          where: { stripeCustomerId },
        });

        if (!sub) {
          this.logger.warn(
            `checkout.session.completed: no TenantSubscription for customer ${stripeCustomerId}`,
          );
          break;
        }

        // Link the subscription ID created by Stripe Checkout to the TenantSubscription.
        // customer.subscription.created will also fire and set the status — this just ensures
        // the stripeSubId is stored so subsequent events can find the record.
        await this.db.tenantSubscription.update({
          where: { id: sub.id },
          data: {
            stripeSubId,
            metadata: {
              ...(sub.metadata as Record<string, unknown>),
              checkoutCompletedAt: new Date().toISOString(),
              checkoutSessionId: session.id,
            },
          },
        });

        await this.writeAuditLog(sub.tenantId, "billing.checkout_completed", "system", {
          stripeCustomerId,
          stripeSubId,
          sessionId: session.id,
        });

        this.logger.log(
          `Checkout completed: tenant=${sub.tenantId}, customer=${stripeCustomerId}, sub=${stripeSubId}`,
        );
        break;
      }

      case "invoice.payment_failed": {
        const stripeInvoice = event.data.object;
        if (stripeInvoice.subscription) {
          await this.db.tenantSubscription.updateMany({
            where: { stripeSubId: stripeInvoice.subscription },
            data: {
              status: SubscriptionStatus.PAST_DUE,
              lastInvoiceStatus: "OPEN",
            },
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

  // ── Phase R: Stripe Checkout & Portal ──────────────────────────────────────

  async createCheckoutSession(
    tenantId: string,
    params: { planId: string; successUrl: string; cancelUrl: string; stripeService: any },
  ) {
    const plan = await this.getPlanById(params.planId);
    if (!plan.stripePriceId) {
      throw new BadRequestException(
        `Plan '${plan.name}' does not have a Stripe price configured`,
      );
    }

    let sub = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      select: { stripeCustomerId: true },
    });

    let stripeCustomerId: string | null = sub?.stripeCustomerId ?? null;

    if (!stripeCustomerId && params.stripeService.isConfigured) {
      const tenant = await this.db.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, users: { where: { role: "TENANT_OWNER" }, select: { email: true }, take: 1 } },
      });
      const ownerEmail = tenant?.users?.[0]?.email ?? `${tenantId}@orderhub.io`;
      stripeCustomerId = await params.stripeService.createCustomer({
        tenantId,
        email: ownerEmail,
        name: tenant?.name ?? tenantId,
      });
      if (sub) {
        await this.db.tenantSubscription.update({
          where: { tenantId },
          data: { stripeCustomerId },
        });
      }
    }

    if (!stripeCustomerId) {
      throw new BadRequestException("Stripe is not configured — cannot create checkout session");
    }

    return params.stripeService.createCheckoutSession({
      stripeCustomerId,
      stripePriceId: plan.stripePriceId,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      tenantId,
      trialDays: plan.trialDays ?? undefined,
    });
  }

  async createPortalSession(
    tenantId: string,
    params: { returnUrl: string; stripeService: any },
  ) {
    const sub = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      select: { stripeCustomerId: true },
    });
    if (!sub?.stripeCustomerId) {
      throw new BadRequestException("No Stripe customer associated with this tenant");
    }
    return params.stripeService.createBillingPortalSession({
      stripeCustomerId: sub.stripeCustomerId,
      returnUrl: params.returnUrl,
    });
  }

  // ── Phase R: Grace period and UNPAID transition ────────────────────────────

  async applyGracePeriod(tenantId: string): Promise<void> {
    const gracePeriodEndsAt = new Date();
    gracePeriodEndsAt.setDate(gracePeriodEndsAt.getDate() + GRACE_PERIOD_DAYS);

    await this.db.tenantSubscription.update({
      where: { tenantId },
      data: {
        status: SubscriptionStatus.PAST_DUE,
        gracePeriodEndsAt,
        lastInvoiceStatus: "OPEN",
      },
    });
    this.logger.warn(
      `Grace period applied for tenant ${tenantId} — expires ${gracePeriodEndsAt.toISOString()}`,
    );
  }

  // Called by a scheduled job to expire overdue grace periods
  async expireGracePeriods(): Promise<number> {
    const now = new Date();
    const result = await this.db.tenantSubscription.updateMany({
      where: {
        status: SubscriptionStatus.PAST_DUE,
        gracePeriodEndsAt: { lt: now },
      },
      data: { status: SubscriptionStatus.UNPAID },
    });
    if (result.count > 0) {
      this.logger.warn(`Expired grace periods: ${result.count} tenant(s) moved to UNPAID`);
    }
    return result.count as number;
  }

  // ── Phase R: Admin billing overview ───────────────────────────────────────

  async getAdminBillingOverview(): Promise<any[]> {
    const subscriptions = await this.db.tenantSubscription.findMany({
      include: {
        tenant: { select: { id: true, name: true, slug: true, status: true } },
        plan: { select: { name: true, displayName: true, pricePerMonth: true } },
        invoices: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true, amountDue: true, createdAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return subscriptions.map((sub: any) => ({
      tenantId: sub.tenantId,
      tenantName: sub.tenant.name,
      tenantSlug: sub.tenant.slug,
      plan: sub.plan.name,
      planDisplayName: sub.plan.displayName,
      status: sub.status,
      stripeCustomerId: sub.stripeCustomerId ?? null,
      stripeSubId: sub.stripeSubId ?? null,
      currentPeriodEnd: sub.currentPeriodEnd,
      trialEndsAt: sub.trialEndsAt ?? null,
      gracePeriodEndsAt: sub.gracePeriodEndsAt ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      billingEmail: sub.billingEmail ?? null,
      paymentMethodStatus: sub.paymentMethodStatus ?? null,
      lastInvoiceStatus: sub.invoices[0]?.status ?? null,
      lastInvoiceAmountDue: sub.invoices[0]?.amountDue ?? null,
      lastInvoiceDate: sub.invoices[0]?.createdAt ?? null,
    }));
  }

  // ── Phase R: Pilot migration helper ───────────────────────────────────────

  async migrateToFreePilot(tenantId: string, trialEndsAt: Date): Promise<void> {
    const sub = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (sub) {
      await this.db.tenantSubscription.update({
        where: { tenantId },
        data: {
          status: SubscriptionStatus.FREE_PILOT,
          trialEndsAt,
          cancelAtPeriodEnd: false,
          metadata: {
            ...(sub.metadata as Record<string, unknown>),
            migratedToFreePilot: new Date().toISOString(),
            originalStatus: sub.status,
          },
        },
      });
    }

    this.logger.log(
      `Tenant ${tenantId} migrated to FREE_PILOT — free until ${trialEndsAt.toISOString()}`,
    );
  }

  // ── Phase R: Tenant billing status ────────────────────────────────────────

  async getTenantBillingStatus(tenantId: string) {
    const sub = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      include: {
        plan: { select: { name: true, displayName: true, pricePerMonth: true, maxLocations: true } },
        invoices: {
          orderBy: { createdAt: "desc" },
          take: 3,
          select: {
            id: true,
            number: true,
            status: true,
            amountDue: true,
            amountPaid: true,
            createdAt: true,
            dueDate: true,
            pdfUrl: true,
          },
        },
      },
    });

    if (!sub) throw new NotFoundException("No subscription found for this tenant");

    return {
      status: sub.status,
      plan: sub.plan,
      trialEndsAt: sub.trialEndsAt ?? null,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      gracePeriodEndsAt: sub.gracePeriodEndsAt ?? null,
      paymentMethodStatus: sub.paymentMethodStatus ?? null,
      recentInvoices: sub.invoices,
      // Do NOT expose stripeCustomerId, stripeSubId, or Stripe keys to tenants
    };
  }

  // ── Phase S: Admin billing controls (PLATFORM_ADMIN only) ─────────────────

  async adminGetBillingDetail(tenantId: string) {
    const sub = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      include: {
        plan: true,
        invoices: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });
    if (!sub) throw new NotFoundException("No subscription found for this tenant");

    const usageSummary = await this.db.usageRecord.findMany({
      where: { tenantId },
      orderBy: { billingMonth: "desc" },
      take: 3,
      select: { locationId: true, billingMonth: true, orderCount: true, printJobCount: true, reportedToStripe: true },
    });

    const auditLog = await this.db.auditLog.findMany({
      where: { tenantId, event: { startsWith: "billing." } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { event: true, meta: true, createdAt: true, userId: true },
    });

    return {
      ...sub,
      // Admin sees Stripe IDs — never expose these to tenant-facing endpoints
      stripeCustomerId: sub.stripeCustomerId ?? null,
      stripeSubId: sub.stripeSubId ?? null,
      usageSummary,
      auditLog,
    };
  }

  async adminExtendFreePilot(
    tenantId: string,
    newEndDate: Date,
    reason: string,
    adminUserId: string,
  ): Promise<void> {
    const sub = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      select: { status: true, trialEndsAt: true },
    });
    if (!sub) throw new NotFoundException("No subscription found for this tenant");
    if (sub.status !== "FREE_PILOT") {
      throw new BadRequestException(
        `Cannot extend FREE_PILOT: current status is '${sub.status}'`,
      );
    }

    const previousEnd = sub.trialEndsAt;
    await this.db.tenantSubscription.update({
      where: { tenantId },
      data: {
        trialEndsAt: newEndDate,
        metadata: {
          extendedAt: new Date().toISOString(),
          extendedBy: adminUserId,
          extendedReason: reason,
          previousTrialEndsAt: previousEnd?.toISOString() ?? null,
        },
      },
    });

    await this.writeAuditLog(tenantId, "billing.free_pilot_extended", adminUserId, {
      reason,
      previousEnd: previousEnd?.toISOString() ?? null,
      newEnd: newEndDate.toISOString(),
    });

    this.logger.log(
      `Admin ${adminUserId} extended FREE_PILOT for tenant ${tenantId} → ${newEndDate.toISOString().slice(0, 10)} (${reason})`,
    );
  }

  async adminConvertToTrial(
    tenantId: string,
    reason: string,
    adminUserId: string,
  ): Promise<void> {
    const sub = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      select: { status: true },
    });
    if (!sub) throw new NotFoundException("No subscription found for this tenant");

    const allowedFromStatuses = ["FREE_PILOT", "INCOMPLETE", "UNPAID"];
    if (!allowedFromStatuses.includes(sub.status)) {
      throw new BadRequestException(
        `Cannot convert to TRIALING from status '${sub.status}'`,
      );
    }

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 30);

    await this.db.tenantSubscription.update({
      where: { tenantId },
      data: {
        status: SubscriptionStatus.TRIALING,
        trialEndsAt,
        cancelAtPeriodEnd: false,
        gracePeriodEndsAt: null,
        metadata: {
          convertedToTrialAt: new Date().toISOString(),
          convertedBy: adminUserId,
          convertedReason: reason,
          previousStatus: sub.status,
        },
      },
    });

    await this.writeAuditLog(tenantId, "billing.converted_to_trial", adminUserId, {
      reason,
      previousStatus: sub.status,
      trialEndsAt: trialEndsAt.toISOString(),
    });

    this.logger.log(
      `Admin ${adminUserId} converted tenant ${tenantId} from ${sub.status} → TRIALING (${reason})`,
    );
  }

  async adminAssignPlan(
    tenantId: string,
    planId: string,
    reason: string,
    adminUserId: string,
  ): Promise<void> {
    const plan = await this.getPlanById(planId);
    const sub = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      select: { planId: true, status: true },
    });
    if (!sub) throw new NotFoundException("No subscription found for this tenant");

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    await this.db.tenantSubscription.update({
      where: { tenantId },
      data: {
        planId: plan.id,
        metadata: {
          planAssignedByAdmin: adminUserId,
          planAssignedAt: now.toISOString(),
          planAssignedReason: reason,
          previousPlanId: sub.planId,
        },
      },
    });

    await this.writeAuditLog(tenantId, "billing.plan_assigned_by_admin", adminUserId, {
      reason,
      newPlanId: plan.id,
      newPlanName: plan.name,
      previousPlanId: sub.planId,
    });

    this.logger.log(
      `Admin ${adminUserId} assigned plan '${plan.name}' to tenant ${tenantId} (${reason})`,
    );
  }

  async adminGrantException(
    tenantId: string,
    targetStatus: string,
    reason: string,
    adminUserId: string,
  ): Promise<void> {
    const allowedTargets = ["ACTIVE", "TRIALING", "FREE_PILOT", "PAUSED"];
    if (!allowedTargets.includes(targetStatus)) {
      throw new BadRequestException(
        `Cannot grant exception to status '${targetStatus}'. Allowed: ${allowedTargets.join(", ")}`,
      );
    }

    const sub = await this.db.tenantSubscription.findUnique({
      where: { tenantId },
      select: { status: true },
    });
    if (!sub) throw new NotFoundException("No subscription found for this tenant");

    await this.db.tenantSubscription.update({
      where: { tenantId },
      data: {
        status: targetStatus,
        gracePeriodEndsAt: null,
        metadata: {
          exceptionGrantedBy: adminUserId,
          exceptionGrantedAt: new Date().toISOString(),
          exceptionReason: reason,
          previousStatus: sub.status,
        },
      },
    });

    await this.writeAuditLog(tenantId, "billing.exception_granted", adminUserId, {
      reason,
      targetStatus,
      previousStatus: sub.status,
    });

    this.logger.warn(
      `Admin ${adminUserId} granted billing exception for tenant ${tenantId}: ` +
        `${sub.status} → ${targetStatus} (${reason})`,
    );
  }

  // ── Private audit helper ───────────────────────────────────────────────────

  private async writeAuditLog(
    tenantId: string,
    event: string,
    userId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.auditLog.create({
        data: {
          tenantId,
          userId,
          event,
          resource: "subscription",
          meta: meta as any,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to write billing audit log for ${event}: ${err.message}`);
    }
  }
}
