import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Stripe is loaded lazily to avoid a hard startup failure if the key is absent
// (FREE_PILOT shops don't need Stripe on day 1).
let stripe: any;
function getStripe(secretKey: string): any {
  if (!stripe) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Stripe = require("stripe");
    stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" });
  }
  return stripe;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly secretKey: string | undefined;
  private readonly webhookSecret: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.secretKey = config.get<string>("STRIPE_SECRET_KEY");
    this.webhookSecret = config.get<string>("STRIPE_WEBHOOK_SECRET");
  }

  private get client(): any {
    if (!this.secretKey) {
      throw new InternalServerErrorException(
        "STRIPE_SECRET_KEY is not configured. Cannot process Stripe operations.",
      );
    }
    return getStripe(this.secretKey);
  }

  get isConfigured(): boolean {
    return !!this.secretKey;
  }

  // ── Customer ───────────────────────────────────────────────────────────────

  async createCustomer(params: {
    tenantId: string;
    email: string;
    name: string;
  }): Promise<string> {
    const customer = await this.client.customers.create({
      email: params.email,
      name: params.name,
      metadata: { tenantId: params.tenantId },
    });
    this.logger.log(`Stripe customer created: ${customer.id} for tenant ${params.tenantId}`);
    return customer.id;
  }

  async getCustomer(stripeCustomerId: string): Promise<any> {
    return this.client.customers.retrieve(stripeCustomerId);
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  async createSubscription(params: {
    stripeCustomerId: string;
    stripePriceId: string;
    trialDays?: number;
    metadata?: Record<string, string>;
  }): Promise<any> {
    const data: Record<string, any> = {
      customer: params.stripeCustomerId,
      items: [{ price: params.stripePriceId }],
      metadata: params.metadata ?? {},
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.payment_intent"],
    };

    if (params.trialDays && params.trialDays > 0) {
      data.trial_period_days = params.trialDays;
    }

    const subscription = await this.client.subscriptions.create(data);
    this.logger.log(
      `Stripe subscription created: ${subscription.id} for customer ${params.stripeCustomerId}`,
    );
    return subscription;
  }

  async cancelSubscription(stripeSubId: string, atPeriodEnd = true): Promise<any> {
    if (atPeriodEnd) {
      return this.client.subscriptions.update(stripeSubId, {
        cancel_at_period_end: true,
      });
    }
    return this.client.subscriptions.cancel(stripeSubId);
  }

  async updateSubscription(stripeSubId: string, newPriceId: string): Promise<any> {
    const sub = await this.client.subscriptions.retrieve(stripeSubId);
    const itemId = sub.items.data[0]?.id;
    if (!itemId) throw new InternalServerErrorException("Stripe subscription item not found");

    return this.client.subscriptions.update(stripeSubId, {
      items: [{ id: itemId, price: newPriceId }],
      proration_behavior: "create_prorations",
    });
  }

  // ── Checkout & Portal ──────────────────────────────────────────────────────

  async createCheckoutSession(params: {
    stripeCustomerId: string;
    stripePriceId: string;
    successUrl: string;
    cancelUrl: string;
    tenantId: string;
    trialDays?: number;
  }): Promise<{ url: string; sessionId: string }> {
    const session = await this.client.checkout.sessions.create({
      customer: params.stripeCustomerId,
      mode: "subscription",
      line_items: [{ price: params.stripePriceId, quantity: 1 }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: { tenantId: params.tenantId },
      subscription_data: params.trialDays
        ? { trial_period_days: params.trialDays }
        : undefined,
    });
    return { url: session.url as string, sessionId: session.id as string };
  }

  async createBillingPortalSession(params: {
    stripeCustomerId: string;
    returnUrl: string;
  }): Promise<string> {
    const session = await this.client.billingPortal.sessions.create({
      customer: params.stripeCustomerId,
      return_url: params.returnUrl,
    });
    return session.url as string;
  }

  // ── Metered Usage ──────────────────────────────────────────────────────────

  async reportMeteredUsage(params: {
    subscriptionItemId: string;
    quantity: number;
    timestamp?: number;
    idempotencyKey?: string;
  }): Promise<void> {
    await this.client.subscriptionItems.createUsageRecord(
      params.subscriptionItemId,
      {
        quantity: params.quantity,
        timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
        action: "set",
      },
      params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {},
    );
  }

  // ── Webhook Verification ───────────────────────────────────────────────────

  constructWebhookEvent(rawBody: Buffer, signature: string): any {
    if (!this.webhookSecret) {
      throw new InternalServerErrorException(
        "STRIPE_WEBHOOK_SECRET is not configured. Cannot verify webhook signature.",
      );
    }
    // We run more than one Stripe webhook endpoint at the same URL — one for
    // connected-account payment events, and one for the PLATFORM account's own
    // events (SMS wallet top-ups, platform subscriptions). Each endpoint has a
    // DIFFERENT signing secret, so accept a comma/whitespace-separated list in
    // STRIPE_WEBHOOK_SECRET and try each until one verifies.
    const secrets = this.webhookSecret
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    let lastErr: any;
    for (const secret of secrets) {
      try {
        return this.client.webhooks.constructEvent(rawBody, signature, secret);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("No STRIPE_WEBHOOK_SECRET candidates to verify against");
  }
}
