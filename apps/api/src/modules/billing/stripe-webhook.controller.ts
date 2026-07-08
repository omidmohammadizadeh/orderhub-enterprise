import {
  Controller,
  Post,
  Headers,
  RawBodyRequest,
  Req,
  BadRequestException,
  Logger,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { StripeService } from "./stripe.service";
import { BillingService } from "./billing.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PaymentsService } from "../payments/payments.service";

@ApiTags("webhooks")
@Controller({ path: "webhooks/stripe", version: "1" })
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly billing: BillingService,
    private readonly subscriptions: SubscriptionsService,
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Stripe webhook receiver — verifies signature and processes billing events",
  })
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("stripe-signature") sig: string,
  ): Promise<{ received: boolean }> {
    // Phase AW-30 — VERY first log so we can confirm the route is
    // reached at all when Stripe's "timed out" error shows up. If we
    // don't see this line in Render logs, the request isn't getting
    // through Render's proxy / our middleware → something upstream
    // is dropping it.
    this.logger.log(
      `stripe-webhook HIT sig=${sig?.slice(0, 24) ?? "missing"} body-len=${req.rawBody?.length ?? "n/a"}`,
    );

    if (!sig) {
      throw new BadRequestException("Missing stripe-signature header");
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException(
        "Raw body is unavailable. Ensure bodyParser raw middleware is configured for this route.",
      );
    }

    let event: any;
    try {
      event = this.stripe.constructWebhookEvent(rawBody, sig);
    } catch (err: any) {
      this.logger.warn(`Stripe webhook signature verification failed: ${err.message}`);
      throw new BadRequestException(`Webhook signature verification failed: ${err.message}`);
    }

    // Phase AW-30 — return 200 IMMEDIATELY, then process in background.
    // Stripe's webhook timeout is ~20s; any slow downstream work
    // (Prisma writes, Stripe API calls inside billing.handleStripeWebhookBilling,
    // logging) could push us over that limit and cause the "timed out"
    // failures we were seeing. The DB writes inside the handler are
    // idempotent (stripeWebhookEvent unique key + upserts) so doing
    // them after the response is safe — Stripe will retry on failure
    // and we'll skip duplicates.
    this.processEventInBackground(event);
    return { received: true };
  }

  private processEventInBackground(event: any) {
    setImmediate(async () => {
      try {
        await this.runEventHandlers(event);
      } catch (err: any) {
        this.logger.error(
          `Background webhook processing failed for ${event.id} (${event.type}): ${err?.message ?? err}`,
        );
      }
    });
  }

  private async runEventHandlers(event: any) {

    const db = this.prisma as any;

    // Idempotency check — skip if we've already processed this event
    const existing = await db.stripeWebhookEvent.findUnique({
      where: { stripeEventId: event.id },
      select: { id: true, processedAt: true },
    });

    if (existing?.processedAt) {
      this.logger.debug(`Stripe event ${event.id} already processed — skipping`);
      return;
    }

    // Record event before processing (upsert handles rare duplicate deliveries)
    if (!existing) {
      await db.stripeWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          payload: event as any,
        },
      });
    }

    let processingError: string | null = null;
    try {
      await this.billing.handleStripeWebhookBilling(event);
      // Phase AW-30 — forward subscription events to the per-location
      // merchant-subscription mirror. Each handler is a no-op for events
      // unrelated to a MerchantSubscription row.
      try {
        switch (event.type) {
          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted":
            await this.subscriptions.syncFromStripeSubscription(
              event.data.object,
            );
            break;
          case "invoice.paid":
          case "invoice.payment_failed":
          case "invoice.payment_action_required":
            await this.subscriptions.syncFromStripeInvoice(event.data.object);
            break;
          case "payment_method.attached":
          case "customer.updated":
            if (event.data.object.customer ?? event.data.object.id) {
              await this.subscriptions.syncDefaultPaymentMethod(
                event.data.object.customer ?? event.data.object.id,
                event.data.object,
              );
            }
            break;
        }
      } catch (err: any) {
        this.logger.warn(
          `MerchantSubscription sync skipped for ${event.type}: ${err?.message ?? err}`,
        );
      }
      // This endpoint receives connected-account PAYMENT events too (direct
      // charges) — forward them to PaymentsService so card orders authorise
      // (payment_intent.amount_capturable_updated → markAuthorized → board),
      // cancel, capture-settle and refund. Guarded so a payment-side error
      // doesn't block marking the event processed.
      try {
        await this.payments.dispatchStripeEvent(event);
      } catch (err: any) {
        this.logger.warn(
          `Payment webhook dispatch skipped for ${event.type}: ${err?.message ?? err}`,
        );
      }
      await db.stripeWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { processedAt: new Date(), error: null },
      });
    } catch (err: any) {
      processingError = err?.message ?? String(err);
      this.logger.error(
        `Stripe webhook processing error for event ${event.id} (${event.type}): ${processingError}`,
      );
      await db.stripeWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { error: processingError },
      });
      // Do not re-throw — Stripe retries on 5xx; returning 200 prevents retry storms
      // for events we explicitly don't handle or for tenant-not-found scenarios.
    }
  }
}
