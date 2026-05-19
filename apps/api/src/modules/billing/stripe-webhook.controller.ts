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
import { PrismaService } from "../../infrastructure/database/prisma.service";

@ApiTags("webhooks")
@Controller({ path: "webhooks/stripe", version: "1" })
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly billing: BillingService,
    private readonly prisma: PrismaService,
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

    const db = this.prisma as any;

    // Idempotency check — skip if we've already processed this event
    const existing = await db.stripeWebhookEvent.findUnique({
      where: { stripeEventId: event.id },
      select: { id: true, processedAt: true },
    });

    if (existing?.processedAt) {
      this.logger.debug(`Stripe event ${event.id} already processed — skipping`);
      return { received: true };
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

    return { received: true };
  }
}
