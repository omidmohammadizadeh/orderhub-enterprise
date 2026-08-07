// Phase AW-30 — per-location SaaS subscriptions billed by the platform.
//
// Architecture:
//   1. Platform admin sets a monthly amount per location.
//   2. We mint a Stripe Customer + a per-merchant recurring Price + an
//      incomplete Subscription, then hand the merchant a Stripe Checkout
//      Session URL where they enter card details.
//   3. Stripe activates the subscription once the card succeeds and
//      fires webhooks we mirror onto MerchantSubscription.
//   4. The merchant manages the card / views invoices / downloads PDFs
//      from the Stripe Customer Portal — we never reimplement those.
//   5. Smart Retries + dunning emails happen automatically on Stripe's
//      side (configured once in Stripe Dashboard → Billing → Manage
//      failed payments).

import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Stripe SDK is optional at runtime so dev environments without the key
// can still boot (returns mock IDs in that mode).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Stripe: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Stripe = require("stripe").default ?? require("stripe");
} catch {
  Stripe = null;
}

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly stripe: any | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const key = this.config.get<string>("STRIPE_SECRET_KEY");
    if (key && Stripe) {
      this.stripe = new Stripe(key, { apiVersion: "2024-06-20" });
    } else {
      this.stripe = null;
      this.logger.warn(
        "STRIPE_SECRET_KEY not set — subscription calls will use mock data",
      );
    }
  }

  private webBase(): string {
    return (
      this.config.get<string>("WEB_URL") ?? "https://www.orderhubsolutions.com"
    ).replace(/\/+$/, "");
  }

  // ONLY platform admin — us — sees every location's billing.
  //
  // TENANT_OWNER used to be here too, which meant any tenant owner saw every
  // subscription in the tenant: the monthly fee, the card status and the
  // invoices of locations they have nothing to do with. That is fine when a
  // tenant is one business, and a data leak the moment a tenant holds more
  // than one operator's locations — which is exactly how this one is set up.
  //
  // Billing is the most sensitive page in the product, so it is scoped by
  // assignment like everything else and does not get a role-shaped exemption.
  private static readonly TENANT_WIDE = ["PLATFORM_ADMIN"];

  /** null = all locations (platform admin); array = the scoped allowlist. */
  private async accessibleLocationIds(
    tenantId: string,
    userId?: string,
    role?: string,
  ): Promise<string[] | null> {
    if (role && SubscriptionsService.TENANT_WIDE.includes(role)) return null;

    // No identity → no access. This used to fall through to `return null`,
    // i.e. "see everything", so any caller that reached the service without a
    // resolved user got the whole tenant's billing. Failing open is never the
    // right default; failing closed shows an empty page, which is loud enough
    // to get reported and harmless if it happens.
    if (!userId || !role) {
      this.logger.warn(
        "Subscription access requested without a resolved user — denying",
      );
      return [];
    }
    const [locs, brands] = await Promise.all([
      (this.prisma as any).userLocation.findMany({
        where: { userId },
        select: { locationId: true },
      }),
      (this.prisma as any).userBrand.findMany({
        where: { userId },
        select: { brandId: true },
      }),
    ]);
    const ids = new Set<string>(locs.map((l: any) => l.locationId as string));
    const brandIds = brands.map((b: any) => b.brandId as string);
    if (brandIds.length) {
      const brandRows = await this.prisma.brand.findMany({
        where: { id: { in: brandIds }, tenantId },
        select: { primaryLocationId: true, locations: { select: { id: true } } },
      });
      for (const b of brandRows) {
        if (b.primaryLocationId) ids.add(b.primaryLocationId);
        for (const l of b.locations) ids.add(l.id);
      }
    }
    return Array.from(ids);
  }

  private async assertLocationAccess(
    tenantId: string,
    locationId: string,
    userId?: string,
    role?: string,
  ): Promise<void> {
    const allowed = await this.accessibleLocationIds(tenantId, userId, role);
    if (allowed && !allowed.includes(locationId)) {
      throw new NotFoundException("Subscription not found");
    }
  }

  /**
   * The subscriptions this caller is entitled to see.
   *
   * Platform admin gets the whole tenant (the overview of who's paying, who's
   * overdue, who never started). Everyone else — including tenant owners —
   * gets only the locations they are assigned to.
   */
  async listForTenant(tenantId: string, userId?: string, role?: string) {
    const allowed = await this.accessibleLocationIds(tenantId, userId, role);
    const where: any = { tenantId };
    if (allowed) {
      if (allowed.length === 0) {
        // An owner with no location assignments now sees nothing rather than
        // everything. That's the safe end of the trade, but it looks like a
        // broken page, so say why in the log instead of returning a silent
        // empty list — the fix is to assign them their locations.
        this.logger.warn(
          `No accessible locations for user=${userId} role=${role} — subscription list empty`,
        );
        return [];
      }
      where.locationId = { in: allowed };
    }
    const subs = await (this.prisma as any).merchantSubscription.findMany({
      where,
      include: {
        location: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return subs.map((s: any) => this.serialise(s));
  }

  async getForLocation(tenantId: string, locationId: string, userId?: string, role?: string) {
    await this.assertLocationAccess(tenantId, locationId, userId, role);
    const sub = await (this.prisma as any).merchantSubscription.findFirst({
      where: { tenantId, locationId },
      include: { location: { select: { id: true, name: true } } },
    });
    return sub ? this.serialise(sub) : null;
  }

  /**
   * Set or update the monthly amount for a location. Creates the
   * Stripe Customer + Price + Subscription on the first call; on
   * subsequent calls swaps the subscription's price to the new one.
   * Returns the row plus a one-time `checkoutUrl` the merchant uses
   * to enter their card if they haven't already.
   */
  async setPlan(
    tenantId: string,
    locationId: string,
    monthlyAmountPence: number,
    billingEmail?: string,
    userId?: string,
    role?: string,
  ) {
    await this.assertLocationAccess(tenantId, locationId, userId, role);
    if (!Number.isFinite(monthlyAmountPence) || monthlyAmountPence < 100) {
      throw new BadRequestException(
        "monthlyAmountPence must be a number >= 100 (i.e. >= £1.00)",
      );
    }

    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, name: true, brand: { select: { tenantId: true } } },
    });
    if (!location) throw new NotFoundException("Location not found");

    let sub = await (this.prisma as any).merchantSubscription.findFirst({
      where: { tenantId, locationId },
    });

    // ── First time → mint Customer + Subscription ────────────────
    if (!sub) {
      let stripeCustomerId: string | null = null;
      let stripeSubscriptionId: string | null = null;
      let stripePriceId: string | null = null;
      let checkoutId: string | null = null;
      let checkoutUrl: string | null = null;

      if (this.stripe) {
        try {
          const customer = await this.stripe.customers.create({
            name: location.name,
            email: billingEmail || undefined,
            metadata: { tenantId, locationId },
          });
          stripeCustomerId = customer.id;

          const price = await this.stripe.prices.create({
            unit_amount: monthlyAmountPence,
            currency: "gbp",
            recurring: { interval: "month" },
            product_data: {
              name: `OrderHub subscription — ${location.name}`,
            },
            metadata: { tenantId, locationId },
          });
          stripePriceId = price.id;

          // Checkout Session in `subscription` mode collects the card
          // AND activates the subscription in one round-trip. Far
          // cleaner than SetupIntent + manual subscription update.
          const session = await this.stripe.checkout.sessions.create({
            mode: "subscription",
            customer: customer.id,
            line_items: [{ price: price.id, quantity: 1 }],
            success_url: `${this.webBase()}/dashboard/subscription?status=success&location=${locationId}`,
            cancel_url: `${this.webBase()}/dashboard/subscription?status=cancel&location=${locationId}`,
            metadata: { tenantId, locationId },
            subscription_data: { metadata: { tenantId, locationId } },
            // Smart retries + receipt emails handled on Stripe side.
            billing_address_collection: "auto",
            customer_update: { address: "auto", name: "auto" },
          });
          checkoutId = session.id;
          checkoutUrl = session.url;
          // We can't read the subscription id until checkout completes,
          // but the webhook will fill it in.
        } catch (err: any) {
          this.logger.error(
            `Stripe subscription create failed for ${locationId}: ${err.message}`,
          );
          throw new BadRequestException(
            `Stripe error: ${err.message}`,
          );
        }
      } else {
        stripeCustomerId = `mock_cus_${locationId.slice(-8)}`;
        stripePriceId = `mock_price_${monthlyAmountPence}`;
        checkoutId = `mock_cs_${Date.now()}`;
        checkoutUrl = `${this.webBase()}/dashboard/subscription?status=mock`;
      }

      sub = await (this.prisma as any).merchantSubscription.create({
        data: {
          tenantId,
          locationId,
          stripeCustomerId,
          stripeSubscriptionId,
          stripePriceId,
          stripeCheckoutId: checkoutId,
          monthlyAmountPence,
          currency: "gbp",
          status: "incomplete",
        },
        include: { location: { select: { id: true, name: true } } },
      });

      return { ...this.serialise(sub), checkoutUrl };
    }

    // ── Already have a sub → swap to a new Price for the new amount.
    // For simplicity we always mint a fresh Price; Stripe accepts a
    // few thousand per merchant fine.
    if (this.stripe && sub.stripeSubscriptionId) {
      try {
        const price = await this.stripe.prices.create({
          unit_amount: monthlyAmountPence,
          currency: "gbp",
          recurring: { interval: "month" },
          product_data: {
            name: `OrderHub subscription — ${location.name}`,
          },
          metadata: { tenantId, locationId },
        });
        const current = await this.stripe.subscriptions.retrieve(
          sub.stripeSubscriptionId,
        );
        await this.stripe.subscriptions.update(sub.stripeSubscriptionId, {
          proration_behavior: "create_prorations",
          items: [{ id: current.items.data[0].id, price: price.id }],
        });
        sub = await (this.prisma as any).merchantSubscription.update({
          where: { id: sub.id },
          data: { stripePriceId: price.id, monthlyAmountPence },
          include: { location: { select: { id: true, name: true } } },
        });
      } catch (err: any) {
        this.logger.error(
          `Stripe subscription price swap failed for ${locationId}: ${err.message}`,
        );
        throw new BadRequestException(
          `Stripe error: ${err.message}`,
        );
      }
    } else {
      sub = await (this.prisma as any).merchantSubscription.update({
        where: { id: sub.id },
        data: { monthlyAmountPence },
        include: { location: { select: { id: true, name: true } } },
      });
    }

    return this.serialise(sub);
  }

  /**
   * Open the Stripe Customer Portal so the merchant can update card,
   * view invoices, download PDFs, etc. The portal is HOSTED by Stripe
   * and configured once in the dashboard.
   */
  async createPortalSession(tenantId: string, locationId: string, userId?: string, role?: string) {
    await this.assertLocationAccess(tenantId, locationId, userId, role);
    const sub = await (this.prisma as any).merchantSubscription.findFirst({
      where: { tenantId, locationId },
    });
    if (!sub || !sub.stripeCustomerId) {
      throw new NotFoundException(
        "No subscription set up for this location yet.",
      );
    }
    if (!this.stripe) {
      return { url: `${this.webBase()}/dashboard/subscription?mock=portal` };
    }
    try {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: `${this.webBase()}/dashboard/subscription`,
      });
      return { url: session.url };
    } catch (err: any) {
      this.logger.error(
        `Stripe Customer Portal failed for ${locationId}: ${err.message}`,
      );
      throw new BadRequestException(`Stripe error: ${err.message}`);
    }
  }

  /**
   * Re-open the original Checkout Session URL (or mint a new one) for
   * a subscription that's still `incomplete` — i.e. card never went
   * through the first time.
   */
  async restartCheckout(tenantId: string, locationId: string, userId?: string, role?: string) {
    await this.assertLocationAccess(tenantId, locationId, userId, role);
    const sub = await (this.prisma as any).merchantSubscription.findFirst({
      where: { tenantId, locationId },
      include: { location: { select: { id: true, name: true } } },
    });
    if (!sub) throw new NotFoundException("Subscription not found");
    if (sub.status === "active") {
      throw new BadRequestException(
        "Subscription is already active — open Manage instead.",
      );
    }
    if (!this.stripe || !sub.stripeCustomerId || !sub.stripePriceId) {
      return { url: `${this.webBase()}/dashboard/subscription?mock=checkout` };
    }
    try {
      const session = await this.stripe.checkout.sessions.create({
        mode: "subscription",
        customer: sub.stripeCustomerId,
        line_items: [{ price: sub.stripePriceId, quantity: 1 }],
        success_url: `${this.webBase()}/dashboard/subscription?status=success&location=${locationId}`,
        cancel_url: `${this.webBase()}/dashboard/subscription?status=cancel&location=${locationId}`,
        metadata: { tenantId, locationId },
        subscription_data: { metadata: { tenantId, locationId } },
      });
      await (this.prisma as any).merchantSubscription.update({
        where: { id: sub.id },
        data: { stripeCheckoutId: session.id },
      });
      return { url: session.url };
    } catch (err: any) {
      this.logger.error(
        `Stripe Checkout restart failed for ${locationId}: ${err.message}`,
      );
      throw new BadRequestException(`Stripe error: ${err.message}`);
    }
  }

  /**
   * Cancel the subscription at period end (so the merchant keeps
   * service until their last paid day). Pass `immediate: true` to
   * cancel right now and prorate.
   */
  async cancel(
    tenantId: string,
    locationId: string,
    immediate: boolean,
    userId?: string,
    role?: string,
  ) {
    await this.assertLocationAccess(tenantId, locationId, userId, role);
    const sub = await (this.prisma as any).merchantSubscription.findFirst({
      where: { tenantId, locationId },
    });
    if (!sub) throw new NotFoundException("Subscription not found");
    if (!sub.stripeSubscriptionId) {
      // No Stripe-side subscription yet, just delete our row.
      await (this.prisma as any).merchantSubscription.delete({
        where: { id: sub.id },
      });
      return { canceled: true };
    }
    if (this.stripe) {
      try {
        if (immediate) {
          await this.stripe.subscriptions.cancel(sub.stripeSubscriptionId, {
            prorate: true,
          });
        } else {
          await this.stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: true,
          });
        }
      } catch (err: any) {
        this.logger.error(
          `Stripe cancel failed for ${locationId}: ${err.message}`,
        );
        throw new BadRequestException(`Stripe error: ${err.message}`);
      }
    }
    await (this.prisma as any).merchantSubscription.update({
      where: { id: sub.id },
      data: {
        cancelAtPeriodEnd: !immediate,
        status: immediate ? "canceled" : sub.status,
      },
    });
    return { canceled: true, immediate };
  }

  /**
   * Recent invoices for a subscription. We don't store invoices
   * locally — we proxy to Stripe so the list is always live. Returns
   * the fields our UI needs plus the hosted invoice URL (paid receipt
   * or open invoice) and the PDF download URL.
   */
  async listInvoices(tenantId: string, locationId: string, userId?: string, role?: string) {
    await this.assertLocationAccess(tenantId, locationId, userId, role);
    const sub = await (this.prisma as any).merchantSubscription.findFirst({
      where: { tenantId, locationId },
    });
    if (!sub || !sub.stripeCustomerId) return [];
    if (!this.stripe) {
      return [
        {
          id: "mock_in_1",
          number: "MOCK-0001",
          amountDue: sub.monthlyAmountPence,
          currency: sub.currency,
          status: "paid",
          createdAt: new Date().toISOString(),
          hostedInvoiceUrl: null,
          invoicePdf: null,
        },
      ];
    }
    try {
      const invoices = await this.stripe.invoices.list({
        customer: sub.stripeCustomerId,
        limit: 24,
      });
      return invoices.data.map((inv: any) => ({
        id: inv.id,
        number: inv.number,
        amountDue: inv.amount_due,
        amountPaid: inv.amount_paid,
        currency: inv.currency,
        status: inv.status,
        createdAt: new Date((inv.created ?? 0) * 1000).toISOString(),
        hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
        invoicePdf: inv.invoice_pdf ?? null,
      }));
    } catch (err: any) {
      this.logger.warn(
        `Stripe invoice list failed for ${locationId}: ${err.message}`,
      );
      return [];
    }
  }

  /**
   * Pulls the current truth straight from Stripe and mirrors it onto the
   * MerchantSubscription row, instead of waiting for (or trying to replay)
   * a webhook delivery. This is the only reliable fix once an event has
   * already fired and been missed: Stripe has no way to redeliver an event
   * to a destination that wasn't subscribed to that event type at the time
   * — adding the event type afterwards doesn't backfill anything that
   * already happened, it only starts new deliveries going forward.
   */
  async resyncFromStripe(
    tenantId: string,
    locationId: string,
    userId?: string,
    role?: string,
  ) {
    await this.assertLocationAccess(tenantId, locationId, userId, role);
    const sub = await (this.prisma as any).merchantSubscription.findFirst({
      where: { tenantId, locationId },
    });
    if (!sub) throw new NotFoundException("Subscription not found");
    if (!this.stripe) {
      throw new BadRequestException("Stripe isn't configured on this environment");
    }

    // The subscription id is only ever filled in by the
    // customer.subscription.* webhook — the customer id is set
    // synchronously at plan-creation time, well before that. A row can
    // easily have one and not the other if that webhook was missed (the
    // exact situation this method exists to repair), so fall back to
    // looking the subscription up by customer instead of requiring the id
    // to already be on file.
    let stripeSubscriptionId = sub.stripeSubscriptionId;
    if (!stripeSubscriptionId) {
      if (!sub.stripeCustomerId) {
        throw new BadRequestException(
          "No Stripe customer or subscription on file yet — nothing to resync",
        );
      }
      const list = await this.stripe.subscriptions.list({
        customer: sub.stripeCustomerId,
        status: "all",
        limit: 1,
      });
      const found = list.data?.[0];
      if (!found) {
        throw new BadRequestException(
          "Stripe has no subscription for this customer yet — nothing to resync",
        );
      }
      stripeSubscriptionId = found.id;
    }

    const stripeSub = await this.stripe.subscriptions.retrieve(
      stripeSubscriptionId,
      { expand: ["latest_invoice"] },
    );
    await this.syncFromStripeSubscription(stripeSub);
    if (stripeSub.latest_invoice) {
      await this.syncFromStripeInvoice(stripeSub.latest_invoice);
    }

    if (sub.stripeCustomerId) {
      try {
        const customer = await this.stripe.customers.retrieve(
          sub.stripeCustomerId,
        );
        const pmId = customer?.invoice_settings?.default_payment_method;
        if (pmId) {
          const pm = await this.stripe.paymentMethods.retrieve(pmId);
          await this.syncDefaultPaymentMethod(sub.stripeCustomerId, pm);
        }
      } catch (err: any) {
        this.logger.warn(
          `Payment method resync skipped for ${locationId}: ${err.message}`,
        );
      }
    }

    return this.getForLocation(tenantId, locationId, userId, role);
  }

  // ── Webhook handlers ────────────────────────────────────────────
  //
  // Wired from billing/stripe-webhook.controller.ts. Each handler is
  // idempotent (matches against the subscription row by id) and safe
  // to re-run when Stripe retries delivery.

  async syncFromStripeSubscription(stripeSub: any) {
    const tenantId = stripeSub.metadata?.tenantId;
    const locationId = stripeSub.metadata?.locationId;
    if (!tenantId || !locationId) return;

    const item = stripeSub.items?.data?.[0];
    const data: any = {
      stripeSubscriptionId: stripeSub.id,
      stripePriceId: item?.price?.id,
      status: stripeSub.status,
      currentPeriodStart: stripeSub.current_period_start
        ? new Date(stripeSub.current_period_start * 1000)
        : null,
      currentPeriodEnd: stripeSub.current_period_end
        ? new Date(stripeSub.current_period_end * 1000)
        : null,
      cancelAtPeriodEnd: !!stripeSub.cancel_at_period_end,
      trialEndsAt: stripeSub.trial_end
        ? new Date(stripeSub.trial_end * 1000)
        : null,
    };
    if (item?.price?.unit_amount != null) {
      data.monthlyAmountPence = item.price.unit_amount;
    }

    await (this.prisma as any).merchantSubscription.upsert({
      where: { locationId },
      create: {
        tenantId,
        locationId,
        stripeCustomerId: stripeSub.customer,
        monthlyAmountPence: data.monthlyAmountPence ?? 0,
        currency: stripeSub.currency ?? "gbp",
        ...data,
      },
      update: data,
    });
  }

  async syncFromStripeInvoice(invoice: any) {
    const subId = invoice.subscription;
    if (!subId) return;
    const sub = await (this.prisma as any).merchantSubscription.findFirst({
      where: { stripeSubscriptionId: subId },
    });
    if (!sub) return;
    const lastFailureMessage =
      invoice.status === "paid"
        ? null
        : (invoice.last_finalization_error?.message ??
          invoice.last_payment_error?.message ??
          null);
    await (this.prisma as any).merchantSubscription.update({
      where: { id: sub.id },
      data: {
        lastInvoiceStatus: invoice.status,
        lastFailureMessage,
      },
    });
  }

  async syncDefaultPaymentMethod(customerId: string, pm: any) {
    const sub = await (this.prisma as any).merchantSubscription.findFirst({
      where: { stripeCustomerId: customerId },
    });
    if (!sub) return;
    await (this.prisma as any).merchantSubscription.update({
      where: { id: sub.id },
      data: {
        defaultPaymentBrand: pm?.card?.brand ?? null,
        defaultPaymentLast4: pm?.card?.last4 ?? null,
      },
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private serialise(sub: any) {
    return {
      id: sub.id,
      locationId: sub.locationId,
      locationName: sub.location?.name ?? null,
      monthlyAmountPence: sub.monthlyAmountPence,
      currency: sub.currency,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
      trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
      defaultPaymentBrand: sub.defaultPaymentBrand,
      defaultPaymentLast4: sub.defaultPaymentLast4,
      lastInvoiceStatus: sub.lastInvoiceStatus,
      lastFailureMessage: sub.lastFailureMessage,
      stripeCustomerId: sub.stripeCustomerId,
      stripeSubscriptionId: sub.stripeSubscriptionId,
      createdAt: sub.createdAt?.toISOString?.() ?? null,
    };
  }
}
